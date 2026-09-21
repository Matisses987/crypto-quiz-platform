// 判分与三色（docs/需求规格.md 8.1 / 9.3 / 9.4 / 5.3.3）
import { cn_COLORS, cn_CONFIDENCES, cn_DEFAULTS } from "./constants.mjs";

// 全角→半角折叠（队长 2026-09-19 决定）：
// U+FF01–U+FF5E → ASCII 0x21–0x7E；U+3000（表意空格）→ 半角空格。
// 只做宽度折叠，不做内部空格删除、不做同义替换。
export function jd_foldWidth(s) {
  if (typeof s !== "string") throw new TypeError("foldWidth(s): s must be a string");
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0);
    else if (code === 0x3000) out += " ";
    else out += ch;
  }
  return out;
}

// CQP.norm(s, opts?)：foldWidth（默认取 CQP.DEFAULTS.blankFoldWidth）→ trim → toLowerCase
export function jd_norm(s, opts) {
  if (typeof s !== "string") throw new TypeError("norm(s): s must be a string");
  const fold = !(opts && typeof opts === "object" && opts.foldWidth === false) && cn_DEFAULTS.blankFoldWidth !== false;
  return (fold ? jd_foldWidth(s) : s).trim().toLowerCase();
}

function jd_baseMode(question) {
  const st = question.sectionType;
  if (st === "single" || st === "multiple" || st === "judge" || st === "blank") return st;
  const rm = question.responseMode;
  if (rm === "single" || rm === "multiple" || rm === "judge" || rm === "blank") return rm;
  return null;
}

// 5.3.3 推导（结构分类用 sectionType，判分/控件用本函数的返回值）
export function jd_responseModeOf(question) {
  if (!question || typeof question !== "object") {
    throw new TypeError("responseModeOf(question): question must be an object");
  }
  const base = jd_baseMode(question);
  if (base === null) {
    throw new TypeError("responseModeOf(question): question.sectionType/responseMode must be a known type");
  }
  if (base === "judge" || base === "blank") return base;
  const len = Array.isArray(question.answer) ? question.answer.length : 0;
  return len >= 2 ? "multiple" : "single";
}

function jd_sortedUnique(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  out.sort();
  return out;
}

// CQP.judge(question, response, opts?)：opts.foldWidth=false 可关闭全角折叠（测试开关）
export function jd_judge(question, response, opts) {
  if (!question || typeof question !== "object") {
    throw new TypeError("judge(question, response): question must be an object");
  }
  if (!Array.isArray(question.answer)) {
    throw new TypeError("judge(question, response): question.answer must be an array");
  }
  const mode = jd_responseModeOf(question);
  const answer = question.answer;
  const responseIsArray = Array.isArray(response);
  const safeResponse = responseIsArray ? response : [];

  // 1. 缺答案题（缺陷 B）不作可判分题
  if (answer.length === 0) {
    return {
      correct: false,
      normalizedAnswer: [],
      normalizedResponse: responseIsArray ? safeResponse.slice() : [],
      reason: "no_answer",
    };
  }
  // 2. 作答形状非法
  if (!responseIsArray || safeResponse.some((x) => typeof x !== "string")) {
    return {
      correct: false,
      normalizedAnswer: answer.slice(),
      normalizedResponse: [],
      reason: "invalid_response",
    };
  }

  if (mode === "blank") {
    const normalizedResponse = [jd_norm(safeResponse.length > 0 ? safeResponse[0] : "", opts)];
    const normalizedAnswer = answer.map((a) => jd_norm(a, opts));
    const correct = normalizedAnswer.indexOf(normalizedResponse[0]) >= 0;
    return { correct, normalizedAnswer, normalizedResponse, reason: "string_match" };
  }

  if (mode === "judge") {
    const correct = safeResponse.length === 1 && safeResponse[0] === answer[0];
    return {
      correct,
      normalizedAnswer: answer.slice(),
      normalizedResponse: safeResponse.slice(),
      reason: "exact",
    };
  }

  if (mode === "single") {
    const correct = safeResponse.length === 1 && safeResponse[0] === answer[0];
    return {
      correct,
      normalizedAnswer: answer.slice(),
      normalizedResponse: safeResponse.slice(),
      reason: "exact",
    };
  }

  // multiple：集合相等（全对才算对）
  const normalizedAnswer = jd_sortedUnique(answer);
  const normalizedResponse = jd_sortedUnique(safeResponse);
  let correct = normalizedAnswer.length === normalizedResponse.length;
  if (correct) {
    for (let i = 0; i < normalizedAnswer.length; i += 1) {
      if (normalizedAnswer[i] !== normalizedResponse[i]) {
        correct = false;
        break;
      }
    }
  }
  return { correct, normalizedAnswer, normalizedResponse, reason: "set_equal" };
}

// CQP.color({correct, confidence})
export function jd_color(input) {
  if (!input || typeof input !== "object") throw new TypeError("color(record): record must be an object");
  const { correct, confidence } = input;
  if (typeof correct !== "boolean") throw new TypeError("color(record): record.correct must be a boolean");
  if (cn_CONFIDENCES.indexOf(confidence) < 0) {
    throw new TypeError('color(record): record.confidence must be "confident" | "guessed"');
  }
  if (!correct) return "red";
  return confidence === "guessed" ? "yellow" : "green";
}

// CQP.isWrongEntry(record) = color !== "green"（红与黄都进错题本）
export function jd_isWrongEntry(record) {
  const c = jd_color(record);
  return c !== "green";
}

export function jd_isColor(value) {
  return cn_COLORS.indexOf(value) >= 0;
}

// 供界面展示：正确答案文案
export function jd_answerText(question) {
  if (!Array.isArray(question.answer) || question.answer.length === 0) return "（缺答案）";
  const mode = jd_responseModeOf(question);
  if (mode === "blank") return question.answer.join(" / ");
  return question.answer.join("");
}
