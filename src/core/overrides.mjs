// 手动纠错覆盖层（docs/需求规格.md 6.4 / 9.10 / 13.5 G-1）
import { cn_STORE_SCHEMA_VERSION, cn_MAX_ELAPSED_MS } from "./constants.mjs";
import { tm_isoNow } from "./time.mjs";

function ov_empty() {
  return { schemaVersion: cn_STORE_SCHEMA_VERSION, items: {} };
}

function ov_validateOverrides(overrides) {
  if (overrides === null || overrides === undefined) return ov_empty();
  if (typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("overrides must be an object");
  }
  const items = overrides.items && typeof overrides.items === "object" ? overrides.items : {};
  return { schemaVersion: overrides.schemaVersion || cn_STORE_SCHEMA_VERSION, items };
}

// CQP.applyOverrides(bank, overrides) -> {bank, applied}
export function ov_applyOverrides(bank, overrides) {
  if (!bank || !Array.isArray(bank.questions)) {
    throw new TypeError("applyOverrides(bank, overrides): bank.questions must be an array");
  }
  const norm = ov_validateOverrides(overrides);
  let applied = 0;
  const questions = bank.questions.map((q) => {
    const item = norm.items[q.id];
    if (!item || typeof item !== "object") return q;
    let changed = false;
    const out = {};
    for (const key of Object.keys(q)) out[key] = q[key];
    if (Array.isArray(item.answer) && item.answer.length >= 1) {
      out.answer = item.answer.slice();
      out.answerStatus = "ok";
      out.rawAnswer = item.answer.join(" / ");
      changed = true;
    }
    if (item.difficulty === 1 || item.difficulty === 2 || item.difficulty === 3) {
      out.difficulty = item.difficulty;
      changed = true;
    }
    if (item.flagged === true && q.flagged !== true) {
      out.flagged = true;
      changed = true;
    }
    const meta = {
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : null,
      updatedBy: typeof item.updatedBy === "string" ? item.updatedBy : "",
      rev: Number.isInteger(item.rev) ? item.rev : 1,
      note: typeof item.note === "string" ? item.note : "",
      hasAnswerOverride: Array.isArray(item.answer) && item.answer.length >= 1,
      hasDifficultyOverride: item.difficulty === 1 || item.difficulty === 2 || item.difficulty === 3,
      flagged: item.flagged === true,
    };
    if (changed || meta.hasAnswerOverride || meta.hasDifficultyOverride || meta.flagged || meta.note) {
      out.overrideMeta = meta;
    }
    if (changed) applied += 1;
    return out;
  });
  const outBank = {};
  for (const key of Object.keys(bank)) outBank[key] = bank[key];
  outBank.questions = questions;
  return { bank: outBank, applied };
}

// CQP.isFlagged(overrides, qid)
export function ov_isFlagged(overrides, qid) {
  const norm = ov_validateOverrides(overrides);
  const item = norm.items[qid];
  return !!(item && item.flagged === true);
}

// CQP.setOverride(overrides, qid, patch) -> 新 Overrides 对象（rev +1、updatedAt 更新）
export function ov_setOverride(overrides, qid, patch) {
  if (typeof qid !== "string" || qid.length === 0) {
    throw new TypeError("setOverride(overrides, qid, patch): qid must be a non-empty string");
  }
  if (!patch || typeof patch !== "object") {
    throw new TypeError("setOverride(overrides, qid, patch): patch must be an object");
  }
  if (typeof patch.updatedBy !== "string" || patch.updatedBy.trim().length === 0) {
    throw new TypeError("setOverride(overrides, qid, patch): patch.updatedBy must be a non-empty string");
  }
  const norm = ov_validateOverrides(overrides);
  const prev = norm.items[qid] && typeof norm.items[qid] === "object" ? norm.items[qid] : null;
  const nowISO = patch.nowISO === undefined || patch.nowISO === null ? tm_isoNow() : patch.nowISO;
  if (typeof nowISO !== "string") {
    throw new TypeError("setOverride(overrides, qid, patch): patch.nowISO must be a string");
  }

  const next = {
    answer: prev && Array.isArray(prev.answer) && prev.answer.length >= 1 ? prev.answer.slice() : null,
    tags: null, // G-1：手工改标签未开放
    difficulty: prev && (prev.difficulty === 1 || prev.difficulty === 2 || prev.difficulty === 3) ? prev.difficulty : null,
    flagged: !!(prev && prev.flagged === true),
    note: prev && typeof prev.note === "string" ? prev.note : "",
    updatedAt: prev && typeof prev.updatedAt === "string" ? prev.updatedAt : nowISO,
    updatedBy: prev && typeof prev.updatedBy === "string" ? prev.updatedBy : patch.updatedBy,
    rev: prev && Number.isInteger(prev.rev) ? prev.rev : 0,
  };

  if (Object.prototype.hasOwnProperty.call(patch, "answer")) {
    const raw = patch.answer;
    if (raw === null || raw === undefined) {
      next.answer = null;
    } else if (!Array.isArray(raw)) {
      throw new TypeError("setOverride(overrides, qid, patch): patch.answer must be string[] | null");
    } else {
      const cleaned = [];
      for (const item of raw) {
        if (typeof item !== "string") {
          throw new TypeError("setOverride(overrides, qid, patch): patch.answer items must be strings");
        }
        const trimmed = item.trim();
        if (trimmed.length > 0 && cleaned.indexOf(trimmed) < 0) cleaned.push(trimmed);
      }
      next.answer = cleaned.length >= 1 ? cleaned : null; // 空数组不等价于清空
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "difficulty")) {
    const d = patch.difficulty;
    if (d === null || d === undefined) next.difficulty = null;
    else if (d === 1 || d === 2 || d === 3) next.difficulty = d;
    else throw new TypeError("setOverride(overrides, qid, patch): patch.difficulty must be 1 | 2 | 3 | null");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "flagged")) {
    if (typeof patch.flagged !== "boolean") {
      throw new TypeError("setOverride(overrides, qid, patch): patch.flagged must be a boolean");
    }
    next.flagged = patch.flagged;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "note")) {
    if (typeof patch.note !== "string" && patch.note !== null) {
      throw new TypeError("setOverride(overrides, qid, patch): patch.note must be a string");
    }
    next.note = (patch.note === null ? "" : patch.note).slice(0, 200);
  }

  next.updatedBy = patch.updatedBy.length > 20 ? patch.updatedBy.slice(0, 20) : patch.updatedBy;
  next.updatedAt = nowISO;
  next.rev = (prev && Number.isInteger(prev.rev) ? prev.rev : 0) + 1;

  const items = {};
  for (const key of Object.keys(norm.items)) items[key] = norm.items[key];
  items[qid] = next;
  return { schemaVersion: cn_STORE_SCHEMA_VERSION, items };
}

// 界面用：解析用户输入的答案文本
// mode = "single" | "multiple"：字母（支持 "AB" / "A,B" / "A、B"）→ 升序去重大写字母
// mode = "blank" | "judge"：按 , ， 、 ; ； / 分隔（判断题仅 对/错）
export function ov_parseAnswerInput(text, mode) {
  if (typeof text !== "string") throw new TypeError("parseAnswerInput(text, mode): text must be a string");
  const parts = text
    .split(/[,，、;；/]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (mode === "single" || mode === "multiple") {
    const letters = [];
    for (const part of parts) {
      const upper = part.toUpperCase();
      for (const ch of upper.replace(/[\s.。]/g, "")) {
        if (ch >= "A" && ch <= "Z" && letters.indexOf(ch) < 0) letters.push(ch);
      }
    }
    letters.sort();
    return letters;
  }
  const out = [];
  for (const part of parts) if (out.indexOf(part) < 0) out.push(part);
  return out;
}

export function ov_hasAnyItem(overrides, qid) {
  const norm = ov_validateOverrides(overrides);
  return !!norm.items[qid];
}

export function ov_countItems(overrides) {
  const norm = ov_validateOverrides(overrides);
  return Object.keys(norm.items).length;
}

export function ov_clampElapsed(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(Math.round(ms), cn_MAX_ELAPSED_MS);
}
