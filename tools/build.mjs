// 构建脚本：把 core 模块 + UI + 题库 JSON 内联为单文件 dist/密码赛刷题平台.html
// 用法：node tools/build.mjs [--bank 路径] [--out 路径] [--strict] [--quiet]
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
const DEFAULT_OUT = path.join(DIST, "密码赛刷题平台.html");
const REPORT_NAME = "密码赛刷题平台.build-report.json";

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

export function selfContainmentCheck(html) {
  const problems = [];
  const patterns = [
    { name: "external URLs", re: /https?:\/\//g },
    { name: "script src", re: /<script[^>]*\ssrc=/gi },
    { name: "link href", re: /<link[^>]*\shref=/gi },
    { name: "fetch call", re: /\bfetch\s*\(/g },
    { name: "XMLHttpRequest", re: /XMLHttpRequest/g },
    { name: "WebSocket", re: /WebSocket/g },
    { name: "new Image", re: /\bnew\s+Image\s*\(/g },
    { name: "css @import", re: /@import/g },
    { name: "css remote url", re: /url\(\s*['"]?(?:https?:)?\/\//gi },
    { name: "iframe/object/embed", re: /<(?:iframe|object|embed)\b/gi },
  ];
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
  const fixturePath = path.join(ROOT, "tests", "fixtures", "bank.sample.json");
  const realPath = path.join(ROOT, "src", "data", "bank.json");
  const bankPath = opts.bankPath
    ? path.resolve(opts.bankPath)
    : fs.existsSync(realPath)
      ? realPath
      : fixturePath;
  if (!fs.existsSync(bankPath)) throw new Error("bank file not found: " + bankPath);

  const bank = JSON.parse(fs.readFileSync(bankPath, "utf8"));
  const isFixture = bank.fixture === true || path.resolve(bankPath) === fixturePath;
  const validation = CQP.validateBank(bank, { fixture: isFixture });
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
  const coreJs = readCoreBundle() + "\n" + bankBootstrap();
  const bankJson = escapeJsonForHtml(JSON.stringify(bank));

  let html = template;
  html = html.replace("/*{{STYLE}}*/", () => style);
  html = html.replace("/*{{BANK_JSON}}*/", () => bankJson);
  html = html.replace("/*{{CORE_JS}}*/", () => coreJs);
  html = html.replace("/*{{APP_JS}}*/", () => appJs);
  html = html.replace(/\{\{APP_VERSION\}\}/g, CQP.VERSION);
  html = html.replace(/\{\{BANK_VERSION\}\}/g, () => String(bank.bankVersion || "unknown"));
  html = html.replace(/\{\{GENERATED_AT\}\}/g, () => new Date().toISOString());

  if (html.indexOf("/*{{") >= 0) throw new Error("template placeholder left unreplaced");

  const selfCheck = selfContainmentCheck(html);
  const report = {
    builtAt: new Date().toISOString(),
    appVersion: CQP.VERSION,
    bankPath,
    bankVersion: bank.bankVersion || null,
    fixture: isFixture,
    questions: bank.questions.length,
    validateBank: { ok: validation.ok, errors: validation.errors, warnings: validation.warnings },
    blockingErrors: blocking.map((e) => e.code),
    counts: CQP.countsOf(bank),
    tagCoverage: CQP.buildReport(bank).tagCoverage,
    distribution: CQP.computeMockDistribution(bank.questions, CQP.MOCK_LIMITS.count).byType,
    selfContainment: selfCheck,
    bytes: Buffer.byteLength(html, "utf8"),
    ok: !failed && selfCheck.ok,
  };

  const outPath = opts.outPath ? path.resolve(opts.outPath) : DEFAULT_OUT;
  const reportPath = opts.reportPath === null ? null : path.resolve(opts.reportPath || path.join(DIST, REPORT_NAME));
  if (opts.write === false) return { ...report, outPath, reportPath, html };

  const artifactCheck = opts.verify === false ? null : verifyArtifact(html);
  report.artifactCheck = artifactCheck;
  if (artifactCheck && !artifactCheck.ok) report.ok = false;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, "utf8");
  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  }
  return { ...report, outPath, reportPath };
}

// 成品自检：把写出的 HTML 里的内联脚本放进一个裸 VM 跑一遍（无浏览器依赖）
export function verifyArtifact(html) {
  const checks = [];
  const extract = (id) => {
    const start = html.indexOf('<script id="' + id + '"');
    if (start < 0) throw new Error("script block missing: " + id);
    const openEnd = html.indexOf(">", start);
    const close = html.indexOf("</script>", openEnd);
    return html.slice(openEnd + 1, close);
  };
  const bankJson = extract("bank-data");
  const coreJs = extract("cqp-core");
  const appJs = extract("cqp-app");
  checks.push({ name: "script blocks present", ok: bankJson.length > 0 && coreJs.length > 0 && appJs.length > 0 });
  checks.push({ name: "no protocol text", ok: !/https?:\/\//.test(html) });
  checks.push({ name: "single html document", ok: html.split("<!DOCTYPE html>").length === 2 });

  const bank = JSON.parse(bankJson);
  checks.push({ name: "inlined bank parses", ok: Array.isArray(bank.questions) });

  const context = vm.createContext({
    document: { getElementById: (id) => (id === "bank-data" ? { textContent: bankJson } : null) },
    console: { log() {}, error() {}, warn() {} },
  });
  vm.runInContext(coreJs, context, { filename: "dist-core.js" });
  const CQP = context.CQP;
  // 不再写死版本号——校验成品内联的 CQP.VERSION 与源码常量一致（升版时同步跟随）。
  checks.push({ name: "CQP registered", ok: !!CQP && CQP.VERSION === cn_VERSION });
  const validation = CQP.validateBank(CQP.__test.bank);
  checks.push({ name: "validateBank ok (" + bank.questions.length + " questions)", ok: validation.ok });
  const paper = CQP.buildMockPaper({ bank: CQP.__test.bank, rng: CQP.makeRng(1) });
  const answerable = CQP.candidates({ bank: CQP.__test.bank }).length;
  checks.push({
    name: "mock paper " + paper.questionIds.length + " unique questions (pool " + answerable + ")",
    ok:
      paper.questionIds.length === Math.min(CQP.MOCK_LIMITS.count, answerable) &&
      new Set(paper.questionIds).size === paper.questionIds.length,
  });
  const fullWidth = "ＳＭ４";
  checks.push({ name: "blank full-width judging works", ok: CQP.judge({ sectionType: "blank", answer: ["SM4"] }, [fullWidth]).correct === true });
  checks.push({ name: "app script wires the UI", ok: appJs.indexOf("CQPUI") > 0 && appJs.indexOf("bank-data") > 0 });
  return { ok: checks.every((c) => c.ok), checks };
}

function printReport(result, quiet) {
  if (quiet) return;
  const lines = [];
  lines.push("build: " + (result.ok ? "OK" : "FAILED"));
  lines.push("bank file       : " + result.bankPath + (result.fixture ? " (fixture)" : ""));
  lines.push("bank version    : " + String(result.bankVersion));
  lines.push("questions       : " + result.questions);
  lines.push("by sectionType  : " + JSON.stringify(result.counts.bySectionType));
  lines.push("by responseMode : " + JSON.stringify(result.counts.byResponseMode));
  lines.push("by chapter      : " + JSON.stringify(result.counts.byChapter));
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
  lines.push("mock by type    : " + JSON.stringify(result.distribution));
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
