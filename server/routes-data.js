// 业务路由：题库下发、个人学习文档同步、团队统计
// 设计见 docs/服务器版改造计划.md §4.3 / §6.2
import { CQP } from "../src/core/index.mjs";
import { all, getMeta, nowIso, one, run, setMeta } from "./db.js";
import { assertSameOrigin, badRequest, notFound, readJson, route, sendJson } from "./http.js";
import { loadBank, servedBank, listBanks, questionMap, bankExists, BUILTIN_SLUG } from "./banks.js";
import { emptyDoc, normalizeDoc, mergeDocs, mergeExportInto, docStats } from "./store-doc.js";
import { startMock, currentMock, saveResponses, submitMock, abandonMock, listMocks } from "./mock.js";

/* -------------------------------------------------------------- 个人文档 */

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

/**
 * 题库隔离：适配器给每个题库独立编号（`Q-<章>-<型>-<序号>`），
 * 不同题库会出现同一个 qid 指向两道完全不同的题。
 * 所以个人学习文档必须按 (user_id, bank_slug) 分开存，记录才不会串库。
 */
export function resolveSlug(input, fallback = BUILTIN_SLUG) {
  const raw = String(input || "").trim();
  if (!raw) return fallback;
  if (!SLUG_RE.test(raw)) throw badRequest("题库标识不合法");
  return raw;
}

function loadDocRow(userId, bankSlug) {
  return one("SELECT rev, doc, updated_at FROM user_stores WHERE user_id = ? AND bank_slug = ?", userId, bankSlug);
}

/** 读：没有就给一个空文档（不插行，减少写） */
export function readStore(userId, bankSlug = BUILTIN_SLUG) {
  const row = loadDocRow(userId, bankSlug);
  if (!row) return { rev: 0, store: emptyDoc(), updatedAt: null, bankSlug };
  let doc;
  try {
    doc = normalizeDoc(JSON.parse(row.doc));
  } catch {
    doc = emptyDoc();
  }
  return { rev: row.rev, store: doc, updatedAt: row.updated_at, bankSlug };
}

function saveStore(userId, bankSlug, doc, rev) {
  const text = JSON.stringify(doc);
  const now = nowIso();
  const row = loadDocRow(userId, bankSlug);
  if (row) {
    run(
      "UPDATE user_stores SET rev = ?, doc = ?, updated_at = ? WHERE user_id = ? AND bank_slug = ?",
      rev,
      text,
      now,
      userId,
      bankSlug
    );
  } else {
    run(
      "INSERT INTO user_stores (user_id, bank_slug, rev, doc, updated_at) VALUES (?, ?, ?, ?, ?)",
      userId,
      bankSlug,
      rev,
      text,
      now
    );
  }
  return now;
}

/**
 * 写：乐观锁 + 合并
 * - baseRev === 当前 rev：直接落地，merged:false
 * - 不等：合并后落地（不报错），merged:true
 */
export function writeStore(userId, body, options = {}) {
  const bankSlug = resolveSlug(body.bankSlug || options.bankSlug, BUILTIN_SLUG);
  const current = readStore(userId, bankSlug);
  const baseRev = Number.isInteger(body.baseRev) ? body.baseRev : -1;
  const incoming = body.store;
  if (!incoming || typeof incoming !== "object") throw badRequest("store 必须是对象");
  if (JSON.stringify(incoming).length > 8 * 1024 * 1024) throw badRequest("学习数据过大，请先导出备份并清理");

  let questions = null;
  let bankVersion = null;
  try {
    const bank = loadBank(bankSlug);
    questions = bank.questions.map((q) => ({ id: q.id }));
    bankVersion = bank.bankVersion;
  } catch {
    /* 题库缺失时退化为不做 qid 过滤，合并逻辑照常跑 */
  }

  const now = nowIso();
  const fastPath = baseRev === current.rev;

  if (fastPath) {
    const next = normalizeDoc(incoming);
    next.meta.updatedAt = now;
    if (!next.meta.deviceId && current.store.meta.deviceId) next.meta.deviceId = current.store.meta.deviceId;
    const rev = current.rev + 1;
    saveStore(userId, bankSlug, next, rev);
    setMeta("storeRev", String(Number(getMeta("storeRev", "0")) + 1));
    return { rev, bankSlug, store: next, merged: false, added: { records: 0, wrongbook: 0 } };
  }

  const merged = mergeDocs(current.store, incoming, { questions, bankVersion, nowISO: now });
  const rev = current.rev + 1;
  saveStore(userId, bankSlug, merged.store, rev);
  setMeta("storeRev", String(Number(getMeta("storeRev", "0")) + 1));
  return {
    rev,
    bankSlug,
    store: merged.store,
    merged: true,
    added: { records: merged.report.importedRecords, wrongbook: merged.report.wrongbookAdded },
    report: merged.report,
  };
}

export function clearStore(userId, bankSlug = BUILTIN_SLUG) {
  const slug = resolveSlug(bankSlug, BUILTIN_SLUG);
  const empty = emptyDoc();
  const current = readStore(userId, slug);
  saveStore(userId, slug, empty, current.rev + 1);
  return { rev: current.rev + 1, bankSlug: slug, store: empty };
}

/**
 * 导入一份导出文件（cqp-export）：
 * - payload 可以是 {kind:"cqp-export",...}，也可以是本项目导出的 {bankSlug,rev,store}
 * - records / overrides / sessions 交给 CQP.mergeImport 去重合并
 * - wrongbook 由 mergeExportInto 自己补合（mergeImport 不管它）
 */
export function importExport(userId, body) {
  const bankSlug = resolveSlug(body.bankSlug, BUILTIN_SLUG);
  const payload = body.payload && typeof body.payload === "object" ? body.payload : body;
  const fileName = String(body.fileName || body.name || "服务端导入").slice(0, 120);
  const current = readStore(userId, bankSlug);

  let questions = null;
  let bankVersion = null;
  try {
    const bank = loadBank(bankSlug);
    questions = bank.questions.map((q) => ({ id: q.id }));
    bankVersion = bank.bankVersion;
  } catch {
    /* 题库缺失时退化为不做 qid 过滤 */
  }

  const now = nowIso();
  const merged = mergeExportInto(current.store, payload, {
    questions,
    bankVersion,
    fileName,
    nowISO: now,
  });
  merged.store.meta.updatedAt = now;
  const rev = current.rev + 1;
  saveStore(userId, bankSlug, merged.store, rev);
  setMeta("storeRev", String(Number(getMeta("storeRev", "0")) + 1));
  return {
    rev,
    bankSlug,
    store: merged.store,
    report: {
      importedRecords: merged.report.importedRecords || 0,
      duplicates: merged.report.duplicates || 0,
      wrongbookAdded: merged.report.wrongbookAdded || 0,
      unknownQids: merged.report.unknownQids || [],
      versionMismatch: merged.report.versionMismatch || null,
      repaired: merged.report.repaired || 0,
      sessionsImported: merged.report.sessionsImported || 0,
    },
  };
}

/* -------------------------------------------------------------- 服务端判分 */

/**
 * 服务端权威判分：前端拿不到 answer，只能提交作答后再拿回结果。
 * 返回 {correct, answer[], color, explanation, mode}
 */
export function gradePractice(userId, body) {
  const bankSlug = String(body.bankSlug || BUILTIN_SLUG);
  const qid = String(body.qid || "");
  if (!qid) throw badRequest("缺少 qid");
  const q = questionMap(bankSlug).get(qid);
  if (!q) throw badRequest("题目不存在：" + qid);

  const myAnswer = Array.isArray(body.myAnswer) ? body.myAnswer.map((a) => String(a)) : [];
  const verdict = CQP.judge(q, myAnswer);
  return {
    qid,
    correct: verdict.correct,
    reason: verdict.reason,
    answer: verdict.normalizedAnswer,
    answerText: CQP.answerText(q),
    explanation: typeof q.explanation === "string" ? q.explanation : "",
    responseMode: CQP.responseModeOf(q),
  };
}

/** 一轮练习的整批判分（减少往返；作答与判分一次走完） */
export function gradePracticeBatch(userId, body) {
  const bankSlug = resolveSlug(body.bankSlug, BUILTIN_SLUG);
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) throw badRequest("items 为空");
  if (items.length > 200) throw badRequest("一次最多判 200 题");
  const map = questionMap(bankSlug);
  const out = [];
  for (const item of items) {
    const q = map.get(String(item && item.qid ? item.qid : ""));
    if (!q) {
      out.push({ qid: item && item.qid ? String(item.qid) : "", correct: false, reason: "no_question", answer: [] });
      continue;
    }
    const myAnswer = Array.isArray(item.myAnswer) ? item.myAnswer.map((a) => String(a)) : [];
    const verdict = CQP.judge(q, myAnswer);
    out.push({
      qid: q.id,
      correct: verdict.correct,
      reason: verdict.reason,
      answer: verdict.normalizedAnswer,
      answerText: CQP.answerText(q),
      explanation: typeof q.explanation === "string" ? q.explanation : "",
      responseMode: CQP.responseModeOf(q),
    });
  }
  return { items: out };
}

/**
 * 批量取答案：题库下发时已剥掉 answer，页面要展示正确答案/解析就得回这里拿。
 *
 * 只给「本人已经作答过」的题 —— 未作答的题拿不到答案，防止一次拉全库答案。
 * 对「校对纠错」页需要任意题的答案，另用 includeAll（见下）。
 */
export function fetchAnswers(userId, body) {
  const bankSlug = resolveSlug(body.bankSlug, BUILTIN_SLUG);
  const qids = Array.isArray(body.qids) ? body.qids.map((v) => String(v)) : [];
  if (qids.length === 0) return { items: [] };
  if (qids.length > 400) throw badRequest("一次最多取 400 题");

  const includeAll = body.includeAll === true;
  const answered = new Set();
  if (!includeAll) {
    const doc = readStore(userId, bankSlug).store;
    for (const r of doc.records) answered.add(r.qid);
  }

  const map = questionMap(bankSlug);
  const items = [];
  for (const qid of qids) {
    if (!includeAll && !answered.has(qid)) continue;
    const q = map.get(qid);
    if (!q) continue;
    items.push({
      qid,
      answer: Array.isArray(q.answer) ? q.answer : [],
      answerText: CQP.answerText(q),
      explanation: typeof q.explanation === "string" ? q.explanation : "",
      responseMode: CQP.responseModeOf(q),
      needsReview: q.needsReview === true,
      answerStatus: q.answerStatus || "ok",
    });
  }
  return { items };
}

/* -------------------------------------------------------------- 团队统计 */

export function teamSummary(bankSlug = BUILTIN_SLUG) {
  const users = all("SELECT id, username, display_name, created_at FROM users WHERE disabled = 0 ORDER BY id ASC");
  const docs = all("SELECT user_id, doc, updated_at FROM user_stores WHERE bank_slug = ?", bankSlug);
  const byUser = new Map();
  for (const row of docs) {
    try {
      byUser.set(row.user_id, { doc: normalizeDoc(JSON.parse(row.doc)), updatedAt: row.updated_at });
    } catch {
      byUser.set(row.user_id, { doc: emptyDoc(), updatedAt: row.updated_at });
    }
  }

  let bank = null;
  try {
    bank = loadBank(bankSlug);
  } catch {
    bank = null;
  }
  const questions = bank ? bank.questions : [];

  const records = [];
  const sessions = [];
  const perUser = [];
  for (const user of users) {
    const entry = byUser.get(user.id);
    const doc = entry ? entry.doc : emptyDoc();
    const name = user.display_name || user.username;
    for (const r of doc.records) records.push({ ...r, nickname: name });
    for (const s of doc.sessions) sessions.push(s);
    const stats = docStats(doc);
    perUser.push({
      userId: user.id,
      username: user.username,
      displayName: name,
      records: stats.records,
      correct: stats.correct,
      accuracy: stats.records > 0 ? Math.round((stats.correct / stats.records) * 1000) / 10 : null,
      wrongbookActive: stats.wrongbookActive,
      mockSessions: stats.sessions,
      updatedAt: entry ? entry.updatedAt : null,
    });
  }

  let team = null;
  try {
    team = CQP.teamStats({ records, questions, sessions });
  } catch (err) {
    team = { error: "统计失败：" + (err && err.message ? err.message : "未知错误") };
  }

  return {
    bankSlug,
    questionCount: questions.length,
    userCount: users.length,
    users: perUser,
    team,
    generatedAt: nowIso(),
  };
}

/* -------------------------------------------------------------- 路由注册 */

export function registerStoreRoutes(router, { requireUser }) {
  // 题库列表：登录后才能看（避免匿名摸清题库结构）
  router.get("/api/banks", (req, res) => {
    requireUser(req);
    sendJson(res, 200, { banks: listBanks() });
  });

  // 脱答案题库：ETag + 304
  router.get(route("/api/banks/:slug"), (req, res) => {
    requireUser(req);
    const slug = req.params.slug;
    if (!bankExists(slug)) throw notFound("题库不存在");
    const entry = servedBank(slug);
    const inm = String(req.headers["if-none-match"] || "");
    res.setHeader("ETag", entry.etag);
    res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    if (inm && inm.split(",").some((v) => v.trim() === entry.etag)) {
      res.statusCode = 304;
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(entry.json));
    res.statusCode = 200;
    res.end(req.method === "HEAD" ? undefined : entry.json);
  });

  // 个人文档
  router.get("/api/store", (req, res) => {
    const user = requireUser(req);
    const data = readStore(user.id, resolveSlug(req.query.get("bank"), BUILTIN_SLUG));
    sendJson(res, 200, {
      rev: data.rev,
      bankSlug: data.bankSlug,
      store: data.store,
      serverTime: nowIso(),
      updatedAt: data.updatedAt,
    });
  });

  router.put("/api/store", async (req, res) => {
    const user = requireUser(req);
    assertSameOrigin(req);
    const body = await readJson(req, 8 * 1024 * 1024);
    const result = writeStore(user.id, body);
    sendJson(res, 200, result);
  });

  router.delete("/api/store", (req, res) => {
    const user = requireUser(req);
    const result = clearStore(user.id, resolveSlug(req.query.get("bank"), BUILTIN_SLUG));
    sendJson(res, 200, result);
  });

  // 导入一份 cqp-export（老离线版的「导出全部备份」或本项目的备份），服务端合并落库
  router.post("/api/store/import", async (req, res) => {
    const user = requireUser(req);
    assertSameOrigin(req);
    const body = await readJson(req, 8 * 1024 * 1024);
    const result = importExport(user.id, body);
    sendJson(res, 200, result);
  });

  // 判分
  router.post("/api/practice/grade", async (req, res) => {
    const user = requireUser(req);
    assertSameOrigin(req);
    const body = await readJson(req);
    sendJson(res, 200, gradePractice(user.id, body));
  });

  router.post("/api/practice/grade-batch", async (req, res) => {
    const user = requireUser(req);
    assertSameOrigin(req);
    const body = await readJson(req);
    sendJson(res, 200, gradePracticeBatch(user.id, body));
  });

  // 答案查询（作答后才给）
  router.post("/api/practice/answers", async (req, res) => {
    const user = requireUser(req);
    assertSameOrigin(req);
    const body = await readJson(req);
    sendJson(res, 200, fetchAnswers(user.id, body));
  });

  // 团队统计
  router.get("/api/team/summary", (req, res) => {
    requireUser(req);
    const slug = String(req.query.get("bank") || BUILTIN_SLUG);
    sendJson(res, 200, teamSummary(slug));
  });

  // 模拟考 ------------------------------------------------------------------
  // 出卷/判分都在服务端：题库下发时已剥掉答案，只有这里能拿到标准答案。
  router.post("/api/mock/start", async (req, res) => {
    const user = requireUser(req);
    assertSameOrigin(req);
    const body = await readJson(req);
    const slug = resolveSlug(body && body.bankSlug, BUILTIN_SLUG);
    sendJson(res, 200, startMock(user.id, slug));
  });

  router.get("/api/mock/current", (req, res) => {
    const user = requireUser(req);
    const slug = resolveSlug(req.query.get("bank"), BUILTIN_SLUG);
    sendJson(res, 200, currentMock(user.id, slug));
  });

  router.get("/api/mock/list", (req, res) => {
    const user = requireUser(req);
    const slug = req.query.get("bank") ? resolveSlug(req.query.get("bank")) : "";
    sendJson(res, 200, listMocks(user.id, slug, req.query.get("limit")));
  });

  router.put(route("/api/mock/:id/responses"), async (req, res) => {
    const user = requireUser(req);
    assertSameOrigin(req);
    const body = await readJson(req, 4 * 1024 * 1024);
    sendJson(res, 200, saveResponses(user.id, req.params.id, body && body.responses));
  });

  router.post(route("/api/mock/:id/submit"), async (req, res) => {
    const user = requireUser(req);
    assertSameOrigin(req);
    const body = await readJson(req, 4 * 1024 * 1024);
    sendJson(res, 200, submitMock(user.id, req.params.id, body));
  });

  router.post(route("/api/mock/:id/abandon"), (req, res) => {
    const user = requireUser(req);
    assertSameOrigin(req);
    sendJson(res, 200, abandonMock(user.id, req.params.id));
  });
}
