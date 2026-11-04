import { useState } from "react";
import { useAuth } from "./AuthContext";
import { useMailEnabled } from "./EmailAuth";
import { canNotify, enableNotifications, markNotifyAsked, notifyAsked, type EnableResult } from "./NotifyOnboarding";

const POLICY_KEY = "concord.policy-seen";
/** Sobe a cada mudança relevante na política de privacidade: quem já tem conta vê o aviso de novo. */
export const POLICY_VERSION = "2026-11-04";

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
    /* sem armazenamento: o aviso volta na próxima visita */
  }
}

/**
 * Avisos no alto da tela para quem já tem conta: a política mudou (LGPD pede avisar) e,
 * com envio de e-mail ligado, "adicione um e-mail" para poder recuperar a conta.
 */
export function AccountNotices({ onOpenAccount }: { onOpenAccount: () => void }) {
  const { user, onboarding } = useAuth();
  const mailEnabled = useMailEnabled();
  const [policySeen, setPolicySeen] = useState(() => read(POLICY_KEY) === POLICY_VERSION);
  const [emailDismissed, setEmailDismissed] = useState(() => read("concord.email-nudge") === "1");
  const [notifyDismissed, setNotifyDismissed] = useState(false);
  const [notifyBusy, setNotifyBusy] = useState(false);
  const [notifyResult, setNotifyResult] = useState<EnableResult | null>(null);
  if (!user) return null;

  // este aparelho ainda não respondeu sobre notificações (a conta pode ter sido criada em outro): pergunta uma vez
  const askNotify = !notifyDismissed && !notifyResult && canNotify() && !onboarding && !notifyAsked(user.id) && !(typeof Notification !== "undefined" && Notification.permission === "denied");

  const needsEmail = mailEnabled === true && !user.emailVerified && !user.emailPending && !emailDismissed;
  if (policySeen && !needsEmail && !askNotify && !notifyResult) return null;

  return (
    <section className="account-notices" aria-label="Avisos da conta">
      {!policySeen && (
        <p className="account-notice">
          <span>
            Atualizamos a <a href="/privacidade.html" target="_blank" rel="noopener">política de privacidade</a> e os{" "}
            <a href="/termos.html" target="_blank" rel="noopener">termos</a>: agora o site pode guardar o seu e-mail (só com o seu código), e você pode excluir a conta quando quiser.
          </span>
          <button type="button" className="small secondary" onClick={() => { write(POLICY_KEY, POLICY_VERSION); setPolicySeen(true); }}>Entendi</button>
        </p>
      )}
      {askNotify && (
        <p className="account-notice">
          <span>Receba <strong>mensagens privadas, menções e ligações</strong> neste aparelho, mesmo com o app fechado.</span>
          <span className="row">
            <button
              type="button"
              className="small"
              disabled={notifyBusy}
              onClick={async () => {
                setNotifyBusy(true);
                try {
                  setNotifyResult(await enableNotifications());
                } finally {
                  markNotifyAsked(user.id);
                  setNotifyBusy(false);
                }
              }}
            >
              Ativar avisos
            </button>
            <button type="button" className="small secondary" onClick={() => { markNotifyAsked(user.id); setNotifyDismissed(true); }}>Dispensar</button>
          </span>
        </p>
      )}
      {notifyResult && (
        <p role={notifyResult.ok ? "status" : "alert"} className="account-notice">
          <span>{notifyResult.message}</span>
          <button type="button" className="small secondary" onClick={() => setNotifyResult(null)}>Ok</button>
        </p>
      )}
      {needsEmail && (
        <p className="account-notice">
          <span>Adicione um e-mail à sua conta. Sem ele, não dá para recuperar a conta se você esquecer a senha.</span>
          <span className="row">
            <button type="button" className="small" onClick={onOpenAccount}>Adicionar e-mail</button>
            <button type="button" className="small secondary" onClick={() => { write("concord.email-nudge", "1"); setEmailDismissed(true); }}>Agora não</button>
          </span>
        </p>
      )}
    </section>
  );
}
