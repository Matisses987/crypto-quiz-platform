// 管理后台冒烟：用户管理 / 题库上传删除 / 审计
// 用法：先起服务（data/probe.db），再 node data/smoke-admin.mjs
const BASE = "http://127.0.0.1:3010";
let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log("  ok   " + name);
  } else {
    fail += 1;
    failures.push(name + (extra ? " -> " + JSON.stringify(extra) : ""));
    console.log("  FAIL " + name + (extra ? " -> " + JSON.stringify(extra) : ""));
  }
}

async function call(path, { method = "GET", body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data, setCookie: res.headers.get("set-cookie") };
}

function cookieOf(setCookie) {
  return setCookie ? setCookie.split(";")[0] : "";
}

const stamp = Date.now().toString(36);

async function login(username, password) {
  const reg = await call("/api/auth/register", { method: "POST", body: { username, password } });
  if (reg.status === 201) return { cookie: cookieOf(reg.setCookie), user: reg.data.user };
  const res = await call("/api/auth/login", { method: "POST", body: { username, password } });
  return { cookie: cookieOf(res.setCookie), user: res.data.user };
}

const admin = await login("boss" + stamp, "bosspass1234");
console.log("admin role =", admin.user && admin.user.role);
ok("首个账号是管理员", admin.user && admin.user.role === "admin");

const student = await login("stu" + stamp, "stupass1234");
ok("第二个账号是普通用户", student.user && student.user.role === "user");

// 用户列表
let r = await call("/api/admin/users", { cookie: admin.cookie });
ok("管理员能列用户", r.status === 200 && Array.isArray(r.data.users));
ok("用户列表含记录统计字段", r.status === 200 && "records" in r.data.users[0] && "banks" in r.data.users[0]);
const stuRow = r.status === 200 ? r.data.users.find((u) => u.username === "stu" + stamp) : null;
ok("能定位到学生账号", Boolean(stuRow), r.data && r.data.users && r.data.users.length);

r = await call("/api/admin/users", { cookie: student.cookie });
ok("普通用户列用户被拒 403", r.status === 403, r);

r = await call("/api/admin/users");
ok("匿名列用户被拒 401", r.status === 401, r);

// 停用 / 启用
r = await call("/api/admin/users/" + stuRow.id + "/disabled", { method: "POST", body: { disabled: true }, cookie: admin.cookie });
ok("停用学生账号 200", r.status === 200 && r.data.user.disabled === true, r);

r = await call("/api/store?bank=builtin", { cookie: student.cookie });
ok("停用后旧会话失效 401/403", r.status === 401 || r.status === 403, r.status);

r = await call("/api/auth/login", { method: "POST", body: { username: "stu" + stamp, password: "stupass1234" } });
ok("停用后无法登录 403", r.status === 403, r);

r = await call("/api/admin/users/" + stuRow.id + "/disabled", { method: "POST", body: { disabled: false }, cookie: admin.cookie });
ok("重新启用 200", r.status === 200 && r.data.user.disabled === false, r);

r = await call("/api/auth/login", { method: "POST", body: { username: "stu" + stamp, password: "stupass1234" } });
ok("启用后可登录 200", r.status === 200, r);
const stuCookie2 = cookieOf(r.setCookie);

// 不能停用自己
const me = await call("/api/me", { cookie: admin.cookie });
r = await call("/api/admin/users/" + me.data.user.id + "/disabled", { method: "POST", body: { disabled: true }, cookie: admin.cookie });
ok("不能停用自己 400", r.status === 400, r);

// 改角色
r = await call("/api/admin/users/" + stuRow.id + "/role", { method: "POST", body: { role: "admin" }, cookie: admin.cookie });
ok("提升为管理员 200", r.status === 200 && r.data.user.role === "admin", r);
r = await call("/api/admin/users/" + stuRow.id + "/role", { method: "POST", body: { role: "user" }, cookie: admin.cookie });
ok("降回普通用户 200", r.status === 200 && r.data.user.role === "user", r);

// 管理员重置他人密码
r = await call("/api/admin/users/" + stuRow.id + "/password", { method: "POST", body: { newPassword: "newpass1234" }, cookie: admin.cookie });
ok("管理员重置密码 200", r.status === 200, r);
r = await call("/api/auth/login", { method: "POST", body: { username: "stu" + stamp, password: "newpass1234" } });
ok("新密码可登录", r.status === 200, r);
const stuCookie3 = cookieOf(r.setCookie);
r = await call("/api/store?bank=builtin", { cookie: stuCookie2 });
ok("重置密码后旧会话失效", r.status === 401 || r.status === 403, r.status);

// 题库上传
const miniBank = {
  slug: "mini" + stamp,
  title: "冒烟小题库",
  subject: "custom",
  questions: [
    {
      qid: "m1",
      stem: "1 + 1 = ?",
      type: "single",
      options: [
        { key: "A", text: "1" },
        { key: "B", text: "2" },
        { key: "C", text: "3" },
        { key: "D", text: "4" },
      ],
      answer: ["B"],
      explanation: "小学算术",
      chapter: "密码法",
      difficulty: 1,
    },
    {
      qid: "m2",
      stem: "下列哪些是分组密码？",
      type: "multiple",
      options: [
        { key: "A", text: "SM4" },
        { key: "B", text: "AES" },
        { key: "C", text: "RSA" },
        { key: "D", text: "ZUC" },
      ],
      answer: ["A", "B"],
      explanation: "RSA 公钥，ZUC 流密码",
      chapter: "商用密码管理",
      difficulty: 2,
    },
  ],
};

r = await call("/api/admin/banks", { method: "POST", body: miniBank, cookie: admin.cookie });
ok("管理员上传题库 201", r.status === 201 && r.data.bank.questionCount === 2, r);

r = await call("/api/admin/banks", { method: "POST", body: miniBank, cookie: stuCookie3 });
ok("普通用户上传被拒 403", r.status === 403, r);

r = await call("/api/banks", { cookie: stuCookie3 });
const hasMini = r.status === 200 && r.data.banks.some((b) => b.slug === "mini" + stamp);
ok("新题库出现在列表", hasMini, r.data);

r = await call("/api/banks/mini" + stamp, { cookie: stuCookie3 });
ok("能取到新题库（已脱答案）", r.status === 200 && !JSON.stringify(r.data).includes('"answer":['), r.status);

// 上传非法题库
r = await call("/api/admin/banks", { method: "POST", body: { slug: "bad" + stamp, questions: [{ qid: "x" }] }, cookie: admin.cookie });
ok("非法题库被拒 400", r.status === 400, r);

// 保留 slug
r = await call("/api/admin/banks", { method: "POST", body: { ...miniBank, slug: "builtin" }, cookie: admin.cookie });
ok("不允许覆盖 builtin 400", r.status === 400, r);

// 删除题库
r = await call("/api/admin/banks/mini" + stamp, { method: "DELETE", cookie: admin.cookie });
ok("删除自建题库 200", r.status === 200, r);
r = await call("/api/banks", { cookie: stuCookie3 });
ok("删除后不在列表", r.status === 200 && !r.data.banks.some((b) => b.slug === "mini" + stamp));

r = await call("/api/admin/banks/builtin", { method: "DELETE", cookie: admin.cookie });
ok("内置题库不可删 400", r.status === 400, r);

// 审计
r = await call("/api/admin/audit?limit=20", { cookie: admin.cookie });
const actions = r.status === 200 ? r.data.items.map((i) => i.action) : [];
ok("审计有记录", r.status === 200 && r.data.items.length > 0, r.status);
ok("审计含 user.disabled", actions.includes("user.disabled"), actions);
ok("审计含 bank.import", actions.includes("bank.import"), actions);
ok("审计含 bank.delete", actions.includes("bank.delete"), actions);
r = await call("/api/admin/audit", { cookie: stuCookie3 });
ok("普通用户看审计 403", r.status === 403, r);

console.log("\n=== admin smoke: pass " + pass + " / fail " + fail + " ===");
if (fail > 0) {
  console.log("failures:");
  for (const f of failures) console.log("  - " + f);
  process.exitCode = 1;
}
