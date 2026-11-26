// SQLite 访问层：node:sqlite（Node >= 22.5，Termux 的 nodejs-lts 24.x 可用）
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  pass_hash     TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip         TEXT,
  ua         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS user_stores (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bank_slug  TEXT NOT NULL DEFAULT 'builtin',
  rev        INTEGER NOT NULL DEFAULT 0,
  doc        TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, bank_slug)
);

CREATE TABLE IF NOT EXISTS mock_exams (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bank_slug    TEXT NOT NULL,
  status       TEXT NOT NULL,
  question_ids TEXT NOT NULL,
  responses    TEXT NOT NULL DEFAULT '{}',
  plan_sec     INTEGER NOT NULL,
  started_at   TEXT NOT NULL,
  submitted_at TEXT,
  score        INTEGER,
  correct_cnt  INTEGER,
  total        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mock_user ON mock_exams(user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS banks (
  slug         TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  subject      TEXT NOT NULL DEFAULT 'builtin',
  bank_version TEXT NOT NULL,
  payload      TEXT NOT NULL,
  question_cnt INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 100,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  action     TEXT NOT NULL,
  detail     TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function nowIso() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * 轻量迁移：`CREATE TABLE IF NOT EXISTS` 不会改已有表的列。
 * user_stores 从「每用户一份」改成「每用户每题库一份」时，老库需要重建。
 */
function migrate(conn) {
  const cols = conn.prepare("PRAGMA table_info(user_stores)").all();
  const hasBankSlug = cols.some((c) => c.name === "bank_slug");
  if (cols.length > 0 && !hasBankSlug) {
    conn.exec("ALTER TABLE user_stores RENAME TO user_stores_old");
    conn.exec(`CREATE TABLE user_stores (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bank_slug  TEXT NOT NULL DEFAULT 'builtin',
      rev        INTEGER NOT NULL DEFAULT 0,
      doc        TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, bank_slug)
    )`);
    // 老数据未知属于哪个题库：按「内置题库」继承，但仍保留原 rev 语义
    conn.exec(
      "INSERT INTO user_stores (user_id, bank_slug, rev, doc, updated_at) " +
        "SELECT user_id, 'builtin', rev, doc, updated_at FROM user_stores_old"
    );
    conn.exec("DROP TABLE user_stores_old");
    console.log("[db] 已迁移 user_stores：加上 bank_slug，老数据归入 builtin");
  }
}

export function openDb(file = config.dbPath) {
  if (db) return db;
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function getDb() {
  if (!db) openDb();
  return db;
}

export function closeDb() {
  if (db) {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
    db = null;
  }
}

/** 单行查询 */
export function one(sql, ...params) {
  const stmt = getDb().prepare(sql);
  return stmt.get(...params) ?? null;
}

/** 多行查询 */
export function all(sql, ...params) {
  const stmt = getDb().prepare(sql);
  return stmt.all(...params);
}

/** 写入，返回 {changes, lastId} */
export function run(sql, ...params) {
  const stmt = getDb().prepare(sql);
  const info = stmt.run(...params);
  return { changes: Number(info.changes ?? 0), lastId: Number(info.lastInsertRowid ?? 0) };
}

/** 事务：fn 抛错则整体回滚 */
export function tx(fn) {
  const conn = getDb();
  conn.exec("BEGIN IMMEDIATE");
  try {
    const out = fn(conn);
    conn.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      conn.exec("ROLLBACK");
    } catch {
      /* 回滚失败时保留原始错误 */
    }
    throw err;
  }
}

export function getMeta(key, fallback = null) {
  const row = one("SELECT value FROM meta WHERE key = ?", key);
  return row ? row.value : fallback;
}

export function setMeta(key, value) {
  run(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    String(value)
  );
}

/** 备份到文件（供定时任务或管理接口调用） */
export async function backupTo(dir) {
  const target = path.join(dir);
  fs.mkdirSync(target, { recursive: true });
  const stamp = nowIso().replace(/[:+]/g, "").replace("T", "-").slice(0, 15);
  const file = path.join(target, `app-${stamp}.db`);
  await getDb().backup(file);
  return file;
}
