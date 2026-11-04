import { describe, expect, it } from "vitest";
import { MediaPool, httpUrlOf, type MediaConfig } from "./mediaPool.js";

const primary: MediaConfig = { url: "wss://principal.teste", apiKey: "kp", apiSecret: "sp" };
const fallback: MediaConfig = { url: "wss://reserva.teste", apiKey: "kf", apiSecret: "sf" };

/** Pool com um "ping" que a gente liga e desliga. */
function setup(withPrimary = true) {
  const state = { up: true, pinged: [] as string[] };
  const pool = new MediaPool({ primary: withPrimary ? primary : null, fallback }, async (url) => {
    state.pinged.push(url);
    return state.up;
  });
  const set = async (up: boolean, times: number) => {
    state.up = up;
    for (let i = 0; i < times; i++) await pool.check();
  };
  return { pool, state, set };
}

describe("MediaPool", () => {
  it("sem principal: pick devolve sempre a reserva", () => {
    const { pool } = setup(false);
    expect(pool.pick("voice-1", 1)).toMatchObject({ name: "fallback", url: fallback.url, apiKey: "kf" });
    expect(pool.pick("voice-2", 2).name).toBe("fallback");
  });

  it("com principal saudável: a primeira pessoa de uma sala recebe a principal; a segunda, a mesma", () => {
    const { pool } = setup();
    expect(pool.pick("voice-1", 1)).toMatchObject({ name: "primary", url: primary.url, apiKey: "kp" });
    expect(pool.pick("voice-1", 2).name).toBe("primary");
    expect(pool.serverOf("voice-1")).toBe("primary");
  });

  it("sala fixa: a principal cai com A na sala; B entra e continua recebendo primary; depois que saem, a sala some e a próxima recebe a reserva", async () => {
    const { pool, set } = setup();
    pool.pick("voice-1", 1);
    await set(false, 2);
    expect(pool.primaryHealthy).toBe(false);
    expect(pool.pick("voice-1", 2).name).toBe("primary");
    pool.left("voice-1", 1);
    expect(pool.serverOf("voice-1")).toBe("primary");
    pool.left("voice-1", 2);
    expect(pool.serverOf("voice-1")).toBeUndefined();
    expect(pool.pick("voice-1", 3).name).toBe("fallback");
  });

  it("sala vazia escolhe de novo: a principal volta a ser a escolha depois de 2 acertos", async () => {
    const { pool, set } = setup();
    await set(false, 2);
    expect(pool.pick("voice-1", 1).name).toBe("fallback");
    pool.left("voice-1", 1);
    await set(true, 2);
    expect(pool.pick("voice-1", 1).name).toBe("primary");
  });

  it("na partida: principal já fora do ar avisa 'caiu'; principal saudável não avisa nada", async () => {
    const down = setup();
    const avisos: boolean[] = [];
    down.pool.onChange((h) => avisos.push(h));
    down.state.up = false;
    await down.pool.check(true);
    expect(avisos).toEqual([false]);

    const up = setup();
    const avisosUp: boolean[] = [];
    up.pool.onChange((h) => avisosUp.push(h));
    await up.pool.check(true);
    expect(avisosUp).toEqual([]);
  });

  it("histerese: 1 falha não derruba; 2 seguidas sim; 1 acerto não restaura; 2 seguidos sim; onChange só nas trocas", async () => {
    const { pool, set } = setup();
    const changes: boolean[] = [];
    pool.onChange((healthy) => changes.push(healthy));

    await set(false, 1);
    expect(pool.primaryHealthy).toBe(true);
    await set(true, 1); // a falha isolada é esquecida
    await set(false, 1);
    expect(pool.primaryHealthy).toBe(true);
    expect(changes).toEqual([]);

    await set(false, 1); // segunda seguida
    expect(pool.primaryHealthy).toBe(false);
    expect(changes).toEqual([false]);
    await set(false, 3); // continua fora, sem repetir aviso
    expect(changes).toEqual([false]);

    await set(true, 1);
    expect(pool.primaryHealthy).toBe(false);
    await set(false, 1); // o acerto isolado também é esquecido
    await set(true, 1);
    expect(pool.primaryHealthy).toBe(false);
    await set(true, 1);
    expect(pool.primaryHealthy).toBe(true);
    expect(changes).toEqual([false, true]);
  });

  it("salas diferentes são independentes", async () => {
    const { pool, set } = setup();
    pool.pick("voice-1", 1);
    await set(false, 2);
    expect(pool.pick("voice-2", 2).name).toBe("fallback");
    expect(pool.serverOf("voice-1")).toBe("primary");
    expect(pool.serverOf("voice-2")).toBe("fallback");
  });

  it("a mesma pessoa saindo duas vezes não estraga a contagem", () => {
    const { pool } = setup();
    pool.pick("voice-1", 1);
    pool.pick("voice-1", 2);
    pool.left("voice-1", 1);
    pool.left("voice-1", 1);
    expect(pool.serverOf("voice-1")).toBe("primary");
    pool.left("voice-9", 1); // sala que nunca existiu: ignora
  });

  it("verifica o endereço http da principal e não faz nada sem principal", async () => {
    const a = setup();
    await a.pool.check();
    expect(a.state.pinged).toEqual(["https://principal.teste"]);
    const b = setup(false);
    await b.pool.check();
    expect(b.state.pinged).toEqual([]);
    expect(b.pool.primaryHealthy).toBe(false);
  });

  it("ping que lança erro conta como falha", async () => {
    const pool = new MediaPool({ primary, fallback }, async () => {
      throw new Error("sem rede");
    });
    await pool.check();
    await pool.check();
    expect(pool.primaryHealthy).toBe(false);
  });

  it("start: a primeira verificação já vale sozinha (principal morta no boot vai direto para a reserva)", async () => {
    const pool = new MediaPool({ primary, fallback }, async () => false);
    const stop = pool.start();
    await new Promise((r) => setTimeout(r, 10));
    stop();
    expect(pool.primaryHealthy).toBe(false);
    expect(pool.pick("voice-1", 1).name).toBe("fallback");
  });

  it("reinício do Concord: as atribuições recomeçam do zero e todos reentram no mesmo servidor", () => {
    const { pool } = setup();
    pool.pick("voice-1", 1);
    const novo = setup().pool; // processo novo, mesma principal saudável
    expect(novo.pick("voice-1", 1).name).toBe("primary");
    expect(novo.pick("voice-1", 2).name).toBe("primary");
  });
});

describe("httpUrlOf", () => {
  it("troca ws por http e wss por https", () => {
    expect(httpUrlOf("wss://x.com")).toBe("https://x.com");
    expect(httpUrlOf("ws://localhost:7880")).toBe("http://localhost:7880");
  });
});
