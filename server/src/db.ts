import type { DatabaseSync } from "node:sqlite";
import { seedRoles } from "./roles.js";

// getBuiltinModule porque o Vitest não resolve `import "node:sqlite"` (tira o prefixo node:)
const sqlite = process.getBuiltinModule("node:sqlite");

export type Db = DatabaseSync;

/**
 * Versão do formato do banco, guardada em `PRAGMA user_version`.
 *  0 = antes das mensagens diretas (messages.channel_id obrigatório)
 *  1 = messages aceita channel_id OU dm_id; existe dm_conversations
 *  2 = messages.edited_at (mensagens editadas)
 *  3 = messages.audio_ms e audio_mime (mensagens de áudio; o arquivo fica em disco)
 *  4 = channels.type ('text' ou 'voice')
 *  5 = cargos (roles, members.role_id), convites de uso único (used_by/used_at/revoked_at), bans, audit_log,
 *      users.is_admin / token_version / must_change_password
 * 17 = e-mail confirmado da conta (users.email / email_verified_at / email_required) e códigos de verificação (email_codes)
 * 16 = tópico do canal (channels.topic)
 * 15 = timeout de membro (members.timeout_until, em ms desde 1970)
 * 14 = modo lento (channels.slowmode_seconds) e enquetes (messages.poll_multiple, poll_options, poll_votes)
 * 13 = login externo: identities (Google/GitHub ligados a uma conta; chave = provedor + id no provedor)
 * 12 = monitor: usage_monthly (minutos e tráfego de voz do mês), admin_alerts (avisos de limite para a administradora)
 * 11 = push: push_subscriptions (aparelhos que recebem notificação com o app fechado)
 * 10 = ordem: categories.position, channels.position (ordena por posição e depois por criação)
 *  9 = servidor flexível: categories, channels.category_id/read_only/private, channel_roles, members.nickname
 *  8 = avisos: read_state (última mensagem lida), mutes (canais, servidores e conversas silenciados)
 *  7 = mensagens ricas: messages.reply_to/pinned_at/pinned_by/att_*, reactions, link_previews
 *  6 = perfil (users.display_name/about/status_kind/status_text/avatar_version/avatar_mime) e ícone do servidor
 * Ao mudar o formato: suba o número e acrescente o passo de migração em `openDb`.
 */
export const SCHEMA_VERSION = 17;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    token_version INTEGER NOT NULL DEFAULT 0,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    display_name  TEXT,
    about         TEXT NOT NULL DEFAULT '',
    status_kind   TEXT NOT NULL DEFAULT 'online' CHECK (status_kind IN ('online', 'away', 'dnd')),
    status_text   TEXT NOT NULL DEFAULT '',
    avatar_version INTEGER NOT NULL DEFAULT 0,
    avatar_mime   TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS servers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    icon_version INTEGER NOT NULL DEFAULT 0,
    icon_mime  TEXT
  );

  CREATE TABLE IF NOT EXISTS members (
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    role_id   INTEGER REFERENCES roles(id) ON DELETE SET NULL,
    nickname  TEXT,
    PRIMARY KEY (server_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS invites (
    code       TEXT PRIMARY KEY,
    server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- uso único: quem usou e quando; revoked_at = o convite foi cancelado
    used_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    used_at    TEXT,
    revoked_at TEXT
  );

  -- Cargos do servidor. permissions = nomes separados por vírgula; is_default = cargo de quem entra.
  CREATE TABLE IF NOT EXISTS roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    permissions TEXT NOT NULL DEFAULT '',
    is_default  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (server_id, name)
  );

  -- Quem foi banido de qual servidor.
  CREATE TABLE IF NOT EXISTS bans (
    server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    banned_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (server_id, user_id)
  );

  -- Registro de ações de moderação e convites.
  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action     TEXT NOT NULL,
    target_id  INTEGER,
    detail     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_server ON audit_log (server_id, id);

  -- Categorias: agrupam canais na lista do servidor.
  CREATE TABLE IF NOT EXISTS categories (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    position  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS channels (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    type       TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'voice')),
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    read_only  INTEGER NOT NULL DEFAULT 0,
    private    INTEGER NOT NULL DEFAULT 0,
    position   INTEGER NOT NULL DEFAULT 0,
    slowmode_seconds INTEGER NOT NULL DEFAULT 0,
    UNIQUE (server_id, name)
  );

  -- Cargos que enxergam um canal privado.
  CREATE TABLE IF NOT EXISTS channel_roles (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, role_id)
  );

  -- Conversa direta entre duas pessoas. user_a < user_b garante um único registro por par.
  CREATE TABLE IF NOT EXISTS dm_conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_a     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_a, user_b),
    CHECK (user_a < user_b)
  );

  -- Uma mensagem é de um canal OU de uma conversa direta, nunca das duas.
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
    dm_id      INTEGER REFERENCES dm_conversations(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    edited_at  TEXT,
    audio_ms   INTEGER,
    audio_mime TEXT,
    reply_to   INTEGER,
    pinned_at  TEXT,
    pinned_by  INTEGER,
    att_name   TEXT,
    att_mime   TEXT,
    att_size   INTEGER,
    att_kind   TEXT CHECK (att_kind IN ('image', 'file')),
    poll_multiple INTEGER,
    CHECK ((channel_id IS NULL) != (dm_id IS NULL)),
    CHECK ((audio_ms IS NULL) = (audio_mime IS NULL))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (channel_id, id);
  CREATE INDEX IF NOT EXISTS idx_messages_dm ON messages (dm_id, id);

  -- Enquetes: a mensagem tem poll_multiple (0 = escolha única, 1 = várias); opções e votos ficam aqui.
  CREATE TABLE IF NOT EXISTS poll_options (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL,
    text       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_poll_options_message ON poll_options (message_id, position);
  CREATE TABLE IF NOT EXISTS poll_votes (
    option_id  INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (option_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_poll_votes_message ON poll_votes (message_id);

  -- Reações: uma por pessoa, por emoji, por mensagem.
  CREATE TABLE IF NOT EXISTS reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (message_id, user_id, emoji)
  );
  CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions (message_id);

  -- Pré-visualizações de links já buscadas (guardadas por 24 h).
  CREATE TABLE IF NOT EXISTS link_previews (
    url         TEXT PRIMARY KEY,
    ok          INTEGER NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    site        TEXT NOT NULL DEFAULT '',
    fetched_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Login com Google/GitHub: a identidade é o id da pessoa no provedor (nunca o e-mail). Um de cada provedor por conta.
  CREATE TABLE IF NOT EXISTS identities (
    provider   TEXT NOT NULL CHECK (provider IN ('google', 'github')),
    subject    TEXT NOT NULL,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (provider, subject),
    UNIQUE (user_id, provider)
  );

  -- Monitor de limites: uso de voz por mês e avisos para a administradora (a chave evita avisar duas vezes a mesma coisa).
  CREATE TABLE IF NOT EXISTS usage_monthly (
    month TEXT NOT NULL,
    kind  TEXT NOT NULL,
    value REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (month, kind)
  );
  CREATE TABLE IF NOT EXISTS admin_alerts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    key        TEXT NOT NULL UNIQUE,
    level      TEXT NOT NULL CHECK (level IN ('aviso', 'critico')),
    title      TEXT NOT NULL,
    message    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    acked_at   TEXT
  );

  -- Notificações com o app fechado: um registro por aparelho/navegador.
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL UNIQUE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions (user_id);

  -- Avisos: até onde cada pessoa leu cada canal/conversa, e o que ela silenciou.
  CREATE TABLE IF NOT EXISTS read_state (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('channel', 'dm')),
    target_id    INTEGER NOT NULL,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, kind, target_id)
  );
  -- Códigos de 6 dígitos enviados por e-mail (confirmar o e-mail, recuperar a senha). Só o hash fica guardado.
  CREATE TABLE IF NOT EXISTS email_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    purpose    TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email      TEXT NOT NULL,
    code_hash  TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_email_codes_user ON email_codes (user_id, purpose);
  CREATE TABLE IF NOT EXISTS mutes (
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind      TEXT NOT NULL CHECK (kind IN ('channel', 'server', 'dm')),
    target_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, kind, target_id)
  );
`;

function hasTable(db: Db, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

export function openDb(path = ":memory:"): Db {
  const db = new sqlite.DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");

  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  // Banco criado antes das DMs: guarda a tabela velha de lado para copiar as mensagens
  const legacyMessages = user_version < 1 && hasTable(db, "messages");

  db.exec("BEGIN");
  try {
    if (legacyMessages) {
      db.exec("ALTER TABLE messages RENAME TO messages_v0; DROP INDEX IF EXISTS idx_messages_channel;");
    }
    db.exec(SCHEMA);
    if (legacyMessages) {
      db.exec(`
        INSERT INTO messages (id, channel_id, user_id, content, created_at)
          SELECT id, channel_id, user_id, content, created_at FROM messages_v0;
        DROP TABLE messages_v0;
      `);
    }
    // v1 -> v2: o CREATE TABLE IF NOT EXISTS acima não mexe numa tabela que já existe
    const columns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "edited_at")) db.exec("ALTER TABLE messages ADD COLUMN edited_at TEXT");
    // v2 -> v3 (o ALTER não leva o CHECK; em banco novo ele vem do CREATE TABLE)
    if (!columns.some((c) => c.name === "audio_ms")) {
      db.exec("ALTER TABLE messages ADD COLUMN audio_ms INTEGER; ALTER TABLE messages ADD COLUMN audio_mime TEXT;");
    }
    // v3 -> v4
    const channelColumns = db.prepare("PRAGMA table_info(channels)").all() as { name: string }[];
    if (!channelColumns.some((c) => c.name === "type")) {
      db.exec("ALTER TABLE channels ADD COLUMN type TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'voice'))");
    }
    // v4 -> v5
    const addColumn = (table: string, column: string, ddl: string) => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    };
    addColumn("users", "is_admin", "INTEGER NOT NULL DEFAULT 0");
    addColumn("users", "token_version", "INTEGER NOT NULL DEFAULT 0");
    addColumn("users", "must_change_password", "INTEGER NOT NULL DEFAULT 0");
    addColumn("members", "role_id", "INTEGER REFERENCES roles(id) ON DELETE SET NULL");
    addColumn("invites", "used_by", "INTEGER REFERENCES users(id) ON DELETE SET NULL");
    addColumn("invites", "used_at", "TEXT");
    addColumn("invites", "revoked_at", "TEXT");
    // Servidores que já existiam ganham os cargos iniciais, e os membros (menos o dono) viram "Membro"
    const semCargos = db
      .prepare("SELECT id FROM servers WHERE id NOT IN (SELECT server_id FROM roles)")
      .all() as { id: number }[];
    for (const { id } of semCargos) {
      const padrao = seedRoles(db, id);
      db.prepare(
        "UPDATE members SET role_id = ? WHERE server_id = ? AND role_id IS NULL AND user_id != (SELECT owner_id FROM servers WHERE id = ?)",
      ).run(padrao, id, id);
    }
    // v5 -> v6
    addColumn("users", "display_name", "TEXT");
    addColumn("users", "about", "TEXT NOT NULL DEFAULT ''");
    addColumn("users", "status_kind", "TEXT NOT NULL DEFAULT 'online' CHECK (status_kind IN ('online', 'away', 'dnd'))");
    addColumn("users", "status_text", "TEXT NOT NULL DEFAULT ''");
    addColumn("users", "avatar_version", "INTEGER NOT NULL DEFAULT 0");
    addColumn("users", "avatar_mime", "TEXT");
    addColumn("servers", "icon_version", "INTEGER NOT NULL DEFAULT 0");
    addColumn("servers", "icon_mime", "TEXT");
    // v6 -> v7
    addColumn("messages", "reply_to", "INTEGER");
    addColumn("messages", "pinned_at", "TEXT");
    addColumn("messages", "pinned_by", "INTEGER");
    addColumn("messages", "att_name", "TEXT");
    addColumn("messages", "att_mime", "TEXT");
    addColumn("messages", "att_size", "INTEGER");
    addColumn("messages", "att_kind", "TEXT CHECK (att_kind IN ('image', 'file'))");
    // v8 -> v9
    addColumn("channels", "category_id", "INTEGER REFERENCES categories(id) ON DELETE SET NULL");
    addColumn("channels", "read_only", "INTEGER NOT NULL DEFAULT 0");
    addColumn("channels", "private", "INTEGER NOT NULL DEFAULT 0");
    addColumn("members", "nickname", "TEXT");
    // v9 -> v10
    addColumn("channels", "position", "INTEGER NOT NULL DEFAULT 0");
    addColumn("categories", "position", "INTEGER NOT NULL DEFAULT 0");
    // v13 -> v14
    addColumn("channels", "slowmode_seconds", "INTEGER NOT NULL DEFAULT 0");
    addColumn("messages", "poll_multiple", "INTEGER");
    // v14 -> v15
    addColumn("members", "timeout_until", "INTEGER");
    // v15 -> v16
    addColumn("channels", "topic", "TEXT NOT NULL DEFAULT ''");
    // v16 -> v17: o e-mail só entra em users depois de confirmado com o código
    addColumn("users", "email", "TEXT");
    addColumn("users", "email_verified_at", "TEXT");
    addColumn("users", "email_required", "INTEGER NOT NULL DEFAULT 0");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email COLLATE NOCASE) WHERE email IS NOT NULL");
    // A primeira conta criada é a administradora da plataforma
    db.exec(
      "UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users) AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1)",
    );
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return db;
}
