import { useState, type FormEvent } from "react";
import { useAuth } from "./AuthContext";
import { ForgotPassword, useMailEnabled } from "./EmailAuth";
import { OAuthButtons } from "./oauthClient";

type Mode = "login" | "register" | "forgot";

export function AuthForm({ inviteCode = null, notice = null }: { inviteCode?: string | null; notice?: string | null }) {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const mailEnabled = useMailEnabled();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isLogin = mode === "login";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (isLogin) await login(username, password);
      else await register(username, password, inviteCode, mailEnabled ? email : undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Algo deu errado");
    } finally {
      setBusy(false);
    }
  }

  if (mode === "forgot") return <ForgotPassword onBack={() => setMode("login")} />;

  return (
    <form className="card" onSubmit={onSubmit}>
      <img className="brand-logo" src="/logo.svg" alt="" width={84} height={84} />
      <h1>Concord Hub</h1>
      <p className="muted">{isLogin ? "Que bom te ver de novo!" : "Crie sua conta"}</p>

      <label>
        Usuário
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
        />
      </label>
      {!isLogin && mailEnabled && (
        <label>
          E-mail
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </label>
      )}
      <label>
        Senha
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={isLogin ? "current-password" : "new-password"}
          required
        />
      </label>

      {notice && <p role="alert" className="error">{notice}</p>}
      {error && <p role="alert" className="error">{error}</p>}

      {!isLogin && (
        <p className="legal-note">
          Ao criar a conta, você concorda com os <a href="/termos.html" target="_blank" rel="noopener">Termos de uso</a> e com a{" "}
          <a href="/privacidade.html" target="_blank" rel="noopener">Política de privacidade</a>.
        </p>
      )}
      <button type="submit" disabled={busy}>{isLogin ? "Entrar" : "Criar conta"}</button>
      {isLogin && mailEnabled && (
        <button type="button" className="link" onClick={() => { setMode("forgot"); setError(null); }}>Esqueci a senha</button>
      )}
      <button type="button" className="link" onClick={() => { setMode(isLogin ? "register" : "login"); setError(null); }}>
        {isLogin ? "Precisa de uma conta? Registre-se" : "Já tem conta? Entrar"}
      </button>
      <OAuthButtons inviteCode={inviteCode} />
      <p className="legal-note">
        <a href="/termos.html" target="_blank" rel="noopener">Termos de uso</a> · <a href="/privacidade.html" target="_blank" rel="noopener">Privacidade</a> · <a href="/licencas.html" target="_blank" rel="noopener">Licenças de terceiros</a>
      </p>
    </form>
  );
}
