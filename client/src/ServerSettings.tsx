import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
import { PERMISSION_LABELS, type Access, type Role } from "./access";
import { useAuth } from "./AuthContext";
import { putImage, squareThumbnail } from "./image";
import { UserName, useProfiles } from "./profiles";
import { useSocket, type Member } from "./socket";
import { useDialog } from "./useDialog";

type Tab = "nickname" | "general" | "invites" | "roles" | "members" | "bans" | "log";

const errorText = (err: unknown, fallback = "Algo deu errado") => (err instanceof Error ? err.message : fallback);
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
const inviteLink = (code: string) => `${window.location.origin}/convite/${code}`;
/** Durações do timeout: minutos e o texto de cada uma. */
const TIMEOUT_CHOICES: [number, string][] = [[1, "1 minuto"], [5, "5 minutos"], [10, "10 minutos"], [60, "1 hora"], [1440, "1 dia"], [10080, "1 semana"]];

/** Botão que pede uma confirmação antes de agir (expulsar, banir, revogar...). */
function ConfirmButton({ label, confirmLabel = "Confirmar", onConfirm, danger = true }: { label: string; confirmLabel?: string; onConfirm: () => void | Promise<void>; danger?: boolean }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className={`small ${danger ? "danger" : "secondary"}`} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="row" role="group" aria-label={`Confirmar: ${label}`}>
      <button type="button" className="small danger" onClick={() => { setAsking(false); void onConfirm(); }}>
        {confirmLabel}
      </button>
      <button type="button" className="small secondary" onClick={() => setAsking(false)}>Cancelar</button>
    </span>
  );
}

// ---------------------------------------------------------------- Meu apelido

/** O apelido da própria pessoa neste servidor (aparece no lugar do nome de exibição, só aqui). */
function NicknameTab({ serverId }: { serverId: number }) {
  const { user } = useAuth();
  const { nick, learnNicknames } = useProfiles();
  const current = user ? nick(serverId, user.id) ?? "" : "";
  const [value, setValue] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      const d = await api<{ nickname: string | null }>(`/api/servers/${serverId}/nickname`, "PUT", { nickname: value });
      if (user) learnNicknames(serverId, [{ id: user.id, nickname: d.nickname }]);
      setValue(d.nickname ?? "");
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <section aria-label="Meu apelido">
      <p className="muted">Só neste servidor, os outros veem este apelido no lugar do seu nome. Deixe em branco para voltar ao normal.</p>
      <form onSubmit={save}>
        <label>
          Apelido neste servidor
          <input value={value} maxLength={32} onChange={(e) => { setValue(e.target.value); setSaved(false); }} />
        </label>
        <button type="submit" className="small">Salvar apelido</button>
      </form>
      {saved && <p role="status" className="ok">Apelido salvo.</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------- Geral

/** Nome e ícone do servidor (só o dono). */
function GeneralTab({ server }: { server: { id: number; name: string; iconVersion?: number } }) {
  const [name, setName] = useState(server.name);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await api(`/api/servers/${server.id}`, "PATCH", { name });
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    }
  }
  async function onIcon(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      await putImage(`/api/servers/${server.id}/icon`, await squareThumbnail(file));
    } catch (err) {
      setError(errorText(err, "Não foi possível enviar o ícone"));
    }
  }
  async function removeIcon() {
    try {
      await api(`/api/servers/${server.id}/icon`, "DELETE");
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <section aria-label="Geral">
      <div className="profile-photo">
        {server.iconVersion ? <img className="avatar" style={{ width: 64, height: 64 }} src={`/api/servers/${server.id}/icon?v=${server.iconVersion}`} alt="Ícone do servidor" /> : <span className="avatar initial" style={{ width: 64, height: 64, background: "var(--accent)" }} aria-hidden="true">{server.name.charAt(0).toUpperCase()}</span>}
        <div className="row">
          <label className="file-button">
            Trocar ícone
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="Escolher ícone do servidor" onChange={(e) => void onIcon(e.target.files?.[0])} hidden />
          </label>
          {!!server.iconVersion && <button type="button" className="small secondary" onClick={() => void removeIcon()}>Remover ícone</button>}
        </div>
      </div>
      <form className="stack-form" onSubmit={save}>
        <label>
          Nome do servidor
          <input value={name} maxLength={50} onChange={(e) => setName(e.target.value)} required />
        </label>
        {error && <p role="alert" className="error">{error}</p>}
        {saved && <p role="status" className="ok">Nome salvo.</p>}
        <button type="submit">Salvar nome</button>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------- Convites

interface InviteInfo {
  code: string;
  createdBy: { id: number; username: string };
  createdAt: string;
  usedBy: { id: number; username: string } | null;
  usedAt: string | null;
  status: "pending" | "used" | "revoked";
}
interface InvitesData {
  invites: InviteInfo[];
  limit: number;
  used: number;
  remaining: number;
  canSeeAll: boolean;
}

function InvitesTab({ serverId, canInvite, canManage }: { serverId: number; canInvite: boolean; canManage: boolean }) {
  const { user } = useAuth();
  const [data, setData] = useState<InvitesData | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<InvitesData>(`/api/servers/${serverId}/invites`));
    } catch (err) {
      setError(errorText(err));
    }
  }, [serverId]);
  useEffect(() => void load(), [load]);

  async function create() {
    setError(null);
    try {
      const d = await api<{ code: string }>(`/api/servers/${serverId}/invites`, "POST");
      setFresh(d.code);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  }
  async function revoke(code: string) {
    setError(null);
    try {
      await api<void>(`/api/servers/${serverId}/invites/${code}`, "DELETE");
      if (fresh === code) setFresh(null);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  }

  const statusText = (i: InviteInfo) =>
    i.status === "used" ? `Usado por ${i.usedBy?.username}${i.usedAt ? ` em ${when(i.usedAt)}` : ""}` : i.status === "revoked" ? "Revogado" : "Pendente (ninguém usou ainda)";

  return (
    <section aria-label="Convites">
      <p className="muted">
        Cada link vale <strong>uma única vez</strong>. {data && <>Você usou <strong>{data.used}</strong> de <strong>{data.limit}</strong> convites; restam <strong>{data.remaining}</strong>. Revogar um convite que ninguém usou devolve a vaga.</>}
      </p>
      {canInvite && (
        <button type="button" onClick={() => void create()} disabled={data?.remaining === 0}>Criar convite</button>
      )}
      {fresh && (
        <div className="link-box" role="status">
          <input readOnly value={inviteLink(fresh)} aria-label="Link do novo convite" onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="small" onClick={() => void navigator.clipboard?.writeText(inviteLink(fresh))}>Copiar</button>
        </div>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="table">
        {data?.invites.length === 0 && <p className="muted">Nenhum convite ainda.</p>}
        {data?.invites.map((i) => (
          <div key={i.code} className="table-row">
            <span className="grow">
              <code>{i.code.slice(0, 6)}…</code> — {statusText(i)}
              {data.canSeeAll && <span className="muted"> · criado por {i.createdBy.username}</span>}
            </span>
            {i.status === "pending" && (
              <>
                <button type="button" className="small" onClick={() => void navigator.clipboard?.writeText(inviteLink(i.code))}>Copiar link</button>
                {(i.createdBy.id === user?.id || canManage) && <ConfirmButton label="Revogar" onConfirm={() => revoke(i.code)} />}
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Cargos

function RoleEditor({ serverId, role, all, onChanged }: { serverId: number; role: Role; all: string[]; onChanged: () => void }) {
  const [name, setName] = useState(role.name);
  const [perms, setPerms] = useState<string[]>(role.permissions);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await api(`/api/servers/${serverId}/roles/${role.id}`, "PATCH", { name, permissions: perms });
      setSaved(true);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  }
  async function makeDefault() {
    try {
      await api(`/api/servers/${serverId}/roles/${role.id}`, "PATCH", { isDefault: true });
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  }
  async function remove() {
    try {
      await api<void>(`/api/servers/${serverId}/roles/${role.id}`, "DELETE");
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <form className="table-row" onSubmit={save} aria-label={`Cargo ${role.name}`}>
      <div className="grow">
        <label>
          Nome do cargo
          <input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} required />
        </label>
        <div className="perm-list">
          {all.map((p) => (
            <label key={p}>
              <input
                type="checkbox"
                checked={perms.includes(p)}
                onChange={(e) => setPerms((cur) => (e.target.checked ? [...cur, p] : cur.filter((x) => x !== p)))}
              />
              {PERMISSION_LABELS[p] ?? p}
            </label>
          ))}
        </div>
        <div className="row">
          <button type="submit" className="small">Salvar</button>
          {!role.isDefault && <button type="button" className="small secondary" onClick={() => void makeDefault()}>Tornar padrão</button>}
          {!role.isDefault && <ConfirmButton label="Apagar cargo" onConfirm={remove} />}
          <span className="muted">{role.isDefault ? "Cargo padrão (de quem entra) · " : ""}{role.members} {role.members === 1 ? "membro" : "membros"}</span>
        </div>
        {saved && <p role="status" className="ok">Salvo.</p>}
        {error && <p role="alert" className="error">{error}</p>}
      </div>
    </form>
  );
}

function RolesTab({ serverId, access }: { serverId: number; access: Access }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/api/servers/${serverId}/roles`, "POST", { name, permissions: [] });
      setName("");
      access.reload();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <section aria-label="Cargos">
      <p className="muted">Cada membro tem um cargo. O dono tem todas as permissões sempre. Quem entra recebe o cargo padrão.</p>
      <form className="row" onSubmit={create}>
        <input aria-label="Nome do novo cargo" placeholder="Nome do novo cargo" value={name} maxLength={30} onChange={(e) => setName(e.target.value)} required />
        <button type="submit" className="small">Criar cargo</button>
      </form>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="table">
        {access.roles.map((r) => (
          <RoleEditor key={`${r.id}-${r.name}-${r.permissions.join()}`} serverId={serverId} role={r} all={access.allPermissions} onChanged={access.reload} />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Membros

function MembersTab({ serverId, access, isOwner, canKick }: { serverId: number; access: Access; isOwner: boolean; canKick: boolean }) {
  const { user } = useAuth();
  const { epoch, subscribe } = useSocket();
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [temp, setTemp] = useState<{ username: string; tempPassword: string } | null>(null);
  const [editingNick, setEditingNick] = useState<{ id: number; value: string } | null>(null);

  const load = useCallback(() => {
    api<{ members: Member[] }>(`/api/servers/${serverId}/members`)
      .then((d) => setMembers(d.members))
      .catch((err) => setError(errorText(err)));
  }, [serverId]);
  useEffect(load, [load, epoch]);
  useEffect(
    () =>
      subscribe((event) => {
        if ((event.type === "member.removed" || event.type === "roles.changed" || event.type === "member.joined" || event.type === "member.updated" || event.type === "member.timeout") && event.serverId === serverId) load();
      }),
    [subscribe, serverId, load],
  );

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      load();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <section aria-label="Membros do servidor">
      {error && <p role="alert" className="error">{error}</p>}
      {temp && (
        <div role="status" className="table-row">
          Senha temporária de <strong>{temp.username}</strong> (mostrada só agora; mande por um canal seguro): <code>{temp.tempPassword}</code>
          <button type="button" className="small secondary" onClick={() => setTemp(null)}>Ok</button>
        </div>
      )}
      <div className="table">
        {members.map((m) => (
          <div key={m.id} className="table-row">
            <span className="grow">
              <UserName id={m.id} username={m.username} /> {m.isOwner && <span className="badge">dono</span>}
              {m.nickname && <span className="muted"> (apelido: {m.nickname})</span>}
            </span>
            {isOwner && !m.isOwner ? (
              <select
                aria-label={`Cargo de ${m.username}`}
                value={m.roleId ?? ""}
                onChange={(e) => void act(() => api(`/api/servers/${serverId}/members/${m.id}/role`, "PUT", { roleId: Number(e.target.value) }))}
              >
                {access.roles.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            ) : (
              !m.isOwner && <span className="muted">{m.roleName ?? ""}</span>
            )}
            {canKick && !m.isOwner && m.id !== user?.id && editingNick?.id === m.id && (
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  const value = editingNick.value;
                  setEditingNick(null);
                  void act(() => api(`/api/servers/${serverId}/members/${m.id}/nickname`, "PUT", { nickname: value }));
                }}
              >
                <input aria-label={`Apelido de ${m.username}`} value={editingNick.value} maxLength={32} autoFocus onChange={(e) => setEditingNick({ id: m.id, value: e.target.value })} />
                <button type="submit" className="small">Salvar</button>
                <button type="button" className="small secondary" onClick={() => setEditingNick(null)}>Cancelar</button>
              </form>
            )}
            {canKick && !m.isOwner && m.id !== user?.id && editingNick?.id !== m.id && (
              <>
                <button type="button" className="small secondary" aria-label={`Mudar o apelido de ${m.username}`} onClick={() => setEditingNick({ id: m.id, value: m.nickname ?? "" })}>
                  Apelido
                </button>
                <select
                  aria-label={`Timeout de ${m.username}`}
                  value=""
                  onChange={(e) => {
                    const minutes = Number(e.target.value);
                    if (e.target.value !== "") void act(() => api(`/api/servers/${serverId}/members/${m.id}/timeout`, "PUT", { minutes }));
                  }}
                >
                  <option value="">{m.timeoutUntil != null && m.timeoutUntil > Date.now() ? "⏳ Em timeout…" : "Timeout…"}</option>
                  {TIMEOUT_CHOICES.map(([minutes, label]) => (
                    <option key={minutes} value={minutes}>{label}</option>
                  ))}
                  {m.timeoutUntil != null && m.timeoutUntil > Date.now() && <option value={0}>Tirar o timeout</option>}
                </select>
                <ConfirmButton label="Expulsar" onConfirm={() => act(() => api<void>(`/api/servers/${serverId}/members/${m.id}`, "DELETE"))} />
                <ConfirmButton label="Banir" onConfirm={() => act(() => api(`/api/servers/${serverId}/bans`, "POST", { userId: m.id }))} />
              </>
            )}
            {user?.isAdmin && m.id !== user.id && (
              <ConfirmButton
                label="Redefinir senha"
                confirmLabel="Gerar senha temporária"
                danger={false}
                onConfirm={() => act(async () => setTemp(await api<{ username: string; tempPassword: string }>("/api/auth/admin/reset-password", "POST", { userId: m.id })))}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Banidos e log

function BansTab({ serverId }: { serverId: number }) {
  const [bans, setBans] = useState<{ userId: number; username: string; createdAt: string; bannedBy: string | null }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<{ bans: typeof bans }>(`/api/servers/${serverId}/bans`)
      .then((d) => setBans(d.bans))
      .catch((err) => setError(errorText(err)));
  }, [serverId]);
  useEffect(load, [load]);

  async function unban(userId: number) {
    try {
      await api<void>(`/api/servers/${serverId}/bans/${userId}`, "DELETE");
      load();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <section aria-label="Banidos">
      {error && <p role="alert" className="error">{error}</p>}
      {bans.length === 0 && <p className="muted">Ninguém está banido.</p>}
      <div className="table">
        {bans.map((b) => (
          <div key={b.userId} className="table-row">
            <span className="grow">{b.username} <span className="muted">· banido {b.bannedBy ? `por ${b.bannedBy} ` : ""}em {when(b.createdAt)}</span></span>
            <ConfirmButton label="Desbanir" confirmLabel="Desbanir" danger={false} onConfirm={() => unban(b.userId)} />
          </div>
        ))}
      </div>
    </section>
  );
}

function LogTab({ serverId }: { serverId: number }) {
  const [entries, setEntries] = useState<{ id: number; text: string; createdAt: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ entries: typeof entries }>(`/api/servers/${serverId}/log`)
      .then((d) => setEntries(d.entries))
      .catch((err) => setError(errorText(err)));
  }, [serverId]);
  return (
    <section aria-label="Log de ações">
      {error && <p role="alert" className="error">{error}</p>}
      {entries.length === 0 && !error && <p className="muted">Nada registrado ainda.</p>}
      <div className="table">
        {entries.map((e) => (
          <div key={e.id} className="table-row">
            <span className="grow">{e.text}</span>
            <span className="muted">{when(e.createdAt)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Janela

export function ServerSettings({
  server,
  isOwner,
  access,
  startTab,
  onClose,
  onLeft,
}: {
  server: { id: number; name: string; iconVersion?: number };
  isOwner: boolean;
  access: Access;
  startTab?: Tab;
  onClose: () => void;
  /** Chamado depois de a pessoa sair do servidor. */
  onLeft: (serverId: number) => void;
}) {
  const dialog = useDialog(onClose);
  const canInvite = access.can("invite") || access.can("manage_invites");
  const canKick = access.can("kick_ban");
  const tabs: { id: Tab; label: string; visible: boolean }[] = [
    { id: "nickname", label: "Meu apelido", visible: true },
    { id: "general", label: "Geral", visible: isOwner },
    { id: "invites", label: "Convites", visible: canInvite },
    { id: "roles", label: "Cargos", visible: isOwner },
    { id: "members", label: "Membros", visible: isOwner || canKick },
    { id: "bans", label: "Banidos", visible: canKick },
    { id: "log", label: "Log", visible: access.can("view_log") },
  ];
  const visible = tabs.filter((t) => t.visible);
  const [tab, setTab] = useState<Tab | null>(startTab ?? null);
  // Abre em Convites (o mais usado), se a pessoa puder; senão na primeira aba que ela vê
  const current = visible.find((t) => t.id === tab)?.id ?? visible.find((t) => t.id === "invites")?.id ?? visible[0]?.id ?? null;
  const [error, setError] = useState<string | null>(null);

  async function leave() {
    try {
      await api<void>(`/api/servers/${server.id}/leave`, "POST");
      onLeft(server.id);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label={`Configurações de ${server.name}`} {...dialog}>
        <header className="modal-head">
          <h2>{server.name}</h2>
          <button type="button" className="small secondary" onClick={onClose} aria-label="Fechar">Fechar</button>
        </header>
        {visible.length > 0 ? (
          <div className="tabs" role="tablist">
            {visible.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={t.id === current} className="small secondary" onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        ) : (
          <p className="muted">Seu cargo não tem opções de administração neste servidor.</p>
        )}
        {current === "nickname" && <NicknameTab serverId={server.id} />}
        {current === "general" && <GeneralTab server={server} />}
        {current === "invites" && <InvitesTab serverId={server.id} canInvite={access.can("invite")} canManage={access.can("manage_invites")} />}
        {current === "roles" && <RolesTab serverId={server.id} access={access} />}
        {current === "members" && <MembersTab serverId={server.id} access={access} isOwner={isOwner} canKick={canKick} />}
        {current === "bans" && <BansTab serverId={server.id} />}
        {current === "log" && <LogTab serverId={server.id} />}
        {!isOwner && (
          <div>
            <hr />
            <ConfirmButton label="Sair do servidor" confirmLabel="Sair mesmo" onConfirm={leave} />
            {error && <p role="alert" className="error">{error}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
