// 服务端模拟考：出卷、保存进行中的答卷、交卷判分。
//
// 为什么放服务端：模拟卷要用到标准答案来判分与算错题，而题库下发时已经把答案剥掉了。
// 把整个试卷状态存在 mock_exams 表里，顺带得到两个能力：
//   ① 刷新/换设备可以接着考（GET /api/mock/current）；
//   ② 交卷时间由服务端 started_at + plan_sec 判定，改本地时钟没用。
import { CQP } from "../src/core/index.mjs";
import { badRequest, notFound } from "./http.js";
import { nowIso, all, one, run } from "./db.js";
import { loadBank } from "./banks.js";

/** 交卷宽限：留 30 秒给网络与前端收尾，避免到点那一秒被判超时 */
const GRACE_MS = 30 * 1000;

function toRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    bankSlug: row.bank_slug,
    status: row.status,
    questionIds: JSON.parse(row.question_ids || "[]"),
    responses: JSON.parse(row.responses || "{}"),
    planSec: row.plan_sec,
    startedAt: row.started_at,
    submittedAt: row.submitted_at,
    score: row.score,
    correctCnt: row.correct_cnt,
    total: row.total,
  };
}

function examId(nowISO) {
  const stamp = String(nowISO).replace(/[-:T+]/g, "").slice(0, 14);
  const rand = Math.random().toString(16).slice(2, 8).padEnd(6, "0");
  return `mock-${stamp}-${rand}`;
}

/**
 * 出手一张卷。
 *
 * CQP.buildMockPaper 分配在题库侧完成（题池不足 100 时自动降到可用题数），
 * 这里只负责落一行 running 记录。
 */
export function startMock(userId, bankSlug) {
  const bank = loadBank(bankSlug);
  if (!bank) throw notFound("题库不存在");

  const running = one(
    "SELECT * FROM mock_exams WHERE user_id = ? AND bank_slug = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
    userId,
    bankSlug
  );
  // 已有进行中的场次直接复用，避免用户刷新页面就白白浪费一张卷
  if (running) return { exam: toRow(running), resumed: true };

  const nowISO = nowIso();
  const paper = CQP.buildMockPaper({ bank, nowISO });
  if (!paper.questionIds.length) throw badRequest("题库可用题目不足，无法出卷");

  const id = examId(nowISO);
  run(
    "INSERT INTO mock_exams (id, user_id, bank_slug, status, question_ids, responses, plan_sec, started_at) VALUES (?, ?, ?, 'running', ?, '{}', ?, ?)",
    id,
    userId,
    bankSlug,
    JSON.stringify(paper.questionIds),
    paper.timeLimitSec,
    nowISO
  );
  return {
    exam: {
      id,
      bankSlug,
      status: "running",
      questionIds: paper.questionIds,
      responses: {},
      planSec: paper.timeLimitSec,
      startedAt: nowISO,
      submittedAt: null,
      score: null,
      correctCnt: null,
      total: paper.questionIds.length,
    },
    distribution: paper.distribution,
    resumed: false,
  };
}

export function currentMock(userId, bankSlug) {
  const row = one(
    "SELECT * FROM mock_exams WHERE user_id = ? AND bank_slug = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
    userId,
    bankSlug
  );
  return { exam: toRow(row) };
}

/** 自动保存答卷：每题只存作答与用时，答案与对错一概不在这里出现 */
export function saveResponses(userId, id, responses) {
  const row = one("SELECT * FROM mock_exams WHERE id = ? AND user_id = ?", id, userId);
  if (!row) throw notFound("模拟考场次不存在");
  if (row.status !== "running") throw badRequest("本场模拟考已经结束");
  run("UPDATE mock_exams SET responses = ? WHERE id = ?", JSON.stringify(responses || {}), id);
  return { ok: true };
}

export function abandonMock(userId, id) {
  const row = one("SELECT * FROM mock_exams WHERE id = ? AND user_id = ?", id, userId);
  if (!row) throw notFound("模拟考场次不存在");
  if (row.status === "running") {
    run("UPDATE mock_exams SET status = 'abandoned', submitted_at = ? WHERE id = ?", nowIso(), id);
  }
  return { ok: true };
}

/**
 * 交卷判分。
 *
 * 判分复用 CQP.gradeMock —— 前端在客户端模式下用的是同一个函数，
 * 所以两种模式的分数口径一致（100 题 / 100 分 / 每题 1 分 / 未答按错）。
 * 返回里带上逐题标准答案：交卷之后再给答案，不构成泄题。
 */
export function submitMock(userId, id, body) {
  const row = one("SELECT * FROM mock_exams WHERE id = ? AND user_id = ?", id, userId);
  if (!row) throw notFound("模拟考场次不存在");
  if (row.status !== "running") throw badRequest("本场模拟考已经结束");

  const bank = loadBank(row.bank_slug);
  if (!bank) throw notFound("题库不存在");

  const submittedAt = nowIso();
  const elapsedMs = Date.parse(submittedAt) - Date.parse(row.started_at);
  const autoSubmitted = body && body.autoSubmitted === true
    ? true
    : elapsedMs > row.plan_sec * 1000 + GRACE_MS;

  const session = CQP.gradeMock({
    paper: {
      sessionId: row.id,
      questionIds: JSON.parse(row.question_ids || "[]"),
      timeLimitSec: row.plan_sec,
      totalScore: CQP.MOCK_LIMITS.totalScore,
      perQuestionScore: CQP.MOCK_LIMITS.perQuestionScore,
      startedAt: row.started_at,
    },
    responses: (body && body.responses) || JSON.parse(row.responses || "{}"),
    bank,
    submittedAtISO: submittedAt,
    autoSubmitted,
    nickname: body && body.nickname,
  });

  run(
    "UPDATE mock_exams SET status = 'submitted', responses = ?, submitted_at = ?, score = ?, correct_cnt = ?, total = ? WHERE id = ?",
    JSON.stringify(session.responses || {}),
    submittedAt,
    session.result.score,
    session.result.correctCount,
    session.questionIds.length,
    id
  );

  const index = CQP.questionIndex(bank);
  const answers = {};
  session.questionIds.forEach((qid) => {
    const question = index.get(qid);
    if (!question) return;
    answers[qid] = {
      answer: question.answer || [],
      answerText: CQP.answerText(question),
      explanation: question.explanation || "",
      responseMode: CQP.responseModeOf(question),
    };
  });

  return { session, answers, autoSubmitted };
}

export function listMocks(userId, bankSlug, limit) {
  const size = Math.max(1, Math.min(Number(limit) || 20, 100));
  const rows = bankSlug
    ? all(
        "SELECT * FROM mock_exams WHERE user_id = ? AND bank_slug = ? ORDER BY started_at DESC LIMIT ?",
        userId,
        bankSlug,
        size
      )
    : all("SELECT * FROM mock_exams WHERE user_id = ? ORDER BY started_at DESC LIMIT ?", userId, size);
  return { items: rows.map(toRow) };
}
