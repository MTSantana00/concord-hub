import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { meterOf } from "./app.js";
import { MediaPool } from "./mediaPool.js";
import { THRESHOLDS, type VmReading } from "./usage.js";
import { closeAll, connect, pause, scenario } from "./testkit.js";

afterEach(closeAll);

const cfg = { publicKey: "chave-publica-de-teste", privateKey: "privada", subject: "mailto:teste@exemplo.com" };
const keys = { p256dh: "p".repeat(20), auth: "a".repeat(20) };
const saudavel: VmReading = { memAvailableMb: 330, memTotalMb: 954, swapUsedMb: 600, swapTotalMb: 4096, diskUsedPct: 18, containerMemMb: 53, containerLimitMb: 200 };

/** Ana (administradora) com um aparelho assinado para receber notificação; relógio e leitura da VM controlados pelo teste. */
async function setup(extra: { minutesLimit?: number; gbLimit?: number } = {}) {
  const sent: { endpoint: string; payload: any }[] = [];
  const pushSender = async (sub: { endpoint: string }, payload: string) => {
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
  };
  const clock = { now: new Date("2026-11-10T12:00:00Z") };
  const vm = { reading: { ...saudavel } as VmReading };
  const s = await scenario({
    push: cfg,
    pushSender,
    usage: { minutesLimit: extra.minutesLimit ?? 100, gbLimit: extra.gbLimit ?? 1, now: () => clock.now, read: () => vm.reading },
  } as any);
  await s.ana.agent.post("/api/push/subscribe").send({ endpoint: "https://fcm.googleapis.com/fcm/send/ana", keys });
  const meter = meterOf(s.app as any);
  return { ...s, sent, clock, vm, meter };
}

describe("limites do plano de voz", () => {
  it("avisa uma vez em 70%, 90% e 100%; notifica a administradora (push e tempo real) e mais ninguém", async () => {
    const { ana, beto, port, sent, meter } = await setup();
    await beto.agent.post("/api/push/subscribe").send({ endpoint: "https://fcm.googleapis.com/fcm/send/beto", keys });
    const wsAna = await connect(port, { Cookie: ana.cookie });
    const wsBeto = await connect(port, { Cookie: beto.cookie });

    meter.record(69, 0);
    expect(meter.alerts()).toHaveLength(0);
    meter.record(1, 0); // 70%
    meter.record(5, 0); // continua entre 70% e 90%: não repete
    expect(meter.alerts().map((a) => [a.level, a.title])).toEqual([["aviso", "Voz: 70% do limite gratuito (minutos de voz)"]]);
    meter.record(15, 0); // 90%
    meter.record(10, 0); // 100%
    meter.record(50, 0); // passou de 100%: não repete
    const alertas = meter.alerts().reverse();
    expect(alertas.map((a) => a.level)).toEqual(["aviso", "critico", "critico"]);
    expect(alertas[2].title).toBe("Limite de voz atingido (minutos de voz)");
    expect(alertas[2].message).toContain("dia 1º");
    expect(alertas[2].message).toContain("chat de texto não é afetado");

    await pause(100);
    expect(sent.map((s) => s.endpoint)).toEqual(Array(THRESHOLDS.length).fill("https://fcm.googleapis.com/fcm/send/ana"));
    expect(sent[0].payload).toMatchObject({ title: "⚠ Voz: 70% do limite gratuito (minutos de voz)", tag: "admin-alert" });
    expect((await wsAna.next()).type).toBe("admin.alert"); // com o app aberto também chega (o push não espera ela sair)
    expect(wsBeto.received).toEqual([]);
  });

  it("o tráfego estimado também avisa, e cada mês começa do zero", async () => {
    const { meter, clock } = await setup();
    meter.record(0, 0.7); // 70% de 1 GB
    expect(meter.alerts().map((a) => a.title)).toEqual(["Voz: 70% do limite gratuito (tráfego de voz (estimado))"]);

    clock.now = new Date("2026-12-01T00:30:00Z");
    expect(meter.status().voice).toMatchObject({ minutes: 0, gb: 0 });
    meter.record(80, 0); // dezembro: novo mês, novo aviso
    expect(meter.alerts()).toHaveLength(2);
    expect(meter.status().voice.minutes).toBe(80);
    clock.now = new Date("2026-11-30T23:00:00Z");
    expect(meter.status().voice.minutes).toBe(0); // novembro ficou guardado à parte
  });

  it("conta um minuto por pessoa em sala de voz e estima o tráfego de áudio (n pessoas ouvem n-1)", async () => {
    const { ana, beto, carla, code, port, server, meter } = await setup({ minutesLimit: 5000, gbLimit: 50 });
    await carla.agent.post(`/api/invites/${code}/join`);
    const sala = (await ana.agent.post(`/api/servers/${server.id}/channels`).send({ name: "sala", type: "voice" })).body.channel.id;
    for (const who of [ana, beto, carla]) {
      const ws = await connect(port, { Cookie: who.cookie });
      ws.ws.send(JSON.stringify({ type: "voice.join", channelId: sala }));
    }
    await pause(200);
    meter.tickVoice();
    meter.tickVoice();
    const voz = meter.status().voice;
    expect(voz.minutes).toBe(6); // 3 pessoas x 2 minutos
    expect(voz.gb).toBeCloseTo((2 * 3 * 2 * 0.24) / 1024, 1);
    meter.tickVoice([]); // ninguém na voz: nada é contado
    expect(meter.status().voice.minutes).toBe(6);
  });

  it("com servidor próprio configurado, só as salas da reserva gastam o plano gratuito", async () => {
    const pool = new MediaPool(
      { primary: { url: "wss://p.teste", apiKey: "kp", apiSecret: "sp" }, fallback: { url: "wss://r.teste", apiKey: "kf", apiSecret: "sf" } },
      async () => up.value,
    );
    const up = { value: true };
    const { meter } = await (async () => {
      const s = await scenario({ mediaPool: pool, usage: { minutesLimit: 5000, gbLimit: 50 } } as any);
      return { meter: meterOf(s.app as any) };
    })();
    pool.pick("voice-1", 1); // nasce na principal
    pool.pick("voice-1", 2);
    pool.pick("voice-1", 3);
    up.value = false;
    await pool.check();
    await pool.check();
    pool.pick("voice-2", 4); // nasce na reserva
    pool.pick("voice-2", 5);

    meter.tickVoice([
      { room: "voice-1", size: 3 },
      { room: "voice-2", size: 2 },
      { room: "voice-3", size: 4 }, // sentados mas sem ligação de mídia (ninguém pegou chave): não gastam nada
    ]);
    expect(meter.status().voice.minutes).toBe(2);
  });

  it("sem servidor próprio configurado, conta todas as salas, como sempre", async () => {
    const { meter } = await setup({ minutesLimit: 5000, gbLimit: 50 });
    meter.tickVoice([
      { room: "voice-1", size: 3 },
      { room: "call-9", size: 2 },
    ]);
    expect(meter.status().voice.minutes).toBe(5);
  });

  it("limite 0 desliga a conferência (servidor de mídia próprio)", async () => {
    const { meter } = await setup({ minutesLimit: 0, gbLimit: 0 });
    meter.record(100000, 1000);
    expect(meter.alerts()).toHaveLength(0);
  });
});

describe("saúde da VM", () => {
  it("memória baixa: aviso e depois crítico, uma vez por dia e por nível", async () => {
    const { meter, vm, clock } = await setup();
    meter.checkVm();
    expect(meter.alerts()).toHaveLength(0); // tudo saudável

    vm.reading = { ...saudavel, memAvailableMb: 100 }; // 10%
    meter.checkVm();
    meter.checkVm();
    expect(meter.alerts().map((a) => [a.level, a.title])).toEqual([["aviso", "Memória da VM baixa"]]);
    vm.reading = { ...saudavel, memAvailableMb: 40 }; // 4%
    meter.checkVm();
    expect(meter.alerts()[0]).toMatchObject({ level: "critico", title: "Memória da VM quase no fim" });
    expect(meter.alerts()).toHaveLength(2);

    clock.now = new Date("2026-11-11T12:00:00Z"); // no dia seguinte, se continuar, avisa de novo
    meter.checkVm();
    expect(meter.alerts()).toHaveLength(3);
  });

  it("disco, swap e memória do próprio Concord", async () => {
    const { meter, vm } = await setup();
    vm.reading = { ...saudavel, diskUsedPct: 82, swapUsedMb: 3600, containerMemMb: 175 };
    meter.checkVm();
    expect(meter.alerts().map((a) => a.title).sort()).toEqual(["Concord perto do limite de memória", "Disco da VM enchendo", "Memória de troca (swap) quase cheia"]);
    vm.reading = { ...saudavel, diskUsedPct: 93, containerMemMb: 195 };
    meter.checkVm();
    const criticos = meter.alerts().filter((a) => a.level === "critico").map((a) => a.title).sort();
    expect(criticos).toEqual(["Concord no limite de memória", "Disco da VM quase cheio"]);
  });

  it("sem leitura da máquina (ex.: Windows) não inventa avisos", async () => {
    const { meter, vm } = await setup();
    vm.reading = { memAvailableMb: 0, memTotalMb: 0, swapUsedMb: 0, swapTotalMb: 0, diskUsedPct: 0, containerMemMb: null, containerLimitMb: null };
    meter.checkVm();
    expect(meter.alerts()).toHaveLength(0);
  });

  it("backup atrasado avisa; com backup recente não", async () => {
    const dir = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "concord-usage-"));
    const { createBackup } = await import("./backup.js");
    const { openDb } = await import("./db.js");
    const s = await scenario({ backupDir: dir, usage: { now: () => new Date(), read: () => saudavel, backupDir: dir } } as any);
    const meter = meterOf(s.app as any);
    meter.checkVm();
    expect(meter.alerts().map((a) => a.title)).toEqual(["Backup automático atrasado"]); // nenhum backup ainda
    createBackup(openDb(), dir, new Date());
    const hoje = new Date();
    const outro = await scenario({ backupDir: dir, usage: { now: () => new Date(hoje.getTime() + 24 * 3600 * 1000), read: () => saudavel, backupDir: dir } } as any);
    meterOf(outro.app as any).checkVm();
    expect(meterOf(outro.app as any).alerts()).toHaveLength(0); // 24 h depois do backup ainda está em dia
  });
});

describe("rotas da administradora", () => {
  it("usage mostra o mês, a VM e os avisos; ler e marcar como lido; só a administradora", async () => {
    const { app, ana, beto, meter } = await setup();
    meter.record(70, 0);
    meter.record(25, 0);
    const u = (await ana.agent.get("/api/admin/usage")).body;
    expect(u).toMatchObject({ month: "2026-11", voice: { minutes: 95, minutesLimit: 100, gb: 0, gbLimit: 1 }, vm: { memAvailableMb: 330 } });
    expect(u.alerts.map((a: any) => a.acked)).toEqual([false, false]);

    const primeiro = u.alerts[1].id;
    expect((await ana.agent.post("/api/admin/alerts/ack").send({ id: primeiro })).status).toBe(204);
    expect((await ana.agent.get("/api/admin/usage")).body.alerts.map((a: any) => a.acked)).toEqual([false, true]);
    expect((await ana.agent.post("/api/admin/alerts/ack").send({})).status).toBe(204); // todos
    expect((await ana.agent.get("/api/admin/usage")).body.alerts.every((a: any) => a.acked)).toBe(true);
    expect((await ana.agent.post("/api/admin/alerts/ack").send({ id: "x" })).status).toBe(400);

    expect((await beto.agent.get("/api/admin/usage")).status).toBe(403);
    expect((await beto.agent.post("/api/admin/alerts/ack").send({})).status).toBe(403);
    expect((await request(app).get("/api/admin/usage")).status).toBe(401);
  });
});
