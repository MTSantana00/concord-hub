import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { useSocket } from "./socket";

export interface Role {
  id: number;
  name: string;
  permissions: string[];
  isDefault: boolean;
  members: number;
}

export interface MyAccess {
  isOwner: boolean;
  roleId: number | null;
  permissions: string[];
}

/** Nome de cada permissão na tela. */
export const PERMISSION_LABELS: Record<string, string> = {
  invite: "Criar convites",
  manage_invites: "Ver e revogar convites de todos",
  manage_messages: "Apagar mensagens de outros",
  kick_ban: "Expulsar, banir, desbanir e mudar apelidos de outros",
  manage_channels: "Criar e gerenciar canais e categorias",
  view_log: "Ver o log de ações",
};

/**
 * Cargos do servidor e o que EU posso fazer nele. Atualiza quando o servidor avisa que os cargos mudaram
 * e a cada reconexão. Antes de carregar, `can` só vale para o dono (quem sabe pelo `ownerId`).
 */
export function useServerAccess(serverId: number | null, isOwner: boolean) {
  const { epoch, subscribe } = useSocket();
  const [roles, setRoles] = useState<Role[]>([]);
  const [all, setAll] = useState<string[]>([]);
  const [me, setMe] = useState<MyAccess | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    setRoles([]);
    setMe(null);
    if (serverId === null) return;
    let cancelled = false;
    api<{ roles: Role[]; permissions: string[]; me: MyAccess }>(`/api/servers/${serverId}/roles`)
      .then((d) => {
        if (cancelled) return;
        setRoles(d.roles);
        setAll(d.permissions);
        setMe(d.me);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [serverId, epoch, version]);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === "roles.changed" && event.serverId === serverId) reload();
      }),
    [subscribe, serverId, reload],
  );

  const can = useCallback((permission: string) => isOwner || !!me?.permissions.includes(permission), [isOwner, me]);
  return { roles, allPermissions: all, me, can, reload };
}

export type Access = ReturnType<typeof useServerAccess>;
