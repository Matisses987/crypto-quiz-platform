// 账号与会话：scrypt 口令散列、会话 token、登录限流
import crypto from "node:crypto";
import { config } from "./config.js";
import { all, nowIso, one, run } from "./db.js";
import { HttpError, badRequest, tooMany, unauthorized } from "./http.js";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  let actual;
  try {
    actual = crypto.scryptSync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 128 * N * r * 2,
    });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

const USERNAME_RE = /^[A-Za-z0-9_.\-\u4e00-\u9fa5]{3,24}$/;

export function validateCredentials(username, password) {
  const name = typeof username === "string" ? username.trim() : "";
  const pwd = typeof password === "string" ? password : "";
  if (!USERNAME_RE.test(name)) {
    throw badRequest("用户名需为 3–24 位，可用字母、数字、下划线、点、连字符或中文");
  }
  if (pwd.length < 8 || pwd.length > 128) {
    throw badRequest("密码长度需为 8–128 位");
  }
  return { username: name, password: pwd };
}

export function normalizeDisplayName(input, fallback) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return fallback;
  return raw.slice(0, 20);
}

/* ---------------- 登录限流 ---------------- */

const WINDOW_MS = 60_000;
const IP_LIMIT = 12;
const USER_FAIL_LIMIT = 5;
const USER_LOCK_MS = 5 * 60_000;

const ipHits = new Map();
const userFails = new Map();

function purge(map, ttl) {
  const now = Date.now();
  for (const [key, value] of map) {
    const stamp = Array.isArray(value) ? value[value.length - 1] : value.at;
    if (!stamp || now - stamp > ttl) map.delete(key);
  }
}

/**
 * 登录前检查。
 * - 通道一：按 IP（仅在前方有可信代理、能拿到真实 IP 时才有意义）
 * - 通道二：按用户名（TCP 隧道下所有请求都来自 127.0.0.1，必须靠这条）
 */
export function checkLoginAllowed(username, ipInfo) {
  purge(ipHits, WINDOW_MS);
  purge(userFails, USER_LOCK_MS);

  const key = String(username || "").toLowerCase();
  const locked = userFails.get(key);
  if (locked && locked.count >= USER_FAIL_LIMIT && Date.now() - locked.at < USER_LOCK_MS) {
    const left = Math.ceil((USER_LOCK_MS - (Date.now() - locked.at)) / 1000);
    throw tooMany(`该账号连续登录失败次数过多，请 ${left} 秒后再试`);
  }

  if (ipInfo && !ipInfo.loopback) {
    const hits = (ipHits.get(ipInfo.ip) || []).filter((t) => Date.now() - t < WINDOW_MS);
    if (hits.length >= IP_LIMIT) throw tooMany("登录尝试过于频繁，请稍后再试");
    hits.push(Date.now());
    ipHits.set(ipInfo.ip, hits);
  }
}

export function noteLoginFailure(username) {
  const key = String(username || "").toLowerCase();
  const prev = userFails.get(key);
  const recent = prev && Date.now() - prev.at < USER_LOCK_MS ? prev.count : 0;
  userFails.set(key, { count: recent + 1, at: Date.now() });
}

export function noteLoginSuccess(username) {
  userFails.delete(String(username || "").toLowerCase());
}

/* ---------------- 会话 ---------------- */

export function createSession(userId, { ip, ua } = {}) {
  const token = crypto.randomBytes(32).toString("hex");
  const created = new Date();
  const expires = new Date(created.getTime() + config.sessionDays * 86_400_000);
  run(
    "INSERT INTO sessions(token, user_id, created_at, expires_at, ip, ua) VALUES(?,?,?,?,?,?)",
    token,
    userId,
    toIso(created),
    toIso(expires),
    ip || null,
    String(ua || "").slice(0, 200) || null
  );
  return { token, expiresAt: toIso(expires), maxAgeSec: config.sessionDays * 86_400 };
}

function toIso(date) {
  const pad = (n) => String(n).padStart(2, "0");
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export function sessionUser(token) {
  if (!token) return null;
  const row = one(
    `SELECT s.token, s.expires_at, u.id, u.username, u.display_name, u.role, u.disabled
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`,
    token
  );
  if (!row) return null;
  if (parseIso(row.expires_at) <= Date.now()) {
    run("DELETE FROM sessions WHERE token = ?", token);
    return null;
  }
  if (row.disabled) {
    run("DELETE FROM sessions WHERE token = ?", token);
    throw new HttpError(403, "账号已被停用");
  }
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
  };
}

function parseIso(text) {
  const t = Date.parse(String(text || ""));
  return Number.isFinite(t) ? t : 0;
}

export function destroySession(token) {
  if (token) run("DELETE FROM sessions WHERE token = ?", token);
}

export function destroyUserSessions(userId, exceptToken) {
  if (exceptToken) {
    run("DELETE FROM sessions WHERE user_id = ? AND token <> ?", userId, exceptToken);
  } else {
    run("DELETE FROM sessions WHERE user_id = ?", userId);
  }
}

export function cleanExpiredSessions() {
  const cutoff = toIso(new Date(Date.now() - 86_400_000));
  const { changes } = run("DELETE FROM sessions WHERE expires_at < ?", cutoff);
  return changes;
}

/* ---------------- 用户 ---------------- */

export function findUserByUsername(username) {
  return one("SELECT * FROM users WHERE username = ? COLLATE NOCASE", username);
}

export function countUsers() {
  return all("SELECT count(*) AS c FROM users")[0].c;
}

export function createUser({ username, password, displayName, role }) {
  const hashed = hashPassword(password);
  const isFirst = countUsers() === 0;
  const finalRole = role || (isFirst ? "admin" : "user");
  const { lastId } = run(
    "INSERT INTO users(username, pass_hash, display_name, role, created_at) VALUES(?,?,?,?,?)",
    username,
    hashed,
    normalizeDisplayName(displayName, username),
    finalRole,
    nowIso()
  );
  return one("SELECT id, username, display_name, role FROM users WHERE id = ?", lastId);
}

export function requireUser(req) {
  const user = req.user;
  if (!user) throw unauthorized();
  return user;
}
