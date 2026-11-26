// 配置加载：.env（可选）+ 环境变量 + 内置默认值
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 极简 .env 解析：KEY=VALUE，支持 # 注释、单双引号、CRLF */
function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    } else {
      const hash = val.indexOf(" #");
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    out[key] = val;
  }
  return out;
}

function loadDotEnv(root) {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return {};
  try {
    return parseEnv(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.warn(`[config] 读取 .env 失败，改用环境变量：${err && err.code ? err.code : "ERR"}`);
    return {};
  }
}

const fileEnv = loadDotEnv(ROOT);

function raw(key) {
  if (process.env[key] !== undefined && process.env[key] !== "") return process.env[key];
  if (fileEnv[key] !== undefined && fileEnv[key] !== "") return fileEnv[key];
  return undefined;
}

function str(key, fallback) {
  const v = raw(key);
  return v === undefined ? fallback : v;
}

function int(key, fallback, min, max) {
  const v = raw(key);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

function bool(key, fallback) {
  const v = raw(key);
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function resolvePath(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

export const config = {
  root: ROOT,
  host: str("HOST", "127.0.0.1"),
  port: int("PORT", 3010, 1, 65535),

  dbPath: resolvePath(str("CQP_DB", "data/app.db")),
  backupDir: resolvePath(str("CQP_BACKUP_DIR", "data/backup")),
  backupCron: str("CQP_BACKUP_CRON", "03:10"),
  seedDir: resolvePath(str("CQP_SEED_DIR", "data/seed")),
  uploadDir: resolvePath(str("CQP_UPLOAD_DIR", "data/banks")),

  allowRegister: bool("CQP_ALLOW_REGISTER", true),
  sessionDays: int("CQP_SESSION_DAYS", 7, 1, 90),
  bootstrapAdmin: str("CQP_BOOTSTRAP_ADMIN", ""),
  bootstrapPassword: str("CQP_BOOTSTRAP_PASSWORD", ""),

  cookieSecure: bool("CQP_COOKIE_SECURE", false),
  trustProxy: bool("CQP_TRUST_PROXY", false),
  maxBody: int("CQP_MAX_BODY", 2 * 1024 * 1024, 1024, 64 * 1024 * 1024),
  maxBankBody: int("CQP_MAX_BANK_BODY", 8 * 1024 * 1024, 1024, 128 * 1024 * 1024),

  cookieName: str("CQP_COOKIE_NAME", "cqp_sid"),
  publicDir: resolvePath(str("CQP_PUBLIC_DIR", "public")),
  bankFile: resolvePath(str("CQP_BANK_FILE", "src/data/bank.json")),
};

export function assertTimezone() {
  if (process.env.TZ === undefined) process.env.TZ = "Asia/Shanghai";
  const offset = new Date().getTimezoneOffset();
  if (offset !== -480) {
    console.warn(`[config] 时区偏移 ${offset} 分钟，期望 -480（Asia/Shanghai）；请检查 TZ 设置`);
  }
  return offset;
}
