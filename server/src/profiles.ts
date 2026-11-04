export const STATUS_KINDS = ["online", "away", "dnd"] as const;
export type StatusKind = (typeof STATUS_KINDS)[number];

export const MAX_DISPLAY_NAME = 32;
export const MAX_ABOUT = 190;
export const MAX_STATUS_TEXT = 60;

/** Colunas de perfil de `users`, para juntar em qualquer SELECT. */
export const PROFILE_COLUMNS = "u.display_name, u.about, u.status_kind, u.status_text, u.avatar_version";

export interface ProfileRow {
  display_name: string | null;
  about: string;
  status_kind: StatusKind;
  status_text: string;
  avatar_version: number;
}

/** Formato público do perfil. `avatarVersion` 0 = sem foto (a versão serve para o navegador renovar o cache). */
export function toProfile(r: ProfileRow) {
  return {
    displayName: r.display_name,
    about: r.about,
    statusKind: r.status_kind,
    statusText: r.status_text,
    avatarVersion: r.avatar_version,
  };
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** Texto de uma linha: sem caracteres de controle e sem espaços nas pontas. */
export const cleanLine = (raw: string) => raw.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
