import request from "supertest";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { fetchPreview, isPublicAddress, parsePreview, parseTarget } from "./linkPreview.js";
import { closeAll, scenario } from "./testkit.js";

afterEach(closeAll);

describe("endereços públicos", () => {
  it("recusa rede interna, loopback, link-local, CGNAT, reservados e IPv6 equivalentes", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "not-an-ip"]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });
  it("aceita endereços de internet de verdade", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.63.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });
});

describe("endereço pedido", () => {
  it("só http/https, portas comuns, sem usuário, sem nomes internos nem IP privado", () => {
    expect(parseTarget("https://exemplo.com/a?b=1")?.hostname).toBe("exemplo.com");
    expect(parseTarget("http://exemplo.com:80/")).not.toBeNull();
    for (const bad of ["ftp://x.com", "file:///etc/passwd", "javascript:alert(1)", "https://user:pw@x.com", "https://x.com:8080", "http://localhost/", "http://a.localhost/", "http://servidor.local/", "http://db.internal/", "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data", "http://10.0.0.5/", "http://0x7f000001/", "nao e url", ""]) {
      expect(parseTarget(bad), bad).toBeNull();
    }
  });
});

describe("leitura da página", () => {
  it("prefere Open Graph, decodifica entidades e limpa espaços", () => {
    const html = `<html><head><title>Título velho</title>
      <meta property="og:title" content="Vídeo &quot;legal&quot; &amp; curto">
      <meta property="og:description" content='  Uma   descrição
      em linhas '>
      <meta property="og:site_name" content="MeuSite"></head></html>`;
    expect(parsePreview(html, "https://x.com/v")).toEqual({ url: "https://x.com/v", title: 'Vídeo "legal" & curto', description: "Uma descrição em linhas", site: "MeuSite" });
  });
  it("sem Open Graph usa <title> e meta description; o site vem do endereço", () => {
    const p = parsePreview("<title> Olá </title><meta name='description' content='texto'>", "https://www.exemplo.com/a");
    expect(p).toEqual({ url: "https://www.exemplo.com/a", title: "Olá", description: "texto", site: "exemplo.com" });
  });
  it("página sem nada útil não tem prévia; texto muito longo é cortado", () => {
    expect(parsePreview("<html><body>oi</body></html>", "https://x.com")).toBeNull();
    expect(parsePreview(`<title>${"t".repeat(500)}</title>`, "https://x.com")!.title).toHaveLength(150);
  });
});

describe("busca real protegida", () => {
  it("nunca conecta em endereço interno, nem por nome nem por IP, nem por redirecionamento", async () => {
    let hits = 0;
    const alvo = http.createServer((_q, r) => {
      hits++;
      r.setHeader("Content-Type", "text/html");
      r.end("<title>segredo interno</title>");
    });
    await new Promise<void>((ok) => alvo.listen(0, "127.0.0.1", ok));
    const porta = (alvo.address() as { port: number }).port;
    try {
      expect(await fetchPreview(`http://127.0.0.1:${porta}/`)).toBeNull();
      expect(await fetchPreview(`http://localhost:${porta}/`)).toBeNull();
      expect(hits).toBe(0);
    } finally {
      alvo.close();
    }
  });
});

describe("rota /api/link-preview", () => {
  it("exige login, recusa endereço inválido e guarda o resultado por 24 h (inclusive quando não há prévia)", async () => {
    let chamadas = 0;
    const s = await scenario({
      linkFetcher: async (url) => {
        chamadas++;
        return url.includes("sem-previa") ? null : { url, title: "Título", description: "Desc", site: "site.com" };
      },
    });
    expect((await request(s.app).get("/api/link-preview").query({ url: "https://site.com" })).status).toBe(401);
    expect((await s.ana.agent.get("/api/link-preview").query({ url: "http://127.0.0.1/" })).status).toBe(400);
    expect((await s.ana.agent.get("/api/link-preview")).status).toBe(400);
    expect((await s.ana.agent.get("/api/link-preview").query({ url: `https://x.com/${"a".repeat(2000)}` })).status).toBe(400);
    expect(chamadas).toBe(0);

    const a = await s.ana.agent.get("/api/link-preview").query({ url: "https://site.com/p" });
    expect(a.body.preview).toEqual({ url: "https://site.com/p", title: "Título", description: "Desc", site: "site.com" });
    expect((await s.beto.agent.get("/api/link-preview").query({ url: "https://site.com/p" })).body.preview.title).toBe("Título");
    expect(chamadas).toBe(1); // a segunda veio do cache

    expect((await s.ana.agent.get("/api/link-preview").query({ url: "https://sem-previa.com" })).body.preview).toBeNull();
    await s.ana.agent.get("/api/link-preview").query({ url: "https://sem-previa.com" });
    expect(chamadas).toBe(2);
  });
});
