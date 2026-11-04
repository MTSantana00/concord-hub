// Gera client/public/licencas.html: a lista de bibliotecas de terceiros que vão para produção, com a licença e o
// texto de cada uma (MIT, BSD e Apache pedem que o aviso de autoria acompanhe o que é distribuído).
// Rode na raiz:  npm run licencas   (depois de instalar as dependências; refaça quando mudar uma dependência)
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "client/public/licencas.html");

function findPackage(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const p = join(dir, "node_modules", name, "package.json");
    if (existsSync(p)) return realpathSync(p);
    if (dirname(dir) === dir) break;
  }
  const p = join(root, "node_modules", name, "package.json");
  return existsSync(p) ? realpathSync(p) : null;
}

/** Só o que vai para produção: dependencies (e opcionais) do cliente e do servidor, e as delas, sem devDependencies. */
const packages = new Map();
function visit(name, from) {
  const file = findPackage(name, from);
  if (!file || packages.has(file)) return;
  const json = JSON.parse(readFileSync(file, "utf8"));
  packages.set(file, json);
  for (const dep of Object.keys({ ...json.dependencies, ...json.optionalDependencies })) visit(dep, dirname(file));
}
for (const workspace of ["client", "server"]) {
  const json = JSON.parse(readFileSync(join(root, workspace, "package.json"), "utf8"));
  for (const dep of Object.keys(json.dependencies ?? {})) visit(dep, join(root, workspace));
}

const MIT_TEXT = (author) => `The MIT License (MIT) — texto padrão, autoria declarada no package.json do pacote

Copyright (c) ${author}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

const licenseId =(j) => (typeof j.license === "string" ? j.license : j.license?.type ?? j.licenses?.map((l) => l.type).join(" OR ") ?? "desconhecida");
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const entries = [];
const texts = new Map(); // hash -> { text, users: [] }
const semTexto = [];
for (const [file, json] of packages) {
  const dir = dirname(file);
  const licenseFiles = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f)).sort();
  let text = licenseFiles.map((f) => readFileSync(join(dir, f), "utf8").trim()).join("\n\n---\n\n");
  // pacote MIT sem arquivo de licença: o texto padrão da MIT, com a autoria que o próprio pacote declara
  if (!text && licenseId(json) === "MIT") {
    const author = typeof json.author === "string" ? json.author.replace(/\s*[<(].*$/, "") : json.author?.name;
    if (author) text = MIT_TEXT(author);
  }
  const label = `${json.name}@${json.version}`;
  entries.push({ name: json.name, version: json.version, license: licenseId(json), home: json.homepage ?? json.repository?.url ?? "" });
  if (!text) {
    semTexto.push(label);
    continue;
  }
  const hash = createHash("sha256").update(text).digest("hex");
  if (!texts.has(hash)) texts.set(hash, { text, users: [] });
  texts.get(hash).users.push(label);
}
entries.sort((a, b) => a.name.localeCompare(b.name));

const byLicense = new Map();
for (const e of entries) byLicense.set(e.license, (byLicense.get(e.license) ?? 0) + 1);
const summary = [...byLicense].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${esc(l)}: ${n}`).join(" · ");

const rows = entries.map((e) => `<tr><td>${esc(e.name)}</td><td>${esc(e.version)}</td><td>${esc(e.license)}</td></tr>`).join("\n");
const blocks = [...texts.values()]
  .sort((a, b) => b.users.length - a.users.length)
  .map((t) => `<details><summary>${esc(t.users[0])}${t.users.length > 1 ? ` e mais ${t.users.length - 1}` : ""}</summary><p class="muted">Vale para: ${esc(t.users.join(", "))}</p><pre>${esc(t.text)}</pre></details>`)
  .join("\n");
const faltando = semTexto.length
  ? `<p class="muted">Estes pacotes declaram a licença, mas não trazem o arquivo de texto: ${esc(semTexto.join(", "))}.</p>`
  : "";

const date = new Date().toLocaleDateString("pt-BR", { day: "numeric", month: "long", year: "numeric" });
const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Licenças de terceiros — Concord Hub</title>
<style>
  :root { color-scheme: dark light; --bg: #1e1f22; --text: #e3e5e8; --muted: #a3a6aa; --accent: #ff7a80; --line: #3f4147; }
  @media (prefers-color-scheme: light) { :root { --bg: #fff; --text: #1e1f22; --muted: #5c5f66; --accent: #b3121b; --line: #d4d7dc; } }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.6 system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.15rem; margin-top: 1.6em; }
  a { color: var(--accent); } .muted { color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; } th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); }
  details { border: 1px solid var(--line); border-radius: 8px; margin: 8px 0; padding: 6px 12px; } summary { cursor: pointer; font-weight: 600; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.8rem; line-height: 1.4; }
</style>
</head>
<body>
<main>
  <h1>Licenças de terceiros — Concord Hub</h1>
  <p class="muted">Gerada em ${date} a partir das bibliotecas que o site usa de verdade (${entries.length} pacotes).</p>
  <p>O Concord Hub usa software livre feito por outras pessoas. Agradecemos a todas elas. Abaixo estão as bibliotecas, as licenças e os textos que elas pedem que acompanhem o site. Resumo: ${summary}.</p>

  <h2>Criação própria</h2>
  <p>O logotipo, os ícones do aplicativo e os ícones de voz foram criados pelo autor do Concord Hub. Os sons de aviso são gerados por código. O site não carrega fontes de terceiros: usa as fontes do seu aparelho. Os emojis são os do seu sistema.</p>

  <h2>Servidor de voz</h2>
  <p>A voz, a câmera e a tela passam pelo <a href="https://livekit.io">LiveKit</a> (licença Apache 2.0), cujo código aberto o Concord Hub usa sem alterações.</p>

  <h2>Bibliotecas</h2>
  <table>
    <thead><tr><th>Pacote</th><th>Versão</th><th>Licença</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>

  <h2>Textos das licenças</h2>
  ${faltando}
${blocks}

  <p><a href="/">Voltar ao Concord Hub</a> · <a href="/termos.html">Termos de uso</a> · <a href="/privacidade.html">Privacidade</a></p>
</main>
</body>
</html>
`;
writeFileSync(OUT, html);
console.log(`licencas.html: ${entries.length} pacotes, ${texts.size} textos de licença distintos${semTexto.length ? `, ${semTexto.length} sem arquivo de texto` : ""}`);
