import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, openDb } from "./db.js";

const sqlite = process.getBuiltinModule("node:sqlite");
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "concord-db-"));
  dirs.push(dir);
  return join(dir, "teste.db");
}

/** Banco no formato antigo (versão 0): mensagens só de canal, sem conversas diretas. */
function createLegacyDb(path: string) {
  const db = new sqlite.DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE channels (id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE, name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (server_id, name));
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
    CREATE INDEX idx_messages_channel ON messages (channel_id, id);
    INSERT INTO users (username, password_hash) VALUES ('ana', 'x');
    INSERT INTO servers (name, owner_id) VALUES ('Os Parças', 1);
    INSERT INTO channels (server_id, name) VALUES (1, 'geral');
    INSERT INTO messages (channel_id, user_id, content, created_at) VALUES (1, 1, 'antiga 1', '2026-01-01T10:00:00.000Z');
    INSERT INTO messages (channel_id, user_id, content, created_at) VALUES (1, 1, 'antiga 2', '2026-01-01T10:01:00.000Z');
  `);
  db.close();
}

const version = (db: ReturnType<typeof openDb>) => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

describe("migração do banco", () => {
  it("um banco novo já nasce na versão atual", () => {
    const db = openDb();
    expect(version(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("preserva as mensagens de um banco antigo e passa a aceitar mensagens diretas", () => {
    const path = tempDbPath();
    createLegacyDb(path);

    const db = openDb(path);
    expect(version(db)).toBe(SCHEMA_VERSION);

    const antigas = db.prepare("SELECT id, channel_id, dm_id, content, created_at FROM messages ORDER BY id").all();
    expect(antigas).toEqual([
      { id: 1, channel_id: 1, dm_id: null, content: "antiga 1", created_at: "2026-01-01T10:00:00.000Z" },
      { id: 2, channel_id: 1, dm_id: null, content: "antiga 2", created_at: "2026-01-01T10:01:00.000Z" },
    ]);

    // os ids novos continuam de onde pararam e uma mensagem de DM é aceita
    db.exec("INSERT INTO users (username, password_hash) VALUES ('beto', 'x')");
    db.exec("INSERT INTO dm_conversations (user_a, user_b) VALUES (1, 2)");
    const dm = db.prepare("INSERT INTO messages (dm_id, user_id, content) VALUES (1, 1, 'nova')").run();
    expect(Number(dm.lastInsertRowid)).toBe(3);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'messages_v0'").get()).toEqual({ n: 0 });
    db.close();
  });

  it("recria os índices do banco antigo", () => {
    const path = tempDbPath();
    createLegacyDb(path);
    const db = openDb(path);
    const indices = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'").all() as { name: string }[];
    expect(indices.map((i) => i.name).sort()).toEqual(["idx_messages_channel", "idx_messages_dm"]);
    db.close();
  });

  it("abrir de novo um banco já migrado não muda nada", () => {
    const path = tempDbPath();
    createLegacyDb(path);
    openDb(path).close();
    const db = openDb(path);
    expect(version(db)).toBe(SCHEMA_VERSION);
    expect((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBe(2);
    db.close();
  });

  it("um banco na versão 1 ganha a coluna edited_at sem perder mensagens", () => {
    const path = tempDbPath();
    const v1 = new sqlite.DatabaseSync(path);
    v1.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE channels (id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE, name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (server_id, name));
      CREATE TABLE dm_conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_a INTEGER NOT NULL, user_b INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (user_a, user_b), CHECK (user_a < user_b));
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE, dm_id INTEGER REFERENCES dm_conversations(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        CHECK ((channel_id IS NULL) != (dm_id IS NULL)));
      INSERT INTO users (username, password_hash) VALUES ('ana', 'x');
      INSERT INTO servers (name, owner_id) VALUES ('s', 1);
      INSERT INTO channels (server_id, name) VALUES (1, 'geral');
      INSERT INTO messages (channel_id, user_id, content) VALUES (1, 1, 'da versão 1');
      PRAGMA user_version = 1;
    `);
    v1.close();

    const db = openDb(path);
    expect(version(db)).toBe(SCHEMA_VERSION);
    expect(db.prepare("SELECT content, edited_at FROM messages").all()).toEqual([{ content: "da versão 1", edited_at: null }]);
    db.exec("UPDATE messages SET edited_at = '2026-01-01T00:00:00.000Z'");
    db.close();
    const reaberto = openDb(path); // abrir de novo não tenta adicionar a coluna outra vez
    expect(version(reaberto)).toBe(SCHEMA_VERSION);
    reaberto.close();
  });

  it("um banco na versão 2 ganha as colunas de áudio; duração e tipo vêm juntos", () => {
    const path = tempDbPath();
    const v2 = new sqlite.DatabaseSync(path);
    v2.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE channels (id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE, name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (server_id, name));
      CREATE TABLE dm_conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_a INTEGER NOT NULL, user_b INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (user_a, user_b), CHECK (user_a < user_b));
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE, dm_id INTEGER REFERENCES dm_conversations(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), edited_at TEXT,
        CHECK ((channel_id IS NULL) != (dm_id IS NULL)));
      INSERT INTO users (username, password_hash) VALUES ('ana', 'x');
      INSERT INTO servers (name, owner_id) VALUES ('s', 1);
      INSERT INTO channels (server_id, name) VALUES (1, 'geral');
      INSERT INTO messages (channel_id, user_id, content) VALUES (1, 1, 'da versão 2');
      PRAGMA user_version = 2;
    `);
    v2.close();

    const db = openDb(path);
    expect(version(db)).toBe(SCHEMA_VERSION);
    expect(db.prepare("SELECT content, audio_ms, audio_mime FROM messages").all()).toEqual([
      { content: "da versão 2", audio_ms: null, audio_mime: null },
    ]);
    db.exec("UPDATE messages SET audio_ms = 1500, audio_mime = 'audio/webm'");
    db.close();
    openDb(path).close(); // reabrir não tenta adicionar as colunas de novo
  });

  it("em banco novo, áudio só existe com duração e tipo juntos", () => {
    const db = openDb();
    db.exec("INSERT INTO users (username, password_hash) VALUES ('a', 'x')");
    db.exec("INSERT INTO servers (name, owner_id) VALUES ('s', 1)");
    db.exec("INSERT INTO channels (server_id, name) VALUES (1, 'geral')");
    expect(() => db.exec("INSERT INTO messages (channel_id, user_id, content, audio_ms) VALUES (1, 1, '', 100)")).toThrow();
    db.exec("INSERT INTO messages (channel_id, user_id, content, audio_ms, audio_mime) VALUES (1, 1, '', 100, 'audio/webm')");
    db.close();
  });

  it("um banco antigo ganha channels.type = 'text' e só aceita text ou voice", () => {
    const path = tempDbPath();
    const v3 = new sqlite.DatabaseSync(path);
    v3.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE channels (id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE, name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (server_id, name));
      CREATE TABLE dm_conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_a INTEGER NOT NULL, user_b INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (user_a, user_b), CHECK (user_a < user_b));
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE, dm_id INTEGER REFERENCES dm_conversations(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), edited_at TEXT, audio_ms INTEGER, audio_mime TEXT,
        CHECK ((channel_id IS NULL) != (dm_id IS NULL)));
      INSERT INTO users (username, password_hash) VALUES ('ana', 'x');
      INSERT INTO servers (name, owner_id) VALUES ('s', 1);
      INSERT INTO channels (server_id, name) VALUES (1, 'geral');
      PRAGMA user_version = 3;
    `);
    v3.close();

    const db = openDb(path);
    expect(version(db)).toBe(SCHEMA_VERSION);
    expect(db.prepare("SELECT name, type FROM channels").all()).toEqual([{ name: "geral", type: "text" }]);
    db.exec("INSERT INTO channels (server_id, name, type) VALUES (1, 'sala', 'voice')");
    expect(() => db.exec("INSERT INTO channels (server_id, name, type) VALUES (1, 'x', 'video')")).toThrow();
    db.close();
    openDb(path).close(); // reabrir não tenta adicionar a coluna de novo
  });

  it("recusa mensagem sem canal e sem conversa, ou com os dois", () => {
    const db = openDb();
    db.exec("INSERT INTO users (username, password_hash) VALUES ('a', 'x'), ('b', 'x')");
    db.exec("INSERT INTO servers (name, owner_id) VALUES ('s', 1)");
    db.exec("INSERT INTO channels (server_id, name) VALUES (1, 'geral')");
    db.exec("INSERT INTO dm_conversations (user_a, user_b) VALUES (1, 2)");
    expect(() => db.exec("INSERT INTO messages (user_id, content) VALUES (1, 'x')")).toThrow();
    expect(() => db.exec("INSERT INTO messages (channel_id, dm_id, user_id, content) VALUES (1, 1, 1, 'x')")).toThrow();
    db.close();
  });

  it("só aceita um registro de conversa por par, e na ordem certa", () => {
    const db = openDb();
    db.exec("INSERT INTO users (username, password_hash) VALUES ('a', 'x'), ('b', 'x')");
    db.exec("INSERT INTO dm_conversations (user_a, user_b) VALUES (1, 2)");
    expect(() => db.exec("INSERT INTO dm_conversations (user_a, user_b) VALUES (1, 2)")).toThrow();
    expect(() => db.exec("INSERT INTO dm_conversations (user_a, user_b) VALUES (2, 1)")).toThrow(); // CHECK a < b
    db.close();
  });
});

describe("migração para a versão 5 (cargos, convites de uso único, conta)", () => {
  it("um banco da versão 4 ganha cargos, os membros viram Membro, a primeira conta vira administradora", () => {
    const path = tempDbPath();
    const v4 = new sqlite.DatabaseSync(path);
    v4.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE members (server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, joined_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (server_id, user_id));
      CREATE TABLE invites (code TEXT PRIMARY KEY, server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE channels (id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE, name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), type TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'voice')),
        UNIQUE (server_id, name));
      CREATE TABLE dm_conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_a INTEGER NOT NULL, user_b INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (user_a, user_b), CHECK (user_a < user_b));
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE, dm_id INTEGER REFERENCES dm_conversations(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), edited_at TEXT, audio_ms INTEGER, audio_mime TEXT,
        CHECK ((channel_id IS NULL) != (dm_id IS NULL)));
      INSERT INTO users (username, password_hash) VALUES ('ana', 'x'), ('beto', 'x');
      INSERT INTO servers (name, owner_id) VALUES ('s', 1);
      INSERT INTO members (server_id, user_id) VALUES (1, 1), (1, 2);
      INSERT INTO invites (code, server_id, created_by) VALUES ('antigo', 1, 1);
      INSERT INTO channels (server_id, name) VALUES (1, 'geral');
      INSERT INTO messages (channel_id, user_id, content) VALUES (1, 1, 'mensagem antiga');
      PRAGMA user_version = 4;
    `);
    v4.close();

    const db = openDb(path);
    expect(version(db)).toBe(SCHEMA_VERSION);
    expect((db.prepare("SELECT name, is_default FROM roles ORDER BY id").all() as { name: string; is_default: number }[]).map((r) => [r.name, r.is_default])).toEqual([
      ["Membro", 1],
      ["Convidador", 0],
      ["Moderador", 0],
    ]);
    const membros = db.prepare("SELECT m.user_id, r.name FROM members m LEFT JOIN roles r ON r.id = m.role_id ORDER BY m.user_id").all();
    expect(membros).toEqual([
      { user_id: 1, name: null }, // o dono não tem cargo
      { user_id: 2, name: "Membro" },
    ]);
    expect(db.prepare("SELECT username, is_admin FROM users ORDER BY id").all()).toEqual([
      { username: "ana", is_admin: 1 },
      { username: "beto", is_admin: 0 },
    ]);
    expect(db.prepare("SELECT used_by, revoked_at FROM invites").all()).toEqual([{ used_by: null, revoked_at: null }]);
    expect(db.prepare("SELECT display_name, about, status_kind, avatar_version FROM users ORDER BY id").all()).toEqual([
      { display_name: null, about: "", status_kind: "online", avatar_version: 0 },
      { display_name: null, about: "", status_kind: "online", avatar_version: 0 },
    ]);
    expect(db.prepare("SELECT icon_version FROM servers").all()).toEqual([{ icon_version: 0 }]);
    // mensagens ricas (v7): a mensagem antiga continua igual, sem resposta, fixação nem anexo
    expect(db.prepare("SELECT content, reply_to, pinned_at, att_name, att_kind FROM messages").all()).toEqual([
      { content: "mensagem antiga", reply_to: null, pinned_at: null, att_name: null, att_kind: null },
    ]);
    db.exec("INSERT INTO reactions (message_id, user_id, emoji) VALUES (1, 1, '👍')");
    expect(() => db.exec("INSERT INTO reactions (message_id, user_id, emoji) VALUES (1, 1, '👍')")).toThrow(); // uma por pessoa e emoji
    expect(() => db.exec("UPDATE messages SET att_kind = 'video'")).toThrow(); // CHECK image|file
    db.exec("DELETE FROM messages");
    expect((db.prepare("SELECT COUNT(*) AS n FROM reactions").get() as { n: number }).n).toBe(0); // reação some com a mensagem
    db.exec("INSERT INTO link_previews (url, ok) VALUES ('https://x.com', 0)");
    // avisos (v8): leitura e silenciar por pessoa, com tipos conferidos
    db.exec("INSERT INTO read_state (user_id, kind, target_id, last_read_id) VALUES (1, 'channel', 1, 5)");
    db.exec("INSERT INTO mutes (user_id, kind, target_id) VALUES (1, 'server', 1)");
    expect(() => db.exec("INSERT INTO mutes (user_id, kind, target_id) VALUES (1, 'outro', 1)")).toThrow();
    expect(() => db.exec("INSERT INTO mutes (user_id, kind, target_id) VALUES (1, 'server', 1)")).toThrow(); // não duplica
    // servidor flexível (v9): canais antigos seguem públicos e liberados; categoria some sem apagar o canal; apelido começa vazio
    expect(db.prepare("SELECT name, category_id, read_only, private FROM channels").all()).toEqual([{ name: 'geral', category_id: null, read_only: 0, private: 0 }]);
    db.exec("INSERT INTO categories (server_id, name) VALUES (1, 'Jogos')");
    db.exec("UPDATE channels SET category_id = 1");
    db.exec("DELETE FROM categories");
    expect((db.prepare("SELECT category_id FROM channels").get() as { category_id: number | null }).category_id).toBeNull();
    db.exec("INSERT INTO channel_roles (channel_id, role_id) VALUES (1, 1)");
    expect(() => db.exec("INSERT INTO channel_roles (channel_id, role_id) VALUES (1, 1)")).toThrow();
    expect(db.prepare("SELECT nickname FROM members ORDER BY user_id").all()).toEqual([{ nickname: null }, { nickname: null }]);
    // login externo (v13): um de cada provedor por conta; a chave é provedor + id no provedor; some junto com a conta
    db.exec("INSERT INTO identities (provider, subject, user_id) VALUES ('google', 'g-1', 1)");
    expect(() => db.exec("INSERT INTO identities (provider, subject, user_id) VALUES ('google', 'g-1', 2)")).toThrow(); // mesma identidade em outra conta
    expect(() => db.exec("INSERT INTO identities (provider, subject, user_id) VALUES ('google', 'g-2', 1)")).toThrow(); // dois Google na mesma conta
    expect(() => db.exec("INSERT INTO identities (provider, subject, user_id) VALUES ('facebook', 'f-1', 1)")).toThrow(); // provedor desconhecido
    db.exec("INSERT INTO identities (provider, subject, user_id) VALUES ('github', 'g-1', 2)"); // outro provedor com o mesmo id é outra identidade
    db.exec("DELETE FROM users WHERE id = 2");
    expect((db.prepare("SELECT COUNT(*) AS n FROM identities WHERE user_id = 2").get() as { n: number }).n).toBe(0);
    db.close();
    openDb(path).close(); // reabrir não repete nada nem duplica cargos
    const de_novo = openDb(path);
    expect((de_novo.prepare("SELECT COUNT(*) AS n FROM roles").get() as { n: number }).n).toBe(3);
    de_novo.close();
  });
});
