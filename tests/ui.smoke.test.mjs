// UI smoke test: drives the shipped single-file app inside a minimal DOM shim,
// covering the three-colour rule, wrongbook entry, stats, review overlay and the mock exam.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "../tools/build.mjs";
import { createDom } from "./helpers/domshim.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const fixturePath = path.join(here, "fixtures", "bank.sample.json");
const realPath = path.join(root, "src", "data", "bank.json");
// t46 O-01：临时产物写系统临时目录，绝不落在交付目录 dist/
const artifactPath = path.join(os.tmpdir(), "__cqp_ui_smoke_test.html");

function fullWidth(text) {
  return String(text).replace(/[!-~]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0));
}

function extractScript(html, id) {
  const start = html.indexOf('<script id="' + id + '"');
  assert.ok(start > 0, "missing script " + id);
  const openEnd = html.indexOf(">", start);
  const close = html.indexOf("</script>", openEnd);
  return html.slice(openEnd + 1, close);
}

function bootApp() {
  const bankPath = fs.existsSync(realPath) ? realPath : fixturePath;
  const result = build({ bankPath, outPath: artifactPath, reportPath: null });
  assert.equal(result.ok, true);
  const html = fs.readFileSync(artifactPath, "utf8");
  const bankJson = extractScript(html, "bank-data");
  const coreJs = extractScript(html, "cqp-core");
  const appJs = extractScript(html, "cqp-app");

  const dom = createDom();
  dom.getElementById("bank-data").textContent = bankJson;
  const context = vm.createContext(dom.context);
  vm.runInContext(coreJs, context, { filename: "core.js" });
  dom.window.CQP = context.CQP;
  vm.runInContext(appJs, context, { filename: "app.js" });
  return { dom, context, CQP: context.CQP, CQPUI: dom.window.CQPUI, bankJson };
}

function fakeActionElement(attributes) {
  return {
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    },
  };
}

test("UI smoke: pages render, practice flow follows the three-colour rule", () => {
  const { dom, CQP, CQPUI } = bootApp();
  assert.ok(CQPUI, "CQPUI must be exposed by the shipped app");

  // 首次进入要求填写昵称
  assert.ok(dom.getElementById("modalRoot").innerHTML.indexOf("请填写昵称") > 0);
  CQPUI.state.store.meta.nickname = "小明";
  CQP.touchMeta(CQPUI.state.store, { nickname: "小明" }, CQP.isoNow());
  CQPUI.render();
  assert.ok(dom.getElementById("main").innerHTML.indexOf("今日学习") > 0);

  // 所有页面都能渲染
  for (const page of ["setup", "wrongbook", "stats", "team", "io", "review", "mock", "home"]) {
    CQPUI.go(page);
    assert.ok(dom.getElementById("main").innerHTML.length > 400, "page " + page + " renders something");
  }
  CQPUI.go("setup");
  const setupHtml = dom.getElementById("main").innerHTML;
  assert.ok(setupHtml.indexOf("分类练习设置") > 0);
  assert.ok(setupHtml.indexOf("知识点标签") > 0);
  assert.ok(setupHtml.indexOf("已练") > 0, "shows how much of each chapter has been practised");

  const bank = CQP.__test.bank;
  const single = bank.questions.find((q) => q.sectionType === "single" && q.options.length === 4);
  const blank = bank.questions.find((q) => q.sectionType === "blank" && q.answer.length >= 1);
  const judge = bank.questions.find((q) => q.sectionType === "judge");
  const questions = [single, blank, judge];
  CQPUI.__test.startPractice("practice_chapter", questions, { title: "冒烟练习" });
  assert.ok(dom.getElementById("main").innerHTML.indexOf(CQP.queryEscapedStem ? "" : "") === 0);

  // 第 1 题：答对 + 带猜测 -> 黄，进错题本
  dom.setChecked([single.answer[0]]);
  CQPUI.__test.action("prac-submit");
  let item = CQPUI.__test.practiceItem(0);
  assert.equal(item.submitted, true);
  assert.equal(item.correct, true);
  assert.equal(item.color, "green", "默认有把握 -> 绿");
  CQPUI.__test.action("conf", fakeActionElement({ "data-conf": "guessed" }));
  assert.equal(CQPUI.__test.practiceItem(0).color, "yellow");

  // O-2 回归：提交即落库 —— 未点「下一题」时就已在内存态与 localStorage 里
  assert.equal(CQPUI.state.store.records.length, 1, "提交后立即写记录");
  assert.equal(CQPUI.state.store.records[0].confidence, "guessed");
  assert.equal(CQPUI.state.store.wrongbook[single.id].state, "active", "提交后错题本立即更新");
  assert.equal(JSON.parse(dom.storageMap.get("cqp.v1.records")).length, 1, "提交后立即落盘");
  assert.equal(Object.keys(JSON.parse(dom.storageMap.get("cqp.v1.wrongbook"))).length, 1);
  CQPUI.go("stats");
  assert.ok(dom.getElementById("main").innerHTML.indexOf(single.id) > 0, "统计页能看到刚提交的题");
  const earlyExport = CQP.exportPayload({ store: CQPUI.state.store, scope: "all", nickname: "小明" });
  assert.equal(earlyExport.counts.records, 1, "导出能看到刚提交的题");
  dom.fireWindow("pagehide");
  assert.equal(CQPUI.state.store.records.length, 1, "pagehide 兜底 flush 不重复计数");
  CQPUI.__test.flushPractice();
  assert.equal(CQPUI.state.store.records.length, 1, "兜底 flush 幂等");
  CQPUI.go("practice");
  assert.equal(CQPUI.__test.practiceItem(0).submitted, true, "导航往返后作答状态仍在");

  CQPUI.__test.action("prac-next");
  assert.equal(CQPUI.state.store.records.length, 1);
  assert.equal(CQPUI.state.store.records[0].color, "yellow");
  assert.equal(CQPUI.state.store.records[0].confidence, "guessed");
  assert.equal(CQPUI.state.store.wrongbook[single.id].state, "active", "猜对进入错题本");

  // 第 2 题：填空用全角输入 -> 仍然判对（队长决定），保持有把握 -> 绿，不进错题本
  const blankHtml = dom.getElementById("main").innerHTML;
  assert.equal(blankHtml.split('id="blankInput"').length - 1, 1, "填空输入框只渲染一次（原位替换，无重复控件）");
  CQPUI.__test.action("prac-submit"); // 未作答时不应提交
  assert.equal(CQPUI.__test.practiceItem(1).submitted, false);
  const blankInput = dom.makeElement("input");
  blankInput.value = fullWidth(blank.answer[0]);
  dom.register("#blankInput", blankInput);
  CQPUI.__test.action("prac-submit");
  item = CQPUI.__test.practiceItem(1);
  assert.equal(item.submitted, true, "blank answer submitted");
  assert.equal(item.correct, true, "full-width answer is accepted");
  assert.equal(item.color, "green");
  CQPUI.__test.action("prac-next");
  assert.equal(CQPUI.state.store.wrongbook[blank.id], undefined, "有把握答对不进错题本");

  // 第 3 题：答错 -> 红，进错题本
  dom.setChecked([judge.answer[0] === "对" ? "错" : "对"]);
  CQPUI.__test.action("prac-submit");
  item = CQPUI.__test.practiceItem(2);
  assert.equal(item.correct, false);
  assert.equal(item.color, "red");
  CQPUI.__test.action("prac-next");
  assert.equal(CQPUI.state.store.records.length, 3);
  assert.equal(CQPUI.state.store.wrongbook[judge.id].state, "active");

  // 结算页
  assert.equal(CQPUI.state.page, "result");
  const resultHtml = dom.getElementById("main").innerHTML;
  assert.ok(resultHtml.indexOf("本轮结算") > 0);
  assert.ok(resultHtml.indexOf("正确率") > 0);
  assert.ok(resultHtml.indexOf("绿·有把握对") > 0);
  assert.ok(resultHtml.indexOf("黄·猜对") > 0);
  assert.ok(resultHtml.indexOf("红·错") > 0);

  // 落盘：localStorage 里能读到记录与错题本
  assert.ok(dom.storageMap.has("cqp.v1.records"));
  assert.equal(JSON.parse(dom.storageMap.get("cqp.v1.records")).length, 3);
  assert.equal(Object.keys(JSON.parse(dom.storageMap.get("cqp.v1.wrongbook"))).length, 2);
  assert.equal(JSON.parse(dom.storageMap.get("cqp.v1.meta")).nickname, "小明");

  // 错题本页面与重练入口
  CQPUI.go("wrongbook");
  const wrongHtml = dom.getElementById("main").innerHTML;
  assert.ok(wrongHtml.indexOf("错题本") > 0);
  assert.ok(wrongHtml.indexOf("错题重练") > 0);
  assert.ok(dom.getElementById("whoami").textContent.indexOf("在册错题 2") >= 0);

  // 自动移出：连续两次有把握答对
  const entry = CQP.wrongbookApply(
    CQPUI.state.store.wrongbook,
    CQP.makeRecord({
      question: single,
      myAnswer: single.answer.slice(),
      confidence: "confident",
      elapsedMs: 10,
      mode: "practice_chapter",
      nickname: "小明",
      bankVersion: bank.bankVersion,
      appVersion: CQP.VERSION,
      nowISO: "2026-10-06T10:00:00+08:00",
    }),
    "2026-10-06T10:00:00+08:00"
  );
  assert.equal(entry.action, "kept");
  const cleared = CQP.wrongbookApply(
    entry.book,
    CQP.makeRecord({
      question: single,
      myAnswer: single.answer.slice(),
      confidence: "confident",
      elapsedMs: 10,
      mode: "practice_chapter",
      nickname: "小明",
      bankVersion: bank.bankVersion,
      appVersion: CQP.VERSION,
      nowISO: "2026-10-06T10:05:00+08:00",
    }),
    "2026-10-06T10:05:00+08:00"
  );
  assert.equal(cleared.action, "removed");
  assert.equal(cleared.book[single.id].removedReason, "auto2");
  CQPUI.state.store.wrongbook = cleared.book;
  CQPUI.state.wrongFilter.state = "removed";
  CQPUI.render();
  const afterAuto = dom.getElementById("main").innerHTML;
  assert.ok(afterAuto.indexOf("已自动移出") > 0);
  CQPUI.state.wrongFilter.state = "active";

  // 学习统计：样本不足提示
  CQPUI.go("stats");
  const statsHtml = dom.getElementById("main").innerHTML;
  assert.ok(statsHtml.indexOf("掌握指数") > 0);
  assert.ok(statsHtml.indexOf("薄弱知识点 TOP") > 0);
  assert.ok(statsHtml.indexOf("每题明细") > 0);

  // 校对纠错：写入覆盖层并立即生效
  CQPUI.go("review");
  assert.ok(dom.getElementById("main").innerHTML.indexOf("校对 / 纠错") > 0);
  const answerInput = dom.makeElement("input");
  answerInput.value = "ABD";
  const flagInput = dom.makeElement("input");
  flagInput.checked = true;
  const noteInput = dom.makeElement("input");
  noteInput.value = "冒烟备注";
  dom.register('[data-act="review-answer"][data-qid="' + single.id + '"]', answerInput);
  dom.register('[data-act="review-flag"][data-qid="' + single.id + '"]', flagInput);
  dom.register('[data-act="review-note"][data-qid="' + single.id + '"]', noteInput);
  CQPUI.__test.saveReview(single.id);
  const override = CQPUI.state.store.overrides.items[single.id];
  assert.equal(override.flagged, true);
  assert.equal(override.rev, 1);
  assert.equal(override.answer.join(","), "A,B,D", "parsed multi-answer letters");
  assert.equal(CQP.isFlagged(CQPUI.state.store.overrides, single.id), true);
  assert.equal(
    CQP.effectiveBank().questions.filter((q) => q.id === single.id)[0].answer.join(","),
    "A,B,D",
    "the effective bank changed locally"
  );
  assert.equal(CQP.judge(CQP.effectiveBank().questions.filter((q) => q.id === single.id)[0], ["A", "B", "D"]).correct, true);
  assert.ok(dom.storageMap.has("cqp.v1.overrides"));

  // 导出：单日导出含今天
  CQPUI.go("io");
  assert.ok(dom.getElementById("main").innerHTML.indexOf("导出学习情况") > 0);
  CQPUI.__test.action("export");
  CQPUI.go("team");
  assert.ok(dom.getElementById("main").innerHTML.indexOf("成员对比") > 0);

  fs.rmSync(artifactPath, { force: true });
});

test("UI smoke: importing a teammate file merges once and shows team stats", () => {
  const { dom, CQP, CQPUI } = bootApp();
  CQPUI.state.store.meta.nickname = "小明";
  CQP.touchMeta(CQPUI.state.store, { nickname: "小明" }, CQP.isoNow());

  // 构造队友（小红）的导出文件：同一题答错，另一题答对
  const bank = CQP.__test.bank;
  const q1 = bank.questions[0];
  const q2 = bank.questions[1];
  const teammateStore = CQP.emptyStore();
  teammateStore.meta.nickname = "小红";
  teammateStore.meta.deviceId = "d-11112222";
  teammateStore.records = [
    CQP.makeRecord({
      question: q1,
      myAnswer: q1.options.length ? [q1.options[0].key] : ["错误答案"],
      confidence: "confident",
      elapsedMs: 3000,
      mode: "practice_random",
      nickname: "小红",
      bankVersion: bank.bankVersion,
      appVersion: CQP.VERSION,
      nowISO: "2026-10-05T10:00:00+08:00",
    }),
    CQP.makeRecord({
      question: q2,
      myAnswer: q2.answer.slice(),
      confidence: "confident",
      elapsedMs: 4000,
      mode: "practice_random",
      nickname: "小红",
      bankVersion: bank.bankVersion,
      appVersion: CQP.VERSION,
      nowISO: "2026-10-05T10:01:00+08:00",
    }),
  ];
  // 队友文件里带一条覆盖层修正（F-01 回归：导入后 S.bank 必须立即反映）
  const overrideQuestion = bank.questions.filter((q) => q.options.length === 4 && q.answerStatus === "ok")[0];
  teammateStore.overrides = CQP.setOverride(CQP.emptyStore().overrides, overrideQuestion.id, {
    answer: ["A", "B", "D"],
    flagged: true,
    updatedBy: "小红",
    nowISO: "2026-10-05T10:05:00+08:00",
  });
  const payload = CQP.exportPayload({ store: teammateStore, scope: "all", nickname: "小红" });
  assert.equal(payload.counts.records, 2);
  assert.equal(payload.counts.overrides, 1);

  CQPUI.go("io");
  const validation = CQP.validateImport(JSON.stringify(payload));
  assert.equal(validation.ok, true);
  CQPUI.__test.setPending({ ok: true, errors: [], warnings: [], payload: validation.payload, fileName: "小红.json" });
  CQPUI.render();
  assert.ok(dom.getElementById("main").innerHTML.indexOf("文件校验通过") > 0);
  CQPUI.__test.confirmImport();
  assert.equal(CQPUI.state.store.records.length, 2);
  assert.equal(CQPUI.state.store.imports.length, 1);
  // F-01：内存态先同步再刷新派生数据 —— S.bank 立即反射导入的覆盖层答案
  const reflected = CQPUI.state.bank.questions.filter((q) => q.id === overrideQuestion.id)[0];
  assert.equal(reflected.answer.join(","), "A,B,D", "导入后 S.bank 立即反映新答案");
  assert.equal(CQP.isFlagged(CQPUI.state.store.overrides, overrideQuestion.id), true);
  const reportHtml = dom.getElementById("main").innerHTML;
  assert.ok(reportHtml.indexOf("导入完成") > 0);
  assert.ok(reportHtml.indexOf("小红") > 0);
  assert.ok(dom.storageMap.has("cqp.v1.records"));
  assert.equal(JSON.parse(dom.storageMap.get("cqp.v1.records")).length, 2);

  // 重复导入同一文件：不重复计数 + 冻结文案（F-08）
  CQPUI.__test.setPending({ ok: true, errors: [], warnings: [], payload: validation.payload, fileName: "小红.json" });
  CQPUI.__test.confirmImport();
  assert.equal(CQPUI.state.store.records.length, 2);
  assert.equal(CQPUI.state.store.imports.length, 2);
  assert.ok(
    dom.getElementById("main").innerHTML.indexOf("本次导入 0 条新增记录，2 条为重复记录（未重复计数）") > 0,
    "0 新增时输出冻结文案"
  );

  // 团队对比：成员 2 人
  CQPUI.go("team");
  const teamHtml = dom.getElementById("main").innerHTML;
  assert.ok(teamHtml.indexOf("成员对比") > 0);
  assert.ok(teamHtml.indexOf("小红") > 0);
  assert.ok(teamHtml.indexOf("团队易错题") > 0);

  // 非法文件被拒绝且本地数据不变
  const bad = CQP.validateImport("not json");
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].code, "E_PARSE");
  assert.equal(CQPUI.state.store.records.length, 2);

  fs.rmSync(artifactPath, { force: true });
});

test("UI smoke: mock exam runs, grades and writes mock records", () => {
  const { dom, CQP, CQPUI } = bootApp();
  CQPUI.state.store.meta.nickname = "小明";
  CQP.touchMeta(CQPUI.state.store, { nickname: "小明" }, CQP.isoNow());
  CQPUI.render();

  CQPUI.go("mock");
  const setupHtml = dom.getElementById("main").innerHTML;
  assert.ok(setupHtml.indexOf("100 题") > 0);
  assert.ok(setupHtml.indexOf("60 分钟") > 0);

  CQPUI.__test.action("mock-start");
  const mock = CQPUI.__test.mockState();
  assert.equal(mock.phase, "running");
  const poolSize = CQP.candidates({ bank: CQP.__test.bank }).length;
  assert.equal(mock.paper.questionIds.length, Math.min(100, poolSize));
  assert.equal(new Set(mock.paper.questionIds).size, mock.paper.questionIds.length);
  assert.ok(dom.getElementById("main").innerHTML.indexOf("题号面板") > 0);

  // 离开模拟赛需要二次确认（守卫弹窗）
  CQPUI.go("home");
  assert.ok(dom.getElementById("modalRoot").innerHTML.indexOf("正在模拟赛中") > 0);
  assert.equal(CQPUI.state.page, "mock");

  // 作答两题后交卷
  const firstId = mock.paper.questionIds[0];
  const firstQuestion = CQP.questionById(CQP.getBank(), firstId);
  dom.register("#mockBlank", null);
  if (firstQuestion.options.length > 0) dom.setChecked(firstQuestion.answer.slice());
  else {
    const input = dom.makeElement("input");
    input.value = fullWidth(firstQuestion.answer[0]);
    dom.register("#mockBlank", input);
  }
  CQPUI.__test.action("mock-next");
  assert.ok(mock.responses[firstId].elapsedMs >= 0, "切换题目时结算用时");
  assert.ok(mock.responses[firstId].myAnswer.length > 0, "全角填空在模拟赛中也被接受");

  // 第二题按题型作答（填空用文本框，选择题用勾选）
  const secondId = mock.paper.questionIds[1];
  const secondQuestion = CQP.questionById(CQP.getBank(), secondId);
  if (secondQuestion.options.length > 0) {
    dom.setChecked([secondQuestion.options[0].key]);
  } else {
    const input = dom.makeElement("input");
    input.value = "模拟赛答案";
    dom.register("#mockBlank", input);
  }
  CQPUI.__test.action("mock-next");
  assert.ok(mock.responses[secondId].myAnswer.length > 0, "第二题已作答");

  CQPUI.__test.submitMock(false);
  assert.equal(mock.phase, "result");
  assert.equal(CQPUI.state.store.sessions.length, 1);
  const session = CQPUI.state.store.sessions[0];
  assert.equal(session.nickname, "小明");
  assert.equal(session.result.maxScore, 100);
  assert.equal(session.result.score, session.result.correctCount);
  assert.deepEqual(Object.keys(session.result.byType), ["blank", "multiple", "single", "judge"]);
  assert.equal(session.result.rankKey.length, 6);
  assert.equal(session.result.rankKey[0], session.result.score);
  assert.equal(session.result.rankKey[1] <= 0, true);

  const resultHtml = dom.getElementById("main").innerHTML;
  assert.ok(resultHtml.indexOf("分项成绩（填空 → 多选 → 单选 → 判断）") > 0);
  assert.ok(resultHtml.indexOf("rankKey") > 0);
  assert.ok(resultHtml.indexOf("全部 100 题（逐题改信心）") > 0, "成绩页给出全部题目的逐题信心入口");

  // F-04：成绩页渲染 paper.distribution 的实际抽题分布
  assert.ok(resultHtml.indexOf("本次抽题分布（实际值）") > 0, "成绩页含抽题分布");
  const distByType = mock.paper.distribution.byType;
  const distByChapter = mock.paper.distribution.byChapter;
  assert.ok(resultHtml.indexOf(">" + distByType.single + "<") > 0, "分布含单选实际值");
  assert.ok(resultHtml.indexOf(">" + distByChapter.C01 + "<") > 0, "分布含 C01 实际值");

  // 模拟赛记录写入统计（mode=mock，不自动进错题本）
  const mockRecords = CQPUI.state.store.records.filter((record) => record.mode === "mock");
  assert.ok(mockRecords.length >= 1);
  assert.equal(mockRecords[0].sessionId, session.sessionId);
  assert.equal(Object.keys(CQPUI.state.store.wrongbook).length, 0, "模拟赛不自动写错题本");

  // 成绩页提供「把本次错题加入错题本」
  CQPUI.__test.action("mock-wrong-to-book");
  const wrongbookKeys = Object.keys(CQPUI.state.store.wrongbook);
  const wrongCount = session.questionIds.filter((qid) => !session.responses[qid].correct).length;
  assert.equal(wrongbookKeys.length > 0 || wrongCount === 0, true);

  // F-05：成绩页逐题改信心（写回 session.responses，按三色重算；错题本按 8.3 更新连续计数）
  const wrongQids = session.questionIds.filter((qid) => !session.responses[qid].correct);
  if (wrongQids.length > 0) {
    const targetQid = wrongQids[0];
    assert.equal(session.responses[targetQid].confidence, "confident");
    CQPUI.__test.setMockConfidence(targetQid, "guessed");
    assert.equal(session.responses[targetQid].confidence, "guessed", "信心写回 session.responses");
    assert.equal(
      CQP.color({ correct: session.responses[targetQid].correct, confidence: session.responses[targetQid].confidence }),
      "red",
      "答错改信心仍为红"
    );
    const entryBefore = CQPUI.state.store.wrongbook[targetQid];
    assert.ok(entryBefore, "该题已在错题本中（上一步加入）");
    CQPUI.__test.setMockConfidence(targetQid, "confident");
    assert.equal(session.responses[targetQid].confidence, "confident");
    assert.equal(typeof CQPUI.state.store.wrongbook[targetQid].confidentStreak, "number", "已在错题本的题更新连续计数");
    assert.ok(JSON.parse(dom.storageMap.get("cqp.v1.sessions")).length === 1, "信心修改随会话落盘");
    // 不在错题本的题改信心不会把题塞进错题本
    const outsideQid = session.questionIds.filter((qid) => !CQPUI.state.store.wrongbook[qid] && !session.responses[qid].correct)[0];
    if (outsideQid) {
      CQPUI.__test.setMockConfidence(outsideQid, "guessed");
      assert.equal(CQPUI.state.store.wrongbook[outsideQid], undefined, "模拟赛改信心不自动写错题本");
    }
  }

  // F-05b：成绩页为「全部题目」（含答对题）渲染同一 setMockConfidence 切换
  const correctQids = session.questionIds.filter((qid) => session.responses[qid].correct);
  assert.ok(correctQids.length > 0, "本次模拟赛至少有一道答对的题");
  const toggleCount = resultHtml.split('data-act="mock-conf"').length - 1;
  assert.equal(toggleCount, 2 * session.questionIds.length, "全部 100 题各有一套（有把握/带猜测）切换");
  const correctQid = correctQids[0];
  assert.ok(resultHtml.indexOf('data-qid="' + correctQid + '" data-conf="guessed"') > 0, "答对题也能改信心");

  // 答对题标「带猜测」：黄色 + 按 8.3 入册 + 掌握指数按 0.5 计权
  const recordsForQid = () => CQPUI.state.store.records.filter((record) => record.qid === correctQid && record.mode === "mock");
  assert.equal(recordsForQid().length, 1, "本次模拟赛该题只有 1 条作答记录");
  assert.equal(CQP.masteryOfQuestion(recordsForQid(), correctQid).index, 100, "有把握答对按 1.0 计权");
  CQPUI.__test.setMockConfidence(correctQid, "guessed");
  assert.equal(session.responses[correctQid].confidence, "guessed");
  assert.equal(recordsForQid().length, 1, "改信心是原地更新，不新增记录");
  assert.equal(recordsForQid()[0].confidence, "guessed", "作答记录信心同步更新");
  assert.equal(recordsForQid()[0].color, "yellow");
  assert.equal(CQP.masteryOfQuestion(recordsForQid(), correctQid).index, 50, "猜对按 0.5 计权");
  const guessedEntry = CQPUI.state.store.wrongbook[correctQid];
  assert.ok(guessedEntry, "不在册的猜对题按 8.3 入册");
  assert.equal(guessedEntry.state, "active");
  assert.equal(guessedEntry.lastWrongAt, null, "仅因猜对入册：lastWrongAt 为 null（黄）");
  assert.ok(dom.getElementById("main").innerHTML.indexOf('data-qid="' + correctQid + '" data-conf="guessed"') > 0, "改信心后页面重渲染");

  // 再改回「有把握」：出册 + 按 1.0 计权（回到改信心之前的错题本状态）
  CQPUI.__test.setMockConfidence(correctQid, "confident");
  assert.equal(CQPUI.state.store.wrongbook[correctQid], undefined, "撤回本次计入并出册");
  assert.equal(recordsForQid()[0].confidence, "confident");
  assert.equal(recordsForQid()[0].color, "green");
  assert.equal(CQP.masteryOfQuestion(recordsForQid(), correctQid).index, 100, "再改回有把握按 1.0 计权");
  assert.equal(recordsForQid().length, 1, "连续回改仍只保留 1 条记录");

  // 绿↔黄 来回切换仍幂等（入册→出册→入册）
  CQPUI.__test.setMockConfidence(correctQid, "guessed");
  CQPUI.__test.setMockConfidence(correctQid, "confident");
  CQPUI.__test.setMockConfidence(correctQid, "guessed");
  assert.equal(recordsForQid().length, 1, "多次回改不重复计数");
  assert.equal(Object.keys(CQPUI.state.store.wrongbook).filter((qid) => qid === correctQid).length, 1);
  assert.equal(CQPUI.state.store.wrongbook[correctQid].state, "active");
  CQPUI.__test.setMockConfidence(correctQid, "confident");
  assert.equal(CQPUI.state.store.wrongbook[correctQid], undefined);

  // 再来一次回到确认页
  CQPUI.__test.action("mock-again");
  assert.ok(dom.getElementById("main").innerHTML.indexOf("模拟选拔赛") > 0);

  fs.rmSync(artifactPath, { force: true });
});

test("UI smoke: repair guards (range text, part filter, sorting, danger zone)", () => {
  const { dom, CQP, CQPUI } = bootApp();
  CQPUI.state.store.meta.nickname = "小明";
  CQP.touchMeta(CQPUI.state.store, { nickname: "小明" }, CQP.isoNow());
  CQPUI.render();

  // F-11：清空数据入口不在首页，而在校对页的危险操作区
  CQPUI.go("home");
  const homeHtml = dom.getElementById("main").innerHTML;
  assert.equal(homeHtml.indexOf('data-act="clear-data"'), -1, "首页不再直接暴露清空数据");
  assert.ok(homeHtml.indexOf("数据维护与危险操作") > 0);
  CQPUI.go("review");
  const reviewHtml = dom.getElementById("main").innerHTML;
  assert.ok(reviewHtml.indexOf("危险操作区") > 0);
  assert.ok(reviewHtml.indexOf('data-act="clear-data"') > 0);

  // F-07：起始日期晚于结束日期 -> 冻结文案，且不出现内部异常消息
  CQPUI.go("io");
  CQPUI.state.io.scope = "range";
  CQPUI.state.io.from = "2026-10-06";
  CQPUI.state.io.to = "2026-10-05";
  CQPUI.render();
  const ioHtml = dom.getElementById("main").innerHTML;
  assert.ok(ioHtml.indexOf("起始日期不能晚于结束日期") > 0, "导出页显示冻结文案");
  assert.equal(ioHtml.indexOf("must not be later than"), -1, "不暴露内部异常消息");
  assert.ok(ioHtml.indexOf('data-act="export" disabled') > 0, "起始晚于结束时禁止导出");

  CQPUI.state.statsRange.scope = "range";
  CQPUI.state.statsRange.from = "2026-10-06";
  CQPUI.state.statsRange.to = "2026-10-05";
  CQPUI.go("stats");
  const statsHtml = dom.getElementById("main").innerHTML;
  assert.ok(statsHtml.indexOf("起始日期不能晚于结束日期") > 0, "统计页显示冻结文案");
  assert.equal(statsHtml.indexOf("must not be later than"), -1);
  CQPUI.state.statsRange.scope = "all";
  CQPUI.state.io.scope = "day";
  CQPUI.state.io.from = "2026-10-05";
  CQPUI.state.io.to = "2026-10-05";

  // F-03：P5 每题明细含「有把握对」列
  CQPUI.go("stats");
  assert.ok(dom.getElementById("main").innerHTML.indexOf("有把握对") > 0, "明细表含有把握对列");

  // F-09：部分节点可勾选，candidatePool 按 partCode 过滤
  CQPUI.go("setup");
  assert.ok(dom.getElementById("main").innerHTML.indexOf('data-act="sel-part"') > 0, "部分节点有勾选框");
  const allPool = CQPUI.__test.candidatePool().length;
  CQPUI.state.sel.parts = ["B"];
  const basePool = CQPUI.__test.candidatePool().length;
  const expectedBase = CQP.__test.bank.questions.filter((q) => q.partCode === "B" && q.answerStatus === "ok").length;
  assert.equal(basePool, expectedBase, "基础题部分命中数 = partCode=B 的可答题目数");
  assert.ok(basePool < allPool, "部分过滤确实缩小候选池");
  CQPUI.state.sel.chapters = ["C05"];
  assert.equal(CQPUI.__test.candidatePool().length, 0, "基础题 ∩ 密码学 = 空候选");
  assert.equal(JSON.stringify(CQPUI.__test.effectiveChapters()), JSON.stringify(["__none__"]));
  CQPUI.state.sel.parts = [];
  CQPUI.state.sel.chapters = [];
  assert.equal(CQPUI.__test.candidatePool().length, allPool);

  // F-10：总览/明细表列排序 + P5 → P7 按钮
  CQPUI.go("stats");
  const statsPage = dom.getElementById("main").innerHTML;
  assert.ok(statsPage.indexOf('data-page="io"') > 0, "P5 有跳转 P7 的按钮");
  assert.ok(statsPage.indexOf('data-act="stats-sort"') > 0, "表头可排序");
  assert.equal(JSON.stringify(CQPUI.state.statsSort.detail), JSON.stringify({ key: "attempts", dir: "desc" }));
  CQPUI.__test.action("stats-sort", fakeActionElement({ "data-table": "detail", "data-key": "qid" }));
  assert.equal(JSON.stringify(CQPUI.state.statsSort.detail), JSON.stringify({ key: "qid", dir: "asc" }));
  CQPUI.__test.action("stats-sort", fakeActionElement({ "data-table": "detail", "data-key": "qid" }));
  assert.equal(JSON.stringify(CQPUI.state.statsSort.detail), JSON.stringify({ key: "qid", dir: "desc" }));
  CQPUI.__test.action("stats-sort", fakeActionElement({ "data-table": "chapter", "data-key": "accuracy" }));
  assert.equal(JSON.stringify(CQPUI.state.statsSort.chapter), JSON.stringify({ key: "accuracy", dir: "desc" }));
  assert.ok(dom.getElementById("main").innerHTML.indexOf("▼") > 0, "表头显示排序指示");

  fs.rmSync(artifactPath, { force: true });
});

test("UI smoke: t20 regressions (today-correct sum, manual removal survives unload, sel defense)", () => {
  const { dom, CQP, CQPUI } = bootApp();
  CQPUI.state.store.meta.nickname = "小明";
  CQP.touchMeta(CQPUI.state.store, { nickname: "小明" }, CQP.isoNow());
  CQPUI.render();
  const main = () => dom.getElementById("main").innerHTML;
  const bank = CQP.__test.bank;

  // ① 首页「今日正确」必须是数值和：空记录 → 0；1 有把握对 + 2 猜对 + 1 错 → 3（不是 12）
  CQPUI.go("home");
  assert.ok(main().indexOf('<div class="k">今日正确</div><div class="v">0</div>') > 0, "空记录显示 0");
  assert.equal(main().indexOf('<div class="k">今日正确</div><div class="v">00</div>'), -1, "不出现字符串相连的 00");

  const singles = bank.questions.filter((q) => q.sectionType === "single" && q.options.length === 4);
  const build = (question, confidence, answer) =>
    CQP.makeRecord({
      question,
      myAnswer: answer,
      confidence,
      elapsedMs: 10,
      mode: "practice_random",
      nickname: "小明",
      bankVersion: bank.bankVersion,
      appVersion: CQP.VERSION,
      nowISO: CQP.isoNow(),
    });
  const todayRecords = [
    build(singles[0], "confident", singles[0].answer.slice()),
    build(singles[1], "guessed", singles[1].answer.slice()),
    build(singles[2], "guessed", singles[2].answer.slice()),
    build(singles[3], "confident", [singles[3].options.map((o) => o.key).find((key) => singles[3].answer.indexOf(key) < 0)]),
  ];
  assert.equal(todayRecords[3].correct, false, "第 4 条是答错记录");
  CQPUI.state.store.records = todayRecords;
  CQPUI.render();
  assert.ok(main().indexOf('<div class="k">今日正确</div><div class="v">3</div>') > 0, "1 有把握对 + 2 猜对 = 3");
  assert.equal(main().indexOf('<div class="k">今日正确</div><div class="v">12</div>'), -1, "不出现字符串相连的 12");
  CQPUI.state.store.records = [];
  CQPUI.state.store.wrongbook = {};

  // ② F-01：练习答错 → 错题本手动移出 → beforeunload/pagehide/flush 后仍为 removed(manual)
  const target = singles[0];
  const wrongKey = target.options.map((o) => o.key).find((key) => target.answer.indexOf(key) < 0);
  CQPUI.__test.startPractice("practice_chapter", [target], { title: "F-01" });
  dom.setChecked([wrongKey]);
  CQPUI.__test.action("prac-submit");
  assert.equal(CQPUI.state.store.wrongbook[target.id].state, "active", "答错即时进错题本");
  CQPUI.go("wrongbook");
  assert.ok(main().indexOf('data-act="wrong-remove"') > 0, "错题本页可移出");
  CQPUI.__test.action("wrong-remove", fakeActionElement({ "data-qid": target.id }));
  assert.equal(CQPUI.state.store.wrongbook[target.id].state, "removed");
  assert.equal(CQPUI.state.store.wrongbook[target.id].removedReason, "manual");
  const recordsBeforeFlush = CQPUI.state.store.records.length;

  dom.fireWindow("beforeunload");
  dom.fireWindow("pagehide");
  CQPUI.__test.flushPractice();

  assert.equal(CQPUI.state.store.wrongbook[target.id].state, "removed", "卸载兜底不得回滚手动移出");
  assert.equal(CQPUI.state.store.wrongbook[target.id].removedReason, "manual");
  assert.equal(CQPUI.state.store.records.length, recordsBeforeFlush, "兜底只落库记录、不重复计数");
  const persisted = JSON.parse(dom.storageMap.get("cqp.v1.wrongbook"));
  assert.equal(persisted[target.id].state, "removed", "localStorage 中仍为 removed");
  assert.equal(persisted[target.id].removedReason, "manual");
  assert.equal(CQP.wrongbookCountActive(CQPUI.state.store.wrongbook), 0, "在册错题数不回升（0）");

  CQPUI.state.wrongFilter.state = "removed";
  CQPUI.render();
  assert.ok(main().indexOf(target.id) > 0, "「已移出」视图非空");
  CQPUI.state.wrongFilter.state = "active";
  CQPUI.render();
  assert.ok(main().indexOf("暂无符合条件的错题") > 0, "「在册」视图为空");

  // ②-b 同类第二处：回到练习页改信心，也不得把手动移出顶回在册
  CQPUI.go("practice");
  CQPUI.__test.action("conf", fakeActionElement({ "data-conf": "confident" }));
  assert.equal(CQPUI.state.store.wrongbook[target.id].state, "removed", "改信心不覆盖用户的手动移出");

  // ②-c 同类第三处（模拟赛复盘）：手动移出后成绩页改「有把握」不得复活条目
  CQPUI.go("mock");
  CQPUI.__test.action("mock-start");
  const mock = CQPUI.__test.mockState();
  const mockQid = mock.paper.questionIds.filter((qid) => !CQPUI.state.store.wrongbook[qid])[0];
  const mockQuestion = CQP.questionById(CQP.getBank(), mockQid);
  if (mockQuestion.options.length > 0) dom.setChecked(mockQuestion.answer.slice());
  else {
    const input = dom.makeElement("input");
    input.value = mockQuestion.answer[0];
    dom.register("#mockBlank", input);
  }
  CQPUI.__test.action("mock-next");
  CQPUI.__test.submitMock(false);
  CQPUI.__test.setMockConfidence(mockQid, "guessed");
  assert.equal(CQPUI.state.store.wrongbook[mockQid].state, "active", "答对+带猜测按 8.3 入册");
  CQPUI.__test.action("wrong-remove", fakeActionElement({ "data-qid": mockQid }));
  assert.equal(CQPUI.state.store.wrongbook[mockQid].removedReason, "manual");
  CQPUI.__test.setMockConfidence(mockQid, "confident");
  assert.equal(CQPUI.state.store.wrongbook[mockQid].state, "removed", "模拟赛复盘改信心不覆盖手动移出");

  // ③ O-6：外部替换 S.sel（缺 parts/types/chapters/tags、无 count）时 renderSetup 不抛错
  const savedSel = CQPUI.state.sel;
  CQPUI.state.sel = { mode: "practice_chapter" };
  let threw = null;
  try {
    CQPUI.go("setup");
  } catch (err) {
    threw = err;
  }
  assert.equal(threw, null, "S.sel 缺字段时不抛错");
  assert.ok(main().indexOf("分类练习设置") > 0, "分类设置页仍能渲染");
  let interactionThrew = null;
  try {
    CQPUI.__test.action("sel-tag", fakeActionElement({ "data-tag": "密码法" }));
    dom.fire(dom.getElementById("main"), "change", { target: { closest: () => ({ getAttribute: () => "sel-part", value: "B", checked: true }) } });
  } catch (err) {
    interactionThrew = err;
  }
  assert.equal(interactionThrew, null, "缺字段时的交互也不抛错");
  CQPUI.state.sel = savedSel;

  fs.rmSync(artifactPath, { force: true });
});

test("UI smoke: t24 (manual removal is never resurrected by snapshot replays)", () => {
  const { dom, CQP, CQPUI } = bootApp();
  CQPUI.state.store.meta.nickname = "小明";
  CQP.touchMeta(CQPUI.state.store, { nickname: "小明" }, CQP.isoNow());
  CQPUI.render();
  const bank = CQP.__test.bank;
  const persisted = (qid) => JSON.parse(dom.storageMap.get("cqp.v1.wrongbook") || "{}")[qid];
  const stateOf = (qid) => (CQPUI.state.store.wrongbook[qid] ? CQPUI.state.store.wrongbook[qid].state : undefined);
  const reasonOf = (qid) => (CQPUI.state.store.wrongbook[qid] ? CQPUI.state.store.wrongbook[qid].removedReason : undefined);
  const singles = bank.questions.filter((q) => q.sectionType === "single" && q.options.length === 4);
  const wrongKeyOf = (question) => question.options.map((o) => o.key).find((key) => question.answer.indexOf(key) < 0);

  // ① F-01b：练习答错 → 提交 → 手动移出 → 改信心×1 → 「下一题」 → 必须仍为 removed/manual
  const q1 = singles[0];
  CQPUI.__test.startPractice("practice_chapter", [q1], { title: "t24-S1" });
  dom.setChecked([wrongKeyOf(q1)]);
  CQPUI.__test.action("prac-submit");
  assert.equal(stateOf(q1.id), "active", "S1 前置：答错即时入册");
  CQPUI.__test.action("wrong-remove", fakeActionElement({ "data-qid": q1.id }));
  assert.equal(stateOf(q1.id), "removed");
  assert.equal(persisted(q1.id).removedReason, "manual", "S1 前置：localStorage = removed/manual");
  CQPUI.__test.action("conf", fakeActionElement({ "data-conf": "confident" }));
  assert.equal(stateOf(q1.id), "removed", "S1: 改信心×1 不复活");
  CQPUI.__test.action("prac-next");
  assert.equal(stateOf(q1.id), "removed", "S1: 「下一题」不得复活（F-01b）");
  assert.equal(reasonOf(q1.id), "manual", "S1: 移出原因仍为 manual");
  assert.equal(persisted(q1.id).state, "removed", "S1: localStorage 一致（removed）");
  assert.equal(persisted(q1.id).removedReason, "manual", "S1: localStorage 一致（manual）");
  assert.equal(CQP.wrongbookCountActive(CQPUI.state.store.wrongbook), 0, "S1: 在册数 0");

  // ② F-01b 变体：改信心×2 + 「交卷并结算」 → 仍不复活
  const q2 = singles[1];
  CQPUI.__test.startPractice("practice_chapter", [q2], { title: "t24-S2" });
  dom.setChecked([wrongKeyOf(q2)]);
  CQPUI.__test.action("prac-submit");
  CQPUI.__test.action("wrong-remove", fakeActionElement({ "data-qid": q2.id }));
  assert.equal(stateOf(q2.id), "removed");
  CQPUI.__test.action("conf", fakeActionElement({ "data-conf": "confident" }));
  CQPUI.__test.action("conf", fakeActionElement({ "data-conf": "confident" }));
  assert.equal(stateOf(q2.id), "removed", "S2: 改信心×2 不复活（F-01b 变体）");
  CQPUI.__test.action("prac-finish"); // 「交卷并结算」= commitItem + 二次确认弹窗
  assert.equal(stateOf(q2.id), "removed", "S2: 「交卷并结算」不得复活");
  assert.equal(persisted(q2.id).state, "removed", "S2: localStorage 一致（removed）");
  assert.equal(persisted(q2.id).removedReason, "manual", "S2: localStorage 一致（manual）");

  // ③ F-01c：模拟赛「一键加入错题本」入册 → 手动移出 → 成绩页**首次**改信心 → 不得复活
  CQPUI.go("mock");
  CQPUI.__test.action("mock-start");
  const mock = CQPUI.__test.mockState();
  const mockQid = mock.paper.questionIds.filter((qid) => !CQPUI.state.store.wrongbook[qid])[0];
  const mockQuestion = CQP.questionById(CQP.getBank(), mockQid);
  if (mockQuestion.options.length > 0) dom.setChecked([wrongKeyOf(mockQuestion)]);
  else {
    const input = dom.makeElement("input");
    input.value = "t24-wrong-answer";
    dom.register("#mockBlank", input);
  }
  CQPUI.__test.action("mock-next");
  CQPUI.__test.submitMock(false);
  assert.equal(CQPUI.state.store.wrongbook[mockQid], undefined, "S3 前置：模拟赛不自动写错题本");
  CQPUI.__test.action("mock-wrong-to-book"); // 显式入册（不建立信心快照）
  assert.equal(stateOf(mockQid), "active", "S3 前置：一键加入错题本入册");
  CQPUI.__test.action("wrong-remove", fakeActionElement({ "data-qid": mockQid }));
  assert.equal(stateOf(mockQid), "removed");
  CQPUI.__test.setMockConfidence(mockQid, "confident"); // 快照懒建立 → 必须视为不在册
  assert.equal(stateOf(mockQid), "removed", "S3: 成绩页首次改信心不得复活（F-01c）");
  assert.equal(persisted(mockQid).state, "removed", "S3: localStorage 一致（removed）");
  assert.equal(persisted(mockQid).removedReason, "manual", "S3: localStorage 一致（manual）");

  // ④ 正向（不得放宽）：新一次作答判错 → 该题重新入册
  CQPUI.__test.startPractice("practice_chapter", [q1], { title: "t24-P1" });
  dom.setChecked([wrongKeyOf(q1)]);
  CQPUI.__test.action("prac-submit");
  assert.equal(stateOf(q1.id), "active", "P1: 新一次作答判错必须重新入册");
  assert.equal(CQPUI.state.store.wrongbook[q1.id].lastWrongAt !== null, true, "P1: lastWrongAt 已更新");
  assert.equal(persisted(q1.id).state, "active", "P1: localStorage 一致（active）");

  // ⑤ 正向（不得放宽）：显式「重新加入错题本」与模拟赛「一键加入错题本」仍能重新入册
  CQPUI.__test.action("wrong-remove", fakeActionElement({ "data-qid": q1.id }));
  assert.equal(stateOf(q1.id), "removed");
  CQPUI.__test.action("wrong-readd", fakeActionElement({ "data-qid": q1.id }));
  assert.equal(stateOf(q1.id), "active", "P2: 手动「重新加入错题本」必须生效");
  assert.equal(persisted(q1.id).state, "active", "P2: localStorage 一致（active）");
  CQPUI.__test.action("wrong-remove", fakeActionElement({ "data-qid": mockQid }));
  assert.equal(stateOf(mockQid), "removed");
  CQPUI.__test.action("mock-wrong-to-book");
  assert.equal(stateOf(mockQid), "active", "P2: 模拟赛「一键加入错题本」必须生效");
  assert.equal(persisted(mockQid).state, "active", "P2: localStorage 一致（active）");

  fs.rmSync(artifactPath, { force: true });
});
