// 模拟考全流程：开局 → 答几题 → 暂存 → 刷新续考 → 交卷 → 成绩页
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = "http://127.0.0.1:3010";
const PORT = 9333;
const PROFILE = process.cwd() + "\\data\\chrome-profile";
let chrome = null;
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("  ok   " + name);
  else { failures += 1; console.error("  FAIL " + name, extra === undefined ? "" : JSON.stringify(extra).slice(0, 300)); }
}

async function waitPort() {
  for (let i = 0; i < 120; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return await r.json(); } catch { /* wait */ }
    await delay(150);
  }
  throw new Error("chrome devtools not ready");
}
async function ensureChrome() {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return await r.json(); } catch { /* not running */ }
  chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, "--no-first-run",
    "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${PROFILE}`, "about:blank"], { stdio: "ignore" });
  return await waitPort();
}

async function main() {
  await ensureChrome();
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
      return;
    }
    events.push(m);
  });
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = (seq += 1); pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send("Page.enable");
  await send("Runtime.enable");

  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
    return r.result.value;
  };
  const goto = async (url) => {
    await send("Page.navigate", { url });
    for (let i = 0; i < 120; i += 1) { await delay(120); if (await ev("document.readyState").catch(() => "") === "complete") break; }
    await delay(600);
  };
  const shot = async (name, height = 1000) => {
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height, deviceScaleFactor: 1, mobile: false });
    await delay(200);
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`data/shots/${name}.png`, Buffer.from(r.data, "base64"));
    console.log("  shot: " + name);
  };

  console.log("=== 模拟考流程 ===");
  await goto(BASE + "/");

  // 同一 chrome profile 带着上次 cookie；库换了则 cookie 失效，需重新登录/注册
  const already = await ev("!!(window.CQPUI && CQPUI.state.user)");
  if (already) {
    console.log("  （沿用已有登录会话）");
  } else {
    const user = "mock" + Date.now().toString(36).slice(-6);
    const submitOk = await ev(`
      (function(){
        var tab = document.querySelector('[data-tab="register"]');
        if (!tab) return "no-auth-tab";
        tab.click();
        document.getElementById("authUser").value = ${JSON.stringify(user)};
        var nick = document.getElementById("authNick");
        if (nick) nick.value = "模拟考测试";
        document.getElementById("authPass").value = "mockpass123";
        document.getElementById("authForm").dispatchEvent(new Event("submit", {cancelable:true, bubbles:true}));
        return "submitted";
      })()
    `);
    if (submitOk !== "submitted") throw new Error("注册表单没找到：" + submitOk);
    await delay(2500);
  }
  check("已登录会话可用", (await ev("!!(window.CQPUI && CQPUI.state.user)")) === true);

  // 直接用当前题库（内置 1051 题），出卷够用
  check("当前题库可用", (await ev("!!CQPUI.state.bankSlug")) === true, await ev("CQPUI.state.bankSlug"));

  // 进模拟考页并开局
  await ev(`document.querySelector('#nav button[data-nav="mock"]').click(); 1`);
  await delay(700);
  await ev(`(function(){ var b=document.querySelector('[data-act="mock-start"]'); if(b) b.click(); return 1; })()`);
  await delay(2500);
  const mockStart = await ev(`
    (function(){
      var M = CQPUI.__test.mockState();
      return M && M.paper ? { phase: M.phase, count: M.paper.questionIds.length, planSec: M.paper.timeLimitSec } : null;
    })()
  `);
  check("模拟考已开局", mockStart && mockStart.count > 0, mockStart);
  await shot("15-mock-running", 1050);

  // 答 4 题：每题先设作答（选中 radio/checkbox 或填空），再点「下一题」结算
  for (let step = 0; step < 4; step += 1) {
    const picked = await ev(`
      (function(){
        var blank = document.getElementById("mockBlank");
        if (blank) {
          blank.value = "SM4";
          blank.dispatchEvent(new Event("input", {bubbles:true}));
          return "blank:SM4";
        }
        var inp = document.querySelectorAll('input[name="mockOpt"]');
        if (!inp.length) return "none";
        var el = inp[${step} % inp.length];
        el.checked = true;
        el.dispatchEvent(new Event("change", {bubbles:true}));
        return "opt:" + el.value;
      })()
    `);
    await delay(200);
    await ev(`(function(){ var b=document.querySelector('[data-act="mock-next"]'); if(b){ b.click(); return 1; } return 0; })()`);
    await delay(450);
    const now = await ev(`
      (function(){
        var M = CQPUI.__test.mockState();
        var ids = M.paper.questionIds;
        var answered = ids.filter(function(q){ return M.responses[q].myAnswer.length > 0; }).length;
        return { picked: ${JSON.stringify("")}, idx: M.idx, answered: answered, phase: M.phase };
      })()
    `);
    console.log(`  step${step + 1}: ${picked} -> idx=${now.idx} answered=${now.answered}`);
  }

  const progress = await ev(`
    (function(){
      var M = CQPUI.__test.mockState();
      var keys = Object.keys(M.responses || {});
      var withAnswer = keys.filter(function(k){ return M.responses[k] && M.responses[k].myAnswer && M.responses[k].myAnswer.length; });
      return { answered: withAnswer.length, total: M.paper.questionIds.length, phase: M.phase };
    })()
  `);
  check("至少答了 3 题", progress.answered >= 3, progress);

  // 刷新页面：应能续考（服务端 running 复用）
  await goto(BASE + "/");
  await ev(`document.querySelector('#nav button[data-nav="mock"]').click(); 1`);
  await delay(1800);
  const resumed = await ev(`
    (function(){
      var M = CQPUI.__test.mockState();
      if (!M || !M.paper) return { phase: CQPUI.state.page, none: true };
      return { phase: M.phase, count: M.paper.questionIds.length };
    })()
  `);
  check("刷新后模拟考仍在（服务端复用 running）", resumed && !resumed.none, resumed);

  // 交卷
  await ev(`
    (function(){
      var b = document.querySelector('[data-act="mock-submit"]');
      if (b) { b.click(); return "clicked"; }
      return "no-submit";
    })()
  `);
  await delay(1200);
  // 二次确认弹窗
  await ev(`(function(){ var b=document.querySelector('[data-act="modal-ok"]'); if(b){ b.click(); return "confirmed"; } return "no-modal"; })()`);
  await delay(2500);
  const result = await ev(`
    (function(){
      var M = CQPUI.__test.mockState();
      return M && M.session ? {
        phase: M.phase,
        score: M.session.result && M.session.result.score,
        maxScore: M.session.result && M.session.result.maxScore,
        correct: M.session.result && M.session.result.correctCount,
        total: M.session.result && M.session.result.correctCount !== undefined ? M.session.questionIds.length : null,
        autoSubmitted: M.session.autoSubmitted,
      } : { phase: M && M.phase, session: null };
    })()
  `);
  check("交卷后进入成绩页", result.phase === "result", result);
  check("成绩含分数", typeof result.score === "number" && result.score >= 0, result);
  await shot("16-mock-result", 1100);

  // 交卷后数据落库：模拟赛成绩单在 mock_exams 行（服务端版 store.sessions 恒为空），
  // 作答记录由 flushMockRecords 写进 store.records，等 250ms 防抖落盘后再查。
  await delay(1500);
  const storeState = await ev(`
    (function(){
      var S = CQPUI.state;
      return { records: S.store.records.length, wrongbook: Object.keys(S.store.wrongbook).length };
    })()
  `);
  check("交卷后写入作答记录", storeState.records >= 3, storeState);

  const examRow = await ev(`
    (async function(){
      var r = await fetch("/api/mock/list?bank=" + encodeURIComponent(CQPUI.state.bankSlug) + "&limit=1", { credentials: "same-origin" });
      var d = await r.json();
      var row = d.items && d.items[0];
      return row ? { id: row.id, status: row.status, score: row.score, total: row.total } : null;
    })()
  `);
  check("服务端保留了本场成绩", examRow && examRow.status === "submitted", examRow);

  const errors = events.filter((e) => e.method === "Runtime.consoleAPICalled" && e.params.type === "error")
    .map((e) => (e.params.args || []).map((a) => a.value || a.description || "").join(" "));
  const exceptions = events.filter((e) => e.method === "Runtime.exceptionThrown")
    .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
  check("无 console error", errors.length === 0, errors.slice(0, 3));
  check("无未捕获异常", exceptions.length === 0, exceptions.slice(0, 3));

  ws.close();
  if (chrome) chrome.kill();
  console.log(failures === 0 ? "\n=== mock flow: ALL PASS ===" : `\n=== mock flow: ${failures} FAIL ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FAILED:", e.message); if (chrome) { try { chrome.kill(); } catch { /* ignore */ } } process.exit(1); });
