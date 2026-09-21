// 题库校验与索引（docs/需求规格.md 5.x / 9.11 / 5.9）
import {
  cn_ANSWER_STATUS,
  cn_BANK_SCHEMA_VERSION,
  cn_CHAPTER_CODES,
  cn_CHAPTER_FALLBACK_TAGS,
  cn_CHAPTERS,
  cn_EXPECT_COUNTS,
  cn_QID_RE_SRC,
  cn_REVIEW_REASONS,
  cn_TAG_VOCAB,
  cn_TYPES,
  cn_TYPE_CODES,
  cn_TYPE_NAMES,
} from "./constants.mjs";
import { jd_responseModeOf } from "./judge.mjs";

const bk_QID_RE = new RegExp(cn_QID_RE_SRC);

export function bk_chapterByCode(code) {
  for (const c of cn_CHAPTERS) if (c.chapterCode === code) return c;
  return null;
}

export function bk_questionById(bank, qid) {
  if (!bank || !Array.isArray(bank.questions)) {
    throw new TypeError("questionById(bank, qid): bank.questions must be an array");
  }
  if (typeof qid !== "string") throw new TypeError("questionById(bank, qid): qid must be a string");
  for (const q of bank.questions) if (q && q.id === qid) return q;
  return null;
}

export function bk_questionIndex(bank) {
  const map = new Map();
  for (const q of bank.questions) map.set(q.id, q);
  return map;
}

export function bk_tagIndex(bank) {
  if (!bank || !Array.isArray(bank.questions)) {
    throw new TypeError("tagIndex(bank): bank.questions must be an array");
  }
  const out = {};
  for (const q of bank.questions) {
    if (!Array.isArray(q.tags)) continue;
    for (const t of q.tags) {
      if (!out[t]) out[t] = [];
      out[t].push(q.id);
    }
  }
  for (const key of Object.keys(out)) out[key].sort();
  return out;
}

export function bk_chapterIndex(bank) {
  if (!bank || !Array.isArray(bank.questions)) {
    throw new TypeError("chapterIndex(bank): bank.questions must be an array");
  }
  const out = {};
  for (const code of cn_CHAPTER_CODES) out[code] = [];
  for (const q of bank.questions) {
    if (!out[q.chapterCode]) out[q.chapterCode] = [];
    out[q.chapterCode].push(q);
  }
  for (const code of Object.keys(out)) {
    out[code].sort((a, b) => {
      const ta = cn_TYPES.indexOf(a.sectionType);
      const tb = cn_TYPES.indexOf(b.sectionType);
      if (ta !== tb) return ta - tb;
      return (a.seq || 0) - (b.seq || 0);
    });
  }
  return out;
}

export function bk_countsOf(bank) {
  if (!bank || !Array.isArray(bank.questions)) {
    throw new TypeError("countsOf(bank): bank.questions must be an array");
  }
  const bySectionType = {};
  const byResponseMode = {};
  const byChapter = {};
  for (const t of cn_TYPES) {
    bySectionType[t] = 0;
    byResponseMode[t] = 0;
  }
  for (const c of cn_CHAPTER_CODES) byChapter[c] = 0;
  for (const q of bank.questions) {
    bySectionType[q.sectionType] = (bySectionType[q.sectionType] || 0) + 1;
    const rm = q.responseMode && cn_TYPES.indexOf(q.responseMode) >= 0 ? q.responseMode : jd_responseModeOf(q);
    byResponseMode[rm] = (byResponseMode[rm] || 0) + 1;
    byChapter[q.chapterCode] = (byChapter[q.chapterCode] || 0) + 1;
  }
  return { bySectionType, byResponseMode, byChapter };
}

export function bk_tagCounts(bank) {
  const index = bk_tagIndex(bank);
  const out = {};
  for (const key of Object.keys(index)) out[key] = index[key].length;
  return out;
}

export function bk_isFallbackTagged(question) {
  const fallback = cn_CHAPTER_FALLBACK_TAGS[question.chapterCode];
  return (
    fallback !== undefined &&
    Array.isArray(question.tags) &&
    question.tags.length === 1 &&
    question.tags[0] === fallback
  );
}

// 5.7 难度推导（供报告与校验使用）
export function bk_expectedDifficulty(question) {
  const isBasic = question.partCode === "B";
  const st = question.sectionType;
  if (isBasic) {
    if (st === "single" || st === "judge") return 1;
    if (st === "multiple") return 2;
    return 2;
  }
  if (st === "multiple" || st === "blank") return 3;
  return 2;
}

// CQP.validateBank(bank, options?) -> {ok, errors, warnings}
export function bk_validateBank(bank, options) {
  const opts = options && typeof options === "object" ? options : {};
  const errors = [];
  const warnings = [];
  const err = (code, message, qid) => {
    const item = { code, message };
    if (qid) item.qid = qid;
    errors.push(item);
  };
  const warn = (code, message, qid) => {
    const item = { code, message };
    if (qid) item.qid = qid;
    warnings.push(item);
  };

  if (!bank || typeof bank !== "object") {
    err("E_BANK_SHAPE", "bank must be an object");
    return { ok: false, errors, warnings };
  }
  const isFixture = bank.fixture === true || opts.fixture === true;
  if (bank.schemaVersion !== cn_BANK_SCHEMA_VERSION) {
    err("E_BANK_SCHEMA", 'bank.schemaVersion must be "' + cn_BANK_SCHEMA_VERSION + '", got ' + String(bank.schemaVersion));
  }
  if (typeof bank.bankVersion !== "string" || bank.bankVersion.length === 0) {
    err("E_BANK_VERSION", "bank.bankVersion must be a non-empty string");
  }
  if (typeof bank.generatedAt !== "string") err("E_BANK_GENERATED", "bank.generatedAt must be a string");

  const src = bank.source;
  if (!src || typeof src !== "object") {
    err("E_BANK_SOURCE", "bank.source must be an object");
  } else {
    if (typeof src.fileName !== "string") err("E_BANK_SOURCE_FILENAME", "bank.source.fileName must be a string");
    if (!Number.isInteger(src.pages)) err("E_BANK_SOURCE_PAGES", "bank.source.pages must be an integer");
    if (!Number.isInteger(src.theoryBlocks)) {
      err("E_BANK_SOURCE_BLOCKS", "bank.source.theoryBlocks must be an integer");
    }
    if (!Number.isInteger(src.printedQuestions)) {
      err("E_BANK_SOURCE_PRINTED", "bank.source.printedQuestions must be an integer");
    }
    if (!Number.isInteger(src.excludedCount)) err("E_BANK_SOURCE_EXCLUDED", "bank.source.excludedCount must be an integer");
    if (typeof src.excludedReason !== "string") err("E_BANK_SOURCE_REASON", "bank.source.excludedReason must be a string");
  }

  if (!Array.isArray(bank.chapters)) {
    err("E_BANK_CHAPTERS", "bank.chapters must be an array");
  } else {
    if (bank.chapters.length !== cn_CHAPTER_CODES.length) {
      err("E_BANK_CHAPTERS_LEN", "bank.chapters must contain 7 items, got " + bank.chapters.length);
    }
    bank.chapters.forEach((ch, i) => {
      const expectedCode = cn_CHAPTER_CODES[i];
      if (!ch || typeof ch !== "object") {
        err("E_CHAPTER_SHAPE", "chapters[" + i + "] must be an object", expectedCode);
        return;
      }
      if (ch.chapterCode !== expectedCode) {
        err("E_CHAPTER_ORDER", "chapters[" + i + "].chapterCode must be " + expectedCode + ", got " + String(ch.chapterCode));
      }
      const meta = bk_chapterByCode(ch.chapterCode);
      if (!meta) {
        err("E_CHAPTER_CODE", "unknown chapterCode " + String(ch.chapterCode));
      } else {
        if (ch.partCode !== meta.partCode) err("E_CHAPTER_PART", "chapter " + ch.chapterCode + " partCode mismatch", ch.chapterCode);
        if (ch.partName !== meta.partName) err("E_CHAPTER_PARTNAME", "chapter " + ch.chapterCode + " partName mismatch", ch.chapterCode);
        if (ch.chapterName !== meta.chapterName) err("E_CHAPTER_NAME", "chapter " + ch.chapterCode + " chapterName mismatch", ch.chapterCode);
      }
      if (!Array.isArray(ch.sections)) {
        err("E_CHAPTER_SECTIONS", "chapter " + ch.chapterCode + " sections must be an array", ch.chapterCode);
        return;
      }
      let sum = 0;
      for (const s of ch.sections) {
        if (!s || cn_TYPES.indexOf(s.sectionType) < 0) {
          err("E_SECTION_TYPE", "chapter " + ch.chapterCode + " has an unknown sectionType", ch.chapterCode);
          continue;
        }
        if (s.typeName !== cn_TYPE_NAMES[s.sectionType]) {
          err("E_SECTION_TYPENAME", "chapter " + ch.chapterCode + " section typeName mismatch for " + s.sectionType, ch.chapterCode);
        }
        if (!Number.isInteger(s.count) || s.count < 0) {
          err("E_SECTION_COUNT", "chapter " + ch.chapterCode + " section count must be a non-negative integer", ch.chapterCode);
          continue;
        }
        sum += s.count;
      }
      if (Number.isInteger(ch.chapterTotal) && ch.chapterTotal !== sum) {
        err("E_CHAPTER_TOTAL", "chapter " + ch.chapterCode + " chapterTotal " + ch.chapterTotal + " != sum of sections " + sum, ch.chapterCode);
      }
    });
  }

  if (!Array.isArray(bank.questions)) {
    err("E_BANK_QUESTIONS", "bank.questions must be an array");
    return { ok: errors.length === 0, errors, warnings };
  }

  const seenIds = new Set();
  const seenSeq = new Set();
  const chapterTypeCount = {};
  const tagHit = { specific: 0, fallback: 0, uncategorized: 0 };
  for (const code of cn_CHAPTER_CODES) {
    chapterTypeCount[code] = {};
    for (const t of cn_TYPES) chapterTypeCount[code][t] = 0;
  }

  for (const q of bank.questions) {
    if (!q || typeof q !== "object") {
      err("E_Q_SHAPE", "question must be an object");
      continue;
    }
    if (typeof q.id !== "string" || !bk_QID_RE.test(q.id)) {
      err("E_Q_ID", "question.id must match " + cn_QID_RE_SRC + ", got " + String(q.id), q.id);
      continue;
    }
    if (seenIds.has(q.id)) err("E_Q_ID_DUP", "duplicate question id " + q.id, q.id);
    seenIds.add(q.id);

    const meta = bk_chapterByCode(q.chapterCode);
    if (!meta) {
      err("E_Q_CHAPTER", "question.chapterCode unknown: " + String(q.chapterCode), q.id);
    } else {
      if (q.partCode !== meta.partCode) err("E_Q_PART", "question.partCode mismatch for " + q.id, q.id);
      if (q.partName !== meta.partName) err("E_Q_PARTNAME", "question.partName mismatch for " + q.id, q.id);
      if (q.chapterName !== meta.chapterName) err("E_Q_CHAPTERNAME", "question.chapterName mismatch for " + q.id, q.id);
    }
    if (cn_TYPES.indexOf(q.sectionType) < 0) {
      err("E_Q_SECTION", "question.sectionType invalid for " + q.id, q.id);
    } else if (q.typeName !== cn_TYPE_NAMES[q.sectionType]) {
      err("E_Q_TYPENAME", "question.typeName mismatch for " + q.id, q.id);
    }
    const code4 = String(q.id).slice(3, 6);
    void code4;
    if (cn_CHAPTER_CODES.indexOf(q.chapterCode) >= 0 && cn_TYPES.indexOf(q.sectionType) >= 0) {
      chapterTypeCount[q.chapterCode][q.sectionType] += 1;
    }
    const expectedQid = "Q-" + q.chapterCode + "-" + cn_TYPE_CODES[q.sectionType] + "-" + String(q.seq).padStart(4, "0");
    if (expectedQid !== q.id) {
      err("E_Q_ID_SEQ", "question.id does not match chapter/section/seq: expected " + expectedQid + ", got " + q.id, q.id);
    }
    const seqKey = q.chapterCode + "|" + q.sectionType + "|" + q.seq;
    if (seenSeq.has(seqKey)) err("E_Q_SEQ_DUP", "duplicate seq " + q.seq + " in " + q.chapterCode + "/" + q.sectionType, q.id);
    seenSeq.add(seqKey);
    if (!Number.isInteger(q.seq) || q.seq < 1) err("E_Q_SEQ", "question.seq must be an integer >= 1", q.id);
    if (q.printedNo !== null && (!Number.isInteger(q.printedNo) || q.printedNo < 1)) {
      err("E_Q_PRINTED", "question.printedNo must be null or a positive integer", q.id);
    }
    if (typeof q.stem !== "string" || q.stem.trim().length === 0) err("E_Q_STEM", "question.stem must be a non-empty string", q.id);

    if (!Array.isArray(q.options)) {
      err("E_Q_OPTIONS", "question.options must be an array", q.id);
    } else {
      const isChoice = q.sectionType === "single" || q.sectionType === "multiple";
      if (isChoice) {
        if (q.options.length !== 4) {
          err("E_Q_OPTIONS_LEN", "choice question must have 4 options, got " + q.options.length, q.id);
        }
        const keys = q.options.map((o) => (o && typeof o.key === "string" ? o.key : ""));
        const expectedKeys = ["A", "B", "C", "D"];
        for (let i = 0; i < Math.min(4, keys.length); i += 1) {
          if (keys[i] !== expectedKeys[i]) {
            warn("W_Q_OPTION_KEYS", "option keys are not A,B,C,D in order: " + keys.join(","), q.id);
            break;
          }
        }
        if (new Set(keys).size !== keys.length) err("E_Q_OPTION_DUP", "duplicate option keys", q.id);
        for (const o of q.options) {
          if (!o || typeof o.text !== "string" || o.text.length === 0) {
            err("E_Q_OPTION_TEXT", "option text must be a non-empty string", q.id);
          }
        }
      } else if (q.options.length !== 0) {
        warn("W_Q_OPTIONS_EMPTY_EXPECTED", "judge/blank question should have no options, got " + q.options.length, q.id);
      }
    }

    if (!Array.isArray(q.answer)) {
      err("E_Q_ANSWER", "question.answer must be an array", q.id);
    } else {
      for (const a of q.answer) if (typeof a !== "string") err("E_Q_ANSWER_TYPE", "answer items must be strings", q.id);
      if (q.sectionType === "judge") {
        for (const a of q.answer) {
          if (a !== "对" && a !== "错") err("E_Q_JUDGE_ANSWER", 'judge answer must be "对" or "错", got ' + JSON.stringify(a), q.id);
        }
      }
      if (q.sectionType === "single" || q.sectionType === "multiple") {
        for (const a of q.answer) {
          if (!/^[A-D]+$/.test(a)) err("E_Q_CHOICE_ANSWER", "choice answer must be A-D letters, got " + JSON.stringify(a), q.id);
        }
        const joined = q.answer.join("");
        if (q.answer.length >= 2) {
          const sortedUnique = Array.from(new Set(joined.split(""))).sort().join("");
          if (sortedUnique !== joined) {
            err("E_Q_ANSWER_SORT", "multiple answer must be ascending and unique: " + joined, q.id);
          }
        }
      }
    }
    if (cn_ANSWER_STATUS.indexOf(q.answerStatus) < 0) {
      err("E_Q_ANSWER_STATUS", "question.answerStatus invalid", q.id);
    } else if (q.answerStatus === "missing") {
      if (Array.isArray(q.answer) && q.answer.length !== 0) {
        err("E_Q_ANSWER_MISSING_INCONSISTENT", "answerStatus=missing requires answer=[]", q.id);
      }
      if (q.rawAnswer !== null) err("E_Q_RAW_ANSWER_NULL", "answerStatus=missing requires rawAnswer=null", q.id);
    } else if (Array.isArray(q.answer) && q.answer.length === 0) {
      err("E_Q_ANSWER_OK_EMPTY", "answerStatus=ok requires answer.length >= 1", q.id);
    }

    if (!Array.isArray(q.tags)) {
      err("E_Q_TAGS", "question.tags must be an array", q.id);
    } else {
      if (q.tags.length < 1 || q.tags.length > 3) err("E_Q_TAGS_LEN", "question.tags length must be 1..3", q.id);
      if (q.tags.indexOf("未分类") >= 0) err("E_Q_TAGS_UNCATEGORIZED", 'question.tags must not contain "未分类"', q.id);
      for (const t of q.tags) {
        if (cn_TAG_VOCAB.indexOf(t) < 0) err("E_Q_TAG_VOCAB", "tag not in vocabulary: " + String(t), q.id);
      }
      if (bk_isFallbackTagged(q)) tagHit.fallback += 1;
      else tagHit.specific += 1;
    }

    if (q.difficulty !== 1 && q.difficulty !== 2 && q.difficulty !== 3) {
      err("E_Q_DIFFICULTY", "question.difficulty must be 1 | 2 | 3", q.id);
    }
    if (!Number.isInteger(q.sourcePage) || q.sourcePage < 1) {
      err("E_Q_PAGE", "question.sourcePage must be an integer >= 1", q.id);
    }
    if (!Number.isInteger(q.blankCount) || q.blankCount < 0) {
      err("E_Q_BLANKCOUNT", "question.blankCount must be a non-negative integer", q.id);
    }
    if (typeof q.needsReview !== "boolean") err("E_Q_NEEDSREVIEW", "question.needsReview must be a boolean", q.id);
    if (q.reviewReason !== null && cn_REVIEW_REASONS.indexOf(q.reviewReason) < 0) {
      err("E_Q_REVIEWREASON", "question.reviewReason invalid: " + String(q.reviewReason), q.id);
    }
    if (q.needsReview === true && q.reviewReason === null) {
      err("E_Q_NEEDSREVIEW_REASON", "needsReview=true requires reviewReason", q.id);
    }

    let derivedMode = null;
    try {
      derivedMode = jd_responseModeOf(q);
    } catch (e) {
      err("E_Q_MODE", "responseMode cannot be derived", q.id);
    }
    if (derivedMode && q.responseMode !== derivedMode) {
      err("E_Q_MODE_MISMATCH", "responseMode must be " + derivedMode + ", got " + String(q.responseMode), q.id);
    }

    if (cn_CHAPTER_CODES.indexOf(q.chapterCode) < 0) tagHit.uncategorized += 1;
  }

  // 各章各题型计数与 chapters 声明一致
  if (Array.isArray(bank.chapters)) {
    for (const ch of bank.chapters) {
      if (!ch || cn_CHAPTER_CODES.indexOf(ch.chapterCode) < 0 || !Array.isArray(ch.sections)) continue;
      for (const s of ch.sections) {
        if (!s || cn_TYPES.indexOf(s.sectionType) < 0) continue;
        const actual = chapterTypeCount[ch.chapterCode][s.sectionType];
        if (actual !== s.count) {
          err(
            "E_CHAPTER_SECTION_COUNT",
            "chapter " + ch.chapterCode + " " + s.sectionType + " declared " + s.count + " but found " + actual,
            ch.chapterCode
          );
        }
      }
    }
  }

  if (src && Number.isInteger(src.theoryBlocks) && src.theoryBlocks !== bank.questions.length) {
    err("E_BANK_BLOCKS_MISMATCH", "source.theoryBlocks " + src.theoryBlocks + " != questions.length " + bank.questions.length);
  }

  // 标签覆盖率：门禁用标准口径（词表 1..33 具体标签命中率 ≥ 80%），保守口径仅作信息值
  bk_warnTagCoverage(bk_tagCoverage(bank), warn);

  if (!isFixture) {
    // 5.9 计数校验表（真实题库硬性自检）
    const exp = cn_EXPECT_COUNTS;
    const counts = bk_countsOf(bank);
    if (bank.questions.length !== exp.theoryBlocks) {
      err("E_COUNT_QUESTIONS", "questions.length must be " + exp.theoryBlocks + ", got " + bank.questions.length);
    }
    let ok = 0;
    let missing = 0;
    let needsReview = 0;
    let printedNoNull = 0;
    let answerNonEmpty = 0;
    let judgeDui = 0;
    let judgeCuo = 0;
    let multiSingleLetter = 0;
    let singleMultiLetter = 0;
    let blankWithAnswer = 0;
    let mismatch = 0;
    const needsReviewIds = [];
    const mismatchIds = [];
    const fallbackTagged = [];
    for (const q of bank.questions) {
      if (q.answerStatus === "ok") ok += 1;
      if (q.answerStatus === "missing") missing += 1;
      if (q.needsReview === true) {
        needsReview += 1;
        needsReviewIds.push(q.id);
      }
      if (q.printedNo === null) printedNoNull += 1;
      if (Array.isArray(q.answer) && q.answer.length >= 1) answerNonEmpty += 1;
      if (q.sectionType === "judge") {
        if (Array.isArray(q.answer) && q.answer[0] === "对") judgeDui += 1;
        if (Array.isArray(q.answer) && q.answer[0] === "错") judgeCuo += 1;
      }
      if (q.sectionType === "multiple" && Array.isArray(q.answer) && q.answer.join("").length === 1) multiSingleLetter += 1;
      if (q.sectionType === "single" && Array.isArray(q.answer) && q.answer.join("").length > 1) singleMultiLetter += 1;
      if (q.sectionType === "blank" && Array.isArray(q.answer) && q.answer.length >= 1) blankWithAnswer += 1;
      let derived = null;
      try {
        derived = jd_responseModeOf(q);
      } catch (e) {
        derived = null;
      }
      if (derived && q.sectionType !== derived) {
        mismatch += 1;
        mismatchIds.push(q.id);
      }
      if (bk_isFallbackTagged(q)) fallbackTagged.push(q.id);
    }
    const check = (code, actual, expected, label) => {
      if (actual !== expected) err(code, label + " must be " + expected + ", got " + actual);
    };
    check("E_COUNT_ANSWER_OK", ok, exp.answerOk, "answerStatus=ok count");
    check("E_COUNT_ANSWER_MISSING", missing, exp.answerMissing, "answerStatus=missing count");
    check("E_COUNT_NEEDS_REVIEW", needsReview, exp.needsReview, "needsReview=true count");
    check("E_COUNT_PRINTED_NULL", printedNoNull, exp.printedNoNull, "printedNo=null count");
    check("E_COUNT_ANSWER_NONEMPTY", answerNonEmpty, exp.theoryBlocks - exp.answerMissing, "answer.length>=1 count");
    check("E_COUNT_JUDGE_DUI", judgeDui, exp.judgeAnswer["对"], "judge answer 对 count");
    check("E_COUNT_JUDGE_CUO", judgeCuo, exp.judgeAnswer["错"], "judge answer 错 count");
    check("E_COUNT_MULTI_SINGLE_LETTER", multiSingleLetter, exp.multiSingleLetter, "multiple-section single-letter answers");
    check("E_COUNT_SINGLE_MULTI_LETTER", singleMultiLetter, exp.singleMultiLetter, "single-section multi-letter answers");
    check("E_COUNT_BLANK_WITH_ANSWER", blankWithAnswer, exp.blankWithAnswer, "blank answers present");
    check("E_COUNT_MODE_MISMATCH", mismatch, exp.sectionResponseMismatch, "sectionType != responseMode count");
    for (const t of cn_TYPES) {
      check("E_COUNT_SECTION_" + t, counts.bySectionType[t], exp.bySectionType[t], "sectionType " + t + " count");
      check("E_COUNT_MODE_" + t, counts.byResponseMode[t], exp.byResponseMode[t], "responseMode " + t + " count");
    }
    for (const c of cn_CHAPTER_CODES) {
      check("E_COUNT_CHAPTER_" + c, counts.byChapter[c], exp.byChapter[c], "chapter " + c + " count");
      for (const t of cn_TYPES) {
        check(
          "E_COUNT_CHAPTER_SECTION_" + c + "_" + t,
          chapterTypeCount[c][t],
          exp.chapterSection[c][t],
          "chapter " + c + " " + t + " count"
        );
      }
    }
    const idsDiff = (actual, expected) => {
      const a = actual.slice().sort().join(",");
      const b = expected.slice().sort().join(",");
      return a === b;
    };
    if (!idsDiff(needsReviewIds, exp.needsReviewIds)) {
      err("E_COUNT_NEEDS_REVIEW_IDS", "needsReview ids mismatch: " + needsReviewIds.join(","));
    }
    if (!idsDiff(mismatchIds, exp.mismatchIds)) {
      err("E_COUNT_MISMATCH_IDS", "sectionType != responseMode ids mismatch: " + mismatchIds.join(","));
    }
  } else {
    warn("W_FIXTURE_MODE", "fixture bank: absolute count checks (5.9) are skipped");
  }

  return { ok: errors.length === 0, errors, warnings };
}

// 标签命中率的两种口径（t6 O-5 / t11 O-4 统一措辞）：
// - standard（门禁口径，§5.6.1）：tags 命中词表序号 1..33 中任一「具体标签」即算命中。
//   C07 的兜底标签「标准规范」本身就是词表第 24 条，因此在标准口径下按具体标签计。
// - conservative（保守/成品可复算口径）：沿用章级兜底判定（tags 仅由该章兜底标签构成即算兜底），
//   即把 C07 的「标准规范」当作兜底 → 数值更低，仅作信息值输出，不作为门禁。
export const bk_TAG_SPECIFIC_VOCAB_SIZE = 33;

export function bk_tagCoverage(bank) {
  if (!bank || !Array.isArray(bank.questions)) {
    throw new TypeError("tagCoverage(bank): bank.questions must be an array");
  }
  const specificVocab = new Set(cn_TAG_VOCAB.slice(0, bk_TAG_SPECIFIC_VOCAB_SIZE));
  const total = bank.questions.length;
  let standard = 0;
  let conservative = 0;
  for (const q of bank.questions) {
    const tags = Array.isArray(q.tags) ? q.tags : [];
    if (tags.some((t) => specificVocab.has(t))) standard += 1;
    if (!bk_isFallbackTagged(q)) conservative += 1;
  }
  const rate = (value) => (total === 0 ? 0 : Math.round((value / total) * 10000) / 10000);
  return {
    total,
    threshold: cn_EXPECT_COUNTS.tagSpecificRateMin,
    standard: { specific: standard, fallback: total - standard, rate: rate(standard), gate: standard / (total || 1) >= cn_EXPECT_COUNTS.tagSpecificRateMin },
    conservative: { specific: conservative, fallback: total - conservative, rate: rate(conservative) },
  };
}

function bk_warnTagCoverage(coverage, warn) {
  if (!coverage.standard.gate) {
    warn(
      "W_TAG_COVERAGE",
      "standard tag coverage " + coverage.standard.specific + "/" + coverage.total + " = " +
        (coverage.standard.rate * 100).toFixed(2) + "% < " + coverage.threshold * 100 + "% (per 5.6.1: warning only)"
    );
  }
}

// 构建报告用汇总
export function bk_buildReport(bank) {
  const counts = bk_countsOf(bank);
  const tagCounts = bk_tagCounts(bank);
  const difficulty = { 1: 0, 2: 0, 3: 0 };
  let fallback = 0;
  for (const q of bank.questions) {
    difficulty[q.difficulty] = (difficulty[q.difficulty] || 0) + 1;
    if (bk_isFallbackTagged(q)) fallback += 1;
  }
  return {
    chapters: cn_CHAPTERS.map((c) => ({ chapterCode: c.chapterCode, chapterName: c.chapterName, chapterTotal: c.chapterTotal })),
    countsBySectionType: counts.bySectionType,
    countsByResponseMode: counts.byResponseMode,
    countsByChapter: counts.byChapter,
    difficulty,
    tagCounts,
    fallbackTagged: fallback,
    specificTagged: bank.questions.length - fallback,
    tagCoverage: bk_tagCoverage(bank),
  };
}
