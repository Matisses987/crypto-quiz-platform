// 构建脚本：把 core 模块 + UI（+ 题库）内联为单文件 HTML
// 用法：node tools/build.mjs [--bank 路径] [--out 路径] [--target server] [--strict] [--quiet]
//   server（默认，也是唯一受支持的交付目标）：public/index.html
//           —— 不内联题库（题库与判分走服务端 API）
//   offline（已废弃，仅作历史回归对照）：dist/密码赛刷题平台.html
//           —— 题库内联、可离线双击打开。服务端版已删掉本地存储与本地判分，
//              app.js 里没有任何读取内联题库的代码，因此该目标必然过不了
//              verifyArtifact 的 "app script reads inlined bank" 检查，
//              也不再被包进 npm scripts。保留代码路径只为读取旧产物做对比。
// 说明：控制台输出使用英文 ASCII；中文只写入文件。
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { CQP } from "../src/core/index.mjs";
import { cn_VERSION } from "../src/core/constants.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const DIST = path.join(ROOT, "dist");
const PUBLIC = path.join(ROOT, "public");
const DEFAULT_OUT = path.join(DIST, "密码赛刷题平台.html");
const SERVER_OUT = path.join(PUBLIC, "index.html");
const REPORT_NAME = "密码赛刷题平台.build-report.json";
const SERVER_REPORT_NAME = "server.build-report.json";

// core 模块拼接顺序（依赖自上而下；index.mjs 必须最后）
const CORE_ORDER = [
  "constants.mjs",
  "time.mjs",
  "judge.mjs",
  "records.mjs",
  "mastery.mjs",
  "wrongbook.mjs",
  "draw.mjs",
  "mock.mjs",
  "overrides.mjs",
  "bank.mjs",
  "ioport.mjs",
  "stats.mjs",
  "store.mjs",
  "storage.mjs",
  "testkit.mjs",
  "index.mjs",
];

// 仅数据质量类问题不阻断构建（结构性问题一律阻断）；--strict 时全部视为阻断
const NON_BLOCKING_CODES = new Set([
  "E_COUNT_NEEDS_REVIEW",
  "E_COUNT_NEEDS_REVIEW_IDS",
  "E_COUNT_TAG_SPECIFIC",
  "E_Q_OPTIONS_LEN",
  "E_Q_NEEDSREVIEW_REASON",
  "E_Q_OPTION_KEYS",
  "W_Q_OPTIONS_EMPTY_EXPECTED",
  "W_Q_OPTION_KEYS",
  "W_TAG_COVERAGE",
  "W_FIXTURE_MODE",
]);

export function stripEsm(source, fileName) {
  const lines = source.split(/\r?\n/);
  const out = [];
  let skippingImport = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (skippingImport) {
      if (trimmed.endsWith(";")) skippingImport = false;
      continue;
    }
    if (/^import\s/.test(trimmed)) {
      if (!trimmed.endsWith(";")) skippingImport = true;
      continue;
    }
    if (/^export\s*\{/.test(trimmed)) continue;
    if (/^export\s+/.test(line)) {
      out.push(line.replace(/^export\s+(?=(async\s+)?(default\s+)?(const|let|var|function|class))/,''));
      continue;
    }
    if (/\bexport\b/.test(line) && /^\s*export/.test(line)) {
      throw new Error("unsupported export form in " + fileName + ": " + trimmed);
    }
    out.push(line);
  }
  return out.join("\n");
}

// JSON 文本内联到 <script type="application/json">：转义 <、>、& 与行分隔符，
// 并把 http(s):// 写成 \u002f 形式，保证成品 HTML 里不出现任何协议外链字样。
export function escapeJsonForHtml(jsonText) {
  return jsonText
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    .replace(/https?:\/\//g, (match) => match.replace(/:\/\//, ":\\u002f\\u002f"));
}

export function selfContainmentCheck(html, options) {
  const target = (options && options.target) || "offline";
  const problems = [];
  const patterns = [
    { name: "external URLs", re: /https?:\/\//g },
    { name: "script src", re: /<script[^>]*\ssrc=/gi },
    { name: "link href", re: /<link[^>]*\shref=/gi },
    { name: "XMLHttpRequest", re: /XMLHttpRequest/g },
    { name: "WebSocket", re: /WebSocket/g },
    { name: "new Image", re: /\bnew\s+Image\s*\(/g },
    { name: "css @import", re: /@import/g },
    { name: "css remote url", re: /url\(\s*['"]?(?:https?:)?\/\//gi },
    { name: "iframe/object/embed", re: /<(?:iframe|object|embed)\b/gi },
  ];
  // server 目标必须能调接口：放行 fetch(；其余外链禁令一律保留。
  // （API 全用相对路径，所以 "external URLs" 那条对 server 同样生效。）
  if (target !== "server") patterns.splice(3, 0, { name: "fetch call", re: /\bfetch\s*\(/g });
  const counts = {};
  for (const p of patterns) {
    const found = html.match(p.re);
    const count = found ? found.length : 0;
    counts[p.name] = count;
    if (count > 0) problems.push(p.name + "=" + count);
  }
  return { ok: problems.length === 0, problems, counts };
}

function readCoreBundle() {
  const parts = [];
  for (const name of CORE_ORDER) {
    const filePath = path.join(ROOT, "src", "core", name);
    if (!fs.existsSync(filePath)) throw new Error("missing core module: " + filePath);
    const source = fs.readFileSync(filePath, "utf8");
    parts.push("// ===== src/core/" + name + " =====");
    parts.push(stripEsm(source, name));
  }
  return parts.join("\n");
}

// 内联题库读取器：核心脚本执行后把 <script id="bank-data"> 注册为当前题库
function bankBootstrap() {
  return [
    "(function () {",
    '  if (typeof document === "undefined") return;',
    '  var el = document.getElementById("bank-data");',
    '  if (!el) return;',
    "  try {",
    "    CQP.setBank(JSON.parse(el.textContent));",
    "  } catch (err) {",
    '    if (typeof console !== "undefined" && console.error) console.error("bank-data parse failed", err);',
    "  }",
    "})();",
  ].join("\n");
}

export function build(options) {
  const opts = options && typeof options === "object" ? options : {};
  const target = opts.target === "server" ? "server" : "offline";
  const fixturePath = path.join(ROOT, "tests", "fixtures", "bank.sample.json");
  const realPath = path.join(ROOT, "src", "data", "bank.json");
  const bankPath = opts.bankPath
    ? path.resolve(opts.bankPath)
    : fs.existsSync(realPath)
      ? realPath
      : fixturePath;

  // server 目标不内联题库（题库由 /api/banks/:slug 下发），因此题库缺失也不阻断构建。
  const hasBank = fs.existsSync(bankPath);
  if (target === "offline" && !hasBank) throw new Error("bank file not found: " + bankPath);

  const bank = hasBank ? JSON.parse(fs.readFileSync(bankPath, "utf8")) : null;
  const isFixture = hasBank && (bank.fixture === true || path.resolve(bankPath) === fixturePath);
  const validation = bank
    ? CQP.validateBank(bank, { fixture: isFixture })
    : { ok: true, errors: [], warnings: [] };
  const blocking = validation.errors.filter((e) => !NON_BLOCKING_CODES.has(e.code));
  const strict = opts.strict === true;
  const failed = blocking.length > 0 || (strict && validation.errors.length > 0);

  const templatePath = path.join(ROOT, "src", "ui", "app.html");
  const stylePath = path.join(ROOT, "src", "ui", "style.css");
  const appPath = path.join(ROOT, "src", "ui", "app.js");
  for (const filePath of [templatePath, stylePath, appPath]) {
    if (!fs.existsSync(filePath)) throw new Error("missing UI file: " + filePath);
  }

  const template = fs.readFileSync(templatePath, "utf8");
  const style = fs.readFileSync(stylePath, "utf8");
  const appJs = fs.readFileSync(appPath, "utf8");
  const coreJs = readCoreBundle() + (target === "server" ? "" : "\n" + bankBootstrap());
  // server 目标绝不能把题库内联进页面：题目里带标准答案，页面一旦下发就等于泄题。
  const bankJson = target === "server" || !bank ? "" : escapeJsonForHtml(JSON.stringify(bank));

  let html = template;
  if (target === "server") {
    // 整块去掉内联题库（留着空块会让 artifact 自检和后续维护都容易误判）
    html = html.replace(/<script id="bank-data"[^>]*>[\s\S]*?<\/script>\s*/, "");
  }
  html = html.replace("/*{{STYLE}}*/", () => style);
  html = html.replace("/*{{BANK_JSON}}*/", () => bankJson);
  html = html.replace("/*{{CORE_JS}}*/", () => coreJs);
  html = html.replace("/*{{APP_JS}}*/", () => appJs);
  html = html.replace(/\{\{APP_VERSION\}\}/g, CQP.VERSION);
  html = html.replace(/\{\{BANK_VERSION\}\}/g, () => String((bank && bank.bankVersion) || "服务端下发"));
  html = html.replace(/\{\{GENERATED_AT\}\}/g, () => new Date().toISOString());

  if (html.indexOf("/*{{") >= 0) throw new Error("template placeholder left unreplaced");

  const selfCheck = selfContainmentCheck(html, { target });
  const report = {
    builtAt: new Date().toISOString(),
    target,
    appVersion: CQP.VERSION,
    bankPath: hasBank ? bankPath : null,
    bankVersion: bank ? bank.bankVersion || null : null,
    fixture: isFixture,
    questions: bank ? bank.questions.length : null,
    validateBank: { ok: validation.ok, errors: validation.errors, warnings: validation.warnings },
    blockingErrors: blocking.map((e) => e.code),
    counts: bank ? CQP.countsOf(bank) : null,
    tagCoverage: bank ? CQP.buildReport(bank).tagCoverage : null,
    distribution: bank ? CQP.computeMockDistribution(bank.questions, CQP.MOCK_LIMITS.count).byType : null,
    selfContainment: selfCheck,
    bytes: Buffer.byteLength(html, "utf8"),
    ok: !failed && selfCheck.ok,
  };

  const outPath = opts.outPath
    ? path.resolve(opts.outPath)
    : target === "server"
      ? SERVER_OUT
      : DEFAULT_OUT;
  const defaultReport = path.join(DIST, target === "server" ? SERVER_REPORT_NAME : REPORT_NAME);
  const reportPath = opts.reportPath === null ? null : path.resolve(opts.reportPath || defaultReport);

  // 自检先算：write:false 也要拿到 artifactCheck，否则调用方得自己再跑一次
  const artifactCheck = opts.verify === false ? null : verifyArtifact(html, { target, bank });
  report.artifactCheck = artifactCheck;
  if (artifactCheck && !artifactCheck.ok) report.ok = false;

  if (opts.write === false) return { ...report, outPath, reportPath, html };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, "utf8");
  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  }
  return { ...report, outPath, reportPath };
}

// 成品自检：把写出的 HTML 里的内联脚本放进一个裸 VM 跑一遍（无浏览器依赖）
export function verifyArtifact(html, options) {
  const opts = options && typeof options === "object" ? options : {};
  const target = opts.target === "server" ? "server" : "offline";
  const checks = [];
  const extract = (id) => {
    const start = html.indexOf('<script id="' + id + '"');
    if (start < 0) return null;
    const openEnd = html.indexOf(">", start);
    const close = html.indexOf("</script>", openEnd);
    return html.slice(openEnd + 1, close);
  };
  const bankBlock = extract("bank-data");
  const coreJs = extract("cqp-core");
  const appJs = extract("cqp-app");
  checks.push({ name: "script blocks present", ok: !!coreJs && !!appJs && coreJs.length > 0 && appJs.length > 0 });
  checks.push({ name: "no protocol text", ok: !/https?:\/\//.test(html) });
  checks.push({ name: "single html document", ok: html.split("<!DOCTYPE html>").length === 2 });
  if (target === "server") {
    // 服务端版必须不带内联题库，否则答案会随页面泄露。
    checks.push({ name: "no inlined bank (server target)", ok: bankBlock === null });
  }

  const bank = opts.bank || (bankBlock ? JSON.parse(bankBlock) : null);
  if (bank) checks.push({ name: "inlined bank parses", ok: Array.isArray(bank.questions) });

  const context = vm.createContext({
    document: {
      getElementById: (id) => (id === "bank-data" && bankBlock !== null ? { textContent: bankBlock } : null),
    },
    console: { log() {}, error() {}, warn() {} },
  });
  vm.runInContext(coreJs, context, { filename: "dist-core.js" });
  const CQP = context.CQP;
  checks.push({ name: "CQP registered", ok: !!CQP && CQP.VERSION === cn_VERSION });

  if (bank) {
    const validation = CQP.validateBank(bank, { fixture: bank.fixture === true });
    checks.push({ name: "validateBank ok (" + bank.questions.length + " questions)", ok: validation.ok });
    const paper = CQP.buildMockPaper({ bank, rng: CQP.makeRng(1) });
    const answerable = CQP.candidates({ bank }).length;
    checks.push({
      name: "mock paper " + paper.questionIds.length + " unique questions (pool " + answerable + ")",
      ok:
        paper.questionIds.length === Math.min(CQP.MOCK_LIMITS.count, answerable) &&
        new Set(paper.questionIds).size === paper.questionIds.length,
    });
  } else {
    // server 目标没有本地题库：至少确认核心判分函数与题库注册入口都在。
    checks.push({ name: "core judge available", ok: typeof CQP.judge === "function" && typeof CQP.setBank === "function" });
  }
  const fullWidth = "ＳＭ４";
  checks.push({ name: "blank full-width judging works", ok: CQP.judge({ sectionType: "blank", answer: ["SM4"] }, [fullWidth]).correct === true });
  checks.push({ name: "app script wires the UI", ok: appJs.indexOf("CQPUI") > 0 });
  if (target === "server") {
    checks.push({ name: "app script calls server API", ok: appJs.indexOf('"/api/') > 0 });
  } else {
    checks.push({ name: "app script reads inlined bank", ok: appJs.indexOf("bank-data") > 0 });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

function printReport(result, quiet) {
  if (quiet) return;
  const lines = [];
  lines.push("build: " + (result.ok ? "OK" : "FAILED"));
  lines.push("target          : " + result.target);
  if (result.bankPath) {
    lines.push((result.target === "server" ? "validated bank  : " : "bank file       : ") + result.bankPath + (result.fixture ? " (fixture)" : ""));
    lines.push("bank version    : " + String(result.bankVersion));
    lines.push("questions       : " + result.questions);
    lines.push("by sectionType  : " + JSON.stringify(result.counts.bySectionType));
    lines.push("by responseMode : " + JSON.stringify(result.counts.byResponseMode));
    lines.push("by chapter      : " + JSON.stringify(result.counts.byChapter));
  } else {
    lines.push("bank file       : (not inlined; served by API)");
  }
  if (result.tagCoverage) {
    const cov = result.tagCoverage;
    lines.push(
      "tag coverage    : " + cov.standard.specific + "/" + cov.total + " = " + (cov.standard.rate * 100).toFixed(2) +
        "% specific tags (gate >= " + cov.threshold * 100 + "%: " + (cov.standard.gate ? "OK" : "FAIL") + ")"
    );
    lines.push(
      "tag coverage*   : " + cov.conservative.specific + "/" + cov.total + " = " + (cov.conservative.rate * 100).toFixed(2) +
        "% conservative caliber (informational only, never a gate)"
    );
  }
  if (result.distribution) lines.push("mock by type    : " + JSON.stringify(result.distribution));
  lines.push("validateBank    : " + (result.validateBank.ok ? "OK" : "FAIL") + " (errors=" + result.validateBank.errors.length + ", warnings=" + result.validateBank.warnings.length + ")");
  for (const e of result.validateBank.errors) {
    lines.push("  ERROR " + e.code + " " + e.message + (e.qid ? " [" + e.qid + "]" : ""));
  }
  for (const w of result.validateBank.warnings) {
    lines.push("  WARN  " + w.code + " " + w.message);
  }
  lines.push("self-contained  : " + (result.selfContainment.ok ? "OK (0 external references)" : "FAIL " + result.selfContainment.problems.join(", ")));
  if (result.artifactCheck) {
    lines.push("artifact self-test: " + (result.artifactCheck.ok ? "OK" : "FAIL"));
    for (const check of result.artifactCheck.checks) if (!check.ok) lines.push("  FAIL " + check.name);
  }
  lines.push("output          : " + result.outPath + " (" + result.bytes + " bytes)");
  if (result.reportPath) lines.push("build report    : " + result.reportPath);
  console.log(lines.join("\n"));
}

async function main() {
  const args = process.argv.slice(2);
  const getFlagValue = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 && args[index + 1] ? args[index + 1] : null;
  };
  const options = {
    bankPath: getFlagValue("--bank"),
    outPath: getFlagValue("--out"),
    target: getFlagValue("--target") === "server" ? "server" : "offline",
    strict: args.includes("--strict"),
  };
  const quiet = args.includes("--quiet");
  try {
    const result = build(options);
    printReport(result, quiet);
    if (!result.ok) {
      if (!quiet) {
        console.error("build failed: structural bank errors or external references found");
        if (result.blockingErrors.length > 0) console.error("blocking error codes: " + result.blockingErrors.join(", "));
      }
      process.exitCode = 1;
      return;
    }
    if (!result.validateBank.ok && !quiet) {
      console.log("note: validateBank reported data-quality deviations (non-blocking); see the build report.");
    }
  } catch (err) {
    console.error("build error: " + (err && err.message ? err.message : String(err)));
    process.exitCode = 2;
  }
}

const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  await main();
}
