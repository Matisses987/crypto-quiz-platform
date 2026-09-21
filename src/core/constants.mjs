// 冻结常量（依据 docs/需求规格.md 9.1 / 13.6 / 5.9 / 10.2）
// 说明：所有模块内顶层声明一律带模块前缀，便于 tools/build.mjs 做 ESM -> 单文件拼接。

// 应用版本（t37：1.0.0 -> 1.1.0，用户在导入覆盖层/错题本移出复活/首页数字/模拟赛倒计时与导航等修复后要求升版）。
// 注意：下面三个 schema 版本必须保持 "1.0.0"，否则队友已导出的 JSON 会被 ioport 的 E_VERSION 拒收、旧本地数据也会被判不兼容。
export const cn_VERSION = "1.1.0";
export const cn_BANK_SCHEMA_VERSION = "1.0.0";
export const cn_STORE_SCHEMA_VERSION = "1.0.0";
export const cn_EXPORT_SCHEMA_VERSION = "1.0.0";
export const cn_APP_NAME = "密码赛刷题平台";
export const cn_MASTERY_MIN_SAMPLES = 3;
export const cn_CONFIDENT_STREAK_TO_CLEAR = 2;
export const cn_WRONG_THRESHOLD_USERS = 2;
export const cn_MAX_ELAPSED_MS = 86400000;

export const cn_MOCK_LIMITS = {
  count: 100,
  timeLimitSec: 3600,
  totalScore: 100,
  perQuestionScore: 1,
};

export const cn_STORAGE_KEYS = {
  meta: "cqp.v1.meta",
  records: "cqp.v1.records",
  wrongbook: "cqp.v1.wrongbook",
  overrides: "cqp.v1.overrides",
  sessions: "cqp.v1.sessions",
  imports: "cqp.v1.imports",
};

export const cn_STORAGE_PREFIX = "cqp.v1.";

export const cn_TYPES = ["single", "multiple", "judge", "blank"];

export const cn_TYPE_NAMES = {
  single: "单选题",
  multiple: "多选题",
  judge: "判断题",
  blank: "填空题",
};

export const cn_TYPE_CODES = { single: "S", multiple: "M", judge: "J", blank: "F" };

export const cn_CODE_TYPES = { S: "single", M: "multiple", J: "judge", F: "blank" };

// 模拟赛分项固定展示顺序（10.4）
export const cn_MOCK_TYPE_ORDER = ["blank", "multiple", "single", "judge"];

export const cn_MODES = ["practice_chapter", "practice_random", "wrongbook", "mock"];

export const cn_MODE_NAMES = {
  practice_chapter: "分类练习",
  practice_random: "全库随机",
  wrongbook: "错题重练",
  mock: "模拟赛",
};

export const cn_CONFIDENCES = ["confident", "guessed"];

export const cn_CONFIDENCE_NAMES = { confident: "有把握", guessed: "带猜测" };

export const cn_COLORS = ["green", "yellow", "red"];

export const cn_COLOR_NAMES = { green: "绿", yellow: "黄", red: "红" };

export const cn_ANSWER_STATUS = ["ok", "missing"];

export const cn_REVIEW_REASONS = ["printed_number_missing", "answer_missing", "type_mismatch"];

// 5.2.1 章码映射（顺序固定 C01…C07）
export const cn_CHAPTERS = [
  { chapterCode: "C01", partCode: "B", partName: "基础题", chapterName: "密码法律法规", chapterTotal: 65 },
  { chapterCode: "C02", partCode: "B", partName: "基础题", chapterName: "网络安全法律法规", chapterTotal: 50 },
  { chapterCode: "C03", partCode: "B", partName: "基础题", chapterName: "密码管理规章制度", chapterTotal: 55 },
  { chapterCode: "C04", partCode: "B", partName: "基础题", chapterName: "其他政策法规条例", chapterTotal: 45 },
  { chapterCode: "C05", partCode: "P", partName: "专业题", chapterName: "密码学", chapterTotal: 396 },
  { chapterCode: "C06", partCode: "P", partName: "专业题", chapterName: "密码前沿技术", chapterTotal: 195 },
  { chapterCode: "C07", partCode: "P", partName: "专业题", chapterName: "标准题", chapterTotal: 245 },
];

export const cn_CHAPTER_CODES = ["C01", "C02", "C03", "C04", "C05", "C06", "C07"];

export const cn_PARTS = [
  { partCode: "B", partName: "基础题" },
  { partCode: "P", partName: "专业题" },
];

// 13.6 默认值常量（blankFoldWidth 为队长 2026-09-19 决定：填空判分前做全角→半角折叠）
export const cn_DEFAULTS = {
  excludeMissingAnswer: true,
  includeUnnumbered: true,
  mockWritesWrongbook: false,
  mockConfidenceDefault: "confident",
  fullwidthNormalize: false,
  blankFoldWidth: true,
  mockDistributionLocked: true,
  tagEdit: false,
  difficultyWeighted: false,
  recordSkipped: false,
  exportWrongbook: false,
  flaggedAffectsDraw: false,
};

// 5.6 标签词表（序号 1…34，含防御性兜底「未分类」）
export const cn_TAG_VOCAB = [
  "密码法",
  "商用密码管理条例",
  "网络安全法",
  "数据安全法",
  "个人信息保护法",
  "电子签名法",
  "部门规章",
  "地方性法规",
  "SM2",
  "SM3",
  "SM4",
  "SM9",
  "ZUC",
  "分组密码",
  "流密码",
  "公钥密码",
  "杂凑与消息鉴别",
  "密钥管理",
  "量子密码",
  "区块链",
  "电子认证与 PKI",
  "网络协议与密码应用",
  "密评与建设运维",
  "标准规范",
  "人工智能安全",
  "物联网与工控安全",
  "口令与鉴权",
  "职业道德",
  "商用密码",
  "核心密码与普通密码",
  "密码应用",
  "数据安全与个人信息",
  "网络安全与关基",
  "密码法律法规",
  "网络安全法律法规",
  "密码管理规章制度",
  "其他政策法规条例",
  "密码学基础",
  "密码前沿技术",
  "未分类",
];

export const cn_CHAPTER_FALLBACK_TAGS = {
  C01: "密码法律法规",
  C02: "网络安全法律法规",
  C03: "密码管理规章制度",
  C04: "其他政策法规条例",
  C05: "密码学基础",
  C06: "密码前沿技术",
  C07: "标准规范",
};

// 5.9 计数校验表（真实题库必须逐格相等）
export const cn_EXPECT_COUNTS = {
  pages: 199,
  theoryBlocks: 1051,
  printedQuestions: 1050,
  excludedCount: 12,
  answerOk: 1051,
  answerMissing: 0,
  needsReview: 5,
  printedNoNull: 1,
  bySectionType: { single: 491, multiple: 358, judge: 172, blank: 30 },
  byResponseMode: { single: 492, multiple: 357, judge: 172, blank: 30 },
  sectionResponseMismatch: 5,
  byChapter: { C01: 65, C02: 50, C03: 55, C04: 45, C05: 396, C06: 195, C07: 245 },
  chapterSection: {
    C01: { single: 40, multiple: 13, judge: 12, blank: 0 },
    C02: { single: 30, multiple: 10, judge: 10, blank: 0 },
    C03: { single: 35, multiple: 10, judge: 10, blank: 0 },
    C04: { single: 25, multiple: 10, judge: 10, blank: 0 },
    C05: { single: 156, multiple: 130, judge: 80, blank: 30 },
    C06: { single: 115, multiple: 60, judge: 20, blank: 0 },
    C07: { single: 90, multiple: 125, judge: 30, blank: 0 },
  },
  judgeAnswer: { 对: 81, 错: 91 },
  multiSingleLetter: 3,
  singleMultiLetter: 2,
  blankWithAnswer: 30,
  blankMissing: 0,
  needsReviewIds: ["Q-C05-S-0060", "Q-C05-F-0007", "Q-C06-S-0004", "Q-C07-S-0027", "Q-C06-M-0008"],
  printedNoNullIds: ["Q-C05-S-0060"],
  mismatchIds: ["Q-C06-S-0004", "Q-C07-S-0027", "Q-C04-M-0002", "Q-C04-M-0009", "Q-C06-M-0008"],
  linkMatchIds: ["Q-C04-M-0002", "Q-C04-M-0009", "Q-C06-S-0006", "Q-C06-S-0096"],
  tagSpecificMin: 830,
  tagSpecificRate: 0.834,
  tagSpecificRateMin: 0.8,
};

// 10.2 模拟赛两级最大余数分布（真实题库口径）
export const cn_MOCK_DIST_EXPECT = {
  byType: { blank: 3, multiple: 34, single: 47, judge: 16 },
  byChapter: { C01: 6, C02: 5, C03: 5, C04: 4, C05: 37, C06: 19, C07: 24 },
  byChapterType: {
    single: { C01: 4, C02: 3, C03: 3, C04: 2, C05: 15, C06: 11, C07: 9 },
    multiple: { C01: 1, C02: 1, C03: 1, C04: 1, C05: 12, C06: 6, C07: 12 },
    judge: { C01: 1, C02: 1, C03: 1, C04: 1, C05: 7, C06: 2, C07: 3 },
    blank: { C01: 0, C02: 0, C03: 0, C04: 0, C05: 3, C06: 0, C07: 0 },
  },
  pool: {
    C01: { single: 40, multiple: 13, judge: 12, blank: 0 },
    C02: { single: 30, multiple: 10, judge: 10, blank: 0 },
    C03: { single: 35, multiple: 10, judge: 10, blank: 0 },
    C04: { single: 25, multiple: 10, judge: 10, blank: 0 },
    C05: { single: 156, multiple: 130, judge: 80, blank: 30 },
    C06: { single: 115, multiple: 60, judge: 20, blank: 0 },
    C07: { single: 90, multiple: 125, judge: 30, blank: 0 },
  },
};

export const cn_QID_RE_SRC = "^Q-C\\d{2}-[SMJF]-\\d{4}$";
export const cn_DATE_RE_SRC = "^\\d{4}-\\d{2}-\\d{2}$";
export const cn_ISO_RE_SRC =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?(?:Z|[+-]\\d{2}:?\\d{2})$";

// 7.2 导出文件顶层必填字段（导入校验用）
export const cn_EXPORT_KIND = "cqp-export";

// 8.6 交叉矩阵单元格取值
export const cn_MATRIX_CELLS = ["对", "错", "猜对", "未做"];
