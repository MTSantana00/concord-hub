import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
import { updateNotifyPrefs, useNotifyPrefs } from "./notifyPrefs";
import { LinkedAccounts } from "./oauthClient";
import { currentSubscription, disablePush, enablePush, pushSupported, serverKey } from "./push";
import { playSound, unlockAudio, type CallSound } from "./sounds";
import { ACCENTS, useAppearance, type FontSize, type Theme } from "./appearance";
import { useAuth } from "./AuthContext";
import { EmailSection } from "./EmailAuth";
import { useDialog } from "./useDialog";
import { HOTKEYS, comboFromEvent, conflictFor, isValidCombo, prettyCombo, resetHotkeys, setHotkey, setHotkeyCapturing, useHotkeyConfig, type HotkeyAction } from "./hotkeys";
import { putImage, squareThumbnail } from "./image";
import { Avatar } from "./profiles";

function PasswordForm({ forced, onDone }: { forced?: boolean; onDone?: () => void }) {
  const { reload } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== again) {
      setError("As duas senhas novas não são iguais");
      return;
    }
    setBusy(true);
    try {
      await api<void>("/api/auth/password", "POST", { current, next });
      setDone(true);
      setCurrent("");
      setNext("");
      setAgain("");
      await reload();
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Algo deu errado");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={forced ? "card" : "stack-form"} onSubmit={onSubmit}>
      {forced && <h1>Escolha uma senha nova</h1>}
      {forced && <p className="muted">Você entrou com uma senha temporária. Defina a sua para continuar.</p>}
      <label>
        {forced ? "Senha temporária" : "Senha atual"}
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
      </label>
      <label>
        Nova senha
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} maxLength={72} required />
      </label>
      <label>
        Repita a nova senha
        <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required />
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      {done && !forced && <p role="status" className="ok">Senha trocada. Os outros aparelhos foram desconectados.</p>}
      <button type="submit" disabled={busy}>Trocar senha</button>
    </form>
  );
}

/** Tela cheia para quem entrou com a senha temporária que a administradora gerou. */
export function ForcePasswordChange() {
  const { logout } = useAuth();
  return (
    <main className="center">
      <div className="stack">
        <PasswordForm forced />
        <button type="button" className="link" onClick={() => void logout()}>Sair</button>
      </div>
    </main>
  );
}

const STATUS_LABELS: Record<string, string> = { online: "Disponível", away: "Ausente", dnd: "Não perturbe" };

/** Foto, nome de exibição, "sobre mim" e status. */
function ProfileSection() {
  const { user, reload } = useAuth();
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [about, setAbout] = useState(user?.about ?? "");
  const [statusKind, setStatusKind] = useState(user?.statusKind ?? "online");
  const [statusText, setStatusText] = useState(user?.statusText ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      await api("/api/profile", "PATCH", { displayName, about, statusKind, statusText });
      await reload();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Algo deu errado");
    } finally {
      setBusy(false);
    }
  }

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      await putImage("/api/profile/avatar", await squareThumbnail(file));
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível enviar a foto");
    } finally {
      setBusy(false);
    }
  }

  async function removePhoto() {
    setError(null);
    try {
      await api("/api/profile/avatar", "DELETE");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Algo deu errado");
    }
  }

  return (
    <section aria-label="Perfil">
      <h3>Perfil</h3>
      <div className="profile-photo">
        {user && <Avatar id={user.id} username={user.username} size={72} />}
        <div className="row">
          <label className="file-button">
            Trocar foto
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="Escolher foto de perfil" onChange={(e) => void onPhoto(e.target.files?.[0])} hidden />
          </label>
          {(user?.avatarVersion ?? 0) > 0 && <button type="button" className="small secondary" onClick={() => void removePhoto()}>Remover foto</button>}
        </div>
      </div>
      <form className="stack-form" onSubmit={save}>
        <label>
          Nome de exibição
          <input value={displayName} maxLength={32} placeholder={user?.username} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label>
          Sobre mim
          <textarea value={about} maxLength={190} rows={2} onChange={(e) => setAbout(e.target.value)} />
        </label>
        <label>
          Status
          <select value={statusKind} onChange={(e) => setStatusKind(e.target.value)}>
            {Object.entries(STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          Texto do status
          <input value={statusText} maxLength={60} placeholder="O que você está fazendo?" onChange={(e) => setStatusText(e.target.value)} />
        </label>
        {error && <p role="alert" className="error">{error}</p>}
        {saved && <p role="status" className="ok">Perfil salvo.</p>}
        <button type="submit" disabled={busy}>Salvar perfil</button>
      </form>
    </section>
  );
}

/** Tema, cor de destaque e tamanho da letra (valem só neste aparelho). */
function AppearanceSection() {
  const { appearance, update } = useAppearance();
  const themes: [Theme, string][] = [["auto", "Automático"], ["dark", "Escuro"], ["light", "Claro"]];
  const sizes: [FontSize, string][] = [["small", "Pequena"], ["medium", "Média"], ["large", "Grande"]];
  return (
    <section aria-label="Aparência">
      <h3>Aparência</h3>
      <p className="muted">Vale só para este aparelho.</p>
      <div role="radiogroup" aria-label="Tema" className="row">
        {themes.map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={appearance.theme === id} className="small secondary choice" onClick={() => update({ theme: id })}>
            {label}
          </button>
        ))}
      </div>
      <div role="radiogroup" aria-label="Cor de destaque" className="row">
        {ACCENTS.map((a) => (
          <button
            key={a.id}
            type="button"
            role="radio"
            aria-checked={appearance.accent === a.id}
            aria-label={a.name}
            title={a.name}
            className="swatch"
            style={{ background: a.color }}
            onClick={() => update({ accent: a.id })}
          />
        ))}
      </div>
      <div role="radiogroup" aria-label="Tamanho da letra" className="row">
        {sizes.map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={appearance.fontSize === id} className="small secondary choice" onClick={() => update({ fontSize: id })}>
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}

/** Notificações com o app fechado: liga ou desliga neste aparelho. */
function BackgroundPush() {
  const [state, setState] = useState<"checking" | "off" | "on" | "unavailable">("checking");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!pushSupported()) return alive && setState("unavailable");
      try {
        if (!(await serverKey())) return alive && setState("unavailable");
        const sub = await currentSubscription();
        if (alive) setState(sub ? "on" : "off");
      } catch {
        if (alive) setState("unavailable");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function toggle(on: boolean) {
    setError(null);
    setBusy(true);
    try {
      if (on) await enablePush();
      else await disablePush();
      setState(on ? "on" : "off");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível mudar as notificações");
    } finally {
      setBusy(false);
    }
  }

  if (state === "checking") return null;
  if (state === "unavailable") {
    return <p className="muted">Notificações com o app fechado não estão disponíveis aqui. No iPhone, instale o app na tela de início; em outros navegadores, o servidor precisa ter o recurso ligado.</p>;
  }
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={state === "on"} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
        Notificações com o app fechado (mensagens diretas e menções)
      </label>
      {error && <p role="alert" className="error">{error}</p>}
    </>
  );
}

const CALL_SOUND_DEMO: CallSound[] = ["ring-out", "call-connected", "peer-join", "mute", "unmute", "deafen", "undeafen", "camera-on", "camera-off", "screen-on", "screen-off", "peer-leave", "call-end", "ring-in"];

/** Toca todos os avisos da chamada em sequência, para a pessoa saber qual é qual (e conferir se o aparelho está tocando). */
function testCallSounds(volume: number) {
  unlockAudio();
  CALL_SOUND_DEMO.forEach((kind, i) => window.setTimeout(() => playSound(kind, volume), i * 600));
}

/** Sons e notificações (valem só neste aparelho). */
function NotificationsSection() {
  const prefs = useNotifyPrefs();
  const [permissionNote, setPermissionNote] = useState<string | null>(null);

  async function toggleDesktop(on: boolean) {
    setPermissionNote(null);
    if (!on) return updateNotifyPrefs({ desktop: false });
    if (typeof Notification === "undefined") return setPermissionNote("Este navegador não oferece notificações.");
    const result = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (result === "granted") updateNotifyPrefs({ desktop: true });
    else setPermissionNote("O navegador bloqueou as notificações. Libere nas configurações do site e tente de novo.");
  }

  return (
    <section aria-label="Avisos">
      <h3>Avisos</h3>
      <p className="muted">Vale só para este aparelho. No status "Não perturbe" não há som nem notificação.</p>
      <label className="check">
        <input type="checkbox" checked={prefs.sounds} onChange={(e) => updateNotifyPrefs({ sounds: e.target.checked })} />
        Tocar som quando chegar mensagem
      </label>
      <label className="check">
        <input type="checkbox" checked={prefs.callSounds} onChange={(e) => updateNotifyPrefs({ callSounds: e.target.checked })} />
        Tocar avisos de ligação e de chamada (chamando, recebendo, atender, desligar, mutar, câmera, tela, entrar e sair)
      </label>
      <label>
        Volume do som
        <input
          type="range"
          min={0}
          max={100}
          value={prefs.volume}
          disabled={!prefs.sounds}
          aria-label="Volume do som"
          onChange={(e) => updateNotifyPrefs({ volume: Number(e.target.value) })}
        />
      </label>
      <div className="row">
        <button type="button" className="small secondary" disabled={!prefs.sounds} onClick={() => playSound("message", prefs.volume)}>Testar som de mensagem</button>
        <button type="button" className="small secondary" disabled={!prefs.sounds} onClick={() => playSound("mention", prefs.volume)}>Testar som de menção</button>
        <button type="button" className="small secondary" disabled={!prefs.callSounds} onClick={() => testCallSounds(prefs.volume)}>Ouvir os avisos da chamada</button>
      </div>
      <label className="check">
        <input type="checkbox" checked={prefs.desktop} onChange={(e) => void toggleDesktop(e.target.checked)} />
        Notificações do navegador (com a janela em segundo plano)
      </label>
      {permissionNote && <p role="alert" className="error">{permissionNote}</p>}
      <BackgroundPush />
    </section>
  );
}

/** Atalhos de teclado: cada pessoa escolhe a combinação de cada ação (vale só neste aparelho). */
function HotkeysSection() {
  const cfg = useHotkeyConfig();
  const [recording, setRecording] = useState<HotkeyAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    setHotkeyCapturing(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation(); // nada mais reage a esta tecla (nem o Esc que fecha a janela)
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        setRecording(null);
        setError(null);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return; // só apertou Ctrl/Alt/Shift: espera a tecla
      if (!isValidCombo(combo)) {
        setError("Use Ctrl, Alt ou Cmd junto com a tecla (ou uma tecla de F1 a F12).");
        return;
      }
      const clash = conflictFor(cfg, recording, combo);
      if (clash) {
        setError(`Esse atalho já é o de "${clash.label}". Escolha outro ou limpe aquele primeiro.`);
        return;
      }
      setHotkey(recording, combo);
      setRecording(null);
      setError(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      setHotkeyCapturing(false);
    };
  }, [recording, cfg]);

  return (
    <section aria-label="Atalhos">
      <h3>Atalhos de teclado</h3>
      <p className="muted">Clique em um atalho e aperte as teclas que você quer (Esc cancela). Precisa de Ctrl, Alt ou Cmd junto. Vale só neste aparelho. No app de computador, os de chamada funcionam até com a janela em segundo plano; no navegador, só com a aba aberta.</p>
      <ul className="hotkey-list">
        {HOTKEYS.map((h) => (
          <li key={h.id} className="hotkey-row">
            <span>{h.label}</span>
            <span className="row">
              <button
                type="button"
                className={`small secondary hotkey-key${recording === h.id ? " recording" : ""}`}
                aria-label={`Mudar o atalho de ${h.label}`}
                onClick={() => {
                  setError(null);
                  setRecording(recording === h.id ? null : h.id);
                }}
              >
                {recording === h.id ? "Aperte as teclas…" : prettyCombo(cfg[h.id])}
              </button>
              {cfg[h.id] && (
                <button type="button" className="small secondary" aria-label={`Tirar o atalho de ${h.label}`} onClick={() => setHotkey(h.id, "")}>
                  Limpar
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="error">{error}</p>}
      <button type="button" className="small secondary" onClick={() => { resetHotkeys(); setError(null); setRecording(null); }}>Restaurar os atalhos padrão</button>
    </section>
  );
}

interface Usage {
  month: string;
  voice: { minutes: number; minutesLimit: number; gb: number; gbLimit: number };
  vm: { memAvailableMb: number; memTotalMb: number; swapUsedMb: number; swapTotalMb: number; diskUsedPct: number; containerMemMb: number | null; containerLimitMb: number | null };
  alerts: { id: number; level: "aviso" | "critico"; title: string; message: string; createdAt: string; acked: boolean }[];
}

/** Uso do plano gratuito de voz no mês e saúde da VM, com os avisos de limite. */
function UsagePanel() {
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => {
    api<Usage>("/api/admin/usage").then(setUsage).catch(() => {});
  }, []);
  if (!usage) return null;
  const { voice, vm } = usage;
  const pct = (v: number, max: number) => (max > 0 ? Math.min(100, Math.round((v / max) * 100)) : 0);
  const row = (label: string, text: string, value: number, max: number, low = 0.7, high = 0.9) => (
    <div className="usage-row">
      <span>{label}</span>
      <meter value={value} max={max} low={max * low} high={max * high} optimum={0} aria-label={label} />
      <span className="muted">{text}</span>
    </div>
  );
  async function ack() {
    await api<void>("/api/admin/alerts/ack", "POST", {}).catch(() => {});
    setUsage((u) => (u ? { ...u, alerts: u.alerts.map((a) => ({ ...a, acked: true })) } : u));
  }
  return (
    <div className="usage-panel" aria-label="Uso e limites">
      <h4>Uso e limites (mês {usage.month})</h4>
      {voice.minutesLimit > 0 && row("Voz: minutos do plano gratuito", `${voice.minutes.toLocaleString("pt-BR")} de ${voice.minutesLimit.toLocaleString("pt-BR")} (${pct(voice.minutes, voice.minutesLimit)}%)`, voice.minutes, voice.minutesLimit)}
      {voice.gbLimit > 0 && row("Voz: tráfego estimado (só áudio)", `${voice.gb} de ${voice.gbLimit} GB`, voice.gb, voice.gbLimit)}
      {vm.memTotalMb > 0 && row("VM: memória em uso", `${vm.memTotalMb - vm.memAvailableMb} de ${vm.memTotalMb} MB (${vm.memAvailableMb} MB livres)`, vm.memTotalMb - vm.memAvailableMb, vm.memTotalMb, 0.85, 0.94)}
      {vm.diskUsedPct > 0 && row("VM: disco", `${vm.diskUsedPct}% usado`, vm.diskUsedPct, 100, 0.8, 0.9)}
      {vm.containerMemMb !== null && vm.containerLimitMb ? row("Concord: memória", `${vm.containerMemMb} de ${vm.containerLimitMb} MB`, vm.containerMemMb, vm.containerLimitMb, 0.85, 0.95) : null}
      <p className="muted">O tráfego é uma estimativa só de áudio (câmera e tela gastam mais), e os minutos são contados por este app; confira de vez em quando no painel do LiveKit. Você recebe uma notificação ao passar de 70%, 90% e 100%.</p>
      {usage.alerts.length === 0 ? (
        <p className="muted">Nenhum aviso até agora.</p>
      ) : (
        <>
          <ul className="alert-list">
            {usage.alerts.slice(0, 6).map((a) => (
              <li key={a.id} className={`alert-item ${a.level}${a.acked ? " read" : ""}`}>
                <strong>{a.title}</strong> <span className="muted">{new Date(a.createdAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</span>
                <br />
                {a.message}
              </li>
            ))}
          </ul>
          {usage.alerts.some((a) => !a.acked) && (
            <button type="button" className="small secondary" onClick={() => void ack()}>Marcar avisos como lidos</button>
          )}
        </>
      )}
    </div>
  );
}

/** Só a administradora: backups do banco (automáticos na VM e um para baixar e guardar fora dela). */
function AdminSection() {
  const [backups, setBackups] = useState<{ name: string; size: number; createdAt: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ backups: { name: string; size: number; createdAt: string }[] }>("/api/admin/backups")
      .then((d) => setBackups(d.backups))
      .catch((err) => setError(err instanceof Error ? err.message : "Não foi possível ver os backups"));
  }, []);
  const last = backups?.[0];
  return (
    <section aria-label="Administração">
      <h3>Administração: backups</h3>
      {error && <p role="alert" className="error">{error}</p>}
      {backups && (
        <p className="muted">
          {last
            ? `Último backup automático: ${new Date(last.createdAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })} (${backups.length} guardados na VM, 1 por dia).`
            : "Ainda não há backup automático (o primeiro sai logo depois de o servidor ligar)."}
        </p>
      )}
      <p className="muted">Os automáticos ficam na própria VM. Baixe um de vez em quando e guarde no seu computador: é a cópia que sobrevive se a VM se perder. Não inclui os arquivos anexados.</p>
      <a className="button-link" href="/api/admin/backup" download>Baixar um backup agora</a>
      <UsagePanel />
    </section>
  );
}

/** Excluir a própria conta (LGPD): pede o nome de usuário e a senha, e apaga tudo da pessoa. */
function DeleteAccountSection() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api<void>("/api/auth/delete-account", "POST", { confirm, password });
      await logout(); // o servidor já apagou a conta e o cookie; isto só limpa a tela
    } catch (err) {
      setError(err instanceof Error ? err.message : "Algo deu errado");
      setBusy(false);
    }
  }

  return (
    <section aria-label="Excluir conta">
      <h3>Excluir minha conta</h3>
      {!open ? (
        <>
          <p className="muted">Apaga a sua conta, as suas mensagens, conversas diretas, foto e arquivos enviados. Não dá para desfazer.</p>
          <button type="button" className="small danger" onClick={() => setOpen(true)}>Excluir minha conta…</button>
        </>
      ) : (
        <form className="stack-form" onSubmit={onSubmit}>
          <p className="muted">
            Isto apaga <strong>para sempre</strong> a sua conta, as suas mensagens (nos servidores e nas conversas diretas, inclusive para quem conversou com você), a foto e os arquivos que você enviou. Quem é dono de um servidor precisa apagá-lo antes. Cópias de segurança antigas somem em até 14 dias.
          </p>
          <label>
            Digite o seu usuário ({user?.username}) para confirmar
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" required />
          </label>
          <label>
            Senha (deixe em branco se você só entra com Google ou GitHub)
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          {error && <p role="alert" className="error">{error}</p>}
          <div className="row">
            <button type="submit" className="small danger" disabled={busy || confirm !== user?.username}>Excluir para sempre</button>
            <button type="button" className="small secondary" disabled={busy} onClick={() => { setOpen(false); setError(null); }}>Cancelar</button>
          </div>
        </form>
      )}
    </section>
  );
}

/** Janelinha "Minha conta": trocar a senha e sair de todos os aparelhos. */
export function AccountSettings({ onClose }: { onClose: () => void }) {
  const dialog = useDialog(onClose);
  const { user } = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function logoutAll() {
    setError(null);
    setMessage(null);
    try {
      await api<void>("/api/auth/logout-all", "POST");
      setMessage("Pronto: todos os outros aparelhos foram desconectados.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Algo deu errado");
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label="Minha conta" {...dialog}>
        <header className="modal-head">
          <h2>Minha conta</h2>
          <button type="button" className="small secondary" onClick={onClose} aria-label="Fechar">Fechar</button>
        </header>
        <p className="muted">Você é <strong>{user?.username}</strong>{user?.isAdmin ? " (administradora da plataforma)" : ""}.</p>
        <ProfileSection />
        <AppearanceSection />
        <EmailSection />
        <LinkedAccounts />
        <NotificationsSection />
        <HotkeysSection />
        {user?.isAdmin && <AdminSection />}
        <h3>Trocar a senha</h3>
        <PasswordForm />
        <h3>Aparelhos</h3>
        <p className="muted">Se perdeu o celular ou deixou a conta aberta em algum lugar, desconecte tudo. Este aparelho continua logado.</p>
        <button type="button" className="secondary" onClick={() => void logoutAll()}>Sair de todos os outros aparelhos</button>
        {message && <p role="status" className="ok">{message}</p>}
        {error && <p role="alert" className="error">{error}</p>}
        {!user?.isAdmin && <DeleteAccountSection />}
        <p className="legal-note">
          <a href="/termos.html" target="_blank" rel="noopener">Termos de uso</a> · <a href="/privacidade.html" target="_blank" rel="noopener">Privacidade</a> · <a href="/licencas.html" target="_blank" rel="noopener">Licenças de terceiros</a>
        </p>
      </div>
    </div>
  );
}
