// 服务端入口：装配路由、静态资源、会话与错误处理
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { config, assertTimezone } from "./config.js";
import { all, backupTo, closeDb, getMeta, nowIso, one, openDb, run, setMeta } from "./db.js";
import {
  HttpError,
  assertSameOrigin,
  badRequest,
  buildCookie,
  clearCookieHeader,
  clientIp,
  createRouter,
  forbidden,
  notFound,
  parseCookies,
  readJson,
  route,
  sendError,
  sendJson,
  serveStatic,
} from "./http.js";
import {
  checkLoginAllowed,
  cleanExpiredSessions,
  createSession,
  createUser,
  destroySession,
  destroyUserSessions,
  findUserByUsername,
  hashPassword,
  noteLoginFailure,
  noteLoginSuccess,
  normalizeDisplayName,
  requireUser,
  sessionUser,
  validateCredentials,
  verifyPassword,
} from "./auth.js";
import { ensureBuiltinBank, seedBanks } from "./banks.js";
import { registerStoreRoutes } from "./routes-data.js";
import { registerAdminRoutes } from "./admin.js";

const startedAt = Date.now();
const router = createRouter();

/* ---------------- 健康检查 ---------------- */

router.get("/api/health", (req, res) => {
  sendJson(res, 200, {
    ok: true,
    rev: Number(getMeta("storeRev", "0")),
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    node: process.version,
  });
});

/* ---------------- 账号 ---------------- */

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name ?? row.displayName,
    role: row.role,
  };
}

router.post("/api/auth/register", async (req, res) => {
  if (!config.allowRegister) throw forbidden("当前未开放注册，请联系管理员建号");
  assertSameOrigin(req);
  const body = await readJson(req);
  const { username, password } = validateCredentials(body.username, body.password);
  if (findUserByUsername(username)) throw badRequest("该用户名已被占用");

  let user;
  try {
    user = createUser({ username, password, displayName: body.displayName });
  } catch (err) {
    if (String(err && err.message).includes("UNIQUE")) throw badRequest("该用户名已被占用");
    throw err;
  }

  const ipInfo = clientIp(req);
  const session = createSession(user.id, { ip: ipInfo.ip, ua: req.headers["user-agent"] });
  res.setHeader("Set-Cookie", buildCookie(config.cookieName, session.token, { maxAgeSec: session.maxAgeSec }));
  sendJson(res, 201, { ok: true, user: publicUser(user) });
});

router.post("/api/auth/login", async (req, res) => {
  assertSameOrigin(req);
  const body = await readJson(req);
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!username || !password) throw badRequest("请填写用户名和密码");

  const ipInfo = clientIp(req);
  checkLoginAllowed(username, ipInfo);

  const row = findUserByUsername(username);
  // 先验密码再判停用：密码对了才告诉他被停用（这样不会泄露"这个账号存在"）
  const passwordOk = Boolean(row) && verifyPassword(password, row.pass_hash);
  if (!passwordOk) {
    noteLoginFailure(username);
    throw new HttpError(401, "用户名或密码错误");
  }
  if (row.disabled) {
    noteLoginFailure(username);
    throw new HttpError(403, "账号已被停用，请联系管理员");
  }
  noteLoginSuccess(username);

  const session = createSession(row.id, { ip: ipInfo.ip, ua: req.headers["user-agent"] });
  res.setHeader("Set-Cookie", buildCookie(config.cookieName, session.token, { maxAgeSec: session.maxAgeSec }));
  sendJson(res, 200, { ok: true, user: publicUser(row) });
});

router.post("/api/auth/logout", async (req, res) => {
  assertSameOrigin(req);
  destroySession(parseCookies(req)[config.cookieName]);
  res.setHeader("Set-Cookie", clearCookieHeader(config.cookieName));
  sendJson(res, 200, { ok: true });
});

router.post("/api/auth/password", async (req, res) => {
  assertSameOrigin(req);
  const user = requireUser(req);
  const body = await readJson(req);
  const current = String(body.currentPassword || "");
  const next = String(body.newPassword || "");
  if (next.length < 8 || next.length > 128) throw badRequest("新密码长度需为 8–128 位");

  const row = findUserByUsername(user.username);
  if (!row || !verifyPassword(current, row.pass_hash)) throw badRequest("当前密码不正确");

  run("UPDATE users SET pass_hash = ? WHERE id = ?", hashPassword(next), user.id);
  destroyUserSessions(user.id, parseCookies(req)[config.cookieName]);
  sendJson(res, 200, { ok: true });
});

router.post("/api/auth/profile", async (req, res) => {
  assertSameOrigin(req);
  const user = requireUser(req);
  const body = await readJson(req);
  const displayName = normalizeDisplayName(body.displayName, user.username);
  run("UPDATE users SET display_name = ? WHERE id = ?", displayName, user.id);
  const row = one("SELECT id, username, display_name, role, created_at FROM users WHERE id = ?", user.id);
  sendJson(res, 200, { ok: true, user: publicUser(row) });
});

router.get("/api/me", (req, res) => {
  if (!req.user) {
    sendJson(res, 200, { user: null });
    return;
  }
  sendJson(res, 200, { user: req.user, serverTime: nowIso() });
});

/* ---------------- 业务路由（题库 / 文档 / 判分 / 团队） ---------------- */

registerStoreRoutes(router, { requireUser });

/* ---------------- 管理后台（题库上传 / 用户管理 / 审计） ---------------- */

registerAdminRoutes(router, { requireUser });

/* ---------------- 首个管理员 ---------------- */

async function bootstrapAdmin() {
  const count = all("SELECT count(*) AS c FROM users")[0].c;
  if (count > 0) return;
  if (!config.bootstrapAdmin || !config.bootstrapPassword) {
    console.log("[boot] users 表为空；第一个注册的账号将成为管理员");
    return;
  }
  try {
    const { username, password } = validateCredentials(config.bootstrapAdmin, config.bootstrapPassword);
    const user = createUser({ username, password, displayName: username, role: "admin" });
    console.log(`[boot] 已创建管理员 ${user.username}（id=${user.id}）`);
  } catch (err) {
    console.warn(`[boot] 创建管理员失败：${err && err.message ? err.message : "未知错误"}`);
  }
}

/* ---------------- 分发 ---------------- */

async function handle(req, res) {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  const pathname = url.pathname;

  if (req.method === "GET" || req.method === "HEAD") {
    if (!pathname.startsWith("/api/")) {
      const target = pathname === "/" ? "index.html" : pathname;
      if (serveStatic(req, res, target)) return;
      throw notFound("页面不存在");
    }
  }

  const matched = router.match(req.method, pathname);
  if (!matched) throw notFound("接口不存在");

  const token = parseCookies(req)[config.cookieName];
  let user = null;
  try {
    user = sessionUser(token);
  } catch (err) {
    if (err instanceof HttpError && err.status === 403) {
      res.setHeader("Set-Cookie", clearCookieHeader(config.cookieName));
      throw err;
    }
    user = null;
  }
  req.user = user;
  req.token = token;
  req.params = matched.params;
  req.query = url.searchParams;
  req.client = clientIp(req);
  req.ip = req.client.ip;

  await matched.handler(req, res, url);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    sendError(res, err, (e) => {
      console.error("[err]", req.method, req.url, e && e.stack ? e.stack : e);
    });
  });
});

/**
 * keep-alive 超时：默认 5 秒太短，经 frpc / cloudflared 这类反代时会出现
 * 「服务端刚准备关掉空闲连接、反代正好在这条连接上发请求」→ 浏览器侧表现为
 * net::ERR_CONNECTION_CLOSED（偶发、只在提交这类 POST 上被用户看见）。
 * 把空闲窗口拉到 72 秒（大于常见反代的 60 秒空闲超时），让关连接的决定
 * 总是由反代先做出，node 侧就不会成为那个「主动 RST 的人」。
 */
server.keepAliveTimeout = 72 * 1000;
server.headersTimeout = 75 * 1000;
server.requestTimeout = 120 * 1000;

/**
 * 页面产物缺失时自动构建一次。
 * `public/` 是构建产物（被 .gitignore 忽略），克隆仓库后只有源码没有 index.html；
 * 不自动构建的话服务端会一路 404「页面不存在」，看起来像坏掉了。
 */
function ensurePublicArtifact() {
  const indexPath = path.join(config.publicDir, "index.html");
  if (fs.existsSync(indexPath)) return { built: false, indexPath };
  try {
    console.log("[boot] 未找到页面产物，正在构建 public/index.html…");
    execFileSync(process.execPath, [path.join(config.root, "tools", "build.mjs"), "--target", "server", "--strict", "--quiet"], {
      cwd: config.root,
      stdio: "inherit",
    });
    console.log(`[boot] 页面已构建：${indexPath}`);
    return { built: true, indexPath };
  } catch (err) {
    console.error("[boot] 页面构建失败：", err && err.message ? err.message : err);
    console.error("[boot] 请手动运行 npm run build 后重启服务");
    return { built: false, indexPath, failed: true };
  }
}

export function start({ port = config.port, host = config.host } = {}) {
  assertTimezone();
  openDb();
  const removed = cleanExpiredSessions();
  if (removed > 0) console.log(`[boot] 清理过期会话 ${removed} 条`);
  setMeta("bootAt", nowIso());
  ensurePublicArtifact();

  try {
    const builtin = ensureBuiltinBank();
    console.log(
      builtin.skipped
        ? `[boot] 内置题库沿用库内版本（${builtin.reason}）`
        : `[boot] 内置题库已导入：${builtin.questionCount} 题（${builtin.created ? "新建" : "更新"}）`
    );
  } catch (err) {
    console.error("[boot] 内置题库导入失败：", err && err.message ? err.message : err);
  }

  try {
    const seeded = seedBanks();
    if (seeded.imported.length > 0) {
      for (const item of seeded.imported) {
        console.log(`[boot] 种子题库 ${item.slug}：${item.questionCount} 题（${item.created ? "新建" : "更新"}）`);
      }
    }
    for (const bad of seeded.failed) {
      console.warn(`[boot] 种子题库 ${bad.file} 导入失败：${bad.error}`);
    }
  } catch (err) {
    console.error("[boot] 种子题库导入失败：", err && err.message ? err.message : err);
  }

  return bootstrapAdmin().then(
    () =>
      new Promise((resolve) => {
        server.listen(port, host, () => {
          console.log(`[boot] 服务已启动 http://${host}:${port}`);
          console.log(`[boot] 数据库 ${config.dbPath}`);
          console.log(`[boot] 静态目录 ${config.publicDir}`);
          resolve(server);
        });
      })
  );
}

function shutdown(signal) {
  console.log(`\n[shutdown] 收到 ${signal}，正在关闭…`);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

export { server, handle, router, backupTo };

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entry && import.meta.url === entry) {
  start().catch((err) => {
    console.error("[boot] 启动失败", err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
