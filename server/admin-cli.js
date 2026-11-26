#!/usr/bin/env node
/**
 * 运维小工具：在服务器上直接操作账号（不需要网页）。
 *
 *   node server/admin-cli.js list
 *   node server/admin-cli.js passwd <用户名> <新密码>
 *   node server/admin-cli.js promote <用户名>
 *   node server/admin-cli.js demote <用户名>
 *   node server/admin-cli.js disable <用户名>
 *   node server/admin-cli.js enable <用户名>
 *   node server/admin-cli.js create <用户名> <密码> [角色]
 *
 * 改密码/停用会立刻踢掉该账号的全部会话。所有操作都会写审计日志（操作人记 0 = 命令行）。
 */
import { openDb, all, one, run, nowIso } from "./db.js";
import { hashPassword, validateCredentials, normalizeDisplayName } from "./auth.js";
import { writeAudit } from "./admin.js";

const CLI_ACTOR = null; // 命令行操作没有登录用户，审计里 user_id 留空、ip 记 cli

function die(msg) {
  console.error("错误：" + msg);
  process.exit(1);
}

function findUser(name) {
  const key = String(name || "").trim();
  if (!key) die("请给用户名");
  const row = one("SELECT * FROM users WHERE username = ? COLLATE NOCASE", key);
  if (!row) die("找不到账号：" + key);
  return row;
}

function kickSessions(userId) {
  const info = run("DELETE FROM sessions WHERE user_id = ?", userId);
  return info.changes;
}

function lastAdminGuard(userId, action) {
  const others = one(
    "SELECT count(*) AS c FROM users WHERE role = 'admin' AND disabled = 0 AND id <> ?",
    userId
  ).c;
  if (others === 0) die(`这是最后一名可用管理员，不能${action}`);
}

function main(argv) {
  const cmd = String(argv[0] || "").trim();
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(
      [
        "用法：node server/admin-cli.js <命令> [参数]",
        "",
        "  list                       列出全部账号",
        "  create <用户名> <密码> [角色]  新建账号（角色默认 user）",
        "  passwd <用户名> <新密码>      重置密码（同时踢掉该账号所有会话）",
        "  promote <用户名>             升为管理员",
        "  demote <用户名>              降为普通用户",
        "  disable <用户名>             停用账号（同时踢掉所有会话）",
        "  enable <用户名>              恢复账号",
        "",
        "数据库路径由 CQP_DB（或 .env）决定，默认 data/app.db。",
      ].join("\n")
    );
    return;
  }

  openDb();

  if (cmd === "list") {
    const rows = all(
      "SELECT id, username, display_name, role, disabled, created_at, last_login_at FROM users ORDER BY id"
    );
    if (rows.length === 0) {
      console.log("（还没有任何账号；启动服务后第一个注册的账号会成为管理员）");
      return;
    }
    console.log(["id", "用户名", "显示名", "角色", "状态", "创建时间", "最后登录"].join("\t"));
    for (const r of rows) {
      console.log(
        [
          r.id,
          r.username,
          r.display_name || "",
          r.role,
          r.disabled ? "已停用" : "正常",
          r.created_at || "",
          r.last_login_at || "从未",
        ].join("\t")
      );
    }
    return;
  }

  if (cmd === "create") {
    const [username, password, role] = argv.slice(1);
    const cred = validateCredentials(username, password);
    if (role && role !== "admin" && role !== "user") {
      die("角色只能是 admin 或 user");
    }
    // 空库时第一个账号必须是管理员，否则没人能进管理页（与网页注册的口径一致）
    const isFirst = one("SELECT count(*) AS c FROM users").c === 0;
    const finalRole = role || (isFirst ? "admin" : "user");
    if (one("SELECT id FROM users WHERE username = ? COLLATE NOCASE", cred.username)) {
      die("用户名已存在：" + cred.username);
    }
    const info = run(
      "INSERT INTO users (username, pass_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)",
      cred.username,
      hashPassword(cred.password),
      normalizeDisplayName("", cred.username),
      finalRole,
      nowIso()
    );
    writeAudit(CLI_ACTOR, "user.create", `${cred.username} role=${finalRole}`, "cli");
    console.log(`已创建 ${cred.username}（id=${info.lastId}，角色 ${finalRole}）`);
    if (isFirst) console.log("提示：这是空库里的第一个账号，已自动设为管理员。");
    return;
  }

  if (cmd === "passwd") {
    const [username, password] = argv.slice(1);
    const row = findUser(username);
    const cred = validateCredentials(row.username, password);
    run("UPDATE users SET pass_hash = ? WHERE id = ?", hashPassword(cred.password), row.id);
    const kicked = kickSessions(row.id);
    writeAudit(CLI_ACTOR, "user.password", `${row.username}（命令行重置）`, "cli");
    console.log(`已重置 ${row.username} 的密码；踢掉 ${kicked} 个会话`);
    return;
  }

  if (cmd === "promote" || cmd === "demote") {
    const row = findUser(argv[1]);
    const next = cmd === "promote" ? "admin" : "user";
    if (row.role === next) {
      console.log(`${row.username} 已经是 ${next}，无需改动`);
      return;
    }
    if (next === "user") lastAdminGuard(row.id, "降级");
    run("UPDATE users SET role = ? WHERE id = ?", next, row.id);
    writeAudit(CLI_ACTOR, "user.role", `${row.username} -> ${next}（命令行）`, "cli");
    console.log(`${row.username} 的角色已改为 ${next}`);
    return;
  }

  if (cmd === "disable" || cmd === "enable") {
    const row = findUser(argv[1]);
    const disabled = cmd === "disable" ? 1 : 0;
    if (disabled) lastAdminGuard(row.id, "停用");
    run("UPDATE users SET disabled = ? WHERE id = ?", disabled, row.id);
    const kicked = disabled ? kickSessions(row.id) : 0;
    writeAudit(CLI_ACTOR, disabled ? "user.disabled" : "user.enabled", `${row.username}（命令行）`, "cli");
    console.log(`${row.username} 已${disabled ? "停用" : "恢复"}${disabled ? `，踢掉 ${kicked} 个会话` : ""}`);
    return;
  }

  die("不认识的命令：" + cmd + "（跑 node server/admin-cli.js help 看用法）");
}

main(process.argv.slice(2));
