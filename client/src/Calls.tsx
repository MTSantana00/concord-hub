import { useCallback, useEffect, useRef, useState } from "react";
import { UserName } from "./profiles";
import { getNotifyPrefs } from "./notifyPrefs";
import { playCallSound } from "./sounds";
import { useSocket } from "./socket";

export interface ActiveCall {
  dmId: number;
  peer: { id: number; username: string };
  /** Fui eu quem chamou. */
  outgoing: boolean;
  state: "ringing" | "active";
}

const ENDED_NOTICE: Record<string, (peer: string, outgoing: boolean) => string> = {
  declined: (peer, outgoing) => (outgoing ? `${peer} recusou a chamada.` : "Você recusou a chamada."),
  missed: (peer, outgoing) => (outgoing ? `${peer} não atendeu.` : `Chamada perdida de ${peer}.`),
  cancelled: (peer, outgoing) => (outgoing ? "Chamada cancelada." : `${peer} cancelou a chamada.`),
  hangup: () => "Chamada encerrada.",
  disconnected: () => "A chamada caiu.",
};

/**
 * Chamadas na conversa direta, ao vivo: tocar, atender, recusar, cancelar, desligar.
 * O servidor decide tudo (quem pode chamar, ocupado, offline); aqui só se reflete o que ele avisa.
 */
export function useCalls(currentUserId: number | undefined, silent = false) {
  const { epoch, subscribe, send } = useSocket();
  const [call, setCall] = useState<ActiveCall | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const callRef = useRef<ActiveCall | null>(null);
  callRef.current = call;
  /** Depois de um pedido nosso, o próximo erro do servidor é sobre ele. */
  const waiting = useRef(false);

  // Ao reconectar, o servidor já encerrou a chamada (a conexão dela caiu)
  useEffect(() => {
    if (epoch > 0) {
      setCall(null);
      setNotice(null);
    }
  }, [epoch]);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === "call.ringing") {
          waiting.current = false;
          const outgoing = event.from.id === currentUserId;
          setNotice(null);
          setCall({ dmId: event.dmId, peer: outgoing ? event.to : event.from, outgoing, state: "ringing" });
        } else if (event.type === "call.accepted") {
          waiting.current = false;
          if (callRef.current?.dmId === event.dmId) playCallSound("call-connected");
          setCall((c) => (c && c.dmId === event.dmId ? { ...c, state: "active" } : c));
        } else if (event.type === "call.ended") {
          waiting.current = false;
          const c = callRef.current;
          if (c && c.dmId === event.dmId) {
            playCallSound("call-end");
            setNotice((ENDED_NOTICE[event.reason] ?? (() => "Chamada encerrada."))(c.peer.username, c.outgoing));
            setCall(null);
          }
        } else if (event.type === "error" && waiting.current) {
          waiting.current = false;
          setNotice(event.error);
        }
      }),
    [subscribe, currentUserId],
  );

  // Toca enquanto a chamada está tocando: toque para quem recebe (a menos que esteja em "Não perturbe"), sinal de chamando para quem liga
  const ringing = call?.state === "ringing" ? (call.outgoing ? "ring-out" : "ring-in") : null;
  useEffect(() => {
    if (!ringing || (silent && ringing === "ring-in")) return;
    playCallSound(ringing);
    // com a janela em segundo plano, a ligação também chega como notificação do navegador (se a pessoa ligou os avisos)
    if (ringing === "ring-in" && call && getNotifyPrefs().desktop && !document.hasFocus() && typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        const n = new Notification(`📞 ${call.peer.username} está ligando`, { body: "Abra o Concord Hub para atender", tag: `call-${call.dmId}`, requireInteraction: true });
        n.onclick = () => {
          window.focus();
          (window as { concordDesktop?: { show?: () => void } }).concordDesktop?.show?.();
          n.close();
        };
      } catch {
        // navegador sem suporte a construir notificação: fica o toque
      }
    }
    const timer = setInterval(() => playCallSound(ringing), ringing === "ring-in" ? 2000 : 3000);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ringing, silent, call?.dmId]);

  const act = useCallback(
    (type: string, dmId: number) => {
      waiting.current = true;
      setNotice(null);
      if (!send({ type, dmId })) {
        waiting.current = false;
        setNotice("Sem conexão com o servidor. Tente de novo em instantes.");
      }
    },
    [send],
  );

  return {
    call,
    notice,
    dismissNotice: () => setNotice(null),
    start: (dmId: number) => act("call.start", dmId),
    accept: () => call && act("call.accept", call.dmId),
    decline: () => call && act("call.decline", call.dmId),
    hangup: () => call && act("call.hangup", call.dmId),
  };
}

/** Aviso de chamada (recebida, chamando, resultado), visível em qualquer tela do app. */
export function CallBanner({ calls }: { calls: ReturnType<typeof useCalls> }) {
  const { call, notice } = calls;
  // Com a chamada em andamento a barra de voz já mostra tudo; aqui só toca, cancelamento e resultados
  if (!(call?.state === "ringing") && !(!call && notice)) return null;
  return (
    <div className="call-banner" role="status" aria-live="polite">
      {call?.state === "ringing" && !call.outgoing && (
        <>
          <p>📞 <UserName id={call.peer.id} username={call.peer.username} /> está ligando...</p>
          <div className="row">
            <button type="button" className="small" onClick={calls.accept}>Atender</button>
            <button type="button" className="small danger" onClick={calls.decline}>Recusar</button>
          </div>
        </>
      )}
      {call?.state === "ringing" && call.outgoing && (
        <>
          <p>📞 Chamando <UserName id={call.peer.id} username={call.peer.username} />...</p>
          <button type="button" className="small secondary" onClick={calls.hangup}>Cancelar</button>
        </>
      )}
      {!call && notice && (
        <>
          <p>{notice}</p>
          <button type="button" className="small secondary" onClick={calls.dismissNotice}>Fechar</button>
        </>
      )}
    </div>
  );
}
