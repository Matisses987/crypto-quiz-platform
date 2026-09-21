// 测试钩子（docs/需求规格.md 9.14）：供 node --test 与浏览器控制台使用
import {
  cn_CHAPTERS,
  cn_CHAPTER_CODES,
  cn_EXPECT_COUNTS,
  cn_TYPES,
  cn_TYPE_CODES,
  cn_TYPE_NAMES,
  cn_VERSION,
} from "./constants.mjs";

// CQP.__test.makeQuestion(overrides)
export function tk_makeQuestion(overrides) {
  const base = {
    id: "Q-C01-S-0001",
    chapterCode: "C01",
    partCode: "B",
    partName: "基础题",
    chapterName: "密码法律法规",
    sectionType: "single",
    typeName: "单选题",
    responseMode: "single",
    seq: 1,
    printedNo: 1,
    stem: "示例题干（ ）。",
    options: [
      { key: "A", text: "选项甲" },
      { key: "B", text: "选项乙" },
      { key: "C", text: "选项丙" },
      { key: "D", text: "选项丁" },
    ],
    answer: ["A"],
    answerStatus: "ok",
    rawAnswer: "A",
    tags: ["密码法"],
    difficulty: 1,
    sourcePage: 1,
    blankCount: 0,
    needsReview: false,
    reviewReason: null,
  };
  if (!overrides || typeof overrides !== "object") return base;
  const out = {};
  for (const key of Object.keys(base)) out[key] = base[key];
  for (const key of Object.keys(overrides)) out[key] = overrides[key];
  if (!Object.prototype.hasOwnProperty.call(overrides, "id")) {
    out.id = "Q-" + out.chapterCode + "-" + cn_TYPE_CODES[out.sectionType] + "-" + String(out.seq).padStart(4, "0");
  }
  if (!Object.prototype.hasOwnProperty.call(overrides, "typeName")) out.typeName = cn_TYPE_NAMES[out.sectionType];
  if (!Object.prototype.hasOwnProperty.call(overrides, "responseMode")) {
    const st = out.sectionType;
    out.responseMode = st === "single" || st === "multiple" ? (out.answer.length >= 2 ? "multiple" : "single") : st;
  }
  const chap = cn_CHAPTERS.filter((c) => c.chapterCode === out.chapterCode)[0];
  if (chap) {
    if (!Object.prototype.hasOwnProperty.call(overrides, "partCode")) out.partCode = chap.partCode;
    if (!Object.prototype.hasOwnProperty.call(overrides, "partName")) out.partName = chap.partName;
    if (!Object.prototype.hasOwnProperty.call(overrides, "chapterName")) out.chapterName = chap.chapterName;
  }
  if (out.sectionType === "judge" || out.sectionType === "blank") out.options = out.options === base.options ? [] : out.options;
  return out;
}

// CQP.__test.makeRecord(overrides)
export function tk_makeRecord(overrides) {
  const base = {
    recordKey: "测试员\u0001Q-C01-S-0001\u00012026-10-05T21:14:03+08:00",
    qid: "Q-C01-S-0001",
    nickname: "测试员",
    ts: "2026-10-05T21:14:03+08:00",
    localDate: "2026-10-05",
    mode: "practice_chapter",
    sessionId: null,
    myAnswer: ["A"],
    correct: true,
    confidence: "confident",
    color: "green",
    elapsedMs: 1000,
    bankVersion: "fixture-1",
    appVersion: cn_VERSION,
  };
  if (!overrides || typeof overrides !== "object") return base;
  const out = {};
  for (const key of Object.keys(base)) out[key] = base[key];
  for (const key of Object.keys(overrides)) out[key] = overrides[key];
  if (!Object.prototype.hasOwnProperty.call(overrides, "localDate")) out.localDate = String(out.ts).slice(0, 10);
  if (!Object.prototype.hasOwnProperty.call(overrides, "recordKey")) {
    out.recordKey = out.nickname + "\u0001" + out.qid + "\u0001" + out.ts;
  }
  if (!Object.prototype.hasOwnProperty.call(overrides, "color")) {
    out.color = !out.correct ? "red" : out.confidence === "guessed" ? "yellow" : "green";
  }
  return out;
}

export const tk_expectCounts = cn_EXPECT_COUNTS;

// 生成用于测试的合成题库（按章 × 题型 × 数量）
export function tk_makeBank(spec, options) {
  const opts = options && typeof options === "object" ? options : {};
  const chapters = [];
  const questions = [];
  const seqByCell = {};
  for (const code of cn_CHAPTER_CODES) {
    const meta = cn_CHAPTERS.filter((c) => c.chapterCode === code)[0];
    const sections = [];
    for (const type of cn_TYPES) {
      const count = (spec[code] && spec[code][type]) || 0;
      if (count <= 0) continue;
      sections.push({ sectionType: type, typeName: cn_TYPE_NAMES[type], count });
      for (let i = 1; i <= count; i += 1) {
        const key = code + "|" + type;
        seqByCell[key] = (seqByCell[key] || 0) + 1;
        const seq = seqByCell[key];
        const answer =
          type === "judge" ? ["对"] : type === "blank" ? ["答案" + seq] : type === "multiple" ? ["A", "B"] : ["A"];
        const stem = "合成题 " + code + " " + type + " " + seq + "（ ）";
        questions.push({
          id: "Q-" + code + "-" + cn_TYPE_CODES[type] + "-" + String(seq).padStart(4, "0"),
          chapterCode: code,
          partCode: meta.partCode,
          partName: meta.partName,
          chapterName: meta.chapterName,
          sectionType: type,
          typeName: cn_TYPE_NAMES[type],
          responseMode:
            type === "single" || type === "multiple" ? (answer.length >= 2 ? "multiple" : "single") : type,
          seq,
          printedNo: seq,
          stem,
          options:
            type === "single" || type === "multiple"
              ? [
                  { key: "A", text: "甲" + seq },
                  { key: "B", text: "乙" + seq },
                  { key: "C", text: "丙" + seq },
                  { key: "D", text: "丁" + seq },
                ]
              : [],
          answer,
          answerStatus: "ok",
          rawAnswer: answer.join(""),
          tags: [opts.tag || "密码法"],
          difficulty: meta.partCode === "B" ? (type === "multiple" ? 2 : 1) : type === "multiple" || type === "blank" ? 3 : 2,
          sourcePage: 1,
          blankCount: type === "blank" ? 1 : 0,
          needsReview: false,
          reviewReason: null,
        });
      }
    }
    chapters.push({
      chapterCode: code,
      partCode: meta.partCode,
      partName: meta.partName,
      chapterName: meta.chapterName,
      chapterTotal: sections.reduce((sum, s) => sum + s.count, 0),
      sections,
    });
  }
  let total = 0;
  for (const q of questions) total += 1;
  return {
    schemaVersion: "1.0.0",
    bankVersion: opts.bankVersion || "fixture-1",
    generatedAt: "2026-09-16T20:00:00+08:00",
    fixture: opts.fixture === undefined ? true : opts.fixture,
    source: {
      fileName: opts.sourceFileName || "密码赛题库.pdf",
      pages: 199,
      theoryBlocks: total,
      printedQuestions: total,
      excludedCount: 12,
      excludedReason: "第三部分实操题不纳入（用户决策 D12）",
    },
    chapters,
    questions,
  };
}
