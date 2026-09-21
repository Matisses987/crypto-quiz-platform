// 生成 tests/fixtures/bank.sample.json（开发/测试用最小合规题库，38 题）。
// 运行：node tests/fixtures/make_fixture.mjs
// 说明：fixture 只放在 tests/fixtures/；真实题库由 src/data/bank.json 提供。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(here, "bank.sample.json");

const CHAPTERS = [
  { chapterCode: "C01", partCode: "B", partName: "基础题", chapterName: "密码法律法规", single: 4, multiple: 2, judge: 2, blank: 0 },
  { chapterCode: "C02", partCode: "B", partName: "基础题", chapterName: "网络安全法律法规", single: 3, multiple: 1, judge: 1, blank: 0 },
  { chapterCode: "C03", partCode: "B", partName: "基础题", chapterName: "密码管理规章制度", single: 2, multiple: 1, judge: 1, blank: 0 },
  { chapterCode: "C04", partCode: "B", partName: "基础题", chapterName: "其他政策法规条例", single: 2, multiple: 1, judge: 1, blank: 0 },
  { chapterCode: "C05", partCode: "P", partName: "专业题", chapterName: "密码学", single: 3, multiple: 2, judge: 2, blank: 2 },
  { chapterCode: "C06", partCode: "P", partName: "专业题", chapterName: "密码前沿技术", single: 2, multiple: 1, judge: 1, blank: 0 },
  { chapterCode: "C07", partCode: "P", partName: "专业题", chapterName: "标准题", single: 2, multiple: 1, judge: 1, blank: 0 },
];

const TYPE_CODE = { single: "S", multiple: "M", judge: "J", blank: "F" };
const TYPE_NAME = { single: "单选题", multiple: "多选题", judge: "判断题", blank: "填空题" };
const FALLBACK = {
  C01: "密码法律法规",
  C02: "网络安全法律法规",
  C03: "密码管理规章制度",
  C04: "其他政策法规条例",
  C05: "密码学基础",
  C06: "密码前沿技术",
  C07: "标准规范",
};

// 题干/选项/答案素材（按章 × 题型循环使用，风格贴近真实题库）
const STEMS = {
  C01: "根据《中华人民共和国密码法》，关于密码分类与管理的说法，正确的是（ ）。",
  C02: "根据《中华人民共和国网络安全法》，网络运营者应当履行的安全保护义务包括（ ）。",
  C03: "依据《商用密码管理条例》，商用密码检测机构应当满足下列哪项要求？（ ）",
  C04: "依据《江苏省密码应用与创新发展管理办法》，关于密码应用推进工作的表述，正确的是（ ）。",
  C05: "在 SM4 分组密码算法中，关于密钥扩展与轮函数结构的说法，正确的是（ ）。",
  C06: "面向抗量子迁移的密码前沿技术中，下列关于后量子密码的表述，正确的是（ ）。",
  C07: "依据 GB/T 39786 的相关要求，信息系统密码应用基本要求分为几级？（ ）",
};
const MULTI_STEMS = {
  C01: "依据《中华人民共和国密码法》，以下关于密码管理部门职责的说法，正确的有（ ）。",
  C02: "根据《中华人民共和国网络安全法》，以下属于关键信息基础设施运营者义务的有（ ）。",
  C03: "依据《商用密码管理条例》，下列属于商用密码从业单位义务的有（ ）。",
  C04: "依据国家密码管理政策文件，以下关于密码应用的说法，正确的有（ ）。",
  C05: "以下关于杂凑算法与消息鉴别码的说法，正确的有（ ）。",
  C06: "以下关于量子密钥分发（QKD）与后量子密码的说法，正确的有（ ）。",
  C07: "依据 GM/T 标准体系，以下关于密码标准分类的说法，正确的有（ ）。",
};
const JUDGE_STEMS = {
  C01: "核心密码、普通密码用于保护国家秘密信息，商用密码用于保护不属于国家秘密的信息。",
  C02: "关键信息基础设施的运营者应当自行或者委托网络安全服务机构对其网络的安全性和可能存在的风险每年至少进行一次检测评估。",
  C03: "商用密码检测机构应当独立、客观、公正地开展检测工作，并对检测结果负责。",
  C04: "省级密码管理部门负责本行政区域内商用密码的管理工作。",
  C05: "SM3 密码杂凑算法的输出摘要长度为 256 比特。",
  C06: "抗量子密码算法可以完全替代现有的公钥密码算法，无需考虑迁移成本。",
  C07: "GB/T 39786 规定了信息系统密码应用的基本要求，并划分为五个等级。",
};
const OPTIONS_A = ["密码管理部门", "保密行政管理部门", "国家网信部门", "市场监督管理部门"];
const OPTIONS_B = ["建立统一的商用密码监督管理信息平台", "开展随机抽查活动", "将监管信息与社会信用体系相衔接", "以上均是"];
const BLANK_STEMS = {
  C05: ["SM4 分组密码算法的分组长度为 128 比特，其密钥长度为 ______ 比特，轮数为 32 轮。", "SM3 密码杂凑算法输出摘要长度为 ______ 比特。"],
};

const QUESTIONS = [];
const chapterNodes = [];

for (const ch of CHAPTERS) {
  const sections = [];
  for (const type of ["single", "multiple", "judge", "blank"]) {
    const count = ch[type];
    if (count <= 0) continue;
    sections.push({ sectionType: type, typeName: TYPE_NAME[type], count });
    for (let seq = 1; seq <= count; seq += 1) {
      const id = "Q-" + ch.chapterCode + "-" + TYPE_CODE[type] + "-" + String(seq).padStart(4, "0");
      let stem = "";
      let options = [];
      let answer = [];
      let answerStatus = "ok";
      let rawAnswer = "";
      let needsReview = false;
      let reviewReason = null;
      let printedNo = seq;
      let tags = [];
      let blankCount = 0;

      if (type === "single") {
        stem = STEMS[ch.chapterCode];
        options = [
          { key: "A", text: OPTIONS_A[0] + "（" + seq + "）" },
          { key: "B", text: OPTIONS_A[1] + "（" + seq + "）" },
          { key: "C", text: OPTIONS_A[2] + "（" + seq + "）" },
          { key: "D", text: OPTIONS_A[3] + "（" + seq + "）" },
        ];
        answer = ["B"];
        tags = ch.chapterCode === "C01" ? ["密码法"] : ch.chapterCode === "C05" ? ["SM4", "分组密码"] : ch.chapterCode === "C07" ? ["标准规范"] : ch.chapterCode === "C02" ? ["网络安全法"] : ch.chapterCode === "C04" ? ["地方性法规"] : ["部门规章"];
      } else if (type === "multiple") {
        stem = MULTI_STEMS[ch.chapterCode];
        options = [
          { key: "A", text: OPTIONS_B[0] },
          { key: "B", text: OPTIONS_B[1] },
          { key: "C", text: OPTIONS_B[2] },
          { key: "D", text: OPTIONS_B[3] },
        ];
        answer = ["A", "B", "C"];
        tags = ch.chapterCode === "C05" ? ["杂凑与消息鉴别"] : ch.chapterCode === "C06" ? ["量子密码"] : ["商用密码管理条例"];
      } else if (type === "judge") {
        stem = JUDGE_STEMS[ch.chapterCode];
        answer = [seq % 2 === 1 ? "对" : "错"];
        tags = [FALLBACK[ch.chapterCode]];
      } else {
        stem = BLANK_STEMS[ch.chapterCode][seq - 1];
        blankCount = 1;
        answer = seq === 1 ? ["128"] : ["256"];
        tags = ch.chapterCode === "C05" ? ["SM3", "杂凑与消息鉴别"] : [FALLBACK[ch.chapterCode]];
      }
      rawAnswer = answer.join("");
      if (tags.length === 0) tags = [FALLBACK[ch.chapterCode]];

      // 特殊用例（覆盖缺陷 A/B/G 与覆盖层演示题）
      if (ch.chapterCode === "C05" && type === "single" && seq === 2) {
        answer = ["A", "B"];
        rawAnswer = "AB";
        needsReview = true;
        reviewReason = "type_mismatch";
      }
      if (ch.chapterCode === "C05" && type === "single" && seq === 3) {
        printedNo = null;
        needsReview = true;
        reviewReason = "printed_number_missing";
      }
      if (ch.chapterCode === "C05" && type === "multiple" && seq === 1) {
        answer = ["A"];
        rawAnswer = "A";
      }
      if (ch.chapterCode === "C05" && type === "blank" && seq === 2) {
        answer = [];
        rawAnswer = null;
        answerStatus = "missing";
        needsReview = true;
        reviewReason = "answer_missing";
      }
      if (ch.chapterCode === "C06" && type === "single" && seq === 1) {
        tags = [FALLBACK.C06];
      }

      const isChoice = type === "single" || type === "multiple";
      const responseMode = isChoice ? (answer.length >= 2 ? "multiple" : "single") : type;
      QUESTIONS.push({
        id,
        chapterCode: ch.chapterCode,
        partCode: ch.partCode,
        partName: ch.partName,
        chapterName: ch.chapterName,
        sectionType: type,
        typeName: TYPE_NAME[type],
        responseMode,
        seq,
        printedNo,
        stem,
        options: isChoice ? options : [],
        answer,
        answerStatus,
        rawAnswer,
        tags,
        difficulty: ch.partCode === "B" ? (type === "multiple" ? 2 : 1) : type === "multiple" || type === "blank" ? 3 : 2,
        sourcePage: 1 + seq,
        blankCount,
        needsReview,
        reviewReason,
      });
    }
  }
  chapterNodes.push({
    chapterCode: ch.chapterCode,
    partCode: ch.partCode,
    partName: ch.partName,
    chapterName: ch.chapterName,
    chapterTotal: sections.reduce((sum, s) => sum + s.count, 0),
    sections,
  });
}

const bank = {
  schemaVersion: "1.0.0",
  bankVersion: "fixture-1",
  generatedAt: "2026-09-16T20:00:00+08:00",
  fixture: true,
  source: {
    fileName: "密码赛题库.pdf",
    pages: 199,
    theoryBlocks: QUESTIONS.length,
    printedQuestions: QUESTIONS.length - 1,
    excludedCount: 12,
    excludedReason: "第三部分实操题不纳入（用户决策 D12）",
  },
  chapters: chapterNodes,
  questions: QUESTIONS,
};

fs.writeFileSync(outPath, JSON.stringify(bank, null, 2) + "\n", "utf8");
console.log("fixture written: " + outPath);
console.log("questions: " + QUESTIONS.length + " (printed " + bank.source.printedQuestions + ")");
for (const ch of chapterNodes) {
  console.log("  " + ch.chapterCode + " " + ch.chapterName + " total=" + ch.chapterTotal + " sections=" + ch.sections.map((s) => s.sectionType + ":" + s.count).join(","));
}
