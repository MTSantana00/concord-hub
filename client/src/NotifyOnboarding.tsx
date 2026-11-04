import { useState } from "react";
import { useAuth, type User } from "./AuthContext";
import { updateNotifyPrefs } from "./notifyPrefs";
import { enablePush, pushSupported } from "./push";

const askedKey = (userId: number) => `concord.notify-asked.${userId}`;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // sem armazenamento: a pergunta volta na próxima visita
  }
}

/** Este aparelho já respondeu à pergunta de notificações nesta conta? */
export const notifyAsked = (userId: number) => read(askedKey(userId)) === "1";
export const markNotifyAsked = (userId: number) => write(askedKey(userId), "1");

/** O navegador deste aparelho consegue mostrar notificações de algum jeito? */
export const canNotify = () => (typeof Notification !== "undefined") || pushSupported();

export interface EnableResult {
  ok: boolean;
  message: string;
}

/**
 * Liga os avisos NESTE aparelho: pede a permissão, liga a notificação do navegador (janela em segundo plano) e,
 * se o aparelho e o servidor deixarem, a notificação com o app fechado (mensagens privadas, menções e ligações).
 */
export async function enableNotifications(): Promise<EnableResult> {
  if (!canNotify()) {
    return {
      ok: false,
      message: "Este navegador não mostra notificações. No iPhone: toque em Compartilhar, depois em Adicionar à Tela de Início, abra o Concord pelo ícone e ligue em Minha conta → Avisos.",
    };
  }
  if (typeof Notification !== "undefined") {
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission !== "granted") {
      return { ok: false, message: "A permissão foi negada. Se mudar de ideia, libere as notificações do site nas configurações do navegador e ligue em Minha conta → Avisos." };
    }
    updateNotifyPrefs({ desktop: true });
  }
  try {
    await enablePush();
    return { ok: true, message: "Pronto! Neste aparelho você vai receber mensagens privadas, menções e ligações, mesmo com o app fechado." };
  } catch (err) {
    const why = err instanceof Error ? err.message : "";
    return {
      ok: typeof Notification !== "undefined",
      message: `Avisos ligados com o app aberto em segundo plano. Com o app fechado não deu: ${why || "este aparelho não permite."}`,
    };
  }
}

/** A pergunta em si: usada na tela cheia depois de criar a conta e no aviso dos outros aparelhos. */
export function NotifyChoice({ userId, onDone, title = "Quer receber avisos?" }: { userId: number; onDone: () => void; title?: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EnableResult | null>(null);

  async function allow() {
    setBusy(true);
    try {
      setResult(await enableNotifications());
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "Não foi possível ligar as notificações." });
    } finally {
      markNotifyAsked(userId);
      setBusy(false);
    }
  }
  function skip() {
    markNotifyAsked(userId);
    onDone();
  }

  return (
    <div className="card" role="group" aria-label="Notificações">
      <h1>{title}</h1>
      {!result ? (
        <>
          <p className="muted">
            Deixe o Concord Hub te avisar de <strong>mensagens privadas</strong>, <strong>menções</strong> e <strong>ligações</strong>, mesmo com o app fechado.
          </p>
          <p className="muted">A permissão vale só para este aparelho. Quando você entrar no outro (PC ou celular), a pergunta aparece de novo lá. Você muda isso quando quiser em Minha conta → Avisos.</p>
          <button type="button" disabled={busy} onClick={() => void allow()}>Permitir notificações</button>
          <button type="button" className="link" disabled={busy} onClick={skip}>Agora não</button>
        </>
      ) : (
        <>
          <p role={result.ok ? "status" : "alert"} className={result.ok ? "ok" : "error"}>{result.message}</p>
          <button type="button" onClick={onDone}>Continuar</button>
        </>
      )}
    </div>
  );
}

/** Tela cheia logo depois de criar a conta (e de confirmar o e-mail, quando pede). */
export function NotifyOnboarding({ user }: { user: User }) {
  const { finishOnboarding } = useAuth();
  return (
    <main className="center">
      <div className="stack">
        <NotifyChoice userId={user.id} title="Quer receber avisos?" onDone={finishOnboarding} />
      </div>
    </main>
  );
}

