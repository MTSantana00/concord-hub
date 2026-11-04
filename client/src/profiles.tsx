import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSocket } from "./socket";

/** O que se sabe sobre uma pessoa (vem de listas de membros, mensagens e conversas; atualiza ao vivo). */
export interface ProfileInfo {
  id: number;
  username: string;
  displayName?: string | null;
  about?: string;
  statusKind?: string;
  statusText?: string;
  avatarVersion?: number;
}

interface Store {
  get: (id: number) => ProfileInfo | undefined;
  learn: (list: ProfileInfo[]) => void;
  /** Apelido da pessoa num servidor (undefined = não tem). */
  nick: (serverId: number, userId: number) => string | undefined;
  learnNicknames: (serverId: number, list: { id: number; nickname?: string | null }[]) => void;
}

const empty: Store = { get: () => undefined, learn: () => {}, nick: () => undefined, learnNicknames: () => {} };

/** Em que servidor a tela está: nomes mostram o apelido dali (nas conversas diretas, nenhum). */
export const ServerScope = createContext<number | null>(null);
const ProfilesContext = createContext<Store>(empty);

export function ProfilesProvider({ children }: { children: ReactNode }) {
  const { subscribe } = useSocket();
  const map = useRef(new Map<number, ProfileInfo>());
  const nicknames = useRef(new Map<string, string>());
  const [version, setVersion] = useState(0);

  const learnNicknames = useCallback((serverId: number, list: { id: number; nickname?: string | null }[]) => {
    let changed = false;
    for (const p of list) {
      const key = `${serverId}:${p.id}`;
      const before = nicknames.current.get(key);
      if (p.nickname) {
        if (before !== p.nickname) {
          nicknames.current.set(key, p.nickname);
          changed = true;
        }
      } else if (before !== undefined) {
        nicknames.current.delete(key);
        changed = true;
      }
    }
    if (changed) setVersion((v) => v + 1);
  }, []);

  const learn = useCallback((list: ProfileInfo[]) => {
    let changed = false;
    for (const p of list) {
      const before = map.current.get(p.id);
      const after = { ...before, ...p };
      if (!before || JSON.stringify(before) !== JSON.stringify(after)) {
        map.current.set(p.id, after);
        changed = true;
      }
    }
    if (changed) setVersion((v) => v + 1);
  }, []);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === "member.updated") learnNicknames(event.serverId, [{ id: event.userId, nickname: event.nickname }]);
        if (event.type === "profile.updated") learn([{ id: event.userId, username: map.current.get(event.userId)?.username ?? "", ...event.profile }]);
      }),
    [subscribe, learn, learnNicknames],
  );

  const value = useMemo<Store>(
    () => ({ get: (id) => map.current.get(id), learn, nick: (serverId, userId) => nicknames.current.get(`${serverId}:${userId}`), learnNicknames }),
    [learn, learnNicknames, version],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  return <ProfilesContext.Provider value={value}>{children}</ProfilesContext.Provider>;
}

export const useProfiles = () => useContext(ProfilesContext);

/** O nome que aparece: o de exibição, se a pessoa tiver, senão o usuário. */
export function nameOf(p: ProfileInfo | undefined, fallbackUsername = "?"): string {
  return p?.displayName || p?.username || fallbackUsername;
}

/** Função que dá o nome a mostrar de uma pessoa: o apelido do servidor aberto, senão o nome de exibição, senão o usuário. */
export function useNameOf() {
  const { get, nick } = useProfiles();
  const scope = useContext(ServerScope);
  return (id: number, username: string) => (scope !== null ? nick(scope, id) : undefined) ?? nameOf(get(id), username);
}

export function UserName({ id, username }: { id: number; username: string }) {
  const nameOf = useNameOf();
  return <>{nameOf(id, username)}</>;
}

const hue = (id: number) => (id * 137) % 360;

/** Foto de perfil, ou um círculo com a inicial (cor fixa por pessoa) quando não há foto. */
export function Avatar({ id, username, size = 28 }: { id: number; username: string; size?: number }) {
  const { get } = useProfiles();
  const p = get(id);
  const [failed, setFailed] = useState(false);
  const version = p?.avatarVersion ?? 0;
  useEffect(() => setFailed(false), [version]);
  const label = nameOf(p, username);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.45) };
  if (version > 0 && !failed) {
    return <img className="avatar" style={style} src={`/api/profile/avatar/${id}?v=${version}`} alt="" onError={() => setFailed(true)} />;
  }
  return (
    <span className="avatar initial" style={{ ...style, background: `hsl(${hue(id)} 45% 38%)` }} aria-hidden="true">
      {label.trim().charAt(0).toUpperCase()}
    </span>
  );
}
