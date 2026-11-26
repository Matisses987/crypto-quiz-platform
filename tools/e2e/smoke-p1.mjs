// 临时冒烟：文档同步 / 合并 / 判分 / 团队
const BASE = "http://127.0.0.1:3010";

async function call(path, { method = "GET", body, cookie, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

function jar(res) {
  const raw = res.headers.get("set-cookie");
  return raw ? raw.split(";")[0] : null;
}

function rec(qid, correct, nickname, ts) {
  return {
    recordKey: nickname + "\u0001" + qid + "\u0001" + ts,
    qid,
    nickname,
    ts,
    localDate: ts.slice(0, 10),
    mode: "practice_random",
    sessionId: null,
    myAnswer: correct ? ["A"] : ["B"],
    correct,
    confidence: "confident",
    color: correct ? "green" : "red",
    elapsedMs: 5000,
    bankVersion: "2026.08-pdf1",
    appVersion: "1.1.1",
  };
}

function bookEntry(state, addedAt, extra = {}) {
  return {
    state,
    addedAt,
    lastWrongAt: addedAt,
    removedAt: null,
    removedReason: null,
    confidentStreak: 0,
    attemptsSinceAdd: 1,
    correctSinceAdd: 0,
    ...extra,
  };
}

const log = (...a) => console.log(...a);
let failures = 0;
function check(label, cond, extra = "") {
  if (cond) log("  ok   " + label);
  else {
    failures += 1;
    log("  FAIL " + label + (extra ? "  " + extra : ""));
  }
}

const stamp = Date.now().toString(36);
const u1 = "dev" + stamp + "a";
const u2 = "dev" + stamp + "b";

log("== 注册两台设备 ==");
const r1 = await call("/api/auth/register", { method: "POST", body: { username: u1, password: "passpass11", displayName: "设备甲" } });
const c1 = jar(r1);
const r2 = await call("/api/auth/register", { method: "POST", body: { username: u2, password: "passpass11", displayName: "设备乙" } });
const c2 = jar(r2);
check("注册甲", r1.status === 201);
check("注册乙", r2.status === 201);

log("== 空文档 ==");
const s0 = await call("/api/store", { cookie: c1 });
check("首读 rev=0", s0.json.rev === 0);
check("空文档结构", Array.isArray(s0.json.store.records) && s0.json.store.wrongbook !== undefined);

log("== 设备甲写入一条错题 ==");
const doc1 = {
  ...s0.json.store,
  meta: { ...s0.json.store.meta, nickname: "设备甲", deviceId: "d-aaa" },
  records: [rec("Q-C05-S-0001", false, "设备甲", "2026-11-26T10:00:00+08:00")],
  wrongbook: { "Q-C05-S-0001": bookEntry("active", "2026-11-26T10:00:00+08:00") },
};
const w1 = await call("/api/store", { method: "PUT", cookie: c1, body: { baseRev: 0, store: doc1, bankSlug: "builtin" } });
check("写入 rev=1", w1.json.rev === 1, JSON.stringify(w1.json).slice(0, 120));
check("merged=false", w1.json.merged === false);
check("记录落地", w1.json.store.records.length === 1);

log("== 设备乙用陈旧 baseRev=0 写出另一条（触发合并） ==");
const doc2 = {
  ...s0.json.store,
  meta: { ...s0.json.store.meta, nickname: "设备乙", deviceId: "d-bbb" },
  records: [rec("Q-C05-S-0002", false, "设备乙", "2026-11-26T11:00:00+08:00")],
  wrongbook: { "Q-C05-S-0002": bookEntry("active", "2026-11-26T11:00:00+08:00") },
};
const w2 = await call("/api/store", { method: "PUT", cookie: c2, body: { baseRev: 0, store: doc2, bankSlug: "builtin" } });
check("乙 rev=1", w2.json.rev === 1);
check("乙首次写入无冲突", w2.json.merged === false, JSON.stringify(w2.json).slice(0, 160));

log("== 设备乙再提交一次陈旧 rev=0，带新记录 → 必须 merged=true 且不丢） ==");
const doc2b = {
  ...doc2,
  records: [rec("Q-C05-S-0003", true, "设备乙", "2026-11-26T12:00:00+08:00")],
  wrongbook: { "Q-C05-S-0003": bookEntry("active", "2026-11-26T12:00:00+08:00") },
};
const w3 = await call("/api/store", { method: "PUT", cookie: c2, body: { baseRev: 0, store: doc2b, bankSlug: "builtin" } });
check("merged=true", w3.json.merged === true, JSON.stringify(w3.json.report || {}).slice(0, 200));
check("记录累加为 2", w3.json.store.records.length === 2, "got " + w3.json.store.records.length);
check("错题本累加为 2", Object.keys(w3.json.store.wrongbook).length === 2, "got " + Object.keys(w3.json.store.wrongbook).join(","));

log("== 幂等：同 payload 再交一次 ==");
const w4 = await call("/api/store", { method: "PUT", cookie: c2, body: { baseRev: 0, store: doc2b, bankSlug: "builtin" } });
check("记录仍为 2", w4.json.store.records.length === 2, "got " + w4.json.store.records.length);
check("去重计数 >0", (w4.json.report && w4.json.report.duplicates) > 0, JSON.stringify(w4.json.report || {}).slice(0, 160));

log("== 错题本 LWW：旧 active 不覆盖新的 removed ==");
const now = new Date().toISOString();
const doc5 = {
  ...doc2,
  records: [],
  wrongbook: { "Q-C05-S-0003": bookEntry("removed", "2026-11-26T12:00:00+08:00", { removedAt: now, removedReason: "manual", lastWrongAt: null }) },
};
const w5 = await call("/api/store", { method: "PUT", cookie: c2, body: { baseRev: 0, store: doc5, bankSlug: "builtin" } });
const e5 = w5.json.store.wrongbook["Q-C05-S-0003"];
check("removed 胜出", e5 && e5.state === "removed", JSON.stringify(e5));

log("== 服务端判分 ==");
const g1 = await call("/api/practice/grade", {
  method: "POST",
  cookie: c1,
  body: { bankSlug: "builtin", qid: "Q-C01-S-0001", myAnswer: ["C"] },
});
check("判分返回 correct=true", g1.json.correct === true, JSON.stringify(g1.json).slice(0, 200));
check("判分返回正确答案", Array.isArray(g1.json.answer) && g1.json.answer.length > 0);
check("判分返回解析字段", typeof g1.json.explanation === "string");

const g2 = await call("/api/practice/grade", {
  method: "POST",
  cookie: c1,
  body: { bankSlug: "builtin", qid: "Q-C01-S-0001", myAnswer: ["A"] },
});
check("错答 correct=false", g2.json.correct === false);

const gb = await call("/api/practice/grade-batch", {
  method: "POST",
  cookie: c1,
  body: {
    bankSlug: "crypto",
    items: [
      { qid: "Q-C05-S-0001", myAnswer: ["A"] },
      { qid: "Q-C05-S-0002", myAnswer: ["B"] },
      { qid: "Q-C05-S-9999", myAnswer: ["A"] },
    ],
  },
});
check("批量判分 3 条", gb.json.items.length === 3);
check("未知题走 no_question", gb.json.items[2].reason === "no_question");

log("== 团队统计 ==");
const t = await call("/api/team/summary?bank=builtin", { cookie: c1 });
check("返回用户列表", Array.isArray(t.json.users) && t.json.users.length >= 2);
check("含 team 对象", t.json.team !== null && typeof t.json.team === "object");

log("== 鉴权 ==");
const anon = await call("/api/store");
check("匿名 401", anon.status === 401);

log("== 清空 ==");
const d = await call("/api/store", { method: "DELETE", cookie: c1 });
check("清空后 records=0", d.json.store.records.length === 0);

log("");
log(failures === 0 ? "ALL PASS" : failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);
