// 掌握指数（docs/需求规格.md 8.4 / 9.6）
import { cn_MASTERY_MIN_SAMPLES } from "./constants.mjs";

function ms_round1(value) {
  // 保留 1 位小数；+1e-9 抵消二进制浮点误差（如 87.49999999 -> 87.5）
  return Math.round(value * 10 + 1e-9) / 10;
}

// CQP.masteryOfAttempts(attempts)
export function ms_masteryOfAttempts(attempts) {
  if (!Array.isArray(attempts)) {
    throw new TypeError("masteryOfAttempts(attempts): attempts must be an array");
  }
  let confidentCorrect = 0;
  let guessedCorrect = 0;
  let wrong = 0;
  for (const a of attempts) {
    if (!a || typeof a !== "object") {
      throw new TypeError("masteryOfAttempts(attempts): each attempt must be an object");
    }
    if (typeof a.correct !== "boolean") {
      throw new TypeError("masteryOfAttempts(attempts): attempt.correct must be a boolean");
    }
    if (a.correct) {
      if (a.confidence === "guessed") guessedCorrect += 1;
      else confidentCorrect += 1;
    } else {
      wrong += 1;
    }
  }
  const total = attempts.length;
  const index = total === 0 ? null : ms_round1(((confidentCorrect + guessedCorrect * 0.5) / total) * 100);
  return {
    attempts: total,
    confidentCorrect,
    guessedCorrect,
    wrong,
    index,
    insufficient: total < cn_MASTERY_MIN_SAMPLES,
  };
}

// CQP.masteryOfQuestion(records, qid)
export function ms_masteryOfQuestion(records, qid) {
  if (!Array.isArray(records)) throw new TypeError("masteryOfQuestion(records, qid): records must be an array");
  if (typeof qid !== "string") throw new TypeError("masteryOfQuestion(records, qid): qid must be a string");
  return ms_masteryOfAttempts(records.filter((r) => r && r.qid === qid));
}

// CQP.masteryOverall(records) —— 加权平均（分子分母各自求和），不是各题指数算术平均
export function ms_masteryOverall(records) {
  const m = ms_masteryOfAttempts(records);
  return { attempts: m.attempts, index: m.index, insufficient: m.insufficient };
}

// CQP.masteryBy(records, questions, keyFn)
export function ms_masteryBy(records, questions, keyFn) {
  if (!Array.isArray(records)) throw new TypeError("masteryBy(records, questions, keyFn): records must be an array");
  if (!Array.isArray(questions)) throw new TypeError("masteryBy(records, questions, keyFn): questions must be an array");
  if (typeof keyFn !== "function") throw new TypeError("masteryBy(records, questions, keyFn): keyFn must be a function");
  const qidToKey = new Map();
  const keyOrder = [];
  for (const q of questions) {
    const key = keyFn(q);
    if (qidToKey.has(q.id)) continue;
    qidToKey.set(q.id, key);
    if (keyOrder.indexOf(key) < 0) keyOrder.push(key);
  }
  const buckets = new Map();
  for (const key of keyOrder) buckets.set(key, []);
  for (const r of records) {
    const key = qidToKey.get(r.qid);
    if (key === undefined) continue;
    buckets.get(key).push(r);
  }
  return keyOrder.map((key) => {
    const m = ms_masteryOfAttempts(buckets.get(key));
    return { key, attempts: m.attempts, index: m.index, insufficient: m.insufficient };
  });
}

// 每组 {answered, correct, accuracy, mastery}（8.5 的 byType / byChapter）
export function ms_groupSummary(records, questions, keyFn) {
  if (!Array.isArray(records)) throw new TypeError("groupSummary(records, questions, keyFn): records must be an array");
  const qidToKey = new Map();
  const keyOrder = [];
  for (const q of questions) {
    const key = keyFn(q);
    if (qidToKey.has(q.id)) continue;
    qidToKey.set(q.id, key);
    if (keyOrder.indexOf(key) < 0) keyOrder.push(key);
  }
  const buckets = new Map();
  for (const key of keyOrder) buckets.set(key, []);
  for (const r of records) {
    const key = qidToKey.get(r.qid);
    if (key === undefined) continue;
    buckets.get(key).push(r);
  }
  const out = {};
  for (const key of keyOrder) {
    const list = buckets.get(key);
    const m = ms_masteryOfAttempts(list);
    let correct = 0;
    for (const r of list) if (r.correct) correct += 1;
    out[key] = {
      answered: list.length,
      correct,
      accuracy: list.length === 0 ? null : ms_round1((correct / list.length) * 100),
      mastery: { attempts: m.attempts, index: m.index, insufficient: m.insufficient },
    };
  }
  return out;
}

export { ms_round1 };
