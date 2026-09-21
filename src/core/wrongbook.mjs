// 错题本状态机（docs/需求规格.md 6.3 / 8.3 / 9.7）
import { cn_CONFIDENT_STREAK_TO_CLEAR, cn_DEFAULTS, cn_CONFIDENCES } from "./constants.mjs";
import { tm_isoNow } from "./time.mjs";

function wb_clone(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function wb_normalizeEntry(entry) {
  const out = entry && typeof entry === "object" ? wb_clone(entry) : {};
  if (out.state !== "active" && out.state !== "removed") out.state = "active";
  if (typeof out.addedAt !== "string") out.addedAt = null;
  if (typeof out.lastWrongAt !== "string") out.lastWrongAt = null;
  if (typeof out.removedAt !== "string") out.removedAt = null;
  if (out.removedReason !== "manual" && out.removedReason !== "auto2") out.removedReason = null;
  if (!Number.isInteger(out.confidentStreak)) out.confidentStreak = 0;
  if (!Number.isInteger(out.attemptsSinceAdd)) out.attemptsSinceAdd = 0;
  if (!Number.isInteger(out.correctSinceAdd)) out.correctSinceAdd = 0;
  return out;
}

function wb_validateBook(book) {
  if (!book || typeof book !== "object" || Array.isArray(book)) {
    throw new TypeError("wrongbook(book, ...): book must be an object");
  }
}

function wb_validateRecord(record) {
  if (!record || typeof record !== "object") throw new TypeError("wrongbookApply(book, record): record must be an object");
  if (typeof record.qid !== "string" || record.qid.length === 0) {
    throw new TypeError("wrongbookApply(book, record): record.qid must be a non-empty string");
  }
  if (typeof record.correct !== "boolean") {
    throw new TypeError("wrongbookApply(book, record): record.correct must be a boolean");
  }
  if (cn_CONFIDENCES.indexOf(record.confidence) < 0) {
    throw new TypeError('wrongbookApply(book, record): record.confidence must be "confident" | "guessed"');
  }
}

// CQP.wrongbookApply(book, record, nowISO?, opts?) -> {book, action}
// action ∈ "added" | "kept" | "removed" | "none"
export function wb_wrongbookApply(book, record, nowISO, opts) {
  wb_validateBook(book);
  wb_validateRecord(record);
  const now = nowISO === undefined || nowISO === null ? tm_isoNow() : nowISO;
  if (typeof now !== "string") throw new TypeError("wrongbookApply(book, record, nowISO): nowISO must be a string");
  const force = !!(opts && opts.force);

  // 13.2：模拟赛记录默认不自动写错题本（成绩页「加入错题本」按钮可用 force 绕过）
  if (record.mode === "mock" && !cn_DEFAULTS.mockWritesWrongbook && !force) {
    return { book: wb_clone(book), action: "none" };
  }

  const next = wb_clone(book);
  const qid = record.qid;
  const green = record.correct && record.confidence === "confident";
  const guessedCorrect = record.correct && record.confidence === "guessed";
  const wrong = !record.correct;
  const hasEntry = Object.prototype.hasOwnProperty.call(next, qid);
  const entry = hasEntry ? wb_normalizeEntry(next[qid]) : null;

  if (entry && entry.state === "active") {
    entry.attemptsSinceAdd += 1;
    if (green) {
      entry.correctSinceAdd += 1;
      entry.confidentStreak += 1;
      if (entry.confidentStreak >= cn_CONFIDENT_STREAK_TO_CLEAR) {
        entry.state = "removed";
        entry.removedAt = now;
        entry.removedReason = "auto2";
        entry.confidentStreak = 0;
        next[qid] = entry;
        return { book: next, action: "removed" };
      }
      next[qid] = entry;
      return { book: next, action: "kept" };
    }
    // 判错或猜对：连续中断
    entry.confidentStreak = 0;
    if (guessedCorrect) entry.correctSinceAdd += 1;
    if (wrong) entry.lastWrongAt = now;
    next[qid] = entry;
    return { book: next, action: "kept" };
  }

  if (entry && entry.state === "removed") {
    if (green) return { book: next, action: "none" }; // 已移出的题不再因答对回到错题本
    // 重新进入
    entry.state = "active";
    entry.addedAt = now;
    entry.removedAt = null;
    entry.removedReason = null;
    entry.confidentStreak = 0;
    entry.attemptsSinceAdd = 1;
    entry.correctSinceAdd = guessedCorrect ? 1 : 0;
    if (wrong) entry.lastWrongAt = now;
    next[qid] = entry;
    return { book: next, action: "added" };
  }

  // 不在错题本中
  if (green) return { book: next, action: "none" };
  next[qid] = {
    state: "active",
    addedAt: now,
    lastWrongAt: wrong ? now : null,
    removedAt: null,
    removedReason: null,
    confidentStreak: 0,
    attemptsSinceAdd: 1,
    correctSinceAdd: guessedCorrect ? 1 : 0,
  };
  return { book: next, action: "added" };
}

// CQP.wrongbookRemoveManual(book, qid, nowISO?) -> {book, action}
export function wb_wrongbookRemoveManual(book, qid, nowISO) {
  wb_validateBook(book);
  if (typeof qid !== "string" || qid.length === 0) {
    throw new TypeError("wrongbookRemoveManual(book, qid): qid must be a non-empty string");
  }
  const now = nowISO === undefined || nowISO === null ? tm_isoNow() : nowISO;
  const next = wb_clone(book);
  const entry = Object.prototype.hasOwnProperty.call(next, qid) ? wb_normalizeEntry(next[qid]) : null;
  if (!entry || entry.state !== "active") return { book: next, action: "none" };
  entry.state = "removed";
  entry.removedAt = now;
  entry.removedReason = "manual";
  entry.confidentStreak = 0;
  next[qid] = entry;
  return { book: next, action: "removed" };
}

// CQP.wrongbookList(book, questions, filter?) -> 合并题目后的条目数组
export function wb_wrongbookList(book, questions, filter) {
  wb_validateBook(book);
  if (!Array.isArray(questions)) throw new TypeError("wrongbookList(book, questions, filter): questions must be an array");
  const f = filter && typeof filter === "object" ? filter : {};
  const wantedState = f.state === undefined || f.state === null ? "active" : f.state;
  if (wantedState !== "active" && wantedState !== "removed" && wantedState !== "all") {
    throw new TypeError('wrongbookList(book, questions, filter): filter.state must be "active" | "removed" | "all"');
  }
  const chapters = Array.isArray(f.chapters) ? f.chapters : null;
  const types = Array.isArray(f.types) ? f.types : null;
  const tags = Array.isArray(f.tags) ? f.tags : null;
  const colors = Array.isArray(f.colors) ? f.colors : null;

  const qById = new Map();
  for (const q of questions) qById.set(q.id, q);

  const rows = [];
  for (const qid of Object.keys(book)) {
    const q = qById.get(qid);
    if (!q) continue;
    const entry = wb_normalizeEntry(book[qid]);
    if (wantedState !== "all" && entry.state !== wantedState) continue;
    if (chapters && chapters.indexOf(q.chapterCode) < 0) continue;
    if (types && types.indexOf(q.sectionType) < 0) continue;
    if (tags && !(Array.isArray(q.tags) && q.tags.some((t) => tags.indexOf(t) >= 0))) continue;
    if (colors && colors.indexOf(wb_colorOfEntry(entry)) < 0) continue;
    rows.push({ ...entry, qid, question: q });
  }
  rows.sort((a, b) => {
    const aw = a.lastWrongAt || "";
    const bw = b.lastWrongAt || "";
    if (aw !== bw) return aw < bw ? 1 : -1;
    const aa = a.addedAt || "";
    const ba = b.addedAt || "";
    if (aa !== ba) return aa < ba ? 1 : -1;
    return a.qid < b.qid ? -1 : a.qid > b.qid ? 1 : 0;
  });
  return rows;
}

// 颜色来源：红 = 最近判错；黄 = 仅因猜对进入；绿 = 已移出（手动或连续有把握答对）
export function wb_colorOfEntry(entry) {
  if (entry.state === "removed") return "green";
  if (entry.lastWrongAt === null) return "yellow";
  return "red";
}

export function wb_countActive(book) {
  let n = 0;
  for (const qid of Object.keys(book)) if (book[qid] && book[qid].state === "active") n += 1;
  return n;
}
