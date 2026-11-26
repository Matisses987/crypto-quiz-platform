// P3 冒烟：模拟考全流程（出卷 → 自动存卷 → 交卷判分 → 放弃/续考）
const BASE = "http://127.0.0.1:3010";
let cookie = "";
let fails = 0;

function check(label, cond, extra) {
  if (cond) console.log(`  ok   ${label}`);
  else { fails += 1; console.log(`  FAIL ${label}${extra ? " → " + extra : ""}`); }
}

async function call(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers["Cookie"] = cookie;
  const res = await fetch(BASE + path, {
    method: options.method || "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setCookie.length) cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text };
}

const user = "mockprobe" + Date.now().toString().slice(-6);
const pass = "mockpass123";

console.log("[1] 注册并登录");
let r = await call("/api/auth/register", { method: "POST", body: { username: user, password: pass, displayName: "模拟考探针" } });
check("注册 201", r.status === 201, r.status + " " + r.text.slice(0, 120));

console.log("[2] 出卷");
r = await call("/api/mock/start", { method: "POST", body: { bankSlug: "crypto" } });
check("start 200", r.status === 200, r.text.slice(0, 200));
const exam = r.json && r.json.exam;
check("有 exam.id", !!(exam && exam.id));
check("题目数是 44（crypto 全库不足 100 自动缩容）", exam && exam.questionIds.length === 44, exam && exam.questionIds.length);
check("planSec > 0", exam && exam.planSec > 0, exam && exam.planSec);
check("responses 初始为空", exam && Object.keys(exam.responses).length === 0);
const examId = exam && exam.id;
const qids = (exam && exam.questionIds) || [];

console.log("[3] 重复开局复用同一场");
r = await call("/api/mock/start", { method: "POST", body: { bankSlug: "crypto" } });
check("resumed=true", r.json && r.json.resumed === true, JSON.stringify(r.json && r.json.resumed));
check("exam.id 不变", r.json && r.json.exam.id === examId);

console.log("[4] current 能拿到进行中的场次");
r = await call("/api/mock/current?bank=crypto");
check("current 200", r.status === 200, r.status);
check("current 返回同一场", r.json && r.json.exam && r.json.exam.id === examId);

console.log("[5] 自动存卷");
const responses = {};
responses[qids[0]] = { myAnswer: ["A"], confidence: "confident", elapsedMs: 5000 };
responses[qids[1]] = { myAnswer: ["B"], confidence: "guessed", elapsedMs: 8000 };
r = await call(`/api/mock/${examId}/responses`, { method: "PUT", body: { responses } });
check("存卷 200", r.status === 200, r.text.slice(0, 150));
r = await call("/api/mock/current?bank=crypto");
check("存卷后能读回 2 条", r.json && Object.keys(r.json.exam.responses).length === 2, JSON.stringify(Object.keys((r.json && r.json.exam.responses) || {})));

console.log("[6] 交卷");
r = await call(`/api/mock/${examId}/submit`, { method: "POST", body: { responses, nickname: "模拟考探针" } });
check("submit 200", r.status === 200, r.text.slice(0, 300));
const session = r.json && r.json.session;
check("有 result.score", session && typeof session.result.score === "number", session && JSON.stringify(session.result));
check("total 44", session && session.questionIds.length === 44);
check("给回逐题答案", r.json && r.json.answers && Object.keys(r.json.answers).length === 44, r.json && Object.keys(r.json.answers || {}).length);
const a0 = r.json && r.json.answers && r.json.answers[qids[0]];
check("答案含 answer/answerText", !!(a0 && Array.isArray(a0.answer) && typeof a0.answerText === "string"), JSON.stringify(a0));

console.log("[7] 交卷后不能重复交");
r = await call(`/api/mock/${examId}/submit`, { method: "POST", body: { responses } });
check("二次交卷 400", r.status === 400, r.status + " " + r.text.slice(0, 100));

console.log("[8] 已结束的场次不再出现在 current");
r = await call("/api/mock/current?bank=crypto");
check("current 为 null", r.json && r.json.exam === null, JSON.stringify(r.json));

console.log("[9] 历史列表带上这一场");
r = await call("/api/mock/list?bank=crypto");
check("list 200", r.status === 200);
check("列表含本场且 status=submitted", r.json && r.json.items.some((x) => x.id === examId && x.status === "submitted"));

console.log("[10] 放弃流程");
r = await call("/api/mock/start", { method: "POST", body: { bankSlug: "law" } });
const lawId = r.json && r.json.exam.id;
check("law 出卷", !!lawId, r.text.slice(0, 120));
r = await call(`/api/mock/${lawId}/abandon`, { method: "POST", body: {} });
check("abandon 200", r.status === 200, r.text.slice(0, 100));
r = await call("/api/mock/current?bank=law");
check("放弃后 current 为 null", r.json && r.json.exam === null);

console.log("[11] 越权：别人的场次拿不到");
const otherCookie = cookie;
cookie = "";
await call("/api/auth/register", { method: "POST", body: { username: user + "b", password: pass } });
r = await call(`/api/mock/${examId}/submit`, { method: "POST", body: { responses } });
check("他人交卷 404", r.status === 404, r.status + " " + r.text.slice(0, 100));
cookie = otherCookie;

console.log("[12] 匿名 401");
cookie = "";
r = await call("/api/mock/start", { method: "POST", body: { bankSlug: "crypto" } });
check("匿名 401", r.status === 401, r.status);

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
