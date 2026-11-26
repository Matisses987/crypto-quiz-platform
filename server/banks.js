// 题库：加载、校验、脱答案下发、外部题库归一化、启动幂等导入
// 设计见 docs/服务器版改造计划.md §4.4 / §6.2
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CQP } from "../src/core/index.mjs";
import { config } from "./config.js";
import { all, nowIso, one, run } from "./db.js";
import { badRequest, notFound } from "./http.js";

/** 下发时剥掉的字段：答案与校对状态一律留在服务端 */
// 下发给浏览器的题库必须去掉答案；explanation 常常直接写出正确项，也一并剥掉。
// needsReview / reviewReason 只是数据质量标记，不含答案，留着让「校对纠错」页仍能筛出待校对题。
const STRIP_FIELDS = ["answer", "rawAnswer", "explanation"];

const payloadCache = new Map(); // slug -> { bank, etag }
const strippedCache = new Map(); // slug -> { json, etag }

/* ------------------------------------------------------------------ 脱答案 */

export function stripBank(bank) {
  const questions = bank.questions.map((q) => {
    const out = {};
    for (const key of Object.keys(q)) {
      if (STRIP_FIELDS.indexOf(key) >= 0) continue;
      out[key] = q[key];
    }
    return out;
  });
  return { ...bank, questions };
}

function hashOf(text) {
  return '"' + createHash("sha1").update(text).digest("hex").slice(0, 20) + '"';
}

/* ------------------------------------------------------- 外部题库归一化适配器 */

// 旧扁平 schema 的章节名 → 上游 7 个 chapterCode
const DEFAULT_CHAPTER_HINTS = {
  密码法: "C01",
  网络安全法: "C02",
  商用密码管理: "C03",
  商用密码管理条例: "C03",
  数据安全法: "C04",
  个人信息保护法: "C04",
  电子签名法: "C04",
  等级保护与标准: "C07",
  标准规范: "C07",
  // 纯密码学题库：整库落「密码学」这一章（C05）
  古典与基础: "C05",
  对称密码: "C05",
  非对称密码: "C05",
  "哈希与 MAC": "C05",
  "签名与 PKI": "C05",
  国密算法: "C05",
  密码分析: "C05",
  实践与工程: "C05",
  密码学: "C05",
  密码前沿技术: "C06",
};

// 章节名 → 词表标签（词表见 CQP.TAG_VOCAB）
const DEFAULT_TAG_HINTS = {
  密码法: "密码法",
  网络安全法: "网络安全法",
  数据安全法: "数据安全法",
  个人信息保护法: "个人信息保护法",
  商用密码管理: "商用密码管理条例",
  商用密码管理条例: "商用密码管理条例",
   等级保护与标准: "标准规范",
  古典与基础: "密码学基础",
  对称密码: "分组密码",
  非对称密码: "公钥密码",
  "哈希与 MAC": "杂凑与消息鉴别",
  "签名与 PKI": "电子认证与 PKI",
  国密算法: "SM2",
  密码分析: "密码学基础",
  实践与工程: "密码应用",
};

const TYPE_MAP = { single: "single", multiple: "multiple", judge: "judge", blank: "blank" };

function pickTag(chapterName, code) {
  const vocab = CQP.TAG_VOCAB;
  const hinted = DEFAULT_TAG_HINTS[chapterName];
  if (hinted && vocab.indexOf(hinted) >= 0) return hinted;
  const fallback = CQP.CHAPTER_FALLBACK_TAGS && CQP.CHAPTER_FALLBACK_TAGS[code];
  if (fallback && vocab.indexOf(fallback) >= 0) return fallback;
  return "密码应用";
}

/**
 * 把扁平 schema `{slug,title,subject,questions[{qid,stem,type,options,answer,explanation,chapter,difficulty}]}`
 * 归一化成上游冻结 schema（`CQP.validateBank` 必须能过）。
 *
 * 关键点：
 * - `fixture:true` 必置，否则会撞上 1051 题专用的绝对计数表
 * - `id` 必须严格等于 `Q-<chapterCode>-<TYPE_CODE>-<seq:4>`
 * - `chapters[]` 的 chapterTotal / sections[].count 必须与真实计数逐格相等
 * - `responseMode` 必须与 `CQP.responseModeOf()` 推导一致
 */
export function normalizeExternalBank(input, opts = {}) {
  if (!input || typeof input !== "object") throw badRequest("题库文件不是合法 JSON 对象");
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  if (rawQuestions.length === 0) throw badRequest("题库里没有题目（questions 为空）");

  const slug = String(opts.slug || input.slug || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(slug)) throw badRequest("题库 slug 必须是 1–40 位字母数字、下划线或连字符");
  const title = String(input.title || slug).slice(0, 60);
  const subject = String(input.subject || "custom").slice(0, 20);

  const chapterHints = { ...DEFAULT_CHAPTER_HINTS, ...(opts.chapterHints || {}) };
  const seqByKey = new Map();
  const counts = {};
  for (const code of CQP.CHAPTER_CODES) counts[code] = {};

  const questions = [];
  for (const raw of rawQuestions) {
    if (!raw || typeof raw !== "object") throw badRequest("题库里有非法题目条目");
    const sectionType = TYPE_MAP[raw.type];
    if (!sectionType) throw badRequest("题目类型不支持：" + String(raw.type));

    const chapterName = String(raw.chapter || "").trim();
    let code = chapterHints[chapterName];
    if (!code) {
      // 没命中提示表：按出现顺序轮流分配到 C05/C06/C07，避免整库挤在一章
      const used = CQP.CHAPTER_CODES.filter((c) => Object.keys(counts[c]).length > 0);
      code = used.length < 7 ? CQP.CHAPTER_CODES[used.length % 7] : "C05";
    }

    const key = code + "|" + sectionType;
    const seq = (seqByKey.get(key) || 0) + 1;
    seqByKey.set(key, seq);
    counts[code][sectionType] = (counts[code][sectionType] || 0) + 1;

    const meta = CQP.chapterByCode(code);
    const options =
      sectionType === "single" || sectionType === "multiple"
        ? (Array.isArray(raw.options) ? raw.options : []).slice(0, 4).map((o, i) => ({
            key: String(o && o.key ? o.key : "ABCD"[i]),
            text: String(o && o.text ? o.text : ""),
          }))
        : [];

    const answer = (Array.isArray(raw.answer) ? raw.answer : []).map((a) => String(a));
    if (answer.length === 0) throw badRequest("题目缺答案：" + String(raw.qid || raw.stem || "").slice(0, 30));

    const q = {
      id: "Q-" + code + "-" + CQP.TYPE_CODES[sectionType] + "-" + String(seq).padStart(4, "0"),
      chapterCode: code,
      partCode: meta.partCode,
      partName: meta.partName,
      chapterName: meta.chapterName,
      sectionType,
      typeName: CQP.TYPE_NAMES[sectionType],
      seq,
      printedNo: typeof raw.printedNo === "number" ? raw.printedNo : seq,
      stem: String(raw.stem || "").trim(),
      options,
      answer,
      answerStatus: "ok",
      rawAnswer: answer.join(""),
      tags: [pickTag(chapterName, code)],
      difficulty: [1, 2, 3].indexOf(raw.difficulty) >= 0 ? raw.difficulty : 2,
      sourcePage: 1,
      blankCount: sectionType === "blank" ? 1 : 0,
      needsReview: false,
      reviewReason: null,
      explanation: typeof raw.explanation === "string" ? raw.explanation : "",
    };
    q.responseMode = CQP.responseModeOf(q);
    questions.push(q);
  }

  const chapters = CQP.CHAPTER_CODES.map((code) => {
    const meta = CQP.chapterByCode(code);
    const per = counts[code];
    const sections = [];
    let total = 0;
    for (const t of CQP.TYPES) {
      const n = per[t] || 0;
      if (n === 0) continue;
      sections.push({ sectionType: t, typeName: CQP.TYPE_NAMES[t], count: n });
      total += n;
    }
    return {
      chapterCode: code,
      partCode: meta.partCode,
      partName: meta.partName,
      chapterName: meta.chapterName,
      chapterTotal: total,
      sections,
    };
  });

  return {
    schemaVersion: "1.0.0",
    bankVersion: String(opts.bankVersion || input.bankVersion || slug + "-v1"),
    generatedAt: nowIso(),
    fixture: true,
    slug,
    title,
    subject,
    description: String(input.description || ""),
    source: {
      fileName: slug + ".json",
      pages: 1,
      theoryBlocks: questions.length,
      printedQuestions: questions.length,
      excludedCount: 0,
      excludedReason: "外部导入，非原版 PDF",
    },
    chapters,
    questions,
  };
}

/** 校验外部题库并返回 {bank, report}；不通过则抛 400 带明细 */
export function validateExternalBank(bank) {
  const report = CQP.validateBank(bank, { fixture: bank.fixture === true });
  if (!report.ok) {
    const first = (report.errors || []).slice(0, 5).map((e) => (e.code ? e.code + " " : "") + String(e.message || ""));
    throw badRequest("题库校验未通过（" + (report.errors || []).length + " 处错误）：" + first.join("；"), {
      errors: (report.errors || []).slice(0, 40),
    });
  }
  return report;
}

/* ------------------------------------------------------------------ 存取 */

function rowToBank(row) {
  return JSON.parse(row.payload);
}

/** 完整题库（含答案），仅服务端内部使用 */
export function loadBank(slug) {
  const key = String(slug || "builtin");
  if (payloadCache.has(key)) return payloadCache.get(key).bank;
  const row = one("SELECT payload FROM banks WHERE slug = ?", key);
  if (!row) throw notFound("题库不存在：" + key);
  const bank = rowToBank(row);
  payloadCache.set(key, { bank });
  return bank;
}

export function bankExists(slug) {
  return Boolean(one("SELECT 1 AS ok FROM banks WHERE slug = ?", String(slug || "")));
}

/** 脱答案后的下发版本 + ETag */
export function servedBank(slug) {
  const key = String(slug || "builtin");
  if (strippedCache.has(key)) return strippedCache.get(key);
  const bank = loadBank(key);
  // 下发给前端的题库已经抹掉 answer/rawAnswer/explanation，前端无法再做契约自检
  // （每道题都会被判成「缺答案」）。所以这里把服务端在导入时做的自检结论带上，
  // 前端只显示这份结论，不再本地跑 validateBank。
  const report = CQP.validateBank(bank, { fixture: bank.fixture === true });
  const selfCheck = {
    ok: report.ok === true,
    errors: report.errors.length,
    warnings: report.warnings.map((w) => w.code),
    answersStripped: true,
  };
  const json = JSON.stringify({ ...stripBank(bank), selfCheck });
  const entry = { json, etag: hashOf(json) };
  strippedCache.set(key, entry);
  return entry;
}

export function questionMap(slug) {
  const bank = loadBank(slug);
  const map = new Map();
  for (const q of bank.questions) map.set(q.id, q);
  return map;
}

export function listBanks() {
  return all(
    `SELECT slug, title, subject, bank_version, question_cnt, updated_at FROM banks ORDER BY sort_order ASC, slug ASC`
  ).map((row) => ({
    slug: row.slug,
    title: row.title,
    subject: row.subject,
    bankVersion: row.bank_version,
    questionCount: row.question_cnt,
    updatedAt: row.updated_at,
  }));
}

function upsertBank(bank, { subject, sortOrder = 100 } = {}) {
  const payload = JSON.stringify(bank);
  const now = nowIso();
  const existing = one("SELECT slug FROM banks WHERE slug = ?", bank.slug);
  if (existing) {
    run(
      `UPDATE banks SET title = ?, subject = ?, bank_version = ?, payload = ?, question_cnt = ?, updated_at = ? WHERE slug = ?`,
      String(bank.title || bank.slug),
      String(subject || bank.subject || "custom"),
      String(bank.bankVersion || "v1"),
      payload,
      bank.questions.length,
      now,
      bank.slug
    );
  } else {
    run(
      `INSERT INTO banks (slug, title, subject, bank_version, payload, question_cnt, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bank.slug,
      String(bank.title || bank.slug),
      String(subject || bank.subject || "custom"),
      String(bank.bankVersion || "v1"),
      payload,
      bank.questions.length,
      sortOrder,
      now,
      now
    );
  }
  payloadCache.delete(bank.slug);
  strippedCache.delete(bank.slug);
  return {
    slug: bank.slug,
    title: bank.title,
    questionCount: bank.questions.length,
    created: !existing,
  };
}

/* ------------------------------------------------------------------ 导入 */

/** 导入外部扁平 schema 题库（admin 上传或种子导入） */
export function importExternalBank(input, opts = {}) {
  const bank = normalizeExternalBank(input, opts);
  const report = validateExternalBank(bank);
  const result = upsertBank(bank, { subject: opts.subject || bank.subject, sortOrder: opts.sortOrder });
  return {
    ...result,
    warnings: (report.warnings || []).map((w) => w.code),
    questionCount: bank.questions.length,
  };
}

const BUILTIN_SLUG = "builtin";

/** 内置 1051 题：从 src/data/bank.json 读取并落库（幂等） */
export function ensureBuiltinBank() {
  const row = one("SELECT question_cnt FROM banks WHERE slug = ?", BUILTIN_SLUG);
  let bank;
  try {
    bank = JSON.parse(fs.readFileSync(config.bankFile, "utf8"));
  } catch (err) {
    if (row) return { skipped: true, reason: "内置题库文件不可读，沿用库内已有版本" };
    throw err;
  }
  const report = CQP.validateBank(bank, {});
  if (!report.ok) {
    const first = (report.errors || []).slice(0, 3).map((e) => String(e.message || ""));
    throw new Error("内置题库自检未通过：" + first.join("；"));
  }
  const mapped = { ...bank, slug: BUILTIN_SLUG, subject: "builtin", title: bank.title || "密码赛题库" };
  const created = upsertBank(mapped, { subject: "builtin", sortOrder: 10 });
  return { skipped: false, ...created, warnings: (report.warnings || []).length };
}

/** 扫 data/seed/*.json：外部扁平 schema，启动幂等导入 */
export function seedBanks() {
  if (!fs.existsSync(config.seedDir)) return { imported: [], failed: [] };
  const files = fs.readdirSync(config.seedDir).filter((f) => f.endsWith(".json"));
  const imported = [];
  const failed = [];
  for (const file of files) {
    const full = path.join(config.seedDir, file);
    try {
      const input = JSON.parse(fs.readFileSync(full, "utf8"));
      const slug = String(input.slug || path.basename(file, ".json"));
      const result = importExternalBank(input, {
        slug,
        subject: input.subject,
        sortOrder: 20,
        bankVersion: String(input.bankVersion || slug + "-seed"),
      });
      imported.push(result);
    } catch (err) {
      failed.push({ file, error: err && err.message ? err.message : String(err) });
    }
  }
  return { imported, failed };
}

export function deleteBank(slug) {
  const key = String(slug || "");
  if (key === BUILTIN_SLUG) throw badRequest("内置题库不可删除");
  const row = one("SELECT slug FROM banks WHERE slug = ?", key);
  if (!row) throw notFound("题库不存在");
  run("DELETE FROM banks WHERE slug = ?", key);
  payloadCache.delete(key);
  strippedCache.delete(key);
}

export { BUILTIN_SLUG };
