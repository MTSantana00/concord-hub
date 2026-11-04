import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
import { useAuth, type User } from "./AuthContext";

/** O servidor tem envio de e-mail ligado? (null enquanto não se sabe; sem resposta vale "não"). */
export function useMailEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ enabled: boolean }>("/api/auth/mail")
      .then((d) => alive && setEnabled(!!d.enabled))
      .catch(() => alive && setEnabled(false));
    return () => {
      alive = false;
    };
  }, []);
  return enabled;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : "Algo deu errado");

/** "Esqueci a senha": pede o e-mail, recebe um código e escolhe a senha nova (e já entra). */
export function ForgotPassword({ onBack }: { onBack: () => void }) {
  const { reload } = useAuth();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function sendCode(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api<void>("/api/auth/forgot", "POST", { email });
      setStep("code");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function reset(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== again) {
      setError("As duas senhas não são iguais");
      return;
    }
    setBusy(true);
    try {
      await api<void>("/api/auth/reset", "POST", { email, code, password });
      await reload(); // o servidor já deixou a pessoa logada com a senha nova
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (step === "email") {
    return (
      <form className="card" onSubmit={sendCode}>
        <h1>Recuperar a conta</h1>
        <p className="muted">Digite o e-mail da sua conta. Mandamos um código para ele.</p>
        <label>
          E-mail
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </label>
        {error && <p role="alert" className="error">{error}</p>}
        <button type="submit" disabled={busy}>Enviar código</button>
        <button type="button" className="link" onClick={onBack}>Voltar</button>
      </form>
    );
  }
  return (
    <form className="card" onSubmit={reset}>
      <h1>Escolha uma senha nova</h1>
      <p className="muted">Se existe uma conta com <strong>{email}</strong>, o código chegou lá (confira o spam). Ele vale por 15 minutos. O e-mail também diz qual é o seu usuário.</p>
      <label>
        Código de 6 dígitos
        <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={7} required />
      </label>
      <label>
        Nova senha
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} maxLength={72} required />
      </label>
      <label>
        Repita a nova senha
        <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required />
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <button type="submit" disabled={busy}>Trocar a senha e entrar</button>
      <button type="button" className="link" disabled={busy} onClick={() => void sendCode()}>Não chegou? Enviar de novo</button>
      <button type="button" className="link" onClick={onBack}>Voltar</button>
    </form>
  );
}

/**
 * Confirmar um e-mail: pede o endereço (se ainda não há um), manda o código e confere.
 * Usado na tela de confirmação do cadastro e em "Minha conta".
 */
export function ConfirmEmail({ initialEmail = "", alreadySent = false, onDone }: { initialEmail?: string; alreadySent?: boolean; onDone?: () => void }) {
  const { reload } = useAuth();
  const [email, setEmail] = useState(initialEmail);
  const [sent, setSent] = useState(alreadySent);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await api<void>("/api/auth/email/send-code", "POST", { email });
      setSent(true);
      setNotice(`Código enviado para ${email}.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/auth/email/verify", "POST", { code });
      await reload();
      onDone?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-form">
      <form className="stack-form" onSubmit={send}>
        <label>
          E-mail
          <input type="email" value={email} onChange={(e) => { setEmail(e.target.value); setSent(false); }} autoComplete="email" required />
        </label>
        {!sent && <button type="submit" disabled={busy}>Enviar código</button>}
      </form>
      {sent && (
        <form className="stack-form" onSubmit={verify}>
          <label>
            Código de 6 dígitos
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={7} required />
          </label>
          <button type="submit" disabled={busy}>Confirmar e-mail</button>
          <button type="button" className="link" disabled={busy} onClick={() => void send()}>Não chegou? Enviar de novo</button>
        </form>
      )}
      {notice && <p role="status" className="ok">{notice}</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </div>
  );
}

/** Tela cheia para quem acabou de criar a conta: o app só abre depois de confirmar o e-mail. */
export function VerifyEmailGate({ user }: { user: User }) {
  const { logout } = useAuth();
  return (
    <main className="center">
      <div className="stack">
        <div className="card">
          <h1>Confirme o seu e-mail</h1>
          <p className="muted">Mandamos um código de 6 dígitos para o e-mail do cadastro (confira o spam). Ele serve para você recuperar a conta se esquecer a senha.</p>
          <ConfirmEmail initialEmail={user.pendingEmail ?? ""} alreadySent={!!user.pendingEmail} />
        </div>
        <button type="button" className="link" onClick={() => void logout()}>Sair ({user.username})</button>
      </div>
    </main>
  );
}

/** "Minha conta": e-mail confirmado da conta, ou como adicionar um. */
export function EmailSection() {
  const { user } = useAuth();
  const enabled = useMailEnabled();
  const [changing, setChanging] = useState(false);
  if (!enabled) return null;
  return (
    <section aria-label="E-mail">
      <h3>E-mail</h3>
      {user?.emailVerified && !changing ? (
        <>
          <p className="muted">E-mail confirmado: <strong>{user.email}</strong>. É para ele que vai o código se você esquecer a senha.</p>
          <button type="button" className="small secondary" onClick={() => setChanging(true)}>Trocar o e-mail</button>
        </>
      ) : (
        <>
          <p className="muted">{user?.emailVerified ? "Digite o novo e-mail e confirme com o código." : "Sua conta ainda não tem e-mail confirmado. Sem ele, não dá para recuperar a conta se você esquecer a senha."}</p>
          <ConfirmEmail onDone={() => setChanging(false)} />
        </>
      )}
    </section>
  );
}
