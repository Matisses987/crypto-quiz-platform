// 管理后台：题库上传/删除、用户管理、审计日志
// 设计见 docs/服务器版改造计划.md §6.2 P4 / P5
import { all, nowIso, one, run } from "./db.js";
import {
  assertSameOrigin,
  badRequest,
  forbidden,
  notFound,
  readJson,
  route,
  sendJson,
} from "./http.js";
import { destroyUserSessions } from "./auth.js";
import { importExternalBank, deleteBank, listBanks, BUILTIN_SLUG } from "./banks.js";
import { normalizeDoc, docStats } from "./store-doc.js";

/* ------------------------------------------------------------ 审计 */

export function writeAudit(userId, action, detail, ip) {
  try {
    run(
      "INSERT INTO audit_log (user_id, action, detail, ip, created_at) VALUES (?, ?, ?, ?, ?)",
      userId == null ? null : userId,
      String(action),
      detail == null ? null : String(detail).slice(0, 500),
      ip == null ? null : String(ip),
      nowIso()
    );
  } catch {
    /* 审计失败不能影响主流程 */
  }
}

/* ------------------------------------------------------------ 权限 */

function requireAdmin(req) {
  if (!req.user) throw forbidden("请先登录");
  if (req.user.role !== "admin") throw forbidden("需要管理员权限");
  return req.user;
}

/** 目标用户：不存在抛 404；自己不能动自己（避免把唯一管理员锁死） */
function targetUser(req, { allowSelf = false } = {}) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("用户编号不合法");
  const row = one("SELECT id, username, display_name, role, disabled, created_at FROM users WHERE id = ?", id);
  if (!row) throw notFound("用户不存在");
  if (!allowSelf && row.id === req.user.id) throw badRequest("不能对自己执行这个操作");
  return row;
}

function adminCount(excludeId) {
  const row = one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id <> ?", excludeId);
  return row ? Number(row.n) : 0;
}

/* ------------------------------------------------------------ 用户列表 */

export function listUsers() {
  const users = all(
    "SELECT id, username, display_name, role, disabled, created_at, last_login_at FROM users ORDER BY id ASC"
  );
  const rows = all("SELECT user_id, bank_slug, rev, doc, updated_at FROM user_stores");
  const byUser = new Map();
  for (const row of rows) {
    let doc;
    try {
      doc = normalizeDoc(JSON.parse(row.doc));
    } catch {
      doc = null;
    }
    const stats = doc ? docStats(doc) : { records: 0, correct: 0, wrongbookActive: 0, sessions: 0 };
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, { banks: {}, rev: 0 });
    const bucket = byUser.get(row.user_id);
    bucket.banks[row.bank_slug] = stats;
    bucket.rev += Number(row.rev) || 0;
  }
  return users.map((u) => {
    const bucket = byUser.get(u.id) || { banks: {}, rev: 0 };
    let records = 0;
    let wrongbookActive = 0;
    for (const key of Object.keys(bucket.banks)) {
      records += bucket.banks[key].records;
      wrongbookActive += bucket.banks[key].wrongbookActive;
    }
    return {
      id: u.id,
      username: u.username,
      displayName: u.display_name || u.username,
      role: u.role,
      disabled: u.disabled === 1,
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at,
      records,
      wrongbookActive,
      saves: bucket.rev,
      banks: bucket.banks,
    };
  });
}

/* ------------------------------------------------------------ 路由 */

export function registerAdminRoutes(router, { requireUser }) {
  // 用户列表
  router.get("/api/admin/users", (req, res) => {
    requireUser(req);
    requireAdmin(req);
    sendJson(res, 200, { users: listUsers() });
  });

  // 启用 / 停用
  router.post(route("/api/admin/users/:id/disabled"), async (req, res) => {
    assertSameOrigin(req);
    requireUser(req);
    requireAdmin(req);
    const body = await readJson(req);
    const row = targetUser(req);
    const disabled = body.disabled === true;
    if (disabled && row.role === "admin" && adminCount(row.id) === 0) {
      throw badRequest("这是最后一名可用管理员，不能停用");
    }
    if (disabled) {
      run("UPDATE users SET disabled = 1 WHERE id = ?", row.id);
      destroyUserSessions(row.id);
    } else {
      run("UPDATE users SET disabled = 0 WHERE id = ?", row.id);
    }
    writeAudit(req.user.id, disabled ? "user.disabled" : "user.enabled", row.username, req.ip);
    sendJson(res, 200, { ok: true, user: { id: row.id, disabled } });
  });

  // 改角色
  router.post(route("/api/admin/users/:id/role"), async (req, res) => {
    assertSameOrigin(req);
    requireUser(req);
    requireAdmin(req);
    const body = await readJson(req);
    const role = body.role === "admin" ? "admin" : "user";
    const row = targetUser(req);
    if (row.role === "admin" && role !== "admin" && adminCount(row.id) === 0) {
      throw badRequest("这是最后一名管理员，不能降级");
    }
    run("UPDATE users SET role = ? WHERE id = ?", role, row.id);
    writeAudit(req.user.id, "user.role", row.username + " -> " + role, req.ip);
    sendJson(res, 200, { ok: true, user: { id: row.id, role } });
  });

  // 重置密码（管理员代改，不校验原密码）
  router.post(route("/api/admin/users/:id/password"), async (req, res) => {
    assertSameOrigin(req);
    requireUser(req);
    requireAdmin(req);
    const body = await readJson(req);
    const password = String(body.newPassword || "");
    if (password.length < 8 || password.length > 128) throw badRequest("新密码长度需为 8–128 位");
    const row = targetUser(req, { allowSelf: true });
    const { hashPassword } = await import("./auth.js");
    run("UPDATE users SET pass_hash = ? WHERE id = ?", hashPassword(password), row.id);
    if (row.id === req.user.id) destroyUserSessions(row.id, req.token);
    else destroyUserSessions(row.id);
    writeAudit(req.user.id, "user.reset_password", row.username, req.ip);
    sendJson(res, 200, { ok: true });
  });

  // 题库列表（含内置）
  router.get("/api/admin/banks", (req, res) => {
    requireUser(req);
    requireAdmin(req);
    sendJson(res, 200, { banks: listBanks(), builtinSlug: BUILTIN_SLUG });
  });

  // 上传题库：body 可以是题库本体，也可以是 {bank:{...}}
  router.post("/api/admin/banks", async (req, res) => {
    assertSameOrigin(req);
    requireUser(req);
    requireAdmin(req);
    const body = await readJson(req, 8 * 1024 * 1024);
    const input = body && typeof body === "object" && Array.isArray(body.questions) ? body : body.bank;
    if (!input || typeof input !== "object" || !Array.isArray(input.questions)) {
      throw badRequest("题库格式不对：需要一个含 questions 数组的 JSON 对象");
    }
    const slug = String(input.slug || "").trim();
    if (slug === BUILTIN_SLUG) throw badRequest("builtin 为保留标识，请用别的 slug");
    const result = importExternalBank(input, {
      slug: slug || undefined,
      subject: input.subject,
      sortOrder: 50,
      bankVersion: input.bankVersion,
    });
    writeAudit(
      req.user.id,
      "bank.import",
      result.slug + " / " + result.questionCount + " 题 / " + (result.created ? "新建" : "更新"),
      req.ip
    );
    sendJson(res, 201, { ok: true, bank: result });
  });

  // 删除题库（内置不可删）
  router.delete(route("/api/admin/banks/:slug"), (req, res) => {
    assertSameOrigin(req);
    requireUser(req);
    requireAdmin(req);
    const slug = String(req.params.slug || "");
    deleteBank(slug);
    writeAudit(req.user.id, "bank.delete", slug, req.ip);
    sendJson(res, 200, { ok: true, slug });
  });

  // 审计日志
  router.get("/api/admin/audit", (req, res) => {
    requireUser(req);
    requireAdmin(req);
    const raw = Number(req.query.limit);
    const limit = Number.isInteger(raw) ? Math.min(Math.max(raw, 1), 200) : 50;
    const rows = all(
      `SELECT a.id, a.user_id, a.action, a.detail, a.ip, a.created_at, u.username
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        ORDER BY a.id DESC LIMIT ?`,
      limit
    );
    sendJson(res, 200, {
      limit,
      items: rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        username: r.username || "",
        action: r.action,
        detail: r.detail || "",
        ip: r.ip || "",
        createdAt: r.created_at,
      })),
    });
  });
}
