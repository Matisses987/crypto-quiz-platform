// 出题与练习计分（docs/需求规格.md 9.8）
import { cn_CHAPTER_CODES, cn_DEFAULTS, cn_TYPES } from "./constants.mjs";
import { ms_round1 } from "./mastery.mjs";

// CQP.makeRng(seed)：mulberry32；同 seed 与同调用序列必须产生同一序列
export function dr_makeRng(seed) {
  if (typeof seed !== "number" || !Number.isFinite(seed)) {
    throw new TypeError("makeRng(seed): seed must be a finite number");
  }
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dr_typeOrderIndex(type) {
  const i = cn_TYPES.indexOf(type);
  return i < 0 ? 99 : i;
}

function dr_chapterOrderIndex(code) {
  const i = cn_CHAPTER_CODES.indexOf(code);
  return i < 0 ? 99 : i;
}

function dr_sortCandidates(list) {
  const withIndex = list.map((q, i) => ({ q, i }));
  withIndex.sort((a, b) => {
    const ca = dr_chapterOrderIndex(a.q.chapterCode);
    const cb = dr_chapterOrderIndex(b.q.chapterCode);
    if (ca !== cb) return ca - cb;
    const ta = dr_typeOrderIndex(a.q.sectionType);
    const tb = dr_typeOrderIndex(b.q.sectionType);
    if (ta !== tb) return ta - tb;
    const sa = typeof a.q.seq === "number" ? a.q.seq : a.i;
    const sb = typeof b.q.seq === "number" ? b.q.seq : b.i;
    if (sa !== sb) return sa - sb;
    return a.i - b.i;
  });
  return withIndex.map((x) => x.q);
}

// 候选池（界面显示命中题数也用它）
export function dr_candidates(input) {
  if (!input || typeof input !== "object") throw new TypeError("candidates(input): input must be an object");
  const bank = input.bank;
  if (!bank || !Array.isArray(bank.questions)) {
    throw new TypeError("candidates(input): input.bank.questions must be an array");
  }
  const chapters = Array.isArray(input.chapters) && input.chapters.length > 0 ? input.chapters : null;
  const types = Array.isArray(input.types) && input.types.length > 0 ? input.types : null;
  const tags = Array.isArray(input.tags) && input.tags.length > 0 ? input.tags : null;
  const exclude = new Set(Array.isArray(input.excludeQids) ? input.excludeQids : []);
  const includeNoAnswer = input.includeNoAnswer === true;
  let pool = bank.questions.filter((q) => {
    if (!q) return false;
    if (exclude.has(q.id)) return false;
    if (!includeNoAnswer && q.answerStatus !== "ok") return false;
    if (chapters && chapters.indexOf(q.chapterCode) < 0) return false;
    if (types && types.indexOf(q.sectionType) < 0) return false;
    if (tags && !(Array.isArray(q.tags) && q.tags.some((t) => tags.indexOf(t) >= 0))) return false;
    return true;
  });
  pool = dr_sortCandidates(pool);
  return pool;
}

function dr_shuffle(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// CQP.drawQuestions(input)
export function dr_drawQuestions(input) {
  if (!input || typeof input !== "object") throw new TypeError("drawQuestions(input): input must be an object");
  const count = input.count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
    throw new TypeError("drawQuestions(input): input.count must be an integer >= 1");
  }
  const rng = typeof input.rng === "function" ? input.rng : dr_makeRng(Date.now());
  const pool = dr_candidates(input);
  const shuffled = dr_shuffle(pool, rng);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

// CQP.practiceScore(records, opt?) -> {correct, total, unanswered, accuracy, score, maxScore}
export function dr_practiceScore(records, opt) {
  if (!Array.isArray(records)) throw new TypeError("practiceScore(records, opt): records must be an array");
  const planned =
    opt && typeof opt === "object" && typeof opt.plannedCount === "number" && Number.isInteger(opt.plannedCount)
      ? opt.plannedCount
      : records.length;
  let correct = 0;
  for (const r of records) if (r && r.correct) correct += 1;
  const answered = records.length;
  const total = Math.max(planned, answered);
  const unanswered = Math.max(0, total - answered);
  return {
    correct,
    total,
    unanswered,
    accuracy: answered === 0 ? null : ms_round1((correct / answered) * 100),
    score: correct,
    maxScore: total,
  };
}

export { dr_shuffle, dr_sortCandidates, dr_chapterOrderIndex, dr_typeOrderIndex };
