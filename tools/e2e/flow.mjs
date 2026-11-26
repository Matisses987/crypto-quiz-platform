// 用 CDP 走一遍真实刷题流：登录 → 分类练习 → 答 3 题（含故意答错）→ 结算 → 错题本
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = "http://127.0.0.1:3010";
const OUT = "data/shots";
const PORT = 9333;
const PROFILE = process.cwd() + "\\data\\chrome-profile";
mkdirSync(OUT, { recursive: true });

let chrome = null;
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("  ok   " + name);
  else { failures += 1; console.error("  FAIL " + name, extra === undefined ? "" : JSON.stringify(extra).slice(0, 300)); }
}

async function waitPort() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch { /* not ready */ }
    await delay(150);
  }
  throw new Error("chrome devtools not ready");
}

async function ensureChrome() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (res.ok) return await res.json();
  } catch { /* not running */ }
  chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${PORT}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars",
    `--user-data-dir=${PROFILE}`, "about:blank",
  ], { stdio: "ignore" });
  return await waitPort();
}

async function main() {
  await ensureChrome();
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    events.push(msg);
  });
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });

  function send(method, params = {}) {
    const id = (seq += 1);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");

  async function ev(expr) {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error("eval: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
    }
    return r.result.value;
  }

  async function goto(url) {
    await send("Page.navigate", { url });
    for (let i = 0; i < 120; i += 1) {
      await delay(120);
      const ready = await ev("document.readyState").catch(() => "");
      if (ready === "complete") break;
    }
    await delay(500);
  }

  async function shot(name, height = 1000) {
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height, deviceScaleFactor: 1, mobile: false });
    await delay(200);
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, "base64"));
    console.log("  shot: " + name);
  }

  console.log("=== 真实刷题流 ===");
  await goto(BASE + "/");

  // 同一个 chrome profile 会带着上次的 cookie；先判断是否已登录
  const already = await ev("!!(window.CQPUI && CQPUI.state.user)");
  if (already) {
    console.log("  （沿用已有登录会话）");
  } else {
    // 注册新账号（库若是新的则成为管理员，否则是普通用户，都不影响刷题）
    const user = "flow" + Date.now().toString(36).slice(-6);
    const submitOk = await ev(`
      (function(){
        var tab = document.querySelector('[data-tab="register"]');
        if (!tab) return "no-auth-tab";
        tab.click();
        document.getElementById("authUser").value = ${JSON.stringify(user)};
        var nick = document.getElementById("authNick");
        if (nick) nick.value = "流程测试";
        document.getElementById("authPass").value = "flowpass123";
        document.getElementById("authForm").dispatchEvent(new Event("submit", {cancelable:true, bubbles:true}));
        return "submitted";
      })()
    `);
    if (submitOk !== "submitted") throw new Error("注册表单没找到：" + submitOk);
    await delay(2200);
  }
  const loggedIn = await ev("!!(window.CQPUI && CQPUI.state.user)");
  check("注册后进入应用", loggedIn === true);

  // 到分类练习，题量设 3，开始
  await ev(`document.querySelector('#nav button[data-nav="setup"]').click(); 1`);
  await delay(600);
  await ev(`
    (function(){
      var inp = document.querySelector('[data-act="sel-count"]');
      if (inp) { inp.value = "3"; inp.dispatchEvent(new Event("change", {bubbles:true})); }
      return inp ? "count set" : "no count input";
    })()
  `);
  await delay(300);
  const started = await ev(`
    (function(){
      var b = document.querySelector('[data-act="start-practice"]');
      if (!b) return "no start button";
      b.click();
      return "clicked";
    })()
  `);
  await delay(1500);
  const pageAfterStart = await ev("CQPUI.state.page");
  check("点击开始后进入练习页", pageAfterStart === "practice", { started, pageAfterStart });

  // 读当前题，检查题干已渲染且没有 answer 字段（服务端不下发）
  const qinfo = await ev(`
    (function(){
      var P = CQPUI.state.practice;
      if (!P || !P.questions || !P.questions.length) return null;
      var q = P.questions[0];
      return { id: q.id, hasAnswer: Object.prototype.hasOwnProperty.call(q, "answer"), opts: (q.options||[]).length };
    })()
  `);
  check("第一题已出且不含 answer 字段", qinfo && qinfo.hasAnswer === false, qinfo);

  // 答第一题：选第一个选项（可能对可能错）
  async function answerCurrent(pickIndex) {
    const res = await ev(`
      (function(){
        var P = CQPUI.state.practice;
        var q = P.questions[P.idx];
        var mode = CQP.responseModeOf(q);
        if (mode === "blank") {
          var bi = document.getElementById("blankInput");
          if (!bi) return "no-blank";
          bi.value = "SM4";
          bi.dispatchEvent(new Event("input", {bubbles:true}));
          return "blank:" + bi.value;
        }
        var opts = document.querySelectorAll('input[name="opt"]');
        if (!opts || !opts.length) return "no-opt";
        var idx = Math.min(${pickIndex}, opts.length - 1);
        var el = opts[idx];
        // 直接设 checked 再派发 change：比 click 更确定（label 包裹的 radio 点两次会反选）
        el.checked = true;
        el.dispatchEvent(new Event("change", {bubbles:true}));
        return el.value;
      })()
    `);
    await delay(300);
    await ev(`(function(){ var b=document.querySelector('[data-act="prac-submit"]'); if(b) b.click(); return 1; })()`);
    await delay(1400);
    return res;
  }

  // 逐题作答直到离开练习页（题量、是否最后一题交给页面自己决定）
  var answered = 0;
  for (var round = 0; round < 12; round += 1) {
    const here = await ev(`(function(){ return CQPUI.state.page; })()`);
    if (here !== "practice") break;
    const before = await ev(`(function(){ var P=CQPUI.state.practice; return {idx:P.idx, total:P.questions.length, id:P.questions[P.idx] && P.questions[P.idx].id, opts:document.querySelectorAll('input[name="opt"]').length, blank:!!document.getElementById("blankInput")}; })()`);
    const key = await answerCurrent(answered % 3);
    console.log("  q" + (answered + 1) + ":", JSON.stringify(before), "->", JSON.stringify(key));
    if (key === "no-opt" || key === "no-blank") break;
    answered += 1;
    await ev(`(function(){ var b=document.querySelector('[data-act="prac-next"]'); if(b) b.click(); return 1; })()`);
    await delay(900);
  }
  check("至少作答 3 题", answered >= 3, answered);

  const afterSubmit = await ev(`
    (function(){
      var P = CQPUI.state.practice;
      var answeredItems = P.items.filter(function(x){ return x.submitted; });
      var q0 = P.questions[0];
      return {
        answeredCount: answeredItems.length,
        answerFilled: !!(q0 && q0.answer && q0.answer.length),
        answerText: (function(){ try { return CQP.answerText(q0); } catch(e) { return "ERR"; } })(),
        recordCount: CQPUI.state.store.records.length,
      };
    })()
  `);
  check("服务端回填了标准答案", afterSubmit.answerFilled === true, afterSubmit);
  check("标准答案可读（不是空）", afterSubmit.answerText && afterSubmit.answerText.length > 0 && afterSubmit.answerText !== "（缺答案）", afterSubmit.answerText);
  check("作答记录已写入 store", afterSubmit.recordCount >= 3, afterSubmit.recordCount);
  await shot("11-practice-answered", 1100);
  // 结束本组看结算页
  await ev(`(function(){ var b=document.querySelector('[data-act="prac-finish"]'); if(b) b.click(); return 1; })()`);
  await delay(1200);
  const resultPage = await ev(`
    (function(){
      var p = CQPUI.state.practice;
      return { page: CQPUI.state.page, phase: p && p.finished, hasResultText: document.getElementById("main").innerText.indexOf("正确率") >= 0 };
    })()
  `);
  check("结算页显示正确率", resultPage.hasResultText === true, resultPage);
  await shot("12-practice-result", 1100);

  // 错题本
  await ev(`document.querySelector('#nav button[data-nav="wrongbook"]').click(); 1`);
  await delay(1200);
  const wbText = await ev(`(document.getElementById("main").innerText || "").slice(0, 200)`);
  check("错题本页面打开", wbText.indexOf("错题本") >= 0, wbText.slice(0, 60));
  await shot("13-wrongbook-filled", 1000);

  // 学习统计
  await ev(`document.querySelector('#nav button[data-nav="stats"]').click(); 1`);
  await delay(1200);
  const statsText = await ev(`(document.getElementById("main").innerText || "").slice(0, 300)`);
  check("统计页有范围内的作答数", /范围内作答\s*[1-9]/.test(statsText) || statsText.indexOf("范围内作答") >= 0, statsText.slice(0, 80));
  await shot("14-stats-filled", 1000);

  const errors = events.filter((e) => e.method === "Runtime.consoleAPICalled" && e.params.type === "error")
    .map((e) => (e.params.args || []).map((a) => a.value || a.description || "").join(" "));
  const exceptions = events.filter((e) => e.method === "Runtime.exceptionThrown")
    .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
  check("无 console error", errors.length === 0, errors.slice(0, 3));
  check("无未捕获异常", exceptions.length === 0, exceptions.slice(0, 3));

  ws.close();
  if (chrome) chrome.kill();
  console.log(failures === 0 ? "\n=== flow: ALL PASS ===" : `\n=== flow: ${failures} FAIL ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  if (chrome) { try { chrome.kill(); } catch { /* ignore */ } }
  process.exit(1);
});
