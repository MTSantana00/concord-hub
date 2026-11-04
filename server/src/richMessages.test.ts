import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_BYTES, cleanFileName } from "./routes/richMessages.js";
import { closeAll, connect, pause, scenario } from "./testkit.js";

afterEach(closeAll);

const png = (extra = 200) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra, 7)]);
const gif = () => Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(100, 1)]);
const pdf = () => Buffer.from("%PDF-1.4 conteudo do documento");

/** Ana (dona), Beto (membro), Carla (de fora); canal geral e uma conversa direta Ana-Beto. */
async function withChat() {
  const s = await scenario();
  const dm = (await s.ana.agent.post("/api/dms").send({ userId: s.beto.id })).body.dm.id as number;
  const canal = `/api/channels/${s.channelId}`;
  const conversa = `/api/dms/${dm}`;
  const say = async (agent: request.Agent, base: string, content: string, extra: object = {}) =>
    (await agent.post(`${base}/messages`).send({ content, ...extra })).body.message;
  const upload = (agent: request.Agent, base: string, body: Buffer, name: string, extra: Record<string, string> = {}) =>
    agent.post(`${base}/attachments`).query({ name, ...extra }).set("Content-Type", "application/octet-stream").send(body);
  return { ...s, dm, canal, conversa, say, upload };
}

describe("anexos", () => {
  it("imagem: vira mensagem com anexo do tipo imagem (o tipo vem dos bytes), legenda e entrega em tempo real; membros baixam os mesmos bytes", async () => {
    const { ana, beto, port, canal, upload } = await withChat();
    const ws = await connect(port, { Cookie: beto.cookie });
    const bytes = png();
    const res = await upload(ana.agent, canal, bytes, "foto.jpg", { caption: "olha só" }); // diz .jpg mas os bytes são PNG
    expect(res.status).toBe(201);
    expect(res.body.message).toMatchObject({
      content: "olha só",
      attachment: { name: "foto.jpg", mime: "image/png", kind: "image", size: bytes.length },
      author: { username: "ana" },
    });
    expect((await ws.next()).message.id).toBe(res.body.message.id);

    const baixado = await beto.agent.get(`/api/files/${res.body.message.id}`).buffer(true).parse((r, cb) => {
      const parts: Buffer[] = [];
      r.on("data", (c: Buffer) => parts.push(c));
      r.on("end", () => cb(null, Buffer.concat(parts)));
    });
    expect(baixado.status).toBe(200);
    expect(baixado.headers["content-type"]).toContain("image/png");
    expect(baixado.headers["content-disposition"]).toMatch(/^inline/);
    expect(baixado.headers["x-content-type-options"]).toBe("nosniff");
    expect(baixado.headers["content-security-policy"]).toContain("sandbox");
    expect(Buffer.compare(baixado.body, bytes)).toBe(0);
  });

  it("GIF é aceito como imagem", async () => {
    const { ana, canal, upload } = await withChat();
    const r = await upload(ana.agent, canal, gif(), "dancinha.gif");
    expect(r.body.message.attachment).toMatchObject({ kind: "image", mime: "image/gif" });
  });

  it("outros arquivos viram cartão: tipo genérico e só baixam (attachment), com o nome preservado", async () => {
    const { ana, beto, canal, upload } = await withChat();
    const r = await upload(ana.agent, canal, pdf(), "relatório final.pdf");
    expect(r.body.message.attachment).toMatchObject({ name: "relatório final.pdf", kind: "file", mime: "application/octet-stream" });
    const baixado = await beto.agent.get(`/api/files/${r.body.message.id}`);
    expect(baixado.status).toBe(200);
    expect(baixado.headers["content-type"]).toContain("application/octet-stream");
    expect(baixado.headers["content-disposition"]).toBe("attachment; filename*=UTF-8''relat%C3%B3rio%20final.pdf");
  });

  it("uma página disfarçada de imagem não vira imagem: continua sendo arquivo para baixar", async () => {
    const { ana, canal, upload } = await withChat();
    const r = await upload(ana.agent, canal, Buffer.from("<script>alert(1)</script>"), "foto.png");
    expect(r.body.message.attachment).toMatchObject({ kind: "file", mime: "application/octet-stream" });
  });

  it("recusa programas, scripts e páginas pelo nome; e arquivo vazio ou grande demais", async () => {
    const { ana, canal, upload } = await withChat();
    for (const nome of ["setup.exe", "run.BAT", "a.js", "pagina.html", "desenho.svg", "foto.png.exe", "x.ps1", "x.jar"]) {
      expect((await upload(ana.agent, canal, pdf(), nome)).status).toBe(415);
    }
    expect((await upload(ana.agent, canal, Buffer.alloc(0), "vazio.txt")).status).toBe(400);
    expect((await upload(ana.agent, canal, Buffer.alloc(MAX_ATTACHMENT_BYTES + 10), "grande.bin")).status).toBe(413);
    expect((await ana.agent.get(`${canal}/messages`)).body.messages).toHaveLength(0); // nada foi gravado
  });

  it("legenda grande demais ou resposta a mensagem que não existe: 400", async () => {
    const { ana, canal, upload } = await withChat();
    expect((await upload(ana.agent, canal, png(), "a.png", { caption: "x".repeat(2001) })).status).toBe(400);
    expect((await upload(ana.agent, canal, png(), "a.png", { replyTo: "9999" })).status).toBe(400);
  });

  it("o nome do arquivo perde caminhos e caracteres de controle", () => {
    expect(cleanFileName("../../etc/passwd")).toBe("passwd");
    expect(cleanFileName("C:\\Users\\eu\\carta.docx")).toBe("carta.docx");
    expect(cleanFileName("  a\u0000b\n.txt ")).toBe("ab.txt");
    expect(cleanFileName("")).toBe("arquivo");
    expect(cleanFileName(undefined)).toBe("arquivo");
    expect(cleanFileName("termina-com-ponto.")).toBe("arquivo");
    expect(cleanFileName("x".repeat(300)).length).toBe(120);
  });

  it("só quem pode ler a conversa envia e baixa: de fora 404, sem login 401", async () => {
    const { app, ana, carla, canal, upload, conversa } = await withChat();
    const id = (await upload(ana.agent, canal, png(), "a.png")).body.message.id;
    expect((await carla.agent.get(`/api/files/${id}`)).status).toBe(404);
    expect((await upload(carla.agent, canal, png(), "a.png")).status).toBe(404);
    expect((await request(app).get(`/api/files/${id}`)).status).toBe(401);
    expect((await request(app).post(`${canal}/attachments`).send(png())).status).toBe(401);
    expect((await ana.agent.get("/api/files/9999")).status).toBe(404);
    expect((await ana.agent.get("/api/files/abc")).status).toBe(404);
    const dmArquivo = (await upload(ana.agent, conversa, pdf(), "segredo.pdf")).body.message.id;
    expect((await carla.agent.get(`/api/files/${dmArquivo}`)).status).toBe(404);
  });

  it("em conversa direta os dois recebem, e apagar a mensagem apaga o arquivo", async () => {
    const { ana, beto, port, conversa, upload } = await withChat();
    const ws = await connect(port, { Cookie: beto.cookie });
    const r = await upload(ana.agent, conversa, png(), "a.png");
    expect(r.body.message.dmId).toBeTruthy();
    expect((await ws.next()).type).toBe("message.created");
    expect((await beto.agent.get(`/api/files/${r.body.message.id}`)).status).toBe(200);
    expect((await ana.agent.delete(`${conversa}/messages/${r.body.message.id}`)).status).toBe(204);
    await pause(50);
    expect((await beto.agent.get(`/api/files/${r.body.message.id}`)).status).toBe(404);
  });

  it("a legenda de um anexo pode ser editada, mas o anexo continua", async () => {
    const { ana, canal, upload } = await withChat();
    const m = (await upload(ana.agent, canal, png(), "a.png", { caption: "antes" })).body.message;
    const e = await ana.agent.patch(`${canal}/messages/${m.id}`).send({ content: "depois" });
    expect(e.status).toBe(200);
    expect(e.body.message).toMatchObject({ content: "depois", attachment: { name: "a.png" } });
  });
});

describe("responder", () => {
  it("a mensagem traz um trecho da original; áudio e anexo ganham etiqueta; apagar a original vira 'apagada'", async () => {
    const { ana, beto, canal, say, upload } = await withChat();
    const original = await say(ana.agent, canal, "x".repeat(150));
    const r1 = await say(beto.agent, canal, "concordo", { replyTo: original.id });
    expect(r1.replyTo).toMatchObject({ id: original.id, deleted: false, author: { username: "ana" } });
    expect(r1.replyTo.snippet).toBe(`${"x".repeat(117)}...`);

    const comArquivo = (await upload(ana.agent, canal, pdf(), "plano.pdf")).body.message;
    const r2 = await say(beto.agent, canal, "obrigado", { replyTo: comArquivo.id });
    expect(r2.replyTo.snippet).toBe("📎 plano.pdf");

    expect((await ana.agent.delete(`${canal}/messages/${original.id}`)).status).toBe(204);
    const historico = (await beto.agent.get(`${canal}/messages`)).body.messages;
    expect(historico.find((m: any) => m.id === r1.id).replyTo).toEqual({ id: original.id, deleted: true, author: null, snippet: "" });
  });

  it("só dá para responder a mensagens da mesma conversa, e a resposta por anexo também", async () => {
    const { ana, beto, canal, conversa, say, upload } = await withChat();
    const doCanal = await say(ana.agent, canal, "no canal");
    const daConversa = await say(ana.agent, conversa, "na conversa");
    expect((await beto.agent.post(`${conversa}/messages`).send({ content: "x", replyTo: doCanal.id })).status).toBe(400);
    expect((await beto.agent.post(`${canal}/messages`).send({ content: "x", replyTo: daConversa.id })).status).toBe(400);
    expect((await beto.agent.post(`${canal}/messages`).send({ content: "x", replyTo: "abc" })).status).toBe(400);
    const r = await upload(beto.agent, canal, png(), "a.png", { replyTo: String(doCanal.id) });
    expect(r.body.message.replyTo).toMatchObject({ id: doCanal.id, snippet: "no canal" });
  });
});

describe("reações", () => {
  it("dar e tirar a reação, contar quem reagiu, e avisar todos ao vivo", async () => {
    const { ana, beto, port, canal, say, channelId } = await withChat();
    const m = await say(ana.agent, canal, "festa hoje?");
    const ws = await connect(port, { Cookie: ana.cookie });
    const url = `${canal}/messages/${m.id}/reactions`;

    expect((await beto.agent.post(url).send({ emoji: "👍" })).body.reactions).toEqual([{ emoji: "👍", count: 1, users: [beto.id] }]);
    expect(await ws.next()).toEqual({ type: "message.reactions", messageId: m.id, channelId, serverId: expect.any(Number), reactions: [{ emoji: "👍", count: 1, users: [beto.id] }] });
    const duas = (await ana.agent.post(url).send({ emoji: "👍" })).body.reactions;
    expect(duas).toEqual([{ emoji: "👍", count: 2, users: [beto.id, ana.id] }]);
    await ana.agent.post(url).send({ emoji: "🎉" });

    const historico = (await ana.agent.get(`${canal}/messages`)).body.messages[0];
    expect(historico.reactions.map((r: any) => [r.emoji, r.count])).toEqual([["👍", 2], ["🎉", 1]]);

    // clicar de novo tira a sua reação; quando ninguém sobra, o emoji some
    expect((await ana.agent.post(url).send({ emoji: "👍" })).body.reactions.find((r: any) => r.emoji === "👍").count).toBe(1);
    await beto.agent.post(url).send({ emoji: "👍" });
    expect((await beto.agent.get(`${canal}/messages`)).body.messages[0].reactions.map((r: any) => r.emoji)).toEqual(["🎉"]);
  });

  it("aceita emojis compostos (família, bandeira, tom de pele, número em quadrinho) e recusa texto e HTML", async () => {
    const { ana, canal, say } = await withChat();
    const m = await say(ana.agent, canal, "oi");
    const url = `${canal}/messages/${m.id}/reactions`;
    for (const emoji of ["👨‍👩‍👧", "🇧🇷", "👍🏽", "1️⃣", "❤️"]) expect((await ana.agent.post(url).send({ emoji })).status).toBe(200);
    for (const emoji of ["a", "oi", "<b>", "👍👍", "", 5, null, undefined, "x".repeat(40)]) {
      expect((await ana.agent.post(url).send({ emoji })).status).toBe(400);
    }
  });

  it("no máximo 20 emojis diferentes por mensagem; reagir com um que já existe continua valendo", async () => {
    const { ana, beto, canal, say } = await withChat();
    const m = await say(ana.agent, canal, "oi");
    const url = `${canal}/messages/${m.id}/reactions`;
    const vinte = ["😀", "😁", "😂", "🤣", "😃", "😄", "😅", "😆", "😉", "😊", "😋", "😎", "😍", "😘", "🥰", "😗", "😙", "😚", "🙂", "🤗"];
    for (const emoji of vinte) expect((await ana.agent.post(url).send({ emoji })).status).toBe(200);
    expect((await ana.agent.post(url).send({ emoji: "🤩" })).status).toBe(400);
    expect((await beto.agent.post(url).send({ emoji: "😀" })).status).toBe(200);
  });

  it("de fora 404; mensagem de outra conversa 404", async () => {
    const { ana, carla, canal, conversa, say } = await withChat();
    const m = await say(ana.agent, canal, "oi");
    const d = await say(ana.agent, conversa, "dm");
    expect((await carla.agent.post(`${canal}/messages/${m.id}/reactions`).send({ emoji: "👍" })).status).toBe(404);
    expect((await ana.agent.post(`${canal}/messages/${d.id}/reactions`).send({ emoji: "👍" })).status).toBe(404);
  });
});

describe("fixar mensagens", () => {
  it("em canal só quem modera fixa; a lista de fixadas e o aviso ao vivo", async () => {
    const { ana, beto, port, canal, say } = await withChat();
    const m = await say(beto.agent, canal, "regras do servidor");
    expect((await beto.agent.put(`${canal}/messages/${m.id}/pin`)).status).toBe(403); // membro comum
    const ws = await connect(port, { Cookie: beto.cookie });
    const r = await ana.agent.put(`${canal}/messages/${m.id}/pin`);
    expect(r.body.message.pinned).toBe(true);
    expect(await ws.next()).toMatchObject({ type: "message.updated", message: { id: m.id, pinned: true } });

    expect((await beto.agent.get(`${canal}/pins`)).body.messages.map((x: any) => x.content)).toEqual(["regras do servidor"]);
    expect((await beto.agent.delete(`${canal}/messages/${m.id}/pin`)).status).toBe(403);
    expect((await ana.agent.delete(`${canal}/messages/${m.id}/pin`)).body.message.pinned).toBe(false);
    expect((await beto.agent.get(`${canal}/pins`)).body.messages).toEqual([]);
  });

  it("em conversa direta os dois fixam", async () => {
    const { ana, beto, conversa, say } = await withChat();
    const m = await say(ana.agent, conversa, "nosso encontro: sábado");
    expect((await beto.agent.put(`${conversa}/messages/${m.id}/pin`)).status).toBe(200);
    expect((await ana.agent.get(`${conversa}/pins`)).body.messages).toHaveLength(1);
  });

  it("no máximo 50 fixadas por lugar; mensagem de outro lugar ou inexistente 404", async () => {
    const { ana, canal, conversa, say } = await withChat();
    const ids: number[] = [];
    for (let i = 0; i < 51; i++) ids.push((await say(ana.agent, canal, `m${i}`)).id);
    for (let i = 0; i < 50; i++) expect((await ana.agent.put(`${canal}/messages/${ids[i]}/pin`)).status).toBe(200);
    const cheio = await ana.agent.put(`${canal}/messages/${ids[50]}/pin`);
    expect(cheio.status).toBe(400);
    expect(cheio.body.error).toContain("50");
    const outra = await say(ana.agent, conversa, "dm");
    expect((await ana.agent.put(`${canal}/messages/${outra.id}/pin`)).status).toBe(404);
    expect((await ana.agent.put(`${canal}/messages/9999/pin`)).status).toBe(404);
  });

  it("de fora não vê as fixadas (404)", async () => {
    const { carla, canal } = await withChat();
    expect((await carla.agent.get(`${canal}/pins`)).status).toBe(404);
  });
});

describe("busca", () => {
  it("acha pelo texto sem diferenciar maiúsculas, do mais novo ao mais antigo, e também pelo nome do arquivo", async () => {
    const { ana, beto, canal, say, upload } = await withChat();
    await say(ana.agent, canal, "Vamos jogar HOJE à noite");
    await say(beto.agent, canal, "ninguém falou nada");
    await say(beto.agent, canal, "hoje eu não posso");
    await upload(ana.agent, canal, pdf(), "ata-de-hoje.pdf");
    const r = (await beto.agent.get(`${canal}/search`).query({ q: "hoje" })).body.messages;
    expect(r.map((m: any) => m.content || m.attachment.name)).toEqual(["ata-de-hoje.pdf", "hoje eu não posso", "Vamos jogar HOJE à noite"]);
  });

  it("% e _ valem como texto, não como curinga; busca curta ou longa demais é recusada", async () => {
    const { ana, canal, say } = await withChat();
    await say(ana.agent, canal, "desconto de 50% hoje");
    await say(ana.agent, canal, "nome_do_arquivo");
    await say(ana.agent, canal, "qualquer coisa");
    expect((await ana.agent.get(`${canal}/search`).query({ q: "50%" })).body.messages).toHaveLength(1);
    expect((await ana.agent.get(`${canal}/search`).query({ q: "c_isa" })).body.messages).toHaveLength(0); // _ não é "qualquer letra" ("coisa" não casa)
    expect((await ana.agent.get(`${canal}/search`).query({ q: "e_d" })).body.messages).toHaveLength(1);
    expect((await ana.agent.get(`${canal}/search`).query({ q: "a" })).status).toBe(400);
    expect((await ana.agent.get(`${canal}/search`).query({ q: "x".repeat(101) })).status).toBe(400);
    expect((await ana.agent.get(`${canal}/search`)).status).toBe(400);
  });

  it("só olha a conversa pedida e só para quem pode ler", async () => {
    const { ana, carla, canal, conversa, say } = await withChat();
    await say(ana.agent, canal, "segredo do canal");
    await say(ana.agent, conversa, "segredo da conversa");
    expect((await ana.agent.get(`${conversa}/search`).query({ q: "segredo" })).body.messages.map((m: any) => m.content)).toEqual(["segredo da conversa"]);
    expect((await carla.agent.get(`${canal}/search`).query({ q: "segredo" })).status).toBe(404);
    expect((await carla.agent.get(`${conversa}/search`).query({ q: "segredo" })).status).toBe(404);
  });
});

describe("avisos de 'digitando'", () => {
  it("os outros membros recebem; quem digita não; no máximo um aviso por segundo e meio", async () => {
    const { ana, beto, port, channelId } = await withChat();
    const wsAna = await connect(port, { Cookie: ana.cookie });
    const wsBeto = await connect(port, { Cookie: beto.cookie });
    wsBeto.ws.send(JSON.stringify({ type: "typing", channelId }));
    expect(await wsAna.next()).toEqual({ type: "typing", userId: beto.id, username: "beto", channelId });
    wsBeto.ws.send(JSON.stringify({ type: "typing", channelId })); // repetido na hora: ignorado
    await pause(100);
    expect(wsAna.received).toEqual([]);
    expect(wsBeto.received).toEqual([]);
  });

  it("em conversa direta só a outra pessoa recebe; quem não pertence ao lugar é ignorado", async () => {
    const { ana, beto, carla, port, dm, channelId } = await withChat();
    const wsAna = await connect(port, { Cookie: ana.cookie });
    const wsBeto = await connect(port, { Cookie: beto.cookie });
    const wsCarla = await connect(port, { Cookie: carla.cookie });
    wsAna.ws.send(JSON.stringify({ type: "typing", dmId: dm }));
    expect(await wsBeto.next()).toEqual({ type: "typing", userId: ana.id, username: "ana", dmId: dm });
    wsCarla.ws.send(JSON.stringify({ type: "typing", dmId: dm }));
    wsCarla.ws.send(JSON.stringify({ type: "typing", channelId }));
    wsCarla.ws.send(JSON.stringify({ type: "typing", channelId: "x" }));
    await pause(150);
    expect(wsAna.received).toEqual([]);
    expect(wsBeto.received).toEqual([]);
    expect(wsCarla.received).toEqual([]);
  });
});
