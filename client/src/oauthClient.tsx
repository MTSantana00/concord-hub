import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
import { useAuth } from "./AuthContext";

export type ProviderName = "google" | "github";
export const PROVIDER_LABEL: Record<ProviderName, string> = { google: "Google", github: "GitHub" };

/** Mensagens para o que o servidor devolve na barra de endereço (?oauth_erro=...). */
const ERROR_TEXT: Record<string, string> = {
  indisponivel: "Esse jeito de entrar não está disponível agora.",
  "sem-login": "Entre primeiro para vincular uma conta.",
  expirou: "O login expirou. Tente de novo.",
  cancelado: "Você cancelou o login.",
  falhou: "Não foi possível entrar com essa conta. Tente de novo.",
  "sem-convite": "Essa conta ainda não tem convite. Peça um link de convite a um amigo e abra o link antes de entrar.",
  "ja-vinculada": "Essa conta já está ligada a outra pessoa no Concord.",
  "ja-tem": "Sua conta já tem uma conta desse tipo vinculada.",
};

export interface OAuthFlash {
  kind: "erro" | "ok" | "apelido";
  text: string;
}

/** Apaga da barra de endereço o que o login externo deixou (para um F5 não repetir a mensagem). */
export function clearOAuthParams() {
  const p = new URLSearchParams(window.location.search);
  if (!p.has("oauth_erro") && !p.has("oauth_ok") && !p.has("oauth")) return;
  for (const k of ["oauth_erro", "oauth_ok", "oauth"]) p.delete(k);
  const rest = p.toString();
  window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : ""));
}

/** Lê o que o login externo deixou na barra de endereço: erro, sucesso ou "escolha o apelido" (não altera nada; seguro de chamar mais de uma vez). */
export function readOAuthFlash(): OAuthFlash | null {
  const p = new URLSearchParams(window.location.search);
  const erro = p.get("oauth_erro");
  const ok = p.get("oauth_ok");
  const etapa = p.get("oauth");
  if (!erro && !ok && !etapa) return null;
  if (erro) return { kind: "erro", text: ERROR_TEXT[erro] ?? "Não foi possível entrar com essa conta." };
  if (ok) return { kind: "ok", text: "Conta vinculada! Agora você também pode entrar com ela." };
  return { kind: "apelido", text: "" };
}

/** Quais botões de entrada o servidor oferece (vazio se não há credenciais configuradas). */
export function useProviders(): ProviderName[] {
  const [list, setList] = useState<ProviderName[]>([]);
  useEffect(() => {
    api<Record<ProviderName, boolean>>("/api/auth/oauth/providers")
      .then((d) => setList((["google", "github"] as ProviderName[]).filter((p) => d[p])))
      .catch(() => {});
  }, []);
  return list;
}

/** Botões "Entrar com Google/GitHub". Com um convite na barra de endereço, ele vai junto. */
export function OAuthButtons({ inviteCode }: { inviteCode?: string | null }) {
  const providers = useProviders();
  if (providers.length === 0) return null;
  const q = inviteCode ? `?invite=${encodeURIComponent(inviteCode)}` : "";
  return (
    <div className="oauth-buttons">
      <p className="muted oauth-or">ou</p>
      {providers.map((p) => (
        <a key={p} className={`oauth-btn ${p}`} href={`/api/auth/oauth/${p}/start${q}`}>
          Entrar com {PROVIDER_LABEL[p]}
        </a>
      ))}
    </div>
  );
}

/** Depois de voltar do Google/GitHub como pessoa nova: escolher o apelido que aparece no Concord. */
export function ChooseNickname() {
  const { reload, startOnboarding } = useAuth();
  const [info, setInfo] = useState<{ provider: ProviderName; suggestedNick: string } | null>(null);
  const [gone, setGone] = useState(false);
  const [nick, setNick] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ provider: ProviderName; suggestedNick: string }>("/api/auth/oauth/pending")
      .then((d) => {
        setInfo(d);
        setNick(d.suggestedNick);
      })
      .catch(() => setGone(true));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/auth/oauth/complete", "POST", { username: nick });
      startOnboarding(); // conta nova: logo depois pergunta das notificações
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Algo deu errado");
      setBusy(false);
    }
  }

  if (gone) {
    return (
      <div className="card">
        <img className="brand-logo" src="/logo.svg" alt="" width={84} height={84} />
        <h1>Concord Hub</h1>
        <p role="alert" className="error">O cadastro expirou. Volte e entre de novo com o Google ou o GitHub.</p>
        <a className="oauth-btn" href="/">Voltar ao início</a>
      </div>
    );
  }
  return (
    <form className="card" onSubmit={onSubmit}>
      <img className="brand-logo" src="/logo.svg" alt="" width={84} height={84} />
      <h1>Escolha seu apelido</h1>
      <p className="muted">
        {info ? `Conta do ${PROVIDER_LABEL[info.provider]} confirmada.` : "Carregando..."} É assim que seus amigos vão te ver no Concord.
      </p>
      <label>
        Apelido
        <input value={nick} onChange={(e) => setNick(e.target.value)} maxLength={20} autoComplete="nickname" required autoFocus />
      </label>
      <p className="muted">De 3 a 20 letras, números ou _ (sem espaços ou acentos).</p>
      {error && <p role="alert" className="error">{error}</p>}
      <button type="submit" disabled={busy || !info}>Entrar no Concord</button>
    </form>
  );
}

/** Minha conta → contas vinculadas: ligar o Google/GitHub a uma conta que já existe (precisa estar logada). */
export function LinkedAccounts() {
  const providers = useProviders();
  const [state, setState] = useState<{ linked: ProviderName[]; hasPassword: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    api<{ identities: { provider: ProviderName }[]; hasPassword: boolean }>("/api/auth/oauth/identities")
      .then((d) => setState({ linked: d.identities.map((i) => i.provider), hasPassword: d.hasPassword }))
      .catch(() => {});
  useEffect(() => {
    void load();
  }, []);

  async function unlink(provider: ProviderName) {
    setError(null);
    try {
      await api("/api/auth/oauth/unlink", "POST", { provider });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível desvincular");
    }
  }

  if (!state || providers.length === 0) return null;
  return (
    <section aria-label="Contas vinculadas">
      <h3>Contas vinculadas</h3>
      <p className="muted">Vincule o Google ou o GitHub para entrar sem digitar senha.</p>
      {providers.map((p) =>
        state.linked.includes(p) ? (
          <div key={p} className="row linked-row">
            <span>{PROVIDER_LABEL[p]}: vinculado ✓</span>
            <button type="button" className="small secondary" aria-label={`Desvincular ${PROVIDER_LABEL[p]}`} onClick={() => void unlink(p)}>
              Desvincular
            </button>
          </div>
        ) : (
          <div key={p} className="row linked-row">
            <a className="oauth-btn" href={`/api/auth/oauth/${p}/start?mode=link`}>
              Vincular {PROVIDER_LABEL[p]}
            </a>
          </div>
        ),
      )}
      {error && <p role="alert" className="error">{error}</p>}
    </section>
  );
}
