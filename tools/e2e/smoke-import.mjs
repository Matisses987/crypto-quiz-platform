// 导入合并的冒烟测试：验证 /api/store/import 不会丢错题本
// 用法：先起服务（CQP_DB=data/probe.db），再 node data/smoke-import.mjs
const BASE = "http://127.0.0.1:3010";
const stamp = Date.now().toString(36);

function fail(msg, extra) {
  console.error("  FAIL " + msg, extra === undefined ? "" : extra);
  failures += 1;
}
let failures = 0;
function ok(msg) {
  console.log("  ok   " + msg);
}

async function call(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body !== undefined && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  if (opts.cookie) headers.Cookie = opts.cookie;
  const res = await fetch(BASE + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, data, cookie };
}

async function register(username) {
  const r = await call("/api/auth/register", {
    method: "POST",
    body: { username, password: "importpass1", displayName: username },
  });
  if (r.status !== 201) throw new Error("注册失败 " + r.status + " " + JSON.stringify(r.data));
  return r.cookie;
}

// 造一份「老离线版」导出文件：2 条记录 + 1 条错题本
function makeExport(nickname) {
  const now = new Date().toISOString().slice(0, 19) + "+08:00";
  return {
    kind: "cqp-export",
    schemaVersion: "1.0.0",
    appVersion: "1.1.1",
    bankVersion: "2026.08-pdf1",
    exportedAt: now,
    exportedBy: { nickname, deviceId: "d-00000000" },
    range: { scope: "all", from: null, to: null },
    counts: { records: 2, sessions: 0, overrides: 0 },
    records: [
      {
        recordKey: nickname + "\u0001Q-C01-S-0001\u0001" + now,
        qid: "Q-C01-S-0001",
        nickname,
        ts: now,
        localDate: now.slice(0, 10),
        mode: "practice_chapter",
        sessionId: "practice-1",
        myAnswer: ["A"],
        correct: false,
        confidence: "confident",
        color: "red",
        elapsedMs: 5000,
        bankVersion: "2026.08-pdf1",
        appVersion: "1.1.1",
      },
      {
        recordKey: nickname + "\u0001Q-C01-S-0002\u0001" + now,
        qid: "Q-C01-S-0002",
        nickname,
        ts: now,
        localDate: now.slice(0, 10),
        mode: "practice_chapter",
        sessionId: "practice-1",
        myAnswer: ["B"],
        correct: true,
        confidence: "confident",
        color: "green",
        elapsedMs: 4000,
        bankVersion: "2026.08-pdf1",
        appVersion: "1.1.1",
      },
    ],
    mockSessions: [],
    overrides: { schemaVersion: "1.0.0", items: {} },
    wrongbook: {
      "Q-C01-S-0001": {
        state: "active",
        addedAt: now,
        lastWrongAt: now,
        removedAt: null,
        removedReason: null,
        confidentStreak: 0,
        attemptsSinceAdd: 1,
        correctSinceAdd: 0,
      },
    },
  };
}

console.log("=== 导入合并冒烟 ===");
const user = "imp" + stamp;
const cookie = await register(user);
ok("注册 " + user);

// 1) 空文档
let r = await call("/api/store?bank=builtin", { cookie });
if (r.status !== 200 || r.data.store.records.length !== 0) fail("初始文档应为空", r.data && r.data.store && r.data.store.records.length);
else ok("初始文档为空，rev=" + r.data.rev);

// 2) 导入一份带错题本的导出
r = await call("/api/store/import", {
  method: "POST",
  cookie,
  body: { bankSlug: "builtin", payload: makeExport(user), fileName: "队友备份.json" },
});
if (r.status !== 200) fail("导入应 200", r.status + " " + JSON.stringify(r.data));
else {
  const rep = r.data.report;
  if (rep.importedRecords !== 2) fail("应新增 2 条记录，实际 " + rep.importedRecords);
  else ok("新增 2 条记录");
  if (rep.wrongbookAdded !== 1) fail("错题本应 +1，实际 " + rep.wrongbookAdded);
  else ok("错题本 +1（关键：mergeImport 自己不碰 wrongbook，靠 mergeExportInto 补）");
  const wb = r.data.store.wrongbook;
  if (!wb["Q-C01-S-0001"] || wb["Q-C01-S-0001"].state !== "active") fail("错题本里应有 Q-C01-S-0001/active", JSON.stringify(wb));
  else ok("错题本条目录入正确");
  if (r.data.store.records.length !== 2) fail("落地文档应有 2 条记录", r.data.store.records.length);
  else ok("落地文档 2 条记录");
}

// 3) 再导一次同一份：幂等
r = await call("/api/store/import", {
  method: "POST",
  cookie,
  body: { bankSlug: "builtin", payload: makeExport(user), fileName: "队友备份.json" },
});
if (r.status !== 200) fail("二次导入应 200", r.status);
else {
  if (r.data.report.importedRecords !== 0) fail("二次导入应 0 条新增，实际 " + r.data.report.importedRecords);
  else ok("二次导入幂等（0 新增）");
  if (r.data.report.duplicates !== 2) fail("应识别 2 条重复，实际 " + r.data.report.duplicates);
  else ok("识别 2 条重复");
  if (r.data.store.records.length !== 2) fail("记录数应仍为 2", r.data.store.records.length);
  else ok("记录数仍为 2");
  if (r.data.store.wrongbook["Q-C01-S-0001"].state !== "active") fail("错题本应仍 active");
  else ok("错题本未被重复导入破坏");
}

// 4) 错题本 LWW：更新的手动移出应胜出
const export2 = makeExport(user);
const later = new Date(Date.now() + 60000).toISOString().slice(0, 19) + "+08:00";
export2.wrongbook["Q-C01-S-0001"] = {
  state: "removed",
  addedAt: export2.wrongbook["Q-C01-S-0001"].addedAt,
  lastWrongAt: export2.wrongbook["Q-C01-S-0001"].lastWrongAt,
  removedAt: later,
  removedReason: "manual",
  confidentStreak: 2,
  attemptsSinceAdd: 2,
  correctSinceAdd: 2,
};
r = await call("/api/store/import", {
  method: "POST",
  cookie,
  body: { bankSlug: "builtin", payload: export2, fileName: "手动移出后的备份.json" },
});
if (r.status !== 200) fail("三次导入应 200", r.status);
else {
  const entry = r.data.store.wrongbook["Q-C01-S-0001"];
  if (entry.state !== "removed" || entry.removedReason !== "manual") fail("较新的 removed/manual 应胜出", JSON.stringify(entry));
  else ok("错题本 LWW：较新的手动移出胜出");
}

// 5) 隔离：导入 builtin 不应影响 crypto
r = await call("/api/store?bank=crypto", { cookie });
if (r.status !== 200 || r.data.store.records.length !== 0) fail("crypto 题库应仍为空", r.data && r.data.store && r.data.store.records.length);
else ok("题库隔离：crypto 未受影响");

// 6) 鉴权
r = await call("/api/store/import", { method: "POST", body: { payload: makeExport("x") } });
if (r.status !== 401) fail("匿名导入应 401", r.status);
else ok("匿名导入 401");

// 7) 服务端数据可读回（rev 单调）
r = await call("/api/store?bank=builtin", { cookie });
if (r.status !== 200 || r.data.store.records.length !== 2) fail("读回应有 2 条记录", r.data && r.data.store && r.data.store.records.length);
else ok("读回一致，rev=" + r.data.rev);

console.log(failures === 0 ? "\n=== import smoke: ALL PASS ===" : "\n=== import smoke: " + failures + " FAIL ===");
process.exit(failures === 0 ? 0 : 1);
