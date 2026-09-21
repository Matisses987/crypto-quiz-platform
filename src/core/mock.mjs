// 模拟选拔赛（docs/需求规格.md 6.5 / 9.9 / 10.x）
import {
  cn_CHAPTER_CODES,
  cn_MOCK_DIST_EXPECT,
  cn_MOCK_LIMITS,
  cn_MOCK_TYPE_ORDER,
  cn_TYPES,
  cn_TYPE_NAMES,
} from "./constants.mjs";
import { dr_makeRng, dr_shuffle, dr_chapterOrderIndex, dr_typeOrderIndex } from "./draw.mjs";
import { jd_judge } from "./judge.mjs";
import { tm_isoNow, tm_localStamp, tm_diffMs } from "./time.mjs";
import { ov_clampElapsed } from "./overrides.mjs";

// 最大余数法配额分配：total 席位、poolMap 各键池大小、order 决定并列时的优先顺序
export function mk_allocate(total, poolMap, order) {
  const keys = order.filter((k) => Number.isFinite(poolMap[k]) && poolMap[k] > 0);
  const quotas = {};
  for (const k of order) quotas[k] = 0;
  let available = 0;
  for (const k of keys) available += poolMap[k];
  if (total >= available) {
    for (const k of keys) quotas[k] = poolMap[k];
    return quotas;
  }
  const poolTotal = available;
  let assigned = 0;
  const remainders = [];
  for (const k of keys) {
    const exact = (total * poolMap[k]) / poolTotal;
    let base = Math.floor(exact);
    if (base > poolMap[k]) base = poolMap[k];
    quotas[k] = base;
    assigned += base;
    remainders.push({ key: k, rem: exact - Math.floor(exact), idx: order.indexOf(k) });
  }
  let seats = total - assigned;
  remainders.sort((a, b) => (b.rem !== a.rem ? b.rem - a.rem : a.idx - b.idx));
  let cursor = 0;
  while (seats > 0 && cursor < remainders.length * 2 + 4) {
    let progressed = false;
    for (const r of remainders) {
      if (seats <= 0) break;
      if (quotas[r.key] < poolMap[r.key]) {
        quotas[r.key] += 1;
        seats -= 1;
        progressed = true;
      }
    }
    if (!progressed) break;
    cursor += 1;
  }
  return quotas;
}

// 池规模矩阵（按 sectionType × chapterCode）
export function mk_poolMatrix(questions) {
  const byTypeChapter = {};
  for (const t of cn_TYPES) {
    byTypeChapter[t] = {};
    for (const c of cn_CHAPTER_CODES) byTypeChapter[t][c] = 0;
  }
  for (const q of questions) {
    if (!q || q.answerStatus !== "ok") continue;
    if (!byTypeChapter[q.sectionType]) continue;
    if (!(q.chapterCode in byTypeChapter[q.sectionType])) continue;
    byTypeChapter[q.sectionType][q.chapterCode] += 1;
  }
  return byTypeChapter;
}

function mk_typePools(byTypeChapter) {
  const out = {};
  for (const t of cn_TYPES) {
    let sum = 0;
    for (const c of cn_CHAPTER_CODES) sum += byTypeChapter[t][c];
    out[t] = sum;
  }
  return out;
}

// 10.2 两级最大余数法
export function mk_computeDistribution(questions, want) {
  const byTypeChapter = mk_poolMatrix(questions);
  const typePools = mk_typePools(byTypeChapter);
  let poolTotal = 0;
  for (const t of cn_TYPES) poolTotal += typePools[t];
  const total = Math.min(want, poolTotal);
  const typeQuota = mk_allocate(total, typePools, cn_MOCK_TYPE_ORDER);
  const byType = {};
  const byChapter = {};
  const byChapterType = {};
  for (const c of cn_CHAPTER_CODES) byChapter[c] = 0;
  for (const t of cn_TYPES) byChapterType[t] = {};
  for (const t of cn_MOCK_TYPE_ORDER) {
    byType[t] = typeQuota[t];
    const chapterQuota = mk_allocate(typeQuota[t], byTypeChapter[t], cn_CHAPTER_CODES);
    byChapterType[t] = chapterQuota;
    for (const c of cn_CHAPTER_CODES) byChapter[c] += chapterQuota[c];
  }
  return { total, byType, byChapter, byChapterType, byTypeChapter, typePools };
}

function mk_randomHex6() {
  const g = typeof globalThis !== "undefined" ? globalThis : {};
  if (g.crypto && typeof g.crypto.getRandomValues === "function") {
    const buf = new Uint8Array(3);
    g.crypto.getRandomValues(buf);
    let out = "";
    for (const b of buf) out += b.toString(16).padStart(2, "0");
    return out;
  }
  let out = "";
  for (let i = 0; i < 3; i += 1) out += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
  return out;
}

export function mk_sessionId(nowISO) {
  return "mock-" + tm_localStamp(new Date(Date.parse(nowISO))) + "-" + mk_randomHex6();
}

// CQP.buildMockPaper({bank, rng, nowISO})
export function mk_buildMockPaper(input) {
  if (!input || typeof input !== "object") throw new TypeError("buildMockPaper(input): input must be an object");
  const bank = input.bank;
  if (!bank || !Array.isArray(bank.questions)) {
    throw new TypeError("buildMockPaper(input): input.bank.questions must be an array");
  }
  const rng = typeof input.rng === "function" ? input.rng : dr_makeRng(Date.now());
  const nowISO = input.nowISO === undefined || input.nowISO === null ? tm_isoNow() : input.nowISO;
  if (typeof nowISO !== "string") throw new TypeError("buildMockPaper(input): input.nowISO must be a string");

  const dist = mk_computeDistribution(bank.questions, cn_MOCK_LIMITS.count);
  const byCell = new Map();
  for (const q of bank.questions) {
    if (!q || q.answerStatus !== "ok") continue;
    const key = q.sectionType + "|" + q.chapterCode;
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key).push(q);
  }

  const picked = [];
  for (const type of cn_MOCK_TYPE_ORDER) {
    for (const chapter of cn_CHAPTER_CODES) {
      const quota = dist.byChapterType[type][chapter];
      if (!quota) continue;
      const cell = byCell.get(type + "|" + chapter) || [];
      const sorted = cell.slice().sort((a, b) => (a.seq === b.seq ? 0 : a.seq - b.seq));
      const shuffled = dr_shuffle(sorted, rng);
      for (const q of shuffled.slice(0, quota)) picked.push(q);
    }
  }

  picked.sort((a, b) => {
    const ta = dr_typeOrderIndex(a.sectionType);
    const tb = dr_typeOrderIndex(b.sectionType);
    const oa = cn_MOCK_TYPE_ORDER.indexOf(a.sectionType);
    const ob = cn_MOCK_TYPE_ORDER.indexOf(b.sectionType);
    const ra = oa >= 0 ? oa : 90 + ta;
    const rb = ob >= 0 ? ob : 90 + tb;
    if (ra !== rb) return ra - rb;
    const ca = dr_chapterOrderIndex(a.chapterCode);
    const cb = dr_chapterOrderIndex(b.chapterCode);
    if (ca !== cb) return ca - cb;
    return (a.seq || 0) - (b.seq || 0);
  });

  const seen = new Set();
  const questionIds = [];
  for (const q of picked) {
    if (seen.has(q.id)) continue;
    seen.add(q.id);
    questionIds.push(q.id);
  }

  return {
    sessionId: mk_sessionId(nowISO),
    questionIds,
    distribution: { byType: dist.byType, byChapter: dist.byChapter },
    timeLimitSec: cn_MOCK_LIMITS.timeLimitSec,
    totalScore: cn_MOCK_LIMITS.totalScore,
    perQuestionScore: cn_MOCK_LIMITS.perQuestionScore,
    startedAt: nowISO,
  };
}

// CQP.rankKey(result) = [score, -totalElapsedMs, blank, multiple, single, judge]（越大越优）
export function mk_rankKey(result) {
  if (!result || typeof result !== "object") throw new TypeError("rankKey(result): result must be an object");
  const score = typeof result.score === "number" ? result.score : 0;
  const totalElapsedMs = typeof result.totalElapsedMs === "number" ? result.totalElapsedMs : 0;
  const byType = result.byType || {};
  const typeScore = (t) => (byType[t] && typeof byType[t].score === "number" ? byType[t].score : 0);
  return [score, -totalElapsedMs, typeScore("blank"), typeScore("multiple"), typeScore("single"), typeScore("judge")];
}

export function mk_compareRankKey(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] === undefined ? 0 : a[i];
    const y = b[i] === undefined ? 0 : b[i];
    if (x !== y) return y - x;
  }
  return 0;
}

// CQP.gradeMock({paper, responses, bank, submittedAtISO, autoSubmitted})
export function mk_gradeMock(input) {
  if (!input || typeof input !== "object") throw new TypeError("gradeMock(input): input must be an object");
  const paper = input.paper;
  const bank = input.bank;
  if (!paper || !Array.isArray(paper.questionIds)) {
    throw new TypeError("gradeMock(input): input.paper.questionIds must be an array");
  }
  if (!bank || !Array.isArray(bank.questions)) {
    throw new TypeError("gradeMock(input): input.bank.questions must be an array");
  }
  const responses = input.responses && typeof input.responses === "object" ? input.responses : {};
  const submittedAtISO =
    input.submittedAtISO === undefined || input.submittedAtISO === null ? tm_isoNow() : input.submittedAtISO;
  if (typeof submittedAtISO !== "string") {
    throw new TypeError("gradeMock(input): input.submittedAtISO must be a string");
  }
  const qById = new Map();
  for (const q of bank.questions) qById.set(q.id, q);

  const byType = {};
  for (const t of cn_MOCK_TYPE_ORDER) {
    byType[t] = { total: 0, correct: 0, score: 0, elapsedMs: 0 };
  }

  const outResponses = {};
  let correctCount = 0;
  let unansweredCount = 0;
  for (const qid of paper.questionIds) {
    const q = qById.get(qid);
    const raw = responses[qid];
    const myAnswer = raw && Array.isArray(raw.myAnswer) ? raw.myAnswer.filter((x) => typeof x === "string") : [];
    const confidence =
      raw && (raw.confidence === "guessed" || raw.confidence === "confident") ? raw.confidence : "confident";
    const elapsedMs = raw ? ov_clampElapsed(raw.elapsedMs) : 0;
    const verdict = q ? jd_judge(q, myAnswer) : { correct: false };
    const correct = q ? verdict.correct : false;
    if (myAnswer.length === 0) unansweredCount += 1;
    if (correct) correctCount += 1;
    const type = q && byType[q.sectionType] ? q.sectionType : "single";
    byType[type].total += 1;
    if (correct) {
      byType[type].correct += 1;
      byType[type].score += cn_MOCK_LIMITS.perQuestionScore;
    }
    // 10.4：未作答题的用时不计入任何题型（totalElapsedMs 仍按实际经过时间计）
    if (myAnswer.length > 0) byType[type].elapsedMs += elapsedMs;
    outResponses[qid] = { myAnswer, correct, confidence, elapsedMs };
  }

  let elapsed = 0;
  if (typeof paper.startedAt === "string") {
    try {
      elapsed = Math.max(0, tm_diffMs(paper.startedAt, submittedAtISO));
    } catch (err) {
      elapsed = 0;
    }
  }
  const totalElapsedMs = Math.min(elapsed, cn_MOCK_LIMITS.timeLimitSec * 1000);

  const result = {
    score: correctCount,
    maxScore: cn_MOCK_LIMITS.totalScore,
    correctCount,
    unansweredCount,
    totalElapsedMs,
    byType,
  };
  result.rankKey = mk_rankKey(result);

  return {
    sessionId: paper.sessionId,
    nickname: input.nickname === undefined ? "" : input.nickname,
    startedAt: paper.startedAt,
    submittedAt: submittedAtISO,
    timeLimitSec: cn_MOCK_LIMITS.timeLimitSec,
    autoSubmitted: input.autoSubmitted === true,
    bankVersion: bank.bankVersion || "unknown",
    questionIds: paper.questionIds.slice(),
    responses: outResponses,
    result,
  };
}

export function mk_typeNameOf(type) {
  return cn_TYPE_NAMES[type] || type;
}

export { cn_MOCK_DIST_EXPECT };
