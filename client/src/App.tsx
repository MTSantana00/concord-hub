import { useEffect, useState } from "react";
import { AuthForm } from "./AuthForm";
import { ChooseNickname, clearOAuthParams, readOAuthFlash, type OAuthFlash } from "./oauthClient";
import { ForcePasswordChange } from "./Account";
import { NotifyOnboarding } from "./NotifyOnboarding";
import { VerifyEmailGate } from "./EmailAuth";
import { AuthProvider, useAuth } from "./AuthContext";
import { ProfilesProvider } from "./profiles";
import { NotifyProvider } from "./Notifications";
import { SocketProvider } from "./socket";
import { Workspace } from "./Workspace";

/** Pega o código de /convite/<código>; null se o endereço não for de convite. */
function inviteFromPath(pathname: string): string | null {
  const m = /^\/convite\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  return m ? m[1] : null;
}

function Shell() {
  const { user, loading, onboarding } = useAuth();
  // Lido uma vez: depois do login o endereço ainda tem o convite, e o Workspace o consome
  const [inviteCode] = useState(() => inviteFromPath(window.location.pathname));
  // O que o login com Google/GitHub deixou na barra de endereço (erro, sucesso ou "escolha o apelido"); lido uma vez
  const [flash, setFlash] = useState<OAuthFlash | null>(() => readOAuthFlash());
  useEffect(() => clearOAuthParams(), []);
  // O aviso de sucesso some sozinho; erros ficam até a pessoa fechar
  useEffect(() => {
    if (flash?.kind !== "ok") return;
    const t = setTimeout(() => setFlash(null), 6000);
    return () => clearTimeout(t);
  }, [flash]);

  if (loading) return <main className="center"><p className="muted">Carregando...</p></main>;
  if (!user && flash?.kind === "apelido") {
    return (
      <main className="center">
        <div className="stack">
          <ChooseNickname />
        </div>
      </main>
    );
  }
  if (!user) {
    return (
      <main className="center">
        <div className="stack">
          {inviteCode && <p className="invite-note">Você foi convidado! Entre ou crie uma conta para aceitar.</p>}
          <AuthForm inviteCode={inviteCode} notice={flash?.kind === "erro" ? flash.text : null} />
        </div>
      </main>
    );
  }
  if (user.mustChangePassword) return <ForcePasswordChange />;
  if (user.emailPending) return <VerifyEmailGate user={user} />;
  if (onboarding) return <NotifyOnboarding user={user} />; // conta recém-criada: pergunta das notificações
  return (
    <>
      {flash && flash.kind !== "apelido" && (
        <p role={flash.kind === "erro" ? "alert" : "status"} className={`flash ${flash.kind}`}>
          {flash.text} <button type="button" className="link" onClick={() => setFlash(null)}>Fechar</button>
        </p>
      )}
    <SocketProvider>
      <ProfilesProvider>
        <NotifyProvider>
          <Workspace inviteCode={inviteCode} />
        </NotifyProvider>
      </ProfilesProvider>
    </SocketProvider>
    </>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
