// CQP 门面：把各核心模块挂成一个冻结契约的 API（docs/需求规格.md 第 9 章）
import {
  cn_APP_NAME,
  cn_BANK_SCHEMA_VERSION,
  cn_CHAPTERS,
  cn_CHAPTER_CODES,
  cn_CHAPTER_FALLBACK_TAGS,
  cn_COLOR_NAMES,
  cn_COLORS,
  cn_CONFIDENCES,
  cn_CONFIDENCE_NAMES,
  cn_CONFIDENT_STREAK_TO_CLEAR,
  cn_DEFAULTS,
  cn_EXPECT_COUNTS,
  cn_EXPORT_KIND,
  cn_EXPORT_SCHEMA_VERSION,
  cn_MASTERY_MIN_SAMPLES,
  cn_MOCK_DIST_EXPECT,
  cn_MOCK_LIMITS,
  cn_MOCK_TYPE_ORDER,
  cn_MODES,
  cn_MODE_NAMES,
  cn_PARTS,
  cn_REVIEW_REASONS,
  cn_STORAGE_KEYS,
  cn_STORAGE_PREFIX,
  cn_STORE_SCHEMA_VERSION,
  cn_TAG_VOCAB,
  cn_TYPES,
  cn_TYPE_CODES,
  cn_TYPE_NAMES,
  cn_VERSION,
  cn_WRONG_THRESHOLD_USERS,
} from "./constants.mjs";
import { tm_dateInScope, tm_diffMs, tm_filterByDate, tm_isDateString, tm_isIsoTs, tm_isoNow, tm_localDateOf, tm_localStamp } from "./time.mjs";
import { jd_answerText, jd_color, jd_foldWidth, jd_isWrongEntry, jd_judge, jd_norm, jd_responseModeOf } from "./judge.mjs";
import { rc_makeRecord, rc_recordKey, rc_statsOfRecords } from "./records.mjs";
import { ms_groupSummary, ms_masteryBy, ms_masteryOfAttempts, ms_masteryOfQuestion, ms_masteryOverall } from "./mastery.mjs";
import { wb_colorOfEntry, wb_countActive, wb_wrongbookApply, wb_wrongbookList, wb_wrongbookRemoveManual } from "./wrongbook.mjs";
import { dr_candidates, dr_drawQuestions, dr_makeRng, dr_practiceScore } from "./draw.mjs";
import { mk_buildMockPaper, mk_compareRankKey, mk_computeDistribution, mk_gradeMock, mk_poolMatrix, mk_rankKey } from "./mock.mjs";
import { ov_applyOverrides, ov_countItems, ov_isFlagged, ov_parseAnswerInput, ov_setOverride } from "./overrides.mjs";
import {
  bk_buildReport,
  bk_chapterByCode,
  bk_chapterIndex,
  bk_countsOf,
  bk_expectedDifficulty,
  bk_questionById,
  bk_questionIndex,
  bk_tagCounts,
  bk_tagIndex,
  bk_validateBank,
} from "./bank.mjs";
import {
  io_exportFileName,
  io_exportPayload,
  io_getRegisteredBank,
  io_mergeImport,
  io_rangeLabel,
  io_registerBank,
  io_rescueExport,
  io_sanitizeNickname,
  io_validateImport,
} from "./ioport.mjs";
import { st_compareNickname, st_personalStats, st_personalWrongQuestions, st_teamStats } from "./stats.mjs";
import {
  sr_appendRecord,
  sr_appendSession,
  sr_clone,
  sr_emptyStore,
  sr_getStore,
  sr_migrateStore,
  sr_newDeviceId,
  sr_recordsOfNickname,
  sr_resetMemoryStore,
  sr_setStore,
  sr_storeSize,
  sr_touchMeta,
} from "./store.mjs";
import { sg_backendFor, sg_keys, sg_load, sg_probe, sg_readRaw, sg_reset, sg_save, sg_setBackend } from "./storage.mjs";
import { tk_expectCounts, tk_makeBank, tk_makeQuestion, tk_makeRecord } from "./testkit.mjs";

export function cq_createCQP(bank) {
  const CQP = {};

  // 9.1 常量
  CQP.VERSION = cn_VERSION;
  CQP.APP_NAME = cn_APP_NAME;
  CQP.BANK_SCHEMA_VERSION = cn_BANK_SCHEMA_VERSION;
  CQP.STORE_SCHEMA_VERSION = cn_STORE_SCHEMA_VERSION;
  CQP.EXPORT_SCHEMA_VERSION = cn_EXPORT_SCHEMA_VERSION;
  CQP.EXPORT_KIND = cn_EXPORT_KIND;
  CQP.MASTERY_MIN_SAMPLES = cn_MASTERY_MIN_SAMPLES;
  CQP.CONFIDENT_STREAK_TO_CLEAR = cn_CONFIDENT_STREAK_TO_CLEAR;
  CQP.WRONG_THRESHOLD_USERS = cn_WRONG_THRESHOLD_USERS;
  CQP.MOCK_LIMITS = cn_MOCK_LIMITS;
  CQP.MOCK_TYPE_ORDER = cn_MOCK_TYPE_ORDER;
  CQP.MOCK_DIST_EXPECT = cn_MOCK_DIST_EXPECT;
  CQP.STORAGE_KEYS = cn_STORAGE_KEYS;
  CQP.STORAGE_PREFIX = cn_STORAGE_PREFIX;
  CQP.TYPES = cn_TYPES;
  CQP.TYPE_NAMES = cn_TYPE_NAMES;
  CQP.TYPE_CODES = cn_TYPE_CODES;
  CQP.CHAPTERS = cn_CHAPTERS;
  CQP.CHAPTER_CODES = cn_CHAPTER_CODES;
  CQP.PARTS = cn_PARTS;
  CQP.MODES = cn_MODES;
  CQP.MODE_NAMES = cn_MODE_NAMES;
  CQP.CONFIDENCES = cn_CONFIDENCES;
  CQP.CONFIDENCE_NAMES = cn_CONFIDENCE_NAMES;
  CQP.COLORS = cn_COLORS;
  CQP.COLOR_NAMES = cn_COLOR_NAMES;
  CQP.REVIEW_REASONS = cn_REVIEW_REASONS;
  CQP.DEFAULTS = cn_DEFAULTS;
  CQP.TAG_VOCAB = cn_TAG_VOCAB;
  CQP.CHAPTER_FALLBACK_TAGS = cn_CHAPTER_FALLBACK_TAGS;
  CQP.EXPECT_COUNTS = cn_EXPECT_COUNTS;

  // 9.2 时间与日期
  CQP.isoNow = tm_isoNow;
  CQP.localDateOf = tm_localDateOf;
  CQP.filterByDate = tm_filterByDate;
  CQP.dateInScope = tm_dateInScope;
  CQP.localStamp = tm_localStamp;
  CQP.diffMs = tm_diffMs;
  CQP.isIsoTs = tm_isIsoTs;
  CQP.isDateString = tm_isDateString;

  // 9.3 判分
  CQP.norm = jd_norm;
  CQP.foldWidth = jd_foldWidth;
  CQP.judge = jd_judge;
  CQP.responseModeOf = jd_responseModeOf;
  CQP.answerText = jd_answerText;

  // 9.4 颜色与错题进入
  CQP.color = jd_color;
  CQP.isWrongEntry = jd_isWrongEntry;

  // 9.5 记录
  CQP.recordKey = rc_recordKey;
  CQP.makeRecord = rc_makeRecord;
  CQP.statsOfRecords = rc_statsOfRecords;

  // 9.6 掌握指数
  CQP.masteryOfAttempts = ms_masteryOfAttempts;
  CQP.masteryOfQuestion = ms_masteryOfQuestion;
  CQP.masteryOverall = ms_masteryOverall;
  CQP.masteryBy = ms_masteryBy;
  CQP.groupSummary = ms_groupSummary;

  // 9.7 错题本
  CQP.wrongbookApply = wb_wrongbookApply;
  CQP.wrongbookRemoveManual = wb_wrongbookRemoveManual;
  CQP.wrongbookList = wb_wrongbookList;
  CQP.wrongbookColorOfEntry = wb_colorOfEntry;
  CQP.wrongbookCountActive = wb_countActive;

  // 9.8 出题与练习计分
  CQP.makeRng = dr_makeRng;
  CQP.drawQuestions = dr_drawQuestions;
  CQP.candidates = dr_candidates;
  CQP.practiceScore = dr_practiceScore;

  // 9.9 模拟赛
  CQP.buildMockPaper = mk_buildMockPaper;
  CQP.gradeMock = mk_gradeMock;
  CQP.rankKey = mk_rankKey;
  CQP.compareRankKey = mk_compareRankKey;
  CQP.computeMockDistribution = mk_computeDistribution;
  CQP.mockPoolMatrix = mk_poolMatrix;

  // 9.10 覆盖层
  CQP.applyOverrides = ov_applyOverrides;
  CQP.isFlagged = ov_isFlagged;
  CQP.setOverride = ov_setOverride;
  CQP.parseAnswerInput = ov_parseAnswerInput;
  CQP.countOverrides = ov_countItems;

  // 9.11 题库校验与索引
  CQP.validateBank = bk_validateBank;
  CQP.questionById = bk_questionById;
  CQP.questionIndex = bk_questionIndex;
  CQP.tagIndex = bk_tagIndex;
  CQP.chapterIndex = bk_chapterIndex;
  CQP.countsOf = bk_countsOf;
  CQP.tagCounts = bk_tagCounts;
  CQP.chapterByCode = bk_chapterByCode;
  CQP.expectedDifficulty = bk_expectedDifficulty;
  CQP.buildReport = bk_buildReport;

  // 9.12 导出与导入
  CQP.exportPayload = io_exportPayload;
  CQP.exportFileName = io_exportFileName;
  CQP.validateImport = io_validateImport;
  CQP.mergeImport = io_mergeImport;
  // t41 F-03：阻断态「抢救导出」——直接基于磁盘原始字符串组装，不依赖内存 store
  CQP.rescueExport = io_rescueExport;
  CQP.personalStats = st_personalStats;
  CQP.teamStats = st_teamStats;
  CQP.personalWrongQuestions = st_personalWrongQuestions;
  CQP.compareNickname = st_compareNickname;
  CQP.sanitizeNickname = io_sanitizeNickname;
  CQP.rangeLabel = io_rangeLabel;

  // 9.13 存储适配
  CQP.storage = {
    load: sg_load,
    save: sg_save,
    reset: sg_reset,
    probe: sg_probe,
    keys: sg_keys,
    readRaw: sg_readRaw,
    setBackend: sg_setBackend,
    backend: sg_backendFor,
  };
  CQP.getStore = sr_getStore;
  CQP.setStore = sr_setStore;
  CQP.migrateStore = sr_migrateStore;
  CQP.emptyStore = sr_emptyStore;
  CQP.newDeviceId = sr_newDeviceId;
  CQP.clone = sr_clone;
  CQP.appendRecord = sr_appendRecord;
  CQP.appendSession = sr_appendSession;
  CQP.touchMeta = sr_touchMeta;
  CQP.storeSize = sr_storeSize;
  CQP.recordsOfNickname = sr_recordsOfNickname;
  CQP.resetMemoryStore = sr_resetMemoryStore;

  // 题库注册（导入未知 qid 判定、界面生效题库都依赖它）
  CQP.setBank = function setBank(nextBank) {
    io_registerBank(nextBank);
    if (CQP.__test) CQP.__test.bank = nextBank;
    return nextBank;
  };
  CQP.getBank = function getBank() {
    return io_getRegisteredBank();
  };
  CQP.effectiveBank = function effectiveBank() {
    const current = io_getRegisteredBank();
    if (!current) return null;
    const store = sr_getStore();
    const overrides = store && store.overrides ? store.overrides : null;
    return ov_applyOverrides(current, overrides).bank;
  };

  // 9.14 测试钩子
  CQP.__test = {
    bank: bank === undefined ? null : bank,
    makeQuestion: tk_makeQuestion,
    makeRecord: tk_makeRecord,
    makeBank: tk_makeBank,
    expectCounts: tk_expectCounts,
    setStorageBackend: sg_setBackend,
    emptyStore: sr_emptyStore,
    resetMemoryStore: sr_resetMemoryStore,
  };

  if (bank) CQP.setBank(bank);
  return CQP;
}

const cq_default = cq_createCQP(null);

export const CQP = cq_default;

if (typeof globalThis !== "undefined") {
  globalThis.CQP = cq_default;
}
