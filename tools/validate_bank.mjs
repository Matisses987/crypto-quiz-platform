#!/usr/bin/env node
/**
 * validate_bank.mjs -- independent validator for src/data/bank.json
 *
 * Standalone (no dependencies, no imports from the app). Re-checks the frozen
 * contract of docs/需求规格.md (v1.1.0) and prints an ASCII-only report so
 * it can run on any console (Windows cp936 consoles mangle CJK).
 *
 * The output contains the §5.9 count-check table as 22 numbered items plus extra
 * structural guards, and ends with "ok: true" / "ok: false".
 *
 * Usage:
 *   node tools/validate_bank.mjs [path/to/bank.json]
 *   BANK_PATH=... node tools/validate_bank.mjs
 *
 * Exit codes: 0 = all checks pass, 1 = at least one check failed, 2 = usage/IO error.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');           // 
const WORKSPACE = resolve(PROJECT, '..');      // workspace root
const DEFAULT_BANK = join(PROJECT, 'src', 'data', 'bank.json');
const bankPath = process.argv[2] || process.env.BANK_PATH || DEFAULT_BANK;

// ---------------------------------------------------------------- frozen data
const SCHEMA_VERSION = '1.0.0';
const SPEC_VERSION = 'v1.1.0';
const SECTION_TYPES = ['single', 'multiple', 'judge', 'blank'];
const TYPE_NAMES = { single: '单选题', multiple: '多选题', judge: '判断题', blank: '填空题' };
const PART_NAMES = { B: '基础题', P: '专业题' };

/** chapterCode -> { partCode, chapterName, sections: { sectionType: [blocks, printed] } } */
const CHAPTER_SPEC = {
  C01: { partCode: 'B', chapterName: '密码法律法规', sections: { single: [40, 40], multiple: [13, 13], judge: [12, 12] } },
  C02: { partCode: 'B', chapterName: '网络安全法律法规', sections: { single: [30, 30], multiple: [10, 10], judge: [10, 10] } },
  C03: { partCode: 'B', chapterName: '密码管理规章制度', sections: { single: [35, 35], multiple: [10, 10], judge: [10, 10] } },
  C04: { partCode: 'B', chapterName: '其他政策法规条例', sections: { single: [25, 25], multiple: [10, 10], judge: [10, 10] } },
  C05: { partCode: 'P', chapterName: '密码学', sections: { single: [156, 155], multiple: [130, 130], judge: [80, 80], blank: [30, 30] } },
  C06: { partCode: 'P', chapterName: '密码前沿技术', sections: { single: [115, 115], multiple: [60, 60], judge: [20, 20] } },
  C07: { partCode: 'P', chapterName: '标准题', sections: { single: [90, 90], multiple: [125, 125], judge: [30, 30] } },
};
const CHAPTER_ORDER = ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07'];

const TAG_RULES = [
  ['密码法', '密码法'],
  ['商用密码管理条例', '商用密码管理条例'],
  ['网络安全法', '网络安全法'],
  ['数据安全法', '数据安全法'],
  ['个人信息保护法', '个人信息保护法'],
  ['电子签名法', '电子签名法'],
  ['部门规章', '检测机构管理办法|应用安全性评估管理办法|电子政务电子认证服务管理办法|关键信息基础设施商用密码使用管理规定|电子认证服务使用密码管理办法|网络安全审查办法'],
  ['地方性法规', '江苏省|省条例'],
  ['SM2', 'SM2'], ['SM3', 'SM3'], ['SM4', 'SM4'], ['SM9', 'SM9'], ['ZUC', 'ZUC'],
  ['分组密码', '分组密码|工作模式|Feistel|ECB|CBC|CFB|OFB|CTR|GCM|CCM'],
  ['流密码', '流密码|LFSR'],
  ['公钥密码', '公钥|RSA|ElGamal|椭圆曲线|ECDSA|ECC|双线性|Diffie-Hellman'],
  ['杂凑与消息鉴别', '杂凑|哈希|SHA-1|SHA-256|SHA-2|SHA-3|MD5|HMAC|CMAC|摘要'],
  ['密钥管理', '密钥管理|密钥派生|KDF|密钥交换|秘密共享|门限|HSM|密码机'],
  ['量子密码', '量子|BB84|QKD|抗量子|后量子'],
  ['区块链', '区块链'],
  ['电子认证与 PKI', '数字证书|PKI|电子签章|时间戳|身份鉴别|IBC|属性证书|CA 系统'],
  ['网络协议与密码应用', 'TLS|SSL|IPSec|VPN|SSH|协议分析|网关'],
  ['密评与建设运维', '密码应用安全性评估|密评|GB/T 39786|等级保护|测评|建设整改|运维'],
  ['标准规范', '(GB/T|GM/T|GM/Z)\\s*\\d+'],
  ['人工智能安全', '人工智能|生成式|大模型|智能体|AI '],
  ['物联网与工控安全', '物联网|PLC|工控|车联网|RFID'],
  ['口令与鉴权', '口令|动态口令|OTP|双因素|生物特征|访问控制|授权管理'],
  ['职业道德', '职业道德|职业守则|职业标准|保密义务'],
  ['商用密码', '商用密码'],
  ['核心密码与普通密码', '核心密码|普通密码'],
  ['密码应用', '密码应用|密码使用|密码保障|密码测评'],
  ['数据安全与个人信息', '数据安全|个人信息|数据出境|重要数据'],
  ['网络安全与关基', '网络安全|关键信息基础设施|网络关键设备|网络安全审查'],
];
const CHAPTER_FALLBACK_TAG = {
  C01: '密码法律法规', C02: '网络安全法律法规', C03: '密码管理规章制度', C04: '其他政策法规条例',
  C05: '密码学基础', C06: '密码前沿技术', C07: '标准规范',
};
const TAG_VOCAB = new Set([...TAG_RULES.map(([t]) => t), '未分类', ...Object.values(CHAPTER_FALLBACK_TAG)]);

const EXPECTED = {
  questions: 1051,
  printed: 1050,
  answerOk: 1051,
  answerMissing: 0,
  answerLengthZero: 0,
  blankQuestions: 30,
  manualAnswers: 1,
  manualAnswerIds: ['Q-C05-F-0007'],
  needsReviewIds: ['Q-C05-F-0007', 'Q-C05-S-0060', 'Q-C06-M-0008', 'Q-C06-S-0004', 'Q-C07-S-0027'],
  sectionType: { single: 491, multiple: 358, judge: 172, blank: 30 },
  responseMode: { single: 492, multiple: 357, judge: 172, blank: 30 },
  typeMismatchIds: ['Q-C04-M-0002', 'Q-C04-M-0009', 'Q-C06-M-0008', 'Q-C06-S-0004', 'Q-C07-S-0027'],
  matchingIds: ['Q-C04-M-0002', 'Q-C04-M-0009', 'Q-C06-S-0006', 'Q-C06-S-0096'],
  judgeAnswer: { 对: 81, 错: 91 },
  singleSection: { one: 489, many: 2, manyIds: ['Q-C06-S-0004', 'Q-C07-S-0027'] },
  multipleSection: { one: 3, oneIds: ['Q-C04-M-0002', 'Q-C04-M-0009', 'Q-C06-M-0008'] },
  blankManual: { id: 'Q-C05-F-0007', answer: ['16'] },
  unnumberedId: 'Q-C05-S-0060',
  tagCoverageMin: 0.8,
  idRe: /^Q-C\d{2}-[SMJF]-\d{4}$/,
  difficulty: { B: { single: 1, judge: 1, multiple: 2 }, P: { single: 2, judge: 2, multiple: 3, blank: 3 } },
};

// ---------------------------------------------------------------- test harness
const checks = [];
function check(id, item, ok, detail) {
  checks.push({ id, item: item || '', ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  return !!ok;
}
const sortedEq = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
const pad = (s, n) => String(s).padEnd(n);
const num = (v) => String(v).padStart(6);

// ---------------------------------------------------------------- load
let bank;
try {
  bank = JSON.parse(readFileSync(bankPath, 'utf8'));
} catch (err) {
  console.error(`FATAL: cannot read/parse ${bankPath}: ${err.message}`);
  console.error('ok: false');
  process.exit(2);
}

const questions = Array.isArray(bank.questions) ? bank.questions : [];

// ---------------------------------------------------------------- collect
const byType = Object.fromEntries(SECTION_TYPES.map((t) => [t, 0]));
const byMode = Object.fromEntries(SECTION_TYPES.map((t) => [t, 0]));
const printedByType = Object.fromEntries(SECTION_TYPES.map((t) => [t, 0]));
const judgeDist = { 对: 0, 错: 0 };
const judgeBadAnswers = [];
const ids = new Map();
const duplicates = [];
const badTagVocab = [];
const tagLenBad = [];
const badDifficulty = [];
const badOptions = [];
const badIdFormat = [];
const printedNull = [];
const needsReview = [];
const modeMismatch = [];
const answerMissingList = [];
const answerLengthZero = [];
const blankQuestions = [];
const missingFields = [];
const fieldTypes = [];
const printedCounter = {};
const matchingDetected = [];
const REQUIRE_STRICT_RAW = [];

const REQUIRED = [
  ['id', 'string'], ['chapterCode', 'string'], ['partCode', 'string'], ['partName', 'string'],
  ['chapterName', 'string'], ['sectionType', 'string'], ['typeName', 'string'], ['responseMode', 'string'],
  ['seq', 'number'], ['printedNo', 'number|null'], ['stem', 'string'], ['options', 'array'],
  ['answer', 'array'], ['answerStatus', 'string'], ['rawAnswer', 'string|null'], ['tags', 'array'],
  ['difficulty', 'number'], ['sourcePage', 'number'], ['blankCount', 'number'], ['needsReview', 'boolean'],
  ['reviewReason', 'string|null'],
];
const VALID_SECTION_TYPES = new Set(SECTION_TYPES);
const VALID_REVIEW_REASONS = new Set(['printed_number_missing', 'answer_missing', 'type_mismatch', null]);

for (const q of questions) {
  if (!q || typeof q !== 'object') {
    missingFields.push('(non-object entry)');
    continue;
  }
  for (const [key, kind] of REQUIRED) {
    if (!(key in q)) {
      missingFields.push(`${q.id || '?'}.${key}`);
      continue;
    }
    const actual = typeOf(q[key]);
    if (!kind.split('|').includes(actual)) fieldTypes.push(`${q.id}.${key}=${actual} expected ${kind}`);
  }
  if (typeof q.id === 'string') {
    if (!EXPECTED.idRe.test(q.id)) badIdFormat.push(q.id);
    if (ids.has(q.id)) duplicates.push(q.id);
    else ids.set(q.id, q);
  }
  if (!VALID_SECTION_TYPES.has(q.sectionType)) badIdFormat.push(`${q.id}:bad-section-type=${q.sectionType}`);
  else byType[q.sectionType] += 1;
  if (VALID_SECTION_TYPES.has(q.responseMode)) byMode[q.responseMode] += 1;
  if (q.printedNo === null) printedNull.push(q.id);
  else {
    printedByType[q.sectionType] += 1;
    const key = `${q.chapterCode}/${q.sectionType}`;
    (printedCounter[key] = printedCounter[key] || []).push(q.printedNo);
  }
  if (q.sectionType === 'judge') {
    if (Array.isArray(q.answer) && q.answer.length === 1 && (q.answer[0] === '对' || q.answer[0] === '错')) judgeDist[q.answer[0]] += 1;
    else judgeBadAnswers.push(`${q.id}:${JSON.stringify(q.answer)}`);
  }
  if (!Array.isArray(q.tags) || q.tags.length < 1 || q.tags.length > 3) tagLenBad.push(`${q.id}:${JSON.stringify(q.tags)}`);
  else for (const t of q.tags) if (!TAG_VOCAB.has(t)) badTagVocab.push(`${q.id}:${t}`);
  const want = EXPECTED.difficulty[q.partCode]?.[q.sectionType];
  if (![1, 2, 3].includes(q.difficulty) || (want !== undefined && q.difficulty !== want)) badDifficulty.push(`${q.id}:${q.difficulty}`);
  if (q.sectionType === 'single' || q.sectionType === 'multiple') {
    const keys = Array.isArray(q.options) ? q.options.map((o) => o && o.key) : [];
    if (JSON.stringify(keys) !== JSON.stringify(['A', 'B', 'C', 'D'])) badOptions.push(`${q.id}:keys=${keys.join('') || 'none'}`);
    else if (q.options.some((o) => typeof o.text !== 'string' || o.text.trim() === '')) badOptions.push(`${q.id}:empty-option-text`);
  } else if (Array.isArray(q.options) && q.options.length !== 0) {
    badOptions.push(`${q.id}:non-choice-with-options`);
  }
  if (q.needsReview === true) needsReview.push(q.id);
  if (!VALID_REVIEW_REASONS.has(q.reviewReason === undefined ? null : q.reviewReason)) badIdFormat.push(`${q.id}:reviewReason=${q.reviewReason}`);
  if (q.answerStatus === 'missing') answerMissingList.push(q.id);
  if (Array.isArray(q.answer) && q.answer.length === 0) answerLengthZero.push(q.id);
  if ((q.sectionType === 'single' || q.sectionType === 'multiple') && q.sectionType !== q.responseMode) modeMismatch.push(q.id);
  if (
    q.answerStatus === 'ok' &&
    Array.isArray(q.answer) &&
    q.answer.length >= 1 &&
    !EXPECTED.manualAnswerIds.includes(q.id) &&
    (q.rawAnswer === null || q.rawAnswer === undefined)
  ) {
    REQUIRE_STRICT_RAW.push(q.id);
  }
  if (q.sectionType === 'blank') {
    blankQuestions.push(q);
    if (q.blankCount !== 1) badDifficulty.push(`${q.id}:blankCount=${q.blankCount}`);
  } else if (q.blankCount !== 0) badDifficulty.push(`${q.id}:blankCount=${q.blankCount}`);
  if (
    (q.sectionType === 'single' || q.sectionType === 'multiple') &&
    typeof q.stem === 'string' &&
    /连线|匹配/.test(q.stem) &&
    Array.isArray(q.options) &&
    q.options.length === 4 &&
    q.options.every((o) => /^\d+\s*[-—－–]\s*[A-D]/.test(o.text))
  ) {
    matchingDetected.push(q.id);
  }
}

// ---------------------------------------------------------------- §5.9 table (22 items)
const okCount = questions.filter((q) => q.answerStatus === 'ok').length;
const printedTotal = Object.values(printedByType).reduce((a, b) => a + b, 0);
const singleSection = questions.filter((q) => q.sectionType === 'single');
const multipleSection = questions.filter((q) => q.sectionType === 'multiple');
const manualQuestions = questions.filter((q) => EXPECTED.manualAnswerIds.includes(q.id));
const singleOne = singleSection.filter((q) => q.answer.length === 1).map((q) => q.id);
const singleMany = singleSection.filter((q) => q.answer.length >= 2).map((q) => q.id);
const multiOne = multipleSection.filter((q) => q.answer.length === 1).map((q) => q.id);
const multiRangeBad = multipleSection.filter((q) => q.answer.length < 1 || q.answer.length > 4 || q.answer.some((a) => !['A', 'B', 'C', 'D'].includes(a)));
const multiUnsorted = multipleSection
  .filter((q) => q.answer.length >= 2)
  .filter((q) => JSON.stringify([...new Set(q.answer)].sort()) !== JSON.stringify(q.answer));
const blankWithoutAnswer = blankQuestions.filter((q) => !Array.isArray(q.answer) || q.answer.length === 0);
const manualBlank = blankQuestions.find((q) => q.id === EXPECTED.blankManual.id);
const manualOk =
  !!manualBlank &&
  JSON.stringify(manualBlank.answer) === JSON.stringify(EXPECTED.blankManual.answer) &&
  manualBlank.rawAnswer === null &&
  manualBlank.answerStatus === 'ok' &&
  manualBlank.needsReview === true &&
  manualBlank.reviewReason === 'answer_missing' &&
  manualBlank.stem.includes('可以切 16 块');

const chapterCellProblems = [];
for (const code of CHAPTER_ORDER) {
  for (const [stype, [expBlocks, expPrinted]] of Object.entries(CHAPTER_SPEC[code].sections)) {
    const actualBlocks = questions.filter((q) => q.chapterCode === code && q.sectionType === stype).length;
    const actualPrinted = questions.filter((q) => q.chapterCode === code && q.sectionType === stype && q.printedNo !== null).length;
    const nos = (printedCounter[`${code}/${stype}`] || []).slice().sort((a, b) => a - b);
    const seqOk = JSON.stringify(nos) === JSON.stringify(Array.from({ length: nos.length }, (_, i) => i + 1));
    if (actualBlocks !== expBlocks || actualPrinted !== expPrinted || !seqOk) {
      chapterCellProblems.push(`${code}/${stype} blocks=${actualBlocks}/${expBlocks} printed=${actualPrinted}/${expPrinted} seq=${seqOk ? 'ok' : 'gap'}`);
    }
  }
}

let specificQuestions = 0;
let fallbackQuestions = 0;
let fallbackNamedQuestions = 0;
const tagCounter = {};
for (const q of questions) {
  const text = q.stem + ' ' + q.options.map((o) => o.text).join(' ');
  if (TAG_RULES.some(([, pattern]) => new RegExp(pattern, 'i').test(text))) specificQuestions += 1;
  else fallbackQuestions += 1;
  if (q.tags.length === 1 && q.tags[0] === CHAPTER_FALLBACK_TAG[q.chapterCode]) fallbackNamedQuestions += 1;
  for (const t of q.tags) tagCounter[t] = (tagCounter[t] || 0) + 1;
}
const tagCoverage = questions.length ? specificQuestions / questions.length : 0;

check('S01', 'questions.length', questions.length === EXPECTED.questions, `questions=${questions.length} expected ${EXPECTED.questions}`);
check('S02', 'answerStatus="ok" count', okCount === EXPECTED.answerOk, `ok=${okCount} expected ${EXPECTED.answerOk}`);
check('S03', 'answerStatus="missing" count', answerMissingList.length === EXPECTED.answerMissing, `missing=${answerMissingList.length} expected ${EXPECTED.answerMissing}${answerMissingList.length ? ' -> ' + answerMissingList.join(',') : ''}`);
check('S04', 'needsReview=true count and ids', needsReview.length === 5 && sortedEq(needsReview, EXPECTED.needsReviewIds), `needsReview(${needsReview.length})=${needsReview.join(',')}`);
check('S05', 'printedNo=null count', printedNull.length === 1 && printedNull[0] === EXPECTED.unnumberedId, `printedNo=null: ${printedNull.join(',') || 'none'}`);
check('S06', 'per chapter/section counts (5.2.1)', chapterCellProblems.length === 0, chapterCellProblems.join(' | ') || 'all 22 cells match (blocks + printed + 1..N sequence)');
check('S07', 'sectionType counts', JSON.stringify(byType) === JSON.stringify(EXPECTED.sectionType), `sectionType=${JSON.stringify(byType)} expected ${JSON.stringify(EXPECTED.sectionType)}`);
check('S08', 'responseMode counts', JSON.stringify(byMode) === JSON.stringify(EXPECTED.responseMode), `responseMode=${JSON.stringify(byMode)} expected ${JSON.stringify(EXPECTED.responseMode)}`);
check('S09', 'sectionType!==responseMode count and ids', modeMismatch.length === 5 && sortedEq(modeMismatch, EXPECTED.typeMismatchIds), `mismatch(${modeMismatch.length})=${modeMismatch.join(',')}`);
check('S10', 'judge answer distribution', judgeDist.对 === EXPECTED.judgeAnswer.对 && judgeDist.错 === EXPECTED.judgeAnswer.错, `对=${judgeDist.对} 错=${judgeDist.错} expected 81/91`);
check('S11', 'judge answer domain {对,错}', judgeBadAnswers.length === 0, `bad judge answers=${judgeBadAnswers.length}${judgeBadAnswers.length ? ' -> ' + judgeBadAnswers.slice(0, 5).join(',') : ''}`);
check('S12', 'multiple-section answer shape', byType.multiple === 358 && multiRangeBad.length === 0 && multiUnsorted.length === 0 && multiOne.length === EXPECTED.multipleSection.one && sortedEq(multiOne, EXPECTED.multipleSection.oneIds),
  `n=${byType.multiple} lettersOk=${multiRangeBad.length === 0} ascendingUnique=${multiUnsorted.length === 0} singleLetter=${multiOne.length}`);
check('S13', 'single-section answer shape', byType.single === 491 && singleOne.length === EXPECTED.singleSection.one && sortedEq(singleMany, EXPECTED.singleSection.manyIds),
  `n=${byType.single} oneLetter=${singleOne.length} multiLetter=${singleMany.length} (${singleMany.join(',')})`);
check('S14', 'blank-section answer shape', blankQuestions.length === EXPECTED.blankQuestions && blankWithoutAnswer.length === 0 && manualOk,
  `n=${blankQuestions.length} withAnswer=${blankQuestions.length - blankWithoutAnswer.length} manual(Q-C05-F-0007)=${manualOk ? '["16"]/rawAnswer=null/needsReview=true' : 'MISMATCH'}`);
check('S15', 'answer.length >= 1 count / = 0 count', okCount - answerLengthZero.length === EXPECTED.questions - EXPECTED.answerLengthZero && answerLengthZero.length === EXPECTED.answerLengthZero,
  `withAnswer=${okCount - answerLengthZero.length} empty=${answerLengthZero.length} expected ${EXPECTED.questions}/${EXPECTED.answerLengthZero}`);
check('S16', 'manually recorded answers', manualQuestions.length === EXPECTED.manualAnswers && manualQuestions.every((q) => q.rawAnswer === null && q.needsReview === true),
  `manual=${manualQuestions.length} -> ${manualQuestions.map((q) => `${q.id}(rawAnswer=null,needsReview=true)`).join(',')}`);
check('S17', 'source.pages', bank.source?.pages === 199, `source.pages=${bank.source?.pages}`);
check('S18', 'tag coverage', tagLenBad.length === 0 && badTagVocab.length === 0 && !questions.some((q) => q.tags.includes('未分类')) && tagCoverage >= EXPECTED.tagCoverageMin,
  `len1..3ok=${tagLenBad.length === 0} unclassified=${questions.filter((q) => q.tags.includes('未分类')).length} outsideVocab=${badTagVocab.length} specific=${(tagCoverage * 100).toFixed(1)}%`);
check('S19', 'matching/连线 questions', matchingDetected.length === 4 && sortedEq(matchingDetected, EXPECTED.matchingIds), `matching(${matchingDetected.length})=${matchingDetected.join(',')}`);
check('S20', 'id uniqueness and format (guard)', duplicates.length === 0 && badIdFormat.length === 0, `duplicates=${duplicates.length} badFormat=${badIdFormat.length}`);
check('S21', 'chapter tree consistency (guard)', (() => {
  const problems = [];
  if (!Array.isArray(bank.chapters) || bank.chapters.length !== 7) return `chapters length=${Array.isArray(bank.chapters) ? bank.chapters.length : 'n/a'}`;
  bank.chapters.forEach((ch, i) => {
    const code = CHAPTER_ORDER[i];
    const spec = CHAPTER_SPEC[code];
    if (ch.chapterCode !== code) problems.push(`[${i}] chapterCode=${ch.chapterCode}`);
    if (ch.partCode !== spec.partCode || ch.partName !== PART_NAMES[spec.partCode]) problems.push(`${code} part=${ch.partCode}/${ch.partName}`);
    if (ch.chapterName !== spec.chapterName) problems.push(`${code} chapterName=${ch.chapterName}`);
    const gotSections = Array.isArray(ch.sections) ? ch.sections.map((s) => s.sectionType) : [];
    if (JSON.stringify(gotSections) !== JSON.stringify(Object.keys(spec.sections))) problems.push(`${code} sections=${gotSections.join(',')}`);
    let total = 0;
    (ch.sections || []).forEach((s) => {
      const actual = questions.filter((q) => q.chapterCode === code && q.sectionType === s.sectionType).length;
      const expected = spec.sections[s.sectionType]?.[0];
      if (s.count !== actual || s.count !== expected) problems.push(`${code}/${s.sectionType} count=${s.count}/${actual}/${expected}`);
      if (s.typeName !== TYPE_NAMES[s.sectionType]) problems.push(`${code}/${s.sectionType} typeName=${s.typeName}`);
      total += s.count || 0;
    });
    if (ch.chapterTotal !== total) problems.push(`${code} total=${ch.chapterTotal}/${total}`);
  });
  return problems.join(' | ');
})() === '', 'chapters[] tree matches questions');
check('S22', 'source metadata and versions (guard)',
  bank.schemaVersion === SCHEMA_VERSION &&
  typeof bank.bankVersion === 'string' && bank.bankVersion.length > 0 &&
  typeof bank.generatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(bank.generatedAt) &&
  bank.source?.fileName === '密码赛题库.pdf' &&
  bank.source?.theoryBlocks === questions.length &&
  bank.source?.printedQuestions === EXPECTED.printed &&
  bank.source?.excludedCount === 12 &&
  typeof bank.source?.excludedReason === 'string' && bank.source.excludedReason.length > 0,
  `schemaVersion=${bank.schemaVersion} bankVersion=${bank.bankVersion} generatedAt=${bank.generatedAt} fileName=${bank.source?.fileName} theoryBlocks=${bank.source?.theoryBlocks} printedQuestions=${bank.source?.printedQuestions} excludedCount=${bank.source?.excludedCount}`);

// ---------------------------------------------------------------- extra guards
check('G01', '', printedTotal === EXPECTED.printed, `printed questions=${printedTotal} expected ${EXPECTED.printed}`);
check('G02', '', questions.length === EXPECTED.questions && okCount !== answerLengthZero.length, `ok=${okCount} empty=${answerLengthZero.length}`);
check('G03', '', missingFields.length === 0, `missing fields=${missingFields.length}${missingFields.length ? ' -> ' + missingFields.slice(0, 5).join(',') : ''}`);
check('G04', '', fieldTypes.length === 0, `wrong field types=${fieldTypes.length}${fieldTypes.length ? ' -> ' + fieldTypes.slice(0, 5).join(',') : ''}`);
check('G05', '', badOptions.length === 0, `option problems=${badOptions.length}${badOptions.length ? ' -> ' + badOptions.slice(0, 5).join(',') : ''}`);
check('G06', '', badDifficulty.length === 0, `difficulty/blankCount problems=${badDifficulty.length}${badDifficulty.length ? ' -> ' + badDifficulty.slice(0, 5).join(',') : ''}`);
check('G07', '', REQUIRE_STRICT_RAW.length === 0, `answerStatus=ok with rawAnswer=null outside the manual list=${REQUIRE_STRICT_RAW.length}${REQUIRE_STRICT_RAW.length ? ' -> ' + REQUIRE_STRICT_RAW.slice(0, 5).join(',') : ''}`);
check('G08', '', bank.source?.theoryBlocks === bank.source?.printedQuestions + 1, `theoryBlocks=${bank.source?.theoryBlocks} = printedQuestions(${bank.source?.printedQuestions}) + 1 unnumbered`);

// ---------------------------------------------------------------- output
const rel = (p) => relative(WORKSPACE, p).split('\\').join('/');
const partCounts = { B: 0, P: 0 };
questions.forEach((q) => { partCounts[q.partCode] = (partCounts[q.partCode] || 0) + 1; });
const diffCounts = { 1: 0, 2: 0, 3: 0 };
questions.forEach((q) => { diffCounts[q.difficulty] += 1; });

console.log(`bank validator -- ${rel(bankPath)}   (spec ${SPEC_VERSION} 5.9)`);
console.log(`schemaVersion ${bank.schemaVersion}  bankVersion ${bank.bankVersion}  generatedAt ${bank.generatedAt}`);
console.log('');
console.log('counts');
console.log(`  total questions        : ${questions.length}   (printed ${printedTotal} + 1 unnumbered)`);
console.log(`  by section type        : single=${byType.single}  multiple=${byType.multiple}  judge=${byType.judge}  blank=${byType.blank}`);
console.log(`  by response mode       : single=${byMode.single}  multiple=${byMode.multiple}  judge=${byMode.judge}  blank=${byMode.blank}`);
console.log(`  by part                : B=${partCounts.B}  P=${partCounts.P}   by difficulty: 1=${diffCounts[1]} 2=${diffCounts[2]} 3=${diffCounts[3]}`);
console.log('');
console.log('chapter / section table (blocks, printed)');
for (const code of CHAPTER_ORDER) {
  for (const [stype, [expBlocks, expPrinted]] of Object.entries(CHAPTER_SPEC[code].sections)) {
    const actualBlocks = questions.filter((q) => q.chapterCode === code && q.sectionType === stype).length;
    const actualPrinted = questions.filter((q) => q.chapterCode === code && q.sectionType === stype && q.printedNo !== null).length;
    const flag = actualBlocks === expBlocks && actualPrinted === expPrinted ? 'OK' : 'MISMATCH';
    console.log(`  ${code} ${pad(TYPE_NAMES[stype], 10)} blocks=${num(actualBlocks)}/${pad(expBlocks, 4)} printed=${num(actualPrinted)}/${pad(expPrinted, 4)} ${flag}`);
  }
}
console.log('');
console.log('answers');
console.log(`  answerStatus=ok          : ${okCount}`);
console.log(`  answerStatus=missing     : ${answerMissingList.length}`);
console.log(`  answer.length=0          : ${answerLengthZero.length}`);
console.log(`  blank questions          : ${blankQuestions.length} (all have answers: ${blankWithoutAnswer.length === 0})`);
console.log(`  manually recorded answers: ${manualQuestions.length} -> ${EXPECTED.manualAnswerIds.join(',')} (answer=["16"], rawAnswer=null, needsReview=true)`);
console.log(`  judge answer distribution: 对=${judgeDist.对}  错=${judgeDist.错}`);
console.log(`  needsReview questions    : ${needsReview.length} -> ${needsReview.join(',')}`);
console.log('');
console.log('knowledge tags');
console.log(`  tag coverage (>=1 keyword rule): ${(tagCoverage * 100).toFixed(1)}%  (${specificQuestions}/${questions.length})  min 80%`);
console.log(`  chapter-fallback only          : ${fallbackQuestions}`);
console.log(`  tags == chapter fallback tag   : ${fallbackNamedQuestions} (C07 fallback 标准规范 is also rule #24)`);
console.log(`  distinct tags used             : ${Object.keys(tagCounter).length}`);
console.log(`  tags outside vocabulary        : ${badTagVocab.length}`);
console.log('');
console.log('integrity');
console.log(`  duplicate ids            : ${duplicates.length}`);
console.log(`  missing required fields  : ${missingFields.length}`);
console.log(`  option key problems      : ${badOptions.length}`);
console.log(`  printedNo null           : ${printedNull.length} -> ${printedNull.join(',') || 'none'}`);
console.log(`  matching/连线 questions  : ${matchingDetected.length} -> ${matchingDetected.join(',')}`);
console.log('');
console.log('5.9 checklist');
for (const c of checks.filter((x) => x.id.startsWith('S'))) {
  console.log(`  ${c.id} ${pad(c.item, 44)} ${c.ok ? 'PASS' : 'FAIL'}  ${c.detail}`);
}
const extra = checks.filter((x) => x.id.startsWith('G'));
console.log('');
console.log('extra structural guards');
for (const c of extra) {
  console.log(`  ${c.id} ${c.ok ? 'PASS' : 'FAIL'}  ${c.detail}`);
}

const failed = checks.filter((c) => !c.ok);
console.log('');
console.log(`checks: ${checks.length - failed.length}/${checks.length} passed (5.9 items: ${checks.filter((c) => c.id.startsWith('S')).length})`);
if (failed.length) {
  console.log('FAILED CHECKS');
  for (const f of failed) console.log(`  [${f.id}] ${f.item} ${f.detail}`);
  console.log('RESULT: FAIL');
  console.log('ok: false');
  process.exit(1);
}
console.log(`questions=${questions.length} single=${byType.single} multiple=${byType.multiple} judge=${byType.judge} blank=${byType.blank} tagCoverage=${(tagCoverage * 100).toFixed(1)}% missingAnswers=${answerLengthZero.length} duplicateIds=${duplicates.length}`);
console.log('RESULT: PASS');
console.log('ok: true');
process.exit(0);
