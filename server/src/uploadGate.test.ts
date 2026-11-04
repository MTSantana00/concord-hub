import net from "node:net";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_CONCURRENT_UPLOADS } from "./uploadGate.js";
import { closeAll, pause, scenario } from "./testkit.js";

afterEach(closeAll);

/** Abre um envio que nunca termina: declara 4000 bytes e manda só 10 (segura uma vaga do porteiro). */
function envioPendente(port: number, cookie: string, canal: number, rota: "attachments" | "audio") {
  const socket = net.connect(port, "localhost");
  const query = rota === "attachments" ? "name=lento.bin" : "ms=500";
  socket.write(
    `POST /api/channels/${canal}/${rota}?${query} HTTP/1.1\r\nHost: localhost\r\nCookie: ${cookie}\r\nContent-Type: ${rota === "audio" ? "audio/webm" : "application/octet-stream"}\r\nContent-Length: 4000\r\n\r\n0123456789`,
  );
  return socket;
}

describe("limite de envios simultâneos", () => {
  it(`com ${MAX_CONCURRENT_UPLOADS} envios em andamento o próximo recebe 503 com Retry-After; quando um termina, volta a aceitar`, async () => {
    const { ana, beto, port, channelId } = await scenario();
    const url = `/api/channels/${channelId}/attachments`;
    const abertos = [
      envioPendente(port, ana.cookie, channelId, "attachments"),
      envioPendente(port, ana.cookie, channelId, "attachments"),
      envioPendente(port, beto.cookie, channelId, "audio"), // anexos e áudios dividem as mesmas vagas
      envioPendente(port, beto.cookie, channelId, "audio"),
    ];
    const respostas: string[] = [];
    abertos.forEach((s) => s.on("data", (d) => respostas.push(d.toString().split("\r\n")[0])));
    await pause(300);
    expect(respostas, "os envios pendentes não deveriam ter recebido resposta ainda").toEqual([]);

    const recusado = await beto.agent.post(url).query({ name: "a.txt" }).set("Content-Type", "application/octet-stream").send(Buffer.from("x"));
    expect(recusado.status).toBe(503);
    expect(recusado.headers["retry-after"]).toBe("3");
    expect(recusado.body.error).toMatch(/outros arquivos/);
    expect((await beto.agent.get(`/api/channels/${channelId}/messages`)).status).toBe(200); // o resto do app não é afetado

    abertos[0].destroy(); // quem desiste no meio libera a vaga
    await pause(300);
    const ok = await beto.agent.post(url).query({ name: "b.txt" }).set("Content-Type", "application/octet-stream").send(Buffer.from("x"));
    expect(ok.status).toBe(201);
    for (const s of abertos) s.destroy();
  });

  it("sem login continua 401 e não gasta vaga", async () => {
    const { app, channelId } = await scenario();
    for (let i = 0; i < MAX_CONCURRENT_UPLOADS + 2; i++) {
      expect((await request(app).post(`/api/channels/${channelId}/attachments`).query({ name: "x" }).send(Buffer.from("x"))).status).toBe(401);
    }
  });
});
