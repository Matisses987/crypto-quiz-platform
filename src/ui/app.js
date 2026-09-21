// 密码赛刷题平台 · 界面逻辑（无框架、无外链；所有纯逻辑调用 CQP）
(function () {
  "use strict";

  var CQP = window.CQP;
  var S = {
    store: null,
    bankRaw: null,
    bank: null,
    bankValidation: null,
    tagIndex: {},
    tagCounts: {},
    qById: new Map(),
    page: "home",
    storageOk: true,
    // t41 F-03：本地数据 schema 不兼容 / JSON 损坏时置 true —— 完全只读：persist() 直接 return，
    // 导出入口改读磁盘原始数据（抢救导出），危险区「清空本地数据」也被拦下。
    storageBlocked: false,
    blockedCode: "",
    blockedSchemaVersion: "",
    blockedRescue: null,
    sel: { mode: "practice_chapter", parts: [], chapters: [], types: [], tags: [], count: 20 },
    practice: null,
    mock: null,
    wrongFilter: { state: "active", chapter: "", type: "", tag: "", color: "" },
    statsRange: { scope: "day", from: "", to: "" },
    statsNick: "",
    statsSort: {
      chapter: { key: "chapterCode", dir: "asc" },
      type: { key: "order", dir: "asc" },
      detail: { key: "attempts", dir: "desc" },
    },
    teamNick: "",
    reviewFilter: { kind: "flagged", chapter: "", keyword: "" },
    reviewLimit: 60,
    detailLimit: 60,
    io: { scope: "day", from: "", to: "", pending: null, report: null },
    mockTimer: null,
  };

  // ---------------------------------------------------------------- 基础工具
  function $(id) { return document.getElementById(id); }

  function esc(value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, function (ch) {
      if (ch === "&") return "&amp;";
      if (ch === "<") return "&lt;";
      if (ch === ">") return "&gt;";
      if (ch === '"') return "&quot;";
      return "&#39;";
    });
  }

  function today() { return CQP.localDateOf(CQP.isoNow()); }

  // 冻结文案（规格 11.2.5 / 9.2）：界面只呈现这些固定文案，不暴露内部异常消息
  var RANGE_TEXT = "起始日期不能晚于结束日期";
  var IMPORT_NO_NEW_PREFIX = "本次导入 0 条新增记录，";

  function nick() {
    var name = S.store && S.store.meta ? S.store.meta.nickname : "";
    return name && name.length > 0 ? name : "未命名";
  }

  function bankVersion() {
    return S.bankRaw && S.bankRaw.bankVersion ? S.bankRaw.bankVersion : "unknown";
  }

  function trim(value, max) {
    var text = String(value === null || value === undefined ? "" : value).replace(/\s+/g, " ").trim();
    if (max && text.length > max) return text.slice(0, max) + "…";
    return text;
  }

  function plural(count, unit) { return count + " " + unit; }

  function toast(message, ms) {
    var box = $("toast");
    box.textContent = message;
    box.classList.remove("hidden");
    window.clearTimeout(box.__timer);
    box.__timer = window.setTimeout(function () { box.classList.add("hidden"); }, ms || 2600);
  }

  function banner(kind, message) {
    var box = $("banner");
    if (!message) { box.classList.add("hidden"); return; }
    box.className = "banner " + (kind || "error");
    box.textContent = message;
  }

  function closeModal() {
    $("modalRoot").innerHTML = "";
  }

  function openModal(innerHtml, onReady) {
    var root = $("modalRoot");
    root.innerHTML = '<div class="modal-mask"><div class="modal">' + innerHtml + "</div></div>";
    if (typeof onReady === "function") onReady(root.firstChild.firstChild);
    return root.firstChild.firstChild;
  }

  function confirmBox(title, message, onOk, okLabel) {
    openModal(
      "<h3>" + esc(title) + "</h3><div>" + message + '</div><div class="actions">' +
        '<button data-act="modal-close">取消</button>' +
        '<button class="danger" data-act="modal-ok">' + esc(okLabel || "确认") + "</button></div>",
      function (box) {
        box.querySelector('[data-act="modal-ok"]').addEventListener("click", function () {
          closeModal();
          onOk();
        });
        box.querySelector('[data-act="modal-close"]').addEventListener("click", closeModal);
      }
    );
  }

  function infoBox(title, message) {
    openModal(
      "<h3>" + esc(title) + "</h3><div>" + message + '</div><div class="actions">' +
        '<button class="primary" data-act="modal-close">知道了</button></div>',
      function (box) { box.querySelector('[data-act="modal-close"]').addEventListener("click", closeModal); }
    );
  }

  function downloadText(fileName, text) {
    var blob = new Blob([text], { type: "application/json;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  // 读取原始 meta 里的 schemaVersion（不依赖异常消息，只呈现冻结文案）
  function detectedSchemaVersion() {
    try {
      var backend = CQP.storage.backend();
      if (!backend || !backend.getItem) return "?";
      var rawMeta = backend.getItem(CQP.STORAGE_KEYS.meta);
      if (!rawMeta) return "?";
      var parsed = JSON.parse(rawMeta);
      return parsed && typeof parsed.schemaVersion === "string" ? parsed.schemaVersion : "?";
    } catch (err) {
      return "?";
    }
  }

  // ---------------------------------------------------------------- 初始化
  function initStorage() {
    var probe = CQP.storage.probe();
    S.storageOk = probe.available;
    if (!probe.available) {
      banner("error", "本地存储不可用，数据无法保存，请立即导出备份（当前会话仍可答题，刷新即丢失）");
    }
    try {
      S.store = CQP.storage.load();
    } catch (err) {
      S.store = CQP.emptyStore();
      // t41 F-03：加载失败 ⇒ 进入完全只读的「抢救模式」。绝不把空内存态写回磁盘
      //（否则一次刷新/卸载就会静默抹掉用户全部数据），并让导出入口改读磁盘原始数据。
      S.storageBlocked = true;
      S.blockedCode = err && err.code ? String(err.code) : "E_LOAD";
      S.blockedSchemaVersion = detectedSchemaVersion();
      if (err && err.code === "E_VERSION") {
        banner(
          "error",
          "数据版本不兼容（发现 " + S.blockedSchemaVersion + "，程序支持 " + CQP.STORE_SCHEMA_VERSION +
            "）。本次运行不会写入任何数据，你的数据仍保存在浏览器中（本地数据未被改动）；请先导出备份（导出入口已切换为抢救模式，会直接读取浏览器里的原始数据），再使用对应版本的程序打开。"
        );
      } else if (err && err.code === "E_STORE_PARSE") {
        banner(
          "error",
          "本地数据损坏（JSON 解析失败）。本次运行不会写入任何数据，你的数据仍保存在浏览器中（本地数据未被改动）；请先导出备份（无法解析的内容会以原始字符串一并导出）后再排查。"
        );
      } else {
        banner("error", "本地数据读取失败。本次运行不会写入任何数据，你的数据仍保存在浏览器中（本地数据未被改动）；请先导出备份。");
      }
    }
    CQP.setStore(S.store);
    S.statsRange.from = today();
    S.io.from = today();
    S.io.to = today();
  }

  function initBank() {
    var raw = null;
    try {
      raw = JSON.parse($("bank-data").textContent);
    } catch (err) {
      raw = null;
    }
    if (!raw) {
      banner("error", "内嵌题库缺失或损坏，无法开始练习；请重新获取成品文件。");
      return false;
    }
    S.bankRaw = raw;
    CQP.setBank(raw);
    S.bankValidation = CQP.validateBank(raw, { fixture: raw.fixture === true });
    refreshBank();
    return true;
  }

  function refreshBank() {
    S.bank = CQP.effectiveBank() || S.bankRaw;
    S.tagIndex = CQP.tagIndex(S.bank);
    S.tagCounts = CQP.tagCounts(S.bank);
    S.qById = CQP.questionIndex(S.bank);
  }

  function persist() {
    CQP.setStore(S.store);
    // t41 F-03：只读抢救模式——绝不写回磁盘（含卸载兜底 flushPractice 触发的这次）
    if (S.storageBlocked) return;
    if (!S.storageOk) return;
    var res = CQP.storage.save(S.store);
    if (!res.ok) {
      S.storageOk = false;
      banner("error", res.error.message);
    }
  }

  // t41 F-03：阻断态文案与抢救导出的统一入口 ------------------------------------
  function blockedReasonText() {
    if (S.blockedCode === "E_VERSION") return "数据版本不兼容（发现 " + (S.blockedSchemaVersion || "?") + "，程序支持 " + CQP.STORE_SCHEMA_VERSION + "）";
    if (S.blockedCode === "E_STORE_PARSE") return "本地数据损坏（JSON 解析失败）";
    return "本地数据读取失败";
  }

  // 从磁盘原样读取 cqp.v1.* 组装抢救导出（缓存，只读模式下磁盘内容不会再变）
  function rescuePayload() {
    if (S.blockedRescue) return S.blockedRescue;
    var raw = CQP.storage.readRaw ? CQP.storage.readRaw() : {};
    var payload = CQP.rescueExport({
      raw: raw,
      bankVersion: bankVersion(),
      nowISO: CQP.isoNow(),
      reason: S.blockedCode || "E_LOAD",
      detectedSchemaVersion: S.blockedSchemaVersion || detectedSchemaVersion(),
    });
    S.blockedRescue = payload;
    return payload;
  }

  function rescueFileName() {
    var payload = rescuePayload();
    return CQP.exportFileName({ nickname: payload.exportedBy.nickname, scope: "all", nowISO: CQP.isoNow() }).replace("_全部_", "_抢救导出_");
  }

  function myRecords() {
    var name = nick();
    return S.store.records.filter(function (record) { return record.nickname === name; });
  }

  function recordsOf(qid) {
    return myRecords().filter(function (record) { return record.qid === qid; });
  }

  function practicedQids() {
    var set = new Set();
    for (var i = 0; i < S.store.records.length; i += 1) set.add(S.store.records[i].qid);
    return set;
  }

  function masteryText(index, insufficient) {
    if (insufficient) return '<span class="muted">样本不足</span>';
    return "<b>" + (index === null ? "—" : index.toFixed(1)) + "</b>";
  }

  function colorBadge(color, extra) {
    var names = { green: "正确", yellow: "正确（猜测）", red: "错误" };
    return '<span class="badge ' + color + '">' + (extra || names[color] || color) + "</span>";
  }

  // ---------------------------------------------------------------- 昵称
  function ensureNickname() {
    if (S.store.meta.nickname && S.store.meta.nickname.trim().length > 0) return;
    openModal(
      "<h3>请填写昵称</h3><p class=\"muted\">昵称用于导出学习记录与他人合并统计（1～20 字符）；修改昵称不会改变历史记录归属。</p>" +
        '<input type="text" id="nickInput" maxlength="20" style="width:100%" placeholder="例如：小明">' +
        '<div class="actions"><button class="primary" data-act="nick-save">保存并开始</button></div>',
      function (box) {
        var input = box.querySelector("#nickInput");
        input.focus();
        box.querySelector('[data-act="nick-save"]').addEventListener("click", function () {
          var value = input.value.trim().slice(0, 20);
          if (!value) { toast("昵称不能为空"); return; }
          S.store.meta.nickname = value;
          CQP.touchMeta(S.store, { nickname: value }, CQP.isoNow());
          persist();
          closeModal();
          render();
        });
      }
    );
  }

  function changeNickname() {
    openModal(
      "<h3>修改昵称</h3><p class=\"muted\">只改当前昵称；历史记录与错题本仍归属原昵称。</p>" +
        '<input type="text" id="nickInput" maxlength="20" style="width:100%" value="' + esc(S.store.meta.nickname) + '">' +
        '<div class="actions"><button data-act="modal-close">取消</button><button class="primary" data-act="nick-save">保存</button></div>',
      function (box) {
        box.querySelector('[data-act="modal-close"]').addEventListener("click", closeModal);
        box.querySelector('[data-act="nick-save"]').addEventListener("click", function () {
          var value = box.querySelector("#nickInput").value.trim().slice(0, 20);
          if (!value) { toast("昵称不能为空"); return; }
          S.store.meta.nickname = value;
          CQP.touchMeta(S.store, { nickname: value }, CQP.isoNow());
          persist();
          closeModal();
          render();
          toast("昵称已更新；历史记录仍归属原昵称");
        });
      }
    );
  }

  // ---------------------------------------------------------------- 首页 P0
  function renderHome() {
    var all = S.store.records;
    var mine = myRecords();
    var day = today();
    var todayRecords = mine.filter(function (record) { return record.localDate === day; });
    var dayMastery = CQP.masteryOfAttempts(todayRecords);
    var overall = CQP.masteryOverall(mine);
    var activeWrong = CQP.wrongbookCountActive(S.store.wrongbook);
    var overrides = CQP.countOverrides(S.store.overrides);
    var flagged = 0;
    var needsReview = 0;
    var missing = 0;
    for (var i = 0; i < S.bank.questions.length; i += 1) {
      var question = S.bank.questions[i];
      if (CQP.isFlagged(S.store.overrides, question.id)) flagged += 1;
      if (question.needsReview) needsReview += 1;
      if (question.answerStatus !== "ok") missing += 1;
    }
    var sizeKb = Math.round(CQP.storeSize(S.store) / 1024);
    var validationOk = S.bankValidation && S.bankValidation.ok;

    return (
      '<div class="card"><div class="row between"><div><h1>今日学习</h1>' +
      '<div class="muted">昵称：<b>' + esc(nick()) + "</b> ｜ 本地自然日：" + esc(day) + " ｜ 设备：" + esc(S.store.meta.deviceId || "-") + "</div></div>" +
      '<div class="row"><button data-act="nick-edit">修改昵称</button></div></div>' +
      '<div class="kv mt12">' +
      '<div class="item"><div class="k">今日已答</div><div class="v">' + todayRecords.length + "</div></div>" +
      '<div class="item"><div class="k">今日正确</div><div class="v">' + (dayMastery.confidentCorrect + dayMastery.guessedCorrect) + "</div></div>" +
      '<div class="item"><div class="k">今日掌握指数</div><div class="v small">' + masteryText(dayMastery.index, dayMastery.insufficient) + "</div></div>" +
      '<div class="item"><div class="k">累计作答</div><div class="v">' + mine.length + "</div></div>" +
      '<div class="item"><div class="k">全局掌握指数</div><div class="v small">' + masteryText(overall.index, overall.insufficient) + "</div></div>" +
      '<div class="item"><div class="k">错题本（在册）</div><div class="v">' + activeWrong + "</div></div>" +
      "</div></div>" +

      '<div class="card"><h2>快速开始</h2><div class="grid cols4">' +
      entry("setup", "分类练习", "按部分→章→题型或知识点标签随机出题") +
      entry("setup-random", "全库随机", "从 " + S.bank.questions.length + " 题中随机抽题") +
      entry("wrongbook", "错题本", "重练错题、手动移出、查看自动移出记录") +
      entry("stats", "学习统计", "每题对错次数、掌握指数、薄弱榜单") +
      entry("team", "团队对比", "导入队友 JSON，统计团队易错题") +
      entry("io", "导出 / 导入", "按自然日导出，导入后自动合并去重") +
      entry("mock", "模拟选拔赛", "100 题 / 60 分钟 / 100 分 / 到点自动交卷") +
      entry("review", "校对纠错", "标疑问、手动改答案（可随导出共享）") +
      "</div></div>" +

      '<div class="card"><h2>数据与题库</h2><div class="kv">' +
      '<div class="item"><div class="k">应用版本</div><div class="v small">' + esc(CQP.VERSION) + "</div></div>" +
      '<div class="item"><div class="k">题库版本</div><div class="v small">' + esc(bankVersion()) + "</div></div>" +
      '<div class="item"><div class="k">题库题量</div><div class="v small">' + S.bank.questions.length + " 题</div></div>" +
      '<div class="item"><div class="k">作答记录条数</div><div class="v small">' + all.length + " 条（约 " + sizeKb + " KB）</div></div>" +
      '<div class="item"><div class="k">纠错覆盖层</div><div class="v small">' + overrides + " 题（标疑问 " + flagged + "）</div></div>" +
      '<div class="item"><div class="k">每题明细</div><div class="v small">已练 ' + practicedQids().size + " 题</div></div>" +
      "</div>" +
      '<div class="muted mt8">题库自检：' + (validationOk ? "通过（符合冻结契约）" : '<span class="badge red">有数据质量偏差 ' + (S.bankValidation ? S.bankValidation.errors.length : 0) + " 项</span>") +
      "；待校对 " + needsReview + " 题，缺答案 " + missing + " 题（缺答案题不参与出题，可由校对面板补录）。</div>" +
      '<div class="row mt12"><button class="primary" data-act="export-backup">导出全部备份</button>' +
      '<button data-act="io-page">导入队友记录</button>' +
      '<button data-act="go" data-page="review">数据维护与危险操作</button></div>' +
      '<div class="muted mt8">「清空本地数据」等危险操作已移出首页，放在「校对纠错」页底部的危险操作区（仍为二次确认）。</div></div>'
    );
  }

  function entry(page, title, desc) {
    return '<button class="entry" data-act="go" data-page="' + page + '">' + esc(title) + '<span class="desc">' + esc(desc) + "</span></button>";
  }

  // ------------------------------------------------------------ 分类练习 P1
  // 部分（B/P）→ 章节映射：CQP.candidates 只按章节筛选，因此部分条件在这里展开
  function partChapters() {
    // 防御：外部若替换了 S.sel（无 parts 字段）也不抛错（t11 O-2b）
    var parts = Array.isArray(S.sel.parts) ? S.sel.parts : [];
    if (!parts.length) return null;
    return S.bank.chapters
      .filter(function (chapter) { return parts.indexOf(chapter.partCode) >= 0; })
      .map(function (chapter) { return chapter.chapterCode; });
  }

  function effectiveChapters() {
    var parts = partChapters();
    // 防御：外部替换 S.sel 时 chapters 可能缺失（t11 O-6）
    var selected = Array.isArray(S.sel.chapters) ? S.sel.chapters : [];
    if (!parts) return selected.slice();
    if (selected.length === 0) return parts;
    var intersection = selected.filter(function (code) { return parts.indexOf(code) >= 0; });
    // 空交集必须返回「不可能命中」的哨兵，否则空数组会被 candidates 当成「不筛选」
    return intersection.length ? intersection : ["__none__"];
  }

  function candidatePool() {
    var sel = S.sel;
    if (sel.mode === "practice_random") return CQP.candidates({ bank: S.bank });
    return CQP.candidates({ bank: S.bank, chapters: effectiveChapters(), types: sel.types, tags: sel.tags });
  }

  function renderSetup() {
    var sel = S.sel;
    var pool = candidatePool();
    var practiced = practicedQids();
    var isRandom = sel.mode === "practice_random";
    var html = '<div class="card"><h1>分类练习设置</h1>' +
      '<div class="row"><label class="inline"><input type="radio" name="mode" value="practice_chapter" data-act="sel-mode"' + (isRandom ? "" : " checked") + "> 分类练习</label>" +
      '<label class="inline"><input type="radio" name="mode" value="practice_random" data-act="sel-mode"' + (isRandom ? " checked" : "") + "> 全库随机（" + S.bank.questions.length + " 题）</label>" +
      '<span class="muted">出题随机、同一轮内不重复；跳过题不计分。</span></div>' +
      '<div class="row mt12"><label class="inline">题量 <input type="number" id="countInput" data-act="sel-count" min="1" max="' + S.bank.questions.length + '" value="' + (sel.count === undefined || sel.count === null ? 20 : sel.count) + '" style="width:90px"></label>' +
      '<span class="badge blue">命中 ' + pool.length + " 题</span>" +
      '<button class="primary big" data-act="start-practice"' + (pool.length === 0 ? " disabled" : "") + ">开始答题</button></div></div>";

    if (!isRandom) {
      // 防御：外部替换 S.sel 时字段可能缺失（t11 O-6）
      var selectedParts = Array.isArray(sel.parts) ? sel.parts : [];
      var selectedChapters = Array.isArray(sel.chapters) ? sel.chapters : [];
      var selectedTypes = Array.isArray(sel.types) ? sel.types : [];
      var selectedTags = Array.isArray(sel.tags) ? sel.tags : [];
      html += '<div class="split"><div class="card"><h2>三级结构</h2><div class="tree">';
      var parts = [
        { code: "B", name: "基础题" },
        { code: "P", name: "专业题" },
      ];
      for (var p = 0; p < parts.length; p += 1) {
        var part = parts[p];
        var chapters = S.bank.chapters.filter(function (chapter) { return chapter.partCode === part.code; });
        var partTotal = chapters.reduce(function (sum, chapter) { return sum + chapter.chapterTotal; }, 0);
        var partPracticed = chapters.reduce(function (sum, chapter) {
          return sum + chapter.sections.reduce(function (inner, section) {
            return inner + S.bank.questions.filter(function (q) {
              return q.chapterCode === chapter.chapterCode && q.sectionType === section.sectionType && practiced.has(q.id);
            }).length;
          }, 0);
        }, 0);
        html += '<ul><li><label class="inline"><input type="checkbox" data-act="sel-part" value="' + part.code + '"' +
          (selectedParts.indexOf(part.code) >= 0 ? " checked" : "") + "><b>" + esc(part.name) + "</b>（共 " + partTotal + " 题，已练 " + partPracticed + "）</label>";
        html += "<ul>";
        for (var c = 0; c < chapters.length; c += 1) {
          var chapter = chapters[c];
          var chapterPracticed = S.bank.questions.filter(function (q) {
            return q.chapterCode === chapter.chapterCode && practiced.has(q.id);
          }).length;
          html += '<li><label class="inline"><input type="checkbox" data-act="sel-chapter" value="' + chapter.chapterCode + '"' +
            (selectedChapters.indexOf(chapter.chapterCode) >= 0 ? " checked" : "") + "><b>" + esc(chapter.chapterName) + "</b>（" +
            chapter.chapterTotal + " 题，已练 " + chapterPracticed + "）</label><ul>";
          for (var s = 0; s < chapter.sections.length; s += 1) {
            var section = chapter.sections[s];
            var sectionPracticed = S.bank.questions.filter(function (q) {
              return q.chapterCode === chapter.chapterCode && q.sectionType === section.sectionType && practiced.has(q.id);
            }).length;
            html += "<li>" + esc(section.typeName) + '（' + section.count + " 题，已练 " + sectionPracticed + "）" +
              '<label class="inline" style="margin-left:6px"><input type="checkbox" data-act="sel-type" value="' + section.sectionType + '"' +
              (selectedTypes.indexOf(section.sectionType) >= 0 ? " checked" : "") + "> 全库" + esc(section.typeName) + "</label></li>";
          }
          html += "</ul></li>";
        }
        html += "</ul></li></ul>";
      }
      html += "</div><div class=\"muted mt8\">不勾选任何层级=全部参与；勾选「基础题/专业题」后只在该部分内出题，章节与题型与之取交集（部分内没有选中章节时=该部分全部章节）。</div></div>" +
        '<div class="card"><h2>知识点标签</h2><div class="taglist">' +
        '<button data-act="sel-tag-clear">清空标签</button>';
      var tagNames = Object.keys(S.tagCounts).sort(function (a, b) { return S.tagCounts[b] - S.tagCounts[a]; });
      for (var t = 0; t < tagNames.length; t += 1) {
        var tag = tagNames[t];
        html += '<button data-act="sel-tag" data-tag="' + esc(tag) + '" class="' + (selectedTags.indexOf(tag) >= 0 ? "on" : "") + '">' +
          esc(tag) + " " + S.tagCounts[tag] + "</button>";
      }
      html += "</div><div class=\"muted mt8\">命中任一标签即入选（OR）；已练题量按当前题库统计。</div></div></div>";
    }
    return html;
  }

  // ------------------------------------------------------------ 答题页 P2
  function startPractice(mode, questions, extra) {
    S.practice = {
      mode: mode,
      planned: questions.length,
      questions: questions,
      idx: 0,
      items: questions.map(function () { return null; }),
      startedAt: CQP.isoNow(),
      title: extra && extra.title ? extra.title : "练习",
    };
    go("practice");
  }

  function practiceItem(index) {
    if (!S.practice.items[index]) {
      S.practice.items[index] = {
        submitted: false,
        committed: false,
        skipped: false,
        myAnswer: [],
        correct: false,
        confidence: "confident",
        color: null,
        elapsedMs: 0,
        enteredAt: Date.now(),
        record: null,
        wrongAction: null,
        bookHadEntry: false,
        bookBefore: null,
        bookWritten: false,
        bookAfter: null,
      };
    }
    return S.practice.items[index];
  }

  // 填空作答控件：作为 control 传入，由 fillStemHtml 决定放在题干里还是题干下
  function blankControlHtml(item) {
    return '<input class="blank-input" type="text" id="blankInput" data-act="blank-input" value="' +
      esc(item.myAnswer.length ? item.myAnswer[0] : "") + '"' + (item.submitted ? " disabled" : "") + ' placeholder="请输入答案">';
  }

  // 两条冻结分支：① 题干有下划线标记 → 原位替换；② 无标记 → 末尾标点前插入（无末尾标点则追加）
  function fillStemHtml(question, control) {
    var stem = esc(question.stem);
    if (CQP.responseModeOf(question) !== "blank" || !control) return stem;
    var marker = /[_＿]{2,}|_[ \u3000]_/;
    if (marker.test(stem)) return stem.replace(marker, control);
    var withControl = stem.replace(/([。．.？?！!：:；;])\s*$/, control + "$1");
    return withControl === stem ? stem + control : withControl;
  }

  function renderPractice() {
    var P = S.practice;
    if (!P) { return renderSetup(); }
    if (P.idx >= P.questions.length) return renderResult();
    var question = P.questions[P.idx];
    var item = practiceItem(P.idx);
    var mode = CQP.responseModeOf(question);
    var flagged = CQP.isFlagged(S.store.overrides, question.id);
    var answeredCount = P.items.filter(function (entry) { return entry && entry.submitted; }).length;

    var optionsHtml = "";
    var stemControl = "";
    if (mode === "blank") {
      stemControl = blankControlHtml(item);
      optionsHtml = '<div class="row"><span class="muted">忽略大小写与首尾空格（全角字符按半角判分）；一题多答案请在「校对纠错」中补录</span></div>';
    } else {
      var values = mode === "judge" ? ["对", "错"] : question.options.map(function (option) { return option.key; });
      if (values.length === 0) {
        optionsHtml = '<div class="result-box red">本题选项缺失（题库数据异常），无法作答：请直接「跳过」，或在「校对纠错」中处理。</div>';
      }
      for (var i = 0; i < values.length; i += 1) {
        var value = values[i];
        var text = mode === "judge" ? (value === "对" ? "对（正确）" : "错（错误）") : (question.options[i] ? question.options[i].text : "");
        var checked = item.myAnswer.indexOf(value) >= 0 ? " checked" : "";
        var cls = "option";
        if (item.submitted) {
          var answerList = question.answer || [];
          var isAnswer = answerList.indexOf(value) >= 0;
          var picked = item.myAnswer.indexOf(value) >= 0;
          if (isAnswer) cls += " correct";
          else if (picked) cls += " wrong";
        } else if (checked) {
          cls += " selected";
        }
        var type = mode === "multiple" ? "checkbox" : "radio";
        optionsHtml += '<label class="' + cls + '"><input type="' + type + '" name="opt" value="' + esc(value) + '" data-act="opt"' +
          (checked ? " checked" : "") + (item.submitted ? " disabled" : "") + '><span class="key">' + esc(mode === "judge" ? (value === "对" ? "√" : "×") : value) + "</span><span>" + esc(text) + "</span></label>";
      }
    }

    var resultHtml = "";
    if (item.submitted) {
      var hint = item.color === "green" ? "未进入错题本" : "已加入错题本";
      resultHtml = '<div class="result-box ' + item.color + '"><b>' +
        (item.correct ? "回答正确" : "回答错误") + "</b>（" + colorBadge(item.color) + "） ｜ 正确答案：<b class=\"mono\">" +
        esc(CQP.answerText(question)) + "</b> ｜ " + esc(hint) + "</div>" +
        '<div class="confbar"><span>信心标记（提交后立即选择，可回改）：</span>' +
        '<button data-act="conf" data-conf="confident" class="' + (item.confidence === "confident" ? "on" : "") + '">有把握</button>' +
        '<button data-act="conf" data-conf="guessed" class="' + (item.confidence === "guessed" ? "on" : "") + '">带猜测</button>' +
        '<span class="muted">当前：' + esc(item.confidence === "guessed" ? "带猜测" : "有把握") + " → 颜色 " + esc(item.color) + "</span>" +
        '<span class="muted">绿=有把握且对（不进错题本）；黄=猜对（进）；红=错（进）</span></div>';
    }

    return (
      '<div class="card"><div class="progress"><button data-act="prac-prev"' + (P.idx === 0 ? " disabled" : "") + ">上一题</button>" +
      "<span>第 <b>" + (P.idx + 1) + "</b> / " + P.questions.length + " 题</span>" +
      '<span class="muted">' + esc(P.title) + " ｜ 已答 " + answeredCount + " 题</span>" +
      '<span class="bar"><i style="width:' + Math.round(((P.idx + (item.submitted ? 1 : 0)) / P.questions.length) * 100) + '%"></i></span>' +
      '<button data-act="prac-skip">跳过</button>' +
      '<button data-act="prac-finish">交卷</button>' +
      '<button class="primary" data-act="prac-next">' + (P.idx === P.questions.length - 1 ? "交卷并结算" : "下一题") + "</button></div></div>" +

      '<div class="card qcard ' + (item.submitted ? item.color : "") + '">' +
      '<div class="row between"><div class="muted">' + esc(question.chapterName) + " ｜ " + esc(question.typeName) +
      (question.printedNo ? " ｜ 打印第 " + question.printedNo + " 题" : " ｜ 未编号题") +
      (question.needsReview ? ' ｜ <span class="badge flag">待校对</span>' : "") +
      (flagged ? ' ｜ <span class="badge flag">已标疑问</span>' : "") + "</div>" +
      '<div class="row">' + (question.tags || []).map(function (tag) { return '<span class="badge gray">' + esc(tag) + "</span>"; }).join("") + "</div></div>" +
      '<div class="stem">' + fillStemHtml(question, stemControl) + "</div>" +
      optionsHtml +
      resultHtml +
      '<div class="row mt12">' +
      (item.submitted ? "" : '<button class="primary" data-act="prac-submit">提交</button>') +
      '<button data-act="flag-toggle" data-qid="' + esc(question.id) + '">' + (flagged ? "取消标疑问" : "标疑问") + "</button>" +
      '<button data-act="review-q" data-qid="' + esc(question.id) + '">去校对改答案</button>' +
      "</div></div>"
    );
  }

  function renderResult() {
    var P = S.practice;
    if (!P) return renderSetup();
    var score = CQP.practiceScore(practiceRecords(), { plannedCount: P.planned });
    var rows = [];
    for (var i = 0; i < P.questions.length; i += 1) {
      var item = P.items[i];
      var question = P.questions[i];
      if (!item || !item.submitted) {
        rows.push('<tr><td>' + (i + 1) + '</td><td><span class="badge gray">未作答</span></td><td colspan="3">' + esc(trim(question.stem, 70)) + "</td></tr>");
        continue;
      }
      rows.push(
        "<tr><td>" + (i + 1) + '</td><td><span class="badge ' + item.color + '">' +
          (item.color === "green" ? "绿·有把握对" : item.color === "yellow" ? "黄·猜对" : "红·错") + "</span></td>" +
          "<td>" + esc(trim(question.stem, 70)) + "</td>" +
          '<td class="mono">' + esc(item.myAnswer.join("") || "（空）") + "</td>" +
          '<td class="mono">' + esc(CQP.answerText(question)) + "</td>" +
          '<td class="muted">' + (item.wrongAction === "added" ? "已进错题本" : item.wrongAction === "removed" ? "已自动移出" : "未进错题本") + "</td></tr>"
      );
    }
    return (
      '<div class="card"><h1>本轮结算</h1>' +
      '<div class="kv"><div class="item"><div class="k">得分</div><div class="v">' + score.correct + " / " + score.total + "</div></div>" +
      '<div class="item"><div class="k">正确率</div><div class="v small">' + (score.accuracy === null ? "—" : score.accuracy.toFixed(1) + "%") + "</div></div>" +
      '<div class="item"><div class="k">未作答</div><div class="v">' + score.unanswered + "</div></div>" +
      '<div class="item"><div class="k">模式</div><div class="v small">' + esc(CQP.MODE_NAMES[P.mode] || P.mode) + "</div></div></div>" +
      '<div class="row mt12"><button class="primary" data-act="go" data-page="wrongbook">去错题本</button>' +
      '<button data-act="prac-again">再来一轮</button>' +
      '<button data-act="go" data-page="setup">重新设置分类</button>' +
      '<button data-act="go" data-page="stats">查看学习统计</button></div></div>' +
      '<div class="card"><h2>逐题明细（三色）</h2><div class="legend"><span><i class="green"></i>有把握答对（不进错题本）</span>' +
      '<span><i class="yellow"></i>猜对（进错题本）</span><span><i class="red"></i>答错（进错题本）</span></div>' +
      '<div class="table-wrap mt8"><table><thead><tr><th>#</th><th>颜色</th><th>题干</th><th>你的答案</th><th>正确答案</th><th>错题本</th></tr></thead><tbody>' +
      rows.join("") + "</tbody></table></div></div>"
    );
  }

  // ------------------------------------------------------------ 提交与判分
  function readAnswerFromDom(question) {
    var mode = CQP.responseModeOf(question);
    if (mode === "blank") {
      var input = $("blankInput");
      var text = input ? input.value : "";
      return text.trim().length === 0 && text.length === 0 ? [] : [text];
    }
    var picked = [];
    var nodes = document.querySelectorAll('input[name="opt"]:checked');
    for (var i = 0; i < nodes.length; i += 1) picked.push(nodes[i].value);
    return picked;
  }

  // 提交即落库：记录在点「提交」时马写入 store（同 recordKey 幂等更新），
  // 因此答完直接点导航/刷新/关页面也不会丢作答记录与错题本条目（t4 O-2）。
  function upsertRecord(store, record) {
    for (var i = 0; i < store.records.length; i += 1) {
      var existing = store.records[i];
      if (existing && existing.recordKey === record.recordKey) {
        store.records[i] = record;
        return "updated";
      }
    }
    store.records.push(record);
    store.records.sort(function (a, b) { return a.ts === b.ts ? 0 : a.ts < b.ts ? -1 : 1; });
    return "added";
  }

  function cloneBookEntry(entry) {
    return entry === null || entry === undefined ? null : JSON.parse(JSON.stringify(entry));
  }

  function bookEntryOf(qid) {
    return Object.prototype.hasOwnProperty.call(S.store.wrongbook, qid) ? S.store.wrongbook[qid] : null;
  }

  function sameBookEntry(a, b) {
    return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  }

  // 条目是否算「在册」：removed（手动移出 / 连续有把握自动移出）一律视为不在册
  function bookEntryCountsAsInBook(entry) {
    return entry !== null && entry !== undefined && entry.state !== "removed";
  }

  // 改信心后按最新颜色重算错题本：先恢复「本题当前基线」，再按 8.3 规则重新应用。
  // t16 F-01 安全阀：回放前校验当前条目是否仍停在我们的基线上；若用户此后显式改过
  // （手动移出 / 连续有把握自动移出 / 导入等），本次**不回放**，只把基线重置为当前状态，
  // **绝不用提交时的旧快照覆盖用户操作**。
  function refreshItemBookBaseline(item, qid) {
    var current = bookEntryOf(qid);
    var onBaseline = sameBookEntry(current, item.bookBefore);
    var onLastWrite = item.bookWritten === true && sameBookEntry(current, item.bookAfter);
    if (!onBaseline && !onLastWrite) {
      item.bookBefore = cloneBookEntry(current);
      item.bookHadEntry = current !== null;
      item.bookWritten = true;
      item.bookAfter = cloneBookEntry(current);
      return false;
    }
    return true;
  }

  function applyItemBook(item, record) {
    var qid = record.qid;
    if (!refreshItemBookBaseline(item, qid)) return null; // 条目已被用户显式改动 → 不回放
    if (item.bookHadEntry) S.store.wrongbook[qid] = cloneBookEntry(item.bookBefore);
    else delete S.store.wrongbook[qid];
    // t24 F-01b：基线（回放起点）里该条目已经是 removed，且我们此前已为这次作答写过记录
    // （bookWritten=true，即本次是对同一条历史记录的再次回放）→ **只恢复状态、跳过 8.3 重放**，
    // 否则「removed + 判错 → 重新进入」会把用户手动移出的题复活。
    // 注意 bookWritten=false（本题全新提交）时不跳过：新一次作答照常按 8.3 入册。
    var baselineRemoved = item.bookWritten === true && item.bookBefore !== null && item.bookBefore.state === "removed";
    var action = null;
    if (!baselineRemoved) {
      var applied = CQP.wrongbookApply(S.store.wrongbook, record, record.ts);
      S.store.wrongbook = applied.book;
      action = applied.action;
    }
    item.bookWritten = true;
    item.bookAfter = cloneBookEntry(bookEntryOf(qid));
    return action;
  }

  // opts: {skipPersist, skipBook}；skipBook=true 时只落库记录、绝不触碰错题本（卸载兜底用）
  function writeItemRecord(index, opts) {
    var options = opts && typeof opts === "object" ? opts : { skipPersist: opts === true, skipBook: false };
    var P = S.practice;
    var item = P && P.items[index];
    if (!item || !item.submitted) return null;
    var record = CQP.makeRecord({
      question: P.questions[index],
      myAnswer: item.myAnswer,
      confidence: item.confidence,
      elapsedMs: item.elapsedMs,
      mode: P.mode,
      nickname: nick(),
      bankVersion: bankVersion(),
      appVersion: CQP.VERSION,
      sessionId: null,
      nowISO: item.ts,
    });
    upsertRecord(S.store, record);
    item.record = record;
    if (P.mode !== "mock" && !options.skipBook) {
      var action = applyItemBook(item, record);
      if (action !== null) item.wrongAction = action;
    }
    if (!options.skipPersist) persist();
    return record;
  }

  function practiceRecords() {
    var P = S.practice;
    var out = [];
    if (!P) return out;
    for (var i = 0; i < P.items.length; i += 1) {
      if (P.items[i] && P.items[i].record) out.push(P.items[i].record);
    }
    return out;
  }

  function submitCurrent() {
    var P = S.practice;
    var question = P.questions[P.idx];
    var item = practiceItem(P.idx);
    if (item.submitted) return;
    var myAnswer = readAnswerFromDom(question);
    if (myAnswer.length === 0 || (myAnswer.length === 1 && myAnswer[0] === "")) {
      toast("请先作答，或点击「跳过」");
      return;
    }
    var verdict = CQP.judge(question, myAnswer);
    item.myAnswer = myAnswer;
    item.correct = verdict.correct;
    item.confidence = "confident";
    item.color = CQP.color({ correct: verdict.correct, confidence: item.confidence });
    item.elapsedMs = Math.max(0, Date.now() - item.enteredAt);
    item.ts = CQP.isoNow();
    item.submitted = true;
    item.bookHadEntry = Object.prototype.hasOwnProperty.call(S.store.wrongbook, question.id);
    item.bookBefore = item.bookHadEntry ? cloneBookEntry(S.store.wrongbook[question.id]) : null;
    item.bookWritten = false;
    item.bookAfter = null;
    writeItemRecord(P.idx);
    render();
  }

  function setConfidence(conf) {
    var item = practiceItem(S.practice.idx);
    if (!item.submitted) return;
    item.confidence = conf;
    item.color = CQP.color({ correct: item.correct, confidence: conf });
    writeItemRecord(S.practice.idx);
    render();
  }

  // 离开本题时只做一次幂等同步（记录已在提交时落库）
  function commitItem(index) {
    var P = S.practice;
    var item = P && P.items[index];
    if (!item || !item.submitted) return;
    writeItemRecord(index);
  }

  // beforeunload / pagehide 兜底：把已提交题目与进行中模拟赛的作答落库。
  // t16 F-01：兜底**只做记录落库**，不再回放错题本快照 —— 否则会用提交时的旧快照
  // 覆盖用户之后的手动移出（state=removed/manual）等显式操作。
  function flushPractice() {
    var P = S.practice;
    if (P) {
      for (var i = 0; i < P.items.length; i += 1) {
        if (P.items[i] && P.items[i].submitted) writeItemRecord(i, { skipPersist: true, skipBook: true });
      }
    }
    if (S.mock && S.mock.phase === "running" && S.mock.paper) {
      var current = S.mock.paper.questionIds[S.mock.idx];
      if (S.mock.responses[current]) {
        S.mock.responses[current].elapsedMs += Math.max(0, Date.now() - S.mock.enteredAt);
      }
      flushMockRecords(null);
    }
    try {
      persist();
    } catch (err) {
      /* 卸载阶段尽力而为 */
    }
  }

  function nextQuestion() {
    var P = S.practice;
    commitItem(P.idx);
    if (P.idx >= P.questions.length - 1) {
      S.practice = P;
      S.page = "result";
      render();
      return;
    }
    P.idx += 1;
    render();
  }

  function skipQuestion() {
    var P = S.practice;
    var item = practiceItem(P.idx);
    if (!item.submitted) item.skipped = true;
    if (P.idx >= P.questions.length - 1) {
      S.page = "result";
      render();
      return;
    }
    P.idx += 1;
    render();
  }

  function finishPractice() {
    var P = S.practice;
    var item = P.items[P.idx];
    if (item && item.submitted) commitItem(P.idx);
    confirmBox("确认交卷？", "<p>未提交的题将记为「未作答」；已提交题目的作答记录在提交时就已保存。</p>", function () {
      S.page = "result";
      render();
    }, "交卷");
  }

  function prevQuestion() {
    var P = S.practice;
    if (P.idx > 0) { P.idx -= 1; render(); }
  }

  // ------------------------------------------------------------ 错题本 P4
  function renderWrongbook() {
    var filter = S.wrongFilter;
    var rows = CQP.wrongbookList(S.store.wrongbook, S.bank.questions, {
      state: filter.state,
      chapters: filter.chapter ? [filter.chapter] : null,
      types: filter.type ? [filter.type] : null,
      tags: filter.tag ? [filter.tag] : null,
      colors: filter.color ? [filter.color] : null,
    });
    var activeQuestions = CQP.wrongbookList(S.store.wrongbook, S.bank.questions, { state: "active" }).map(function (row) { return row.question; });
    var tagNames = Object.keys(S.tagCounts).sort(function (a, b) { return S.tagCounts[b] - S.tagCounts[a]; });

    var tableRows = rows.map(function (row) {
      var stats = CQP.statsOfRecords(recordsOf(row.qid));
      var mastery = CQP.masteryOfQuestion(myRecords(), row.qid);
      return "<tr><td>" + colorBadge(CQP.wrongbookColorOfEntry(row)) + "</td>" +
        "<td>" + esc(trim(row.question.stem, 80)) + "<div class=\"muted\">" + esc(row.question.id) + " ｜ " + esc(row.question.chapterName) + " ｜ " + esc(row.question.typeName) +
        (CQP.isFlagged(S.store.overrides, row.qid) ? ' <span class="badge flag">已标疑问</span>' : "") + "</div></td>" +
        '<td class="num">' + stats.wrong + "</td>" +
        '<td class="num">' + stats.correct + "</td>" +
        '<td class="num">' + stats.guessedCorrect + "</td>" +
        '<td class="num">' + masteryText(mastery.index, mastery.insufficient) + "</td>" +
        '<td class="muted">' + (row.state === "active"
          ? (row.removedReason ? "" : (row.confidentStreak ? "连续有把握答对 " + row.confidentStreak + " 次" : "在册"))
          : (row.removedReason === "auto2" ? "已自动移出（连续 2 次有把握答对）" : "已手动移出")) + "</td>" +
        '<td class="nowrap">' + (row.state === "active"
          ? '<button class="small" data-act="wrong-remove" data-qid="' + esc(row.qid) + '">移出</button>'
          : '<button class="small" data-act="wrong-readd" data-qid="' + esc(row.qid) + '">重新加入</button>') +
        '<button class="small" data-act="wrong-single" data-qid="' + esc(row.qid) + '">练一题</button></td></tr>';
    });

    return (
      '<div class="card"><h1>错题本</h1>' +
      '<div class="row">' +
      '<label class="inline">状态 <select data-act="wrong-filter" data-key="state">' +
      option("active", "在册", filter.state) + option("removed", "已移出", filter.state) + option("all", "全部", filter.state) + "</select></label>" +
      '<label class="inline">章 <select data-act="wrong-filter" data-key="chapter"><option value="">全部</option>' +
      S.bank.chapters.map(function (chapter) { return option(chapter.chapterCode, chapter.chapterName, filter.chapter); }).join("") + "</select></label>" +
      '<label class="inline">题型 <select data-act="wrong-filter" data-key="type"><option value="">全部</option>' +
      CQP.TYPES.map(function (type) { return option(type, CQP.TYPE_NAMES[type], filter.type); }).join("") + "</select></label>" +
      '<label class="inline">颜色 <select data-act="wrong-filter" data-key="color"><option value="">全部</option>' +
      option("red", "红·答错", filter.color) + option("yellow", "黄·猜对", filter.color) + option("green", "绿·已移出", filter.color) + "</select></label>" +
      '<label class="inline">知识点 <select data-act="wrong-filter" data-key="tag"><option value="">全部</option>' +
      tagNames.map(function (tag) { return option(tag, tag, filter.tag); }).join("") + "</select></label>" +
      '<span class="badge blue">' + rows.length + " 条</span>" +
      '<button class="primary" data-act="wrong-practice"' + (activeQuestions.length === 0 ? " disabled" : "") + ">错题重练（" + activeQuestions.length + " 题）</button>" +
      "</div><div class=\"muted mt8\">自动移出规则：在册错题连续 2 次「有把握答对」即移出；手动移出不删除作答记录。</div></div>" +
      '<div class="card"><div class="table-wrap"><table><thead><tr><th>颜色</th><th>题目</th><th class="num">错过</th><th class="num">对过</th><th class="num">猜对</th><th class="num">掌握指数</th><th>状态</th><th>操作</th></tr></thead><tbody>' +
      (tableRows.length ? tableRows.join("") : '<tr><td colspan="8" class="muted">暂无符合条件的错题。答错或猜对的题会自动进入错题本。</td></tr>') +
      "</tbody></table></div></div>"
    );
  }

  function option(value, label, current) {
    return '<option value="' + esc(value) + '"' + (String(current) === String(value) ? " selected" : "") + ">" + esc(label) + "</option>";
  }

  // ------------------------------------------------------------ 学习统计 P5
  function statsScope() {
    return { scope: S.statsRange.scope, from: S.statsRange.from, to: S.statsRange.to };
  }

  // 列排序：空值恒排最后；字符串按码点，数值按大小，dir 为 asc/desc
  function sortRows(rows, sort) {
    var list = rows.slice();
    var dir = sort && sort.dir === "asc" ? 1 : -1;
    var key = sort && sort.key ? sort.key : null;
    if (!key) return list;
    list.sort(function (a, b) {
      var x = a[key];
      var y = b[key];
      var xNull = x === null || x === undefined;
      var yNull = y === null || y === undefined;
      if (xNull && yNull) return 0;
      if (xNull) return 1;
      if (yNull) return -1;
      if (typeof x === "string" || typeof y === "string") {
        var sx = String(x);
        var sy = String(y);
        if (sx === sy) return 0;
        return sx < sy ? -dir : dir;
      }
      if (x === y) return 0;
      return x < y ? -dir : dir;
    });
    return list;
  }

  function sortHeader(table, key, label, numeric) {
    var sort = S.statsSort[table] || {};
    var mark = sort.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
    return (
      '<th class="' + (numeric ? "num " : "") + '" style="cursor:pointer" data-act="stats-sort" data-table="' + table +
      '" data-key="' + key + '" title="点击切换排序">' + esc(label) + mark + "</th>"
    );
  }

  function renderStats() {
    var range = S.statsRange;
    var all = S.store.records;
    var nicknames = Array.from(new Set(all.map(function (record) { return record.nickname; }))).sort(CQP.compareNickname);
    if (!S.statsNick || nicknames.indexOf(S.statsNick) < 0) S.statsNick = nicknames.indexOf(nick()) >= 0 ? nick() : nicknames[0] || nick();
    var targetNick = S.statsNick;

    var scoped = [];
    var rangeError = "";
    try {
      scoped = CQP.filterByDate(all, range.scope === "all" ? { scope: "all" } : range);
    } catch (err) {
      scoped = all;
      // 只呈现冻结文案，不暴露内部异常消息
      rangeError = err instanceof RangeError ? RANGE_TEXT : "日期不合法，已按全部记录统计";
    }
    var mine = scoped.filter(function (record) { return record.nickname === targetNick; });
    var stats = CQP.personalStats({ records: all, questions: S.bank.questions, nickname: targetNick, sessions: S.store.sessions });
    var scopedStats = CQP.personalStats({ records: scoped, questions: S.bank.questions, nickname: targetNick, sessions: S.store.sessions });
    var overall = CQP.masteryOverall(mine);
    var byType = CQP.groupSummary(mine, S.bank.questions, function (q) { return q.sectionType; });
    var byChapter = CQP.groupSummary(mine, S.bank.questions, function (q) { return q.chapterCode; });

    // 每题明细
    var perQuestion = [];
    var byQid = new Map();
    for (var i = 0; i < mine.length; i += 1) {
      var list = byQid.get(mine[i].qid);
      if (!list) { list = []; byQid.set(mine[i].qid, list); }
      list.push(mine[i]);
    }
    byQid.forEach(function (list, qid) {
      var question = S.qById.get(qid);
      if (!question) return;
      var m = CQP.masteryOfAttempts(list);
      var rec = CQP.statsOfRecords(list);
      perQuestion.push({
        qid: qid,
        question: question,
        chapterName: question.chapterName,
        typeName: question.typeName,
        stem: question.stem,
        attempts: m.attempts,
        correct: m.confidentCorrect + m.guessedCorrect,
        confidentCorrect: m.confidentCorrect,
        wrong: m.wrong,
        guessed: m.guessedCorrect,
        index: m.index,
        insufficient: m.insufficient,
        lastTs: rec.lastTs,
      });
    });

    // 总览与明细表列排序（点击表头切换）
    var chapterRows = S.bank.chapters.map(function (chapter) {
      var row = byChapter[chapter.chapterCode] || { answered: 0, accuracy: null, mastery: { index: null, insufficient: true }, correct: 0 };
      return {
        chapterCode: chapter.chapterCode,
        chapterName: chapter.chapterName,
        chapterTotal: chapter.chapterTotal,
        answered: row.answered,
        accuracy: row.accuracy,
        masteryIndex: row.mastery.index,
        masteryInsufficient: row.mastery.insufficient,
      };
    });
    var typeRows = CQP.TYPES.map(function (type) {
      var row = byType[type] || { answered: 0, accuracy: null, mastery: { index: null, insufficient: true } };
      return {
        type: type,
        typeName: CQP.TYPE_NAMES[type],
        order: CQP.TYPES.indexOf(type),
        answered: row.answered,
        accuracy: row.accuracy,
        masteryIndex: row.mastery.index,
        masteryInsufficient: row.mastery.insufficient,
      };
    });
    chapterRows = sortRows(chapterRows, S.statsSort.chapter);
    typeRows = sortRows(typeRows, S.statsSort.type);
    var sortedPerQuestion = sortRows(perQuestion, S.statsSort.detail);
    var detailRows = sortedPerQuestion.slice(0, S.detailLimit).map(function (row) {
      return "<tr><td class=\"mono\">" + esc(row.qid) + "</td><td>" + esc(row.chapterName) + "</td><td>" + esc(row.typeName) + "</td>" +
        "<td>" + esc(trim(row.stem, 60)) + "</td>" +
        '<td class="num">' + row.attempts + "</td><td class=\"num\">" + row.correct + "</td><td class=\"num\">" + row.confidentCorrect +
        "</td><td class=\"num\">" + row.wrong + "</td><td class=\"num\">" + row.guessed + "</td>" +
        '<td class="num">' + masteryText(row.index, row.insufficient) + "</td></tr>";
    });

    // 薄弱 TOP：按知识点分组正确率
    var tagStats = [];
    Object.keys(S.tagIndex).forEach(function (tag) {
      var ids = S.tagIndex[tag];
      var idSet = new Set(ids);
      var list = mine.filter(function (record) { return idSet.has(record.qid); });
      if (list.length === 0) return;
      var correct = list.filter(function (record) { return record.correct; }).length;
      var m = CQP.masteryOfAttempts(list);
      tagStats.push({ tag: tag, total: ids.length, attempts: list.length, accuracy: (correct / list.length) * 100, index: m.index, insufficient: m.insufficient });
    });
    tagStats.sort(function (a, b) { return a.accuracy === b.accuracy ? b.attempts - a.attempts : a.accuracy - b.accuracy; });
    var weakestTags = tagStats.filter(function (row) { return row.attempts >= 3; }).slice(0, 10);
    var weakestQuestions = perQuestion.filter(function (row) { return row.attempts >= 3 && row.index !== null; }).sort(function (a, b) { return a.index - b.index; }).slice(0, 10);

    return (
      '<div class="card"><h1>学习统计</h1><div class="row">' +
      '<label class="inline"><input type="radio" name="scope" data-act="stats-scope" value="day"' + (range.scope === "day" ? " checked" : "") + "> 单日</label>" +
      '<input type="date" data-act="stats-date" data-key="from" value="' + esc(range.from) + '">' +
      '<label class="inline"><input type="radio" name="scope" data-act="stats-scope" value="all"' + (range.scope === "all" ? " checked" : "") + "> 全部</label>" +
      '<label class="inline"><input type="radio" name="scope" data-act="stats-scope" value="range"' + (range.scope === "range" ? " checked" : "") + "> 区间</label>" +
      '<input type="date" data-act="stats-date" data-key="to" value="' + esc(range.to || range.from) + '">' +
      (nicknames.length > 1 ? '<label class="inline">对象 <select data-act="stats-nick">' + nicknames.map(function (name) { return option(name, name, targetNick); }).join("") + "</select></label>" : "") +
      '<button class="primary" data-act="go" data-page="io">去导出 / 导入</button>' +
      (rangeError ? '<span class="badge red">' + esc(rangeError) + "</span>" : "") +
      '<span class="muted">日期口径＝本地自然日；掌握指数＝(有把握对×1＋猜对×0.5＋错×0)÷作答次数×100，样本&lt;3 显示样本不足；点击表头可排序。</span></div>' +
      '<div class="kv mt12">' +
      '<div class="item"><div class="k">范围内作答</div><div class="v">' + mine.length + "</div></div>" +
      '<div class="item"><div class="k">范围内正确</div><div class="v">' + (scopedStats.nickname === targetNick ? scopedStats.correct : mine.filter(function (r) { return r.correct; }).length) + "</div></div>" +
      '<div class="item"><div class="k">范围内正确率</div><div class="v small">' + (mine.length ? ((mine.filter(function (r) { return r.correct; }).length / mine.length) * 100).toFixed(1) + "%" : "—") + "</div></div>" +
      '<div class="item"><div class="k">范围内掌握指数</div><div class="v small">' + masteryText(overall.index, overall.insufficient) + "</div></div>" +
      '<div class="item"><div class="k">累计作答</div><div class="v">' + stats.answered + "</div></div>" +
      '<div class="item"><div class="k">累计正确率</div><div class="v small">' + (stats.accuracy === null ? "—" : stats.accuracy.toFixed(1) + "%") + "</div></div>" +
      '<div class="item"><div class="k">累计掌握指数</div><div class="v small">' + masteryText(stats.mastery.index, stats.mastery.insufficient) + "</div></div>" +
      '<div class="item"><div class="k">个人易错题</div><div class="v">' + stats.wrongQuestionCount + "</div></div>" +
      "</div></div>" +

      '<div class="grid cols2">' +
      '<div class="card"><h2>分章正确率与掌握指数</h2><div class="table-wrap"><table><thead><tr>' +
      sortHeader("chapter", "chapterName", "章") +
      sortHeader("chapter", "chapterTotal", "题量", true) +
      sortHeader("chapter", "answered", "作答", true) +
      sortHeader("chapter", "accuracy", "正确率", true) +
      sortHeader("chapter", "masteryIndex", "掌握指数", true) + "</tr></thead><tbody>" +
      chapterRows.map(function (row) {
        return "<tr><td>" + esc(row.chapterName) + "</td><td class=\"num\">" + row.chapterTotal + "</td><td class=\"num\">" + row.answered +
          "</td><td class=\"num\">" + (row.accuracy === null ? "—" : row.accuracy.toFixed(1) + "%") + "</td><td class=\"num\">" +
          masteryText(row.masteryIndex, row.masteryInsufficient) + "</td></tr>";
      }).join("") + "</tbody></table></div></div>" +
      '<div class="card"><h2>分题型正确率与掌握指数</h2><div class="table-wrap"><table><thead><tr>' +
      sortHeader("type", "typeName", "题型") +
      sortHeader("type", "answered", "作答", true) +
      sortHeader("type", "accuracy", "正确率", true) +
      sortHeader("type", "masteryIndex", "掌握指数", true) + "</tr></thead><tbody>" +
      typeRows.map(function (row) {
        return "<tr><td>" + esc(row.typeName) + "</td><td class=\"num\">" + row.answered + "</td><td class=\"num\">" +
          (row.accuracy === null ? "—" : row.accuracy.toFixed(1) + "%") + "</td><td class=\"num\">" +
          masteryText(row.masteryIndex, row.masteryInsufficient) + "</td></tr>";
      }).join("") + "</tbody></table></div>" +
      "<h2>薄弱知识点 TOP</h2><div class=\"table-wrap\" style=\"max-height:240px\"><table><thead><tr><th>知识点</th><th class=\"num\">作答</th><th class=\"num\">正确率</th><th class=\"num\">掌握指数</th></tr></thead><tbody>" +
      (weakestTags.length ? weakestTags.map(function (row) {
        return "<tr><td>" + esc(row.tag) + "</td><td class=\"num\">" + row.attempts + "</td><td class=\"num\">" + row.accuracy.toFixed(1) + "%</td><td class=\"num\">" + masteryText(row.index, row.insufficient) + "</td></tr>";
      }).join("") : '<tr><td colspan="4" class="muted">暂无样本（每个知识点作答 ≥3 次后进入榜单）</td></tr>') +
      "</tbody></table></div>" +
      "<h2>薄弱题目 TOP</h2><div class=\"table-wrap\" style=\"max-height:240px\"><table><thead><tr><th>题目</th><th class=\"num\">作答</th><th class=\"num\">掌握指数</th></tr></thead><tbody>" +
      (weakestQuestions.length ? weakestQuestions.map(function (row) {
        return "<tr><td>" + esc(trim(row.question.stem, 46)) + "</td><td class=\"num\">" + row.attempts + "</td><td class=\"num\">" + masteryText(row.index, false) + "</td></tr>";
      }).join("") : '<tr><td colspan="3" class="muted">暂无样本</td></tr>') +
      "</tbody></table></div></div></div>" +

      '<div class="card"><h2>每题明细（范围内）</h2><div class="muted">共 ' + perQuestion.length + " 题，显示前 " + Math.min(S.detailLimit, sortedPerQuestion.length) + " 题。</div>" +
      '<div class="table-wrap mt8"><table><thead><tr>' +
      sortHeader("detail", "qid", "题号") +
      sortHeader("detail", "chapterName", "章") +
      sortHeader("detail", "typeName", "题型") +
      '<th>题干</th>' +
      sortHeader("detail", "attempts", "作答", true) +
      sortHeader("detail", "correct", "对", true) +
      sortHeader("detail", "confidentCorrect", "有把握对", true) +
      sortHeader("detail", "wrong", "错", true) +
      sortHeader("detail", "guessed", "猜对", true) +
      sortHeader("detail", "index", "掌握指数", true) + "</tr></thead><tbody>" +
      (detailRows.length ? detailRows.join("") : '<tr><td colspan="10" class="muted">范围内暂无作答记录</td></tr>') +
      "</tbody></table></div>" +
      (sortedPerQuestion.length > S.detailLimit ? '<div class="mt8"><button data-act="stats-more">显示更多（+' + Math.min(60, sortedPerQuestion.length - S.detailLimit) + "）</button></div>" : "") +
      "</div>"
    );
  }

  // ------------------------------------------------------------ 团队对比 P6
  function renderTeam() {
    var team = CQP.teamStats({ records: S.store.records, questions: S.bank.questions, sessions: S.store.sessions });
    var importedCount = S.store.imports.length;
    var targetNick = S.teamNick && team.nicknames.indexOf(S.teamNick) >= 0 ? S.teamNick : nick();
    var personal = CQP.personalStats({ records: S.store.records, questions: S.bank.questions, nickname: targetNick, sessions: S.store.sessions });

    var memberRows = team.members.map(function (member) {
      return "<tr><td>" + esc(member.nickname) + (member.nickname === nick() ? ' <span class="badge blue">我</span>' : "") + "</td>" +
        '<td class="num">' + member.answered + "</td>" +
        '<td class="num">' + member.correct + "</td>" +
        '<td class="num">' + (member.accuracy === null ? "—" : member.accuracy.toFixed(1) + "%") + "</td>" +
        '<td class="num">' + masteryText(member.mastery.index, member.mastery.insufficient) + "</td>" +
        '<td class="num">' + member.wrongQuestionCount + "</td>" +
        '<td class="num">' + (member.mockBest === null ? "—" : member.mockBest + " 分（" + member.mockCount + " 次）") + "</td></tr>";
    });

    var teamRows = team.teamWrongQuestions.slice(0, 200).map(function (row) {
      return "<tr><td>" + esc(trim(row.question ? row.question.stem : row.qid, 70)) + '<div class="muted mono">' + esc(row.qid) + "</div></td>" +
        '<td class="num">' + row.wrongUsers + "</td>" +
        '<td class="num">' + row.wrongCount + "</td>" +
        '<td class="num">' + (row.wrongRate === null ? "—" : row.wrongRate.toFixed(1) + "%") + "</td>" +
        '<td class="num">' + masteryText(row.teamMasteryIndex, row.insufficient) + "</td>" +
        "<td>" + esc(row.wrongUserNames.join("、")) + "</td></tr>";
    });

    var personalRows = personal.wrongQuestions.slice(0, 200).map(function (row) {
      return "<tr><td>" + esc(trim(row.question ? row.question.stem : row.qid, 70)) + '</td><td class="num">' + row.wrongCount + "</td>" +
        '<td class="num">' + row.correctCount + "</td><td class=\"num\">" + row.guessedCorrect + "</td><td class=\"num\">" +
        masteryText(row.masteryIndex, row.insufficient) + "</td></tr>";
    });

    var matrix = "";
    if (team.matrix.length > 0) {
      matrix = '<div class="card"><h2>交叉矩阵（团队易错题 × 成员）</h2><div class="table-wrap" style="max-height:320px"><table><thead><tr><th>题目</th>' +
        team.nicknames.map(function (name) { return "<th>" + esc(name) + "</th>"; }).join("") + "</tr></thead><tbody>" +
        team.matrix.slice(0, 100).map(function (row) {
          return "<tr><td>" + esc(trim(row.question ? row.question.stem : row.qid, 50)) + "</td>" +
            row.cells.map(function (cell) { return "<td>" + esc(cell.cell) + "</td>"; }).join("") + "</tr>";
        }).join("") + "</tbody></table></div></div>";
    }

    var emptyTeam = team.nicknames.length <= 1 || team.teamWrongQuestions.length === 0;
    return (
      '<div class="card"><h1>团队对比</h1><div class="row between"><div class="muted">团队 = 本机昵称 + 所有已导入文件中的昵称（同一昵称合并统计）；已导入 ' +
      importedCount + " 次文件。团队易错题 = 答错该题的不同昵称数 ≥ " + CQP.WRONG_THRESHOLD_USERS + "（按答错人数降序）。</div>" +
      '<div class="row"><button class="primary" data-act="go" data-page="io">导入队友 JSON</button>' +
      (team.nicknames.length > 1 ? '<label class="inline">个人易错题对象 <select data-act="team-nick">' + team.nicknames.map(function (name) { return option(name, name, targetNick); }).join("") + "</select></label>" : "") +
      "</div></div>" +
      '<div class="kv mt12"><div class="item"><div class="k">团队成员数</div><div class="v">' + team.nicknames.length + "</div></div>" +
      '<div class="item"><div class="k">记录总数</div><div class="v">' + team.totalRecords + "</div></div>" +
      '<div class="item"><div class="k">团队易错题</div><div class="v">' + team.teamWrongQuestions.length + "</div></div>" +
      '<div class="item"><div class="k">团队掌握指数</div><div class="v small">' + masteryText(team.teamMastery.index, team.teamMastery.insufficient) + "</div></div></div></div>" +

      (emptyTeam ? '<div class="card"><div class="muted">还没有可对比的队友数据：请先在「导出/导入」页导入队友导出的 JSON 文件（先导入队友的 JSON）。</div></div>' : "") +

      '<div class="card"><h2>成员对比</h2><div class="table-wrap"><table><thead><tr><th>昵称</th><th class="num">作答</th><th class="num">正确</th><th class="num">正确率</th><th class="num">掌握指数</th><th class="num">个人易错题</th><th class="num">模拟赛最高分</th></tr></thead><tbody>' +
      (memberRows.length ? memberRows.join("") : '<tr><td colspan="7" class="muted">暂无成员</td></tr>') + "</tbody></table></div></div>" +

      '<div class="card"><h2>团队易错题（≥' + CQP.WRONG_THRESHOLD_USERS + ' 人答错）</h2><div class="table-wrap"><table><thead><tr><th>题目</th><th class="num">答错人数</th><th class="num">答错次数</th><th class="num">错误率</th><th class="num">团队掌握指数</th><th>答错成员</th></tr></thead><tbody>' +
      (teamRows.length ? teamRows.join("") : '<tr><td colspan="6" class="muted">暂无团队易错题</td></tr>') + "</tbody></table></div></div>" +

      '<div class="card"><h2>个人易错题（' + esc(targetNick) + "）</h2><div class=\"table-wrap\"><table><thead><tr><th>题目</th><th class=\"num\">错过</th><th class=\"num\">对过</th><th class=\"num\">猜对</th><th class=\"num\">掌握指数</th></tr></thead><tbody>" +
      (personalRows.length ? personalRows.join("") : '<tr><td colspan="5" class="muted">该成员暂无易错题</td></tr>') + "</tbody></table></div></div>" +
      matrix
    );
  }

  // ------------------------------------------------------------ 导出/导入 P7
  function renderIO() {
    var io = S.io;
    var scope = io.scope;
    var preview = null;
    var previewError = "";
    try {
      preview = CQP.exportPayload({
        store: S.store,
        scope: scope,
        from: scope === "all" ? null : io.from,
        to: scope === "range" ? io.to : scope === "day" ? io.from : null,
        nickname: nick(),
        bankVersion: bankVersion(),
        nowISO: CQP.isoNow(),
      });
    } catch (err) {
      // 冻结文案：不把内部异常消息呈现在界面上
      previewError = err instanceof RangeError ? RANGE_TEXT : "导出参数不正确（请检查日期）";
    }
    var fileName = "";
    try {
      fileName = CQP.exportFileName({ nickname: nick(), scope: scope, from: io.from, to: io.to });
    } catch (err) {
      fileName = err instanceof RangeError ? RANGE_TEXT : "（请检查日期）";
    }

    // t41 F-03：只读抢救模式提示卡——文案与行为一致（不写盘、不清空、导出读磁盘原始数据）
    var blockedHtml = "";
    if (S.storageBlocked) {
      var snapshot = rescuePayload();
      blockedHtml = '<div class="card"><h2>只读抢救模式（不会写入任何数据）</h2>' +
        "<div class=\"muted\">检测到 " + esc(blockedReasonText()) + "。程序已切换为只读：<b>本次运行不会写入任何数据</b>，也不会清空，你的数据仍保存在浏览器中。下面的导出按钮会<b>直接读取浏览器里的原始数据</b>（不再从内存取数），请先用它把数据抢救出来。</div>" +
        '<div class="kv mt8">' +
        '<div class="item"><div class="k">磁盘上的昵称</div><div class="v small">' + esc(snapshot.exportedBy.nickname) + "</div></div>" +
        '<div class="item"><div class="k">磁盘上的作答记录</div><div class="v small">' + snapshot.counts.records + " 条</div></div>" +
        '<div class="item"><div class="k">磁盘上的模拟赛</div><div class="v small">' + snapshot.counts.sessions + " 场</div></div>" +
        '<div class="item"><div class="k">纠错覆盖层</div><div class="v small">' + snapshot.counts.overrides + " 条</div></div>" +
        '<div class="item"><div class="k">检测到的数据版本</div><div class="v small">' + esc(snapshot.schemaVersion) + "</div></div>" +
        "</div>" +
        (snapshot.rescue.unparsableKeys.length
          ? '<div class="result-box yellow mt8">有 ' + snapshot.rescue.unparsableKeys.length + " 处内容无法解析为 JSON（" + esc(snapshot.rescue.unparsableKeys.join("、")) + "）：导出文件会把它们的<b>原始字符串</b>一并保存，便于手工抢救。</div>"
          : "") +
        '<div class="row mt12"><button class="primary" data-act="export-backup">导出抢救备份（读取原始数据）</button>' +
        '<button data-act="export">按范围导出（同样读取原始数据）</button></div></div>';
    }

    var reportHtml = "";
    if (io.report) {
      var report = io.report;
      var duplicateTotal = report.duplicates + report.duplicatesInFile;
      var detailText = "跳过 " + report.skipped.length + " 条，补正 " + report.repaired.length + " 条；覆盖层应用 " + report.overridesApplied + " 条（保留本地 " + report.overridesKept +
        " 条）；模拟赛 " + report.sessionsImported + " 场；涉及昵称：" + esc(report.nicknames.join("、") || "—") +
        (report.unknownQids.length ? "；未知题号 " + report.unknownQids.length + " 条（未入库）" : "");
      reportHtml = report.importedRecords === 0
        ? '<div class="result-box yellow mt12"><b>' + IMPORT_NO_NEW_PREFIX + duplicateTotal + " 条为重复记录（未重复计数）</b><br>" + detailText + "</div>"
        : '<div class="result-box green mt12"><b>导入完成</b>：新增 ' + report.importedRecords + " 条，重复 " + duplicateTotal + " 条，" + detailText + "</div>";
    } else if (io.pending) {
      var pending = io.pending;
      reportHtml = '<div class="result-box ' + (pending.ok ? "green" : "red") + ' mt12">' +
        (pending.ok
          ? "<b>文件校验通过</b>：共 " + pending.payload.counts.records + " 条作答记录、" + pending.payload.counts.sessions + " 场模拟赛、" + pending.payload.counts.overrides + " 条纠错覆盖；导出人 " + esc(pending.payload.exportedBy.nickname) + "。"
          : "<b>文件无法导入</b>：" + esc(pending.errors.map(function (e) { return e.code + " " + e.message; }).join("；"))) +
        "</div>" +
        (pending.ok
          ? '<div class="row mt8"><button class="primary" data-act="import-confirm">确认合并</button><button data-act="import-cancel">取消</button></div>'
          : "");
    }

    var ledger = S.store.imports.slice().reverse().slice(0, 30).map(function (item) {
      return "<tr><td>" + esc(item.fileName) + "</td><td>" + esc(item.importedAt) + "</td><td>" + esc((item.nicknames || []).join("、")) +
        '</td><td class="num">' + item.importedRecords + '</td><td class="num">' + item.duplicates + '</td><td class="num">' + item.skipped + "</td></tr>";
    });

    return (
      '<div class="card"><h1>导出 / 导入</h1>' +
      blockedHtml +
      '<h2>导出学习情况（按本地自然日）</h2><div class="row">' +
      '<label class="inline"><input type="radio" name="ioScope" data-act="io-scope" value="day"' + (scope === "day" ? " checked" : "") + "> 单日</label>" +
      '<input type="date" data-act="io-date" data-key="from" value="' + esc(io.from) + '">' +
      '<label class="inline"><input type="radio" name="ioScope" data-act="io-scope" value="range"' + (scope === "range" ? " checked" : "") + "> 区间</label>" +
      '<input type="date" data-act="io-date" data-key="to" value="' + esc(io.to) + '">' +
      '<label class="inline"><input type="radio" name="ioScope" data-act="io-scope" value="all"' + (scope === "all" ? " checked" : "") + "> 全部</label>" +
      '<button class="primary" data-act="export"' + (preview ? "" : " disabled") + ">导出</button></div>" +
      '<div class="muted mt8">文件名：<span class="mono">' + esc(S.storageBlocked ? rescueFileName() : fileName) + "</span>；" +
      (S.storageBlocked
        ? "抢救模式：将导出浏览器里的 " + rescuePayload().counts.records + " 条作答记录（原样读取，不按日期裁剪）。"
        : previewError ? '<span class="badge red">' + esc(previewError) + "</span>" : "本次将导出 " + preview.counts.records + " 条作答记录、" + preview.counts.sessions + " 场模拟赛、覆盖层 " + preview.counts.overrides + " 条（覆盖层整体导出，不按日期裁剪）。") +
      "</div></div>" +

      '<div class="card"><h2>导入队友记录</h2><div class="row">' +
      '<input type="file" id="importFile" accept=".json,application/json">' +
      '<span class="muted">重复导入不会重复计数（按 昵称+题号+时间戳 去重）。</span></div>' + reportHtml + "</div>" +

      '<div class="card"><h2>导入历史</h2><div class="table-wrap" style="max-height:260px"><table><thead><tr><th>文件</th><th>时间</th><th>昵称</th><th class="num">新增</th><th class="num">重复</th><th class="num">跳过</th></tr></thead><tbody>' +
      (ledger.length ? ledger.join("") : '<tr><td colspan="6" class="muted">暂无导入记录</td></tr>') + "</tbody></table></div></div>"
    );
  }

  function handleImportFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var result = CQP.validateImport(String(reader.result));
      S.io.pending = { ok: result.ok, errors: result.errors, warnings: result.warnings, payload: result.payload, fileName: file.name };
      S.io.report = null;
      render();
    };
    reader.onerror = function () {
      S.io.pending = { ok: false, errors: [{ code: "E_READ", message: "文件读取失败" }], warnings: [], payload: null, fileName: file.name };
      render();
    };
    reader.readAsText(file);
  }

  function confirmImport() {
    var pending = S.io.pending;
    if (!pending || !pending.ok) return;
    var merged = CQP.mergeImport({
      store: S.store,
      payload: pending.payload,
      questions: S.bank.questions,
      bankVersion: bankVersion(),
      fileName: pending.fileName,
      nowISO: CQP.isoNow(),
    });
    S.store = merged.store;
    // 先同步内存态再刷新派生数据：否则 refreshBank() 会按旧 store 计算生效题库（覆盖层不生效）
    CQP.setStore(S.store);
    refreshBank();
    S.io.report = merged.report;
    S.io.pending = null;
    persist();
    render();
    var duplicateTotal = merged.report.duplicates + merged.report.duplicatesInFile;
    toast(
      merged.report.importedRecords === 0
        ? IMPORT_NO_NEW_PREFIX + duplicateTotal + " 条为重复记录（未重复计数）"
        : "导入完成：新增 " + merged.report.importedRecords + " 条记录"
    );
  }

  // ------------------------------------------------------------ 模拟赛 P8
  function mockState() {
    if (!S.mock) {
      // limitSec = 不可变限额基准；remaining = 派生值（显示与自动交卷判断用），口径来自 CQP.MOCK_LIMITS
      S.mock = {
        phase: "setup",
        paper: null,
        responses: {},
        idx: 0,
        limitSec: CQP.MOCK_LIMITS.timeLimitSec,
        remaining: CQP.MOCK_LIMITS.timeLimitSec,
        startedAt: null,
        marked: {},
        enteredAt: 0,
        session: null,
        bookSnapshot: {},
      };
    }
    return S.mock;
  }

  function stopMockTimer() {
    if (S.mockTimer) {
      window.clearInterval(S.mockTimer);
      S.mockTimer = null;
    }
  }

  function formatClock(seconds) {
    var mm = Math.floor(seconds / 60);
    var ss = seconds % 60;
    return (mm < 10 ? "0" : "") + mm + ":" + (ss < 10 ? "0" : "") + ss;
  }

  // 单次 tick：倒计时 = 不可变限额 - 已过整秒（t28：remaining 只作派生值）
  function mockTick(M) {
    if (!M || M.phase !== "running" || !M.startedAt) return;
    var elapsedSec = Math.floor((Date.now() - M.startedAt) / 1000);
    var left = Math.max(0, M.limitSec - elapsedSec);
    M.remaining = left;
    var timerNode = $("mockTimer");
    if (timerNode) {
      timerNode.textContent = formatClock(left);
      timerNode.className = "timer" + (left <= 300 ? " danger" : "");
    }
    if (left <= 0) submitMock(true);
  }

  // t31 F-02 计时自愈：只要场次仍在 running 且已有 startedAt，就保证存在活动定时器，
  // 并按真实经过时间**继续**倒数；绝不重设 startedAt、绝不把 remaining 拉回 limitSec（不会回到 60:00）。
  function ensureMockTimer() {
    var M = S.mock;
    if (!M || M.phase !== "running" || !M.startedAt) return;
    if (S.mockTimer) return; // 已有活动定时器，保持原样
    S.mockTimer = window.setInterval(function () {
      mockTick(M);
    }, 500);
    mockTick(M); // 立即同步一次（若冻结期间已超过限额，这里就会按原限额自动交卷）
  }

  function startMock() {
    var M = mockState();
    var paper = CQP.buildMockPaper({ bank: S.bank, nowISO: CQP.isoNow() });
    M.paper = paper;
    M.phase = "running";
    M.responses = {};
    M.idx = 0;
    M.marked = {};
    M.limitSec = paper.timeLimitSec; // 不可变基准：倒计时只从它扣
    M.remaining = paper.timeLimitSec; // 派生值：每次 tick 由 limitSec - 已过整秒 重算
    M.startedAt = Date.now();
    M.session = null;
    M.enteredAt = Date.now();
    M.bookSnapshot = {};
    paper.questionIds.forEach(function (qid) {
      M.responses[qid] = { myAnswer: [], confidence: "confident", elapsedMs: 0 };
    });
    stopMockTimer();
    ensureMockTimer();
    render();
  }

  function collectMockAnswer(question, silent) {
    var M = mockState();
    var response = M.responses[question.id];
    var mode = CQP.responseModeOf(question);
    if (mode === "blank") {
      var input = $("mockBlank");
      if (input) response.myAnswer = input.value.length ? [input.value] : [];
    } else {
      var picked = [];
      var nodes = document.querySelectorAll('input[name="mockOpt"]:checked');
      for (var i = 0; i < nodes.length; i += 1) picked.push(nodes[i].value);
      response.myAnswer = picked;
    }
    if (!silent) render();
  }

  function mockGoto(index, silent) {
    var M = mockState();
    var current = M.paper.questionIds[M.idx];
    M.responses[current].elapsedMs += Math.max(0, Date.now() - M.enteredAt);
    M.enteredAt = Date.now();
    M.idx = Math.max(0, Math.min(index, M.paper.questionIds.length - 1));
    if (!silent) render();
  }

  function flushMockRecords(sessionId) {
    var M = mockState();
    var written = 0;
    M.paper.questionIds.forEach(function (qid) {
      var response = M.responses[qid];
      if (!response || response.myAnswer.length === 0) return;
      var question = S.qById.get(qid);
      if (!question) return;
      var record = CQP.makeRecord({
        question: question,
        myAnswer: response.myAnswer,
        confidence: response.confidence || "confident",
        elapsedMs: response.elapsedMs,
        mode: "mock",
        nickname: nick(),
        bankVersion: bankVersion(),
        appVersion: CQP.VERSION,
        sessionId: sessionId,
        nowISO: CQP.isoNow(),
      });
      var appended = CQP.appendRecord(S.store, record);
      if (appended.added) written += 1;
    });
    if (written > 0) persist();
    return written;
  }

  function abandonMock() {
    var M = mockState();
    if (M.phase !== "running") return;
    flushMockRecords(null);
    stopMockTimer();
    M.phase = "setup";
    M.paper = null;
    M.responses = {};
    M.bookSnapshot = {};
    toast("已退出模拟赛：本次成绩作废，已答题目保留为作答记录");
  }

  function submitMock(auto) {
    var M = mockState();
    if (M.phase !== "running") return;
    var currentQid = M.paper.questionIds[M.idx];
    M.responses[currentQid].elapsedMs += Math.max(0, Date.now() - M.enteredAt);
    collectMockAnswer(S.qById.get(currentQid), true);
    var session = CQP.gradeMock({
      paper: M.paper,
      responses: M.responses,
      bank: S.bank,
      submittedAtISO: CQP.isoNow(),
      autoSubmitted: !!auto,
      nickname: nick(),
    });
    CQP.appendSession(S.store, session);
    M.session = session;
    M.phase = "result";
    stopMockTimer();
    flushMockRecords(session.sessionId);
    persist();
    render();
    if (auto) infoBox("时间到，已自动交卷", "<p>系统按你提交时（60 分钟到点）的作答情况计分。</p>");
  }

  // 规格 13.2 + 队长 t12 裁决：交卷后可在成绩页「逐题」改信心。
  // ① 写回 session.responses[qid].confidence 并按 CQP.color() 重算颜色；
  // ② 错题本按进入前快照重算（幂等）：黄（correct && guessed）→ 入册，绿↔黄来回切换可正确出册/入册；
  // ③ 同步本次模拟赛该题的作答记录（同 recordKey 原地更新），使掌握指数按新信心计权（猜对 ×0.5）。
  function mockBookSnapshot(qid) {
    var M = mockState();
    if (!M.bookSnapshot) M.bookSnapshot = {};
    if (!Object.prototype.hasOwnProperty.call(M.bookSnapshot, qid)) {
      var existing = bookEntryOf(qid);
      // t24 F-01c：快照懒建立时，removed 条目必须视为「不在册」（had=false），
      // 否则「模拟赛入册 → 手动移出 → 成绩页首次改信心」会按 had=true 重放并复活；
      // entry 仍按原样保存（含 removed），回放时只恢复、不删除用户移出的条目。
      M.bookSnapshot[qid] = {
        had: bookEntryCountsAsInBook(existing),
        entry: existing === null ? null : cloneBookEntry(existing),
        written: false,
        after: null,
      };
    }
    return M.bookSnapshot[qid];
  }

  // t16 F-01 同款安全阀：若用户在上次写入之后显式改过该条目（例如去错题本手动移出），
  // 本次不回放旧快照，只把基线重置为当前状态（用户操作优先）。
  function refreshMockBookBaseline(qid, snapshot) {
    var current = bookEntryOf(qid);
    var onBaseline = sameBookEntry(current, snapshot.entry);
    var onLastWrite = snapshot.written === true && sameBookEntry(current, snapshot.after);
    if (!onBaseline && !onLastWrite) {
      snapshot.entry = cloneBookEntry(current);
      snapshot.had = bookEntryCountsAsInBook(current);
      snapshot.written = true;
      snapshot.after = cloneBookEntry(current);
      return false;
    }
    return true;
  }

  function syncMockRecordConfidence(qid, conf, sessionId) {
    var changed = 0;
    for (var i = 0; i < S.store.records.length; i += 1) {
      var record = S.store.records[i];
      if (!record || record.mode !== "mock" || record.qid !== qid) continue;
      if (sessionId && record.sessionId !== sessionId) continue;
      record.confidence = conf;
      record.color = CQP.color({ correct: record.correct, confidence: conf });
      changed += 1;
    }
    return changed;
  }

  function setMockConfidence(qid, conf) {
    var M = mockState();
    if (!M.session) return;
    var response = M.session.responses[qid];
    if (!response) return;
    if (conf !== "guessed" && conf !== "confident") return;
    response.confidence = conf;
    var question = S.qById.get(qid);
    var snapshot = mockBookSnapshot(qid);
    // 恢复「本题改信心之前」的错题本状态，再按 8.3 语义决定是否重新入册（幂等，不重复计数）；
    // 恢复前先校验基线，避免覆盖用户后来的手动移出等显式操作（t16 F-01）
    if (question) {
      if (refreshMockBookBaseline(qid, snapshot)) {
        if (snapshot.entry !== null) S.store.wrongbook[qid] = cloneBookEntry(snapshot.entry);
        else delete S.store.wrongbook[qid];
        // t24 F-01c：基线是 removed（用户手动移出 / 自动移出）时只恢复状态，跳过 8.3 重放，
        // 避免「成绩页首次改信心」立刻把已移出的题复活；新一次模拟赛作答仍按 8.3 正常入册。
        var baselineRemoved = snapshot.entry !== null && snapshot.entry.state === "removed";
        var entersByGuessed = response.correct === true && conf === "guessed";
        if (!baselineRemoved && (snapshot.had || entersByGuessed)) {
          var record = CQP.makeRecord({
            question: question,
            myAnswer: Array.isArray(response.myAnswer) ? response.myAnswer : [],
            confidence: conf,
            elapsedMs: response.elapsedMs,
            mode: "mock",
            nickname: nick(),
            bankVersion: bankVersion(),
            appVersion: CQP.VERSION,
            sessionId: M.session.sessionId,
            nowISO: M.session.submittedAt,
          });
          var applied = CQP.wrongbookApply(S.store.wrongbook, record, CQP.isoNow(), { force: true });
          S.store.wrongbook = applied.book;
        }
        snapshot.written = true;
        snapshot.after = cloneBookEntry(bookEntryOf(qid));
      }
    }
    syncMockRecordConfidence(qid, conf, M.session.sessionId);
    persist();
    render();
    toast("已把该题标为「" + (conf === "guessed" ? "带猜测" : "有把握") + "」；颜色 " + CQP.color({ correct: response.correct, confidence: conf }));
  }

  function renderMock() {
    var M = mockState();
    // t31 F-02：渲染考场即保证计时器活动（自愈，不重置 startedAt / remaining）
    if (M.phase === "running") ensureMockTimer();
    if (M.phase === "setup") {
      var dist = CQP.computeMockDistribution(S.bank.questions, CQP.MOCK_LIMITS.count);
      return (
        '<div class="card"><h1>模拟选拔赛</h1>' +
        '<div class="kv"><div class="item"><div class="k">题量</div><div class="v">100 题</div></div>' +
        '<div class="item"><div class="k">限时</div><div class="v">60 分钟</div></div>' +
        '<div class="item"><div class="k">满分</div><div class="v">100 分</div></div>' +
        '<div class="item"><div class="k">交卷</div><div class="v small">手动交卷（二次确认）或到点自动交卷</div></div></div>' +
        '<div class="muted mt12">按官方赛制：理论知识 100 题 / 60 分钟 / 100 分，超时系统自动提交。<br>' +
        "抽题分布（按题库池占比的两级最大余数法）：填空 " + dist.byType.blank + " / 多选 " + dist.byType.multiple + " / 单选 " + dist.byType.single + " / 判断 " + dist.byType.judge +
        "；章分布 " + CQP.CHAPTER_CODES.map(function (code) { return code.slice(1) + ":" + dist.byChapter[code]; }).join(" ") + "。<br>" +
        "答题期间不显示对错与答案、不提供信心选择；交卷后按 填空→多选→单选→判断 给出得分与用时；模拟赛不自动写错题本（成绩页可一键加入）。</div>" +
        '<div class="row mt12"><button class="primary big" data-act="mock-start">开始答题</button></div></div>'
      );
    }
    if (M.phase === "result") {
      var session = M.session;
      var result = session.result;
      var typeRows = CQP.MOCK_TYPE_ORDER.map(function (type) {
        var row = result.byType[type];
        return "<tr><td>" + esc(CQP.TYPE_NAMES[type]) + '</td><td class="num">' + row.score + " / " + row.total + '</td><td class="num">' +
          Math.round(row.elapsedMs / 1000) + " 秒</td></tr>";
      });
      // 逐题信心切换控件：全部题目（含答对的题）共用同一套按钮 → 同一 setMockConfidence
      var confidenceCellHtml = function (qid, response) {
        var cellColor = CQP.color({ correct: response.correct, confidence: response.confidence });
        var inBook = Object.prototype.hasOwnProperty.call(S.store.wrongbook, qid);
        var entry = inBook ? S.store.wrongbook[qid] : null;
        return colorBadge(cellColor) +
          (inBook ? ' <span class="badge flag">已在错题本' + (entry && entry.confidentStreak ? "（连续有把握 " + entry.confidentStreak + "）" : "") + "</span>" : "") +
          '<div class="nowrap mt8"><button class="small' + (response.confidence === "confident" ? " primary" : "") + '" data-act="mock-conf" data-qid="' +
          esc(qid) + '" data-conf="confident">有把握</button>' +
          '<button class="small' + (response.confidence === "guessed" ? " primary" : "") + '" data-act="mock-conf" data-qid="' +
          esc(qid) + '" data-conf="guessed">带猜测</button></div>';
      };

      // 全部题目清单（含正确题），不再只渲染错题
      var allRows = session.questionIds.map(function (qid, index) {
        var response = session.responses[qid];
        var question = S.qById.get(qid);
        return '<tr><td class="num">' + (index + 1) + "</td>" +
          "<td>" + esc(trim(question ? question.stem : qid, 60)) + '</td>' +
          '<td class="mono">' + esc(response.myAnswer.join("") || "（未答）") + '</td>' +
          '<td class="mono">' + esc(question ? CQP.answerText(question) : "") + "</td>" +
          "<td>" + (response.correct ? '<span class="badge green">正确</span>' : '<span class="badge red">错误</span>') + "</td>" +
          "<td>" + confidenceCellHtml(qid, response) + "</td></tr>";
      }).join("");

      // 抽题分布：由 paper.distribution 的实际值渲染（byType / byChapter）
      var paper = M.paper;
      var distHtml = "";
      if (paper && paper.distribution) {
        var distByType = paper.distribution.byType || {};
        var distByChapter = paper.distribution.byChapter || {};
        distHtml =
          '<h2>本次抽题分布（实际值）</h2><div class="table-wrap" style="max-height:200px"><table><thead><tr><th>题型</th>' +
          CQP.MOCK_TYPE_ORDER.map(function (type) { return '<th class="num">' + esc(CQP.TYPE_NAMES[type]) + "</th>"; }).join("") +
          '</tr></thead><tbody><tr><td>题量</td>' +
          CQP.MOCK_TYPE_ORDER.map(function (type) { return '<td class="num">' + (distByType[type] || 0) + "</td>"; }).join("") +
          "</tr></tbody></table>" +
          '<table><thead><tr><th>章</th>' +
          CQP.CHAPTER_CODES.map(function (code) { return '<th class="num">' + esc(code) + "</th>"; }).join("") +
          '</tr></thead><tbody><tr><td>题量</td>' +
          CQP.CHAPTER_CODES.map(function (code) { return '<td class="num">' + (distByChapter[code] || 0) + "</td>"; }).join("") +
          "</tr></tbody></table></div>";
      }

      return (
        '<div class="card"><h1>模拟赛成绩</h1>' +
        (session.autoSubmitted ? '<div class="result-box yellow">到点自动交卷（成绩以提交时作答情况为准）</div>' : "") +
        '<div class="kv mt12"><div class="item"><div class="k">总分</div><div class="v">' + result.score + " / " + result.maxScore + "</div></div>" +
        '<div class="item"><div class="k">答对</div><div class="v">' + result.correctCount + "</div></div>" +
        '<div class="item"><div class="k">未作答</div><div class="v">' + result.unansweredCount + "</div></div>" +
        '<div class="item"><div class="k">总用时</div><div class="v small">' + Math.round(result.totalElapsedMs / 1000) + " 秒</div></div></div>" +
        '<h2>分项成绩（填空 → 多选 → 单选 → 判断）</h2><div class="table-wrap" style="max-height:220px"><table><thead><tr><th>题型</th><th class="num">得分 / 题数</th><th class="num">用时</th></tr></thead><tbody>' +
        typeRows.join("") + "</tbody></table></div>" +
        '<div class="muted mt8">排序键 rankKey = [总分, -总用时(毫秒), 填空得分, 多选得分, 单选得分, 判断得分] = <span class="mono">' + esc(JSON.stringify(result.rankKey)) + "</span>（越大越靠前，对齐官方同分排名细则）</div>" +
        distHtml +
        '<div class="row mt12"><button class="primary" data-act="mock-wrong-to-book">把本次错题加入错题本</button>' +
        '<button data-act="mock-again">再来一次</button><button data-act="go" data-page="stats">查看学习统计</button></div></div>' +
        '<div class="card"><h2>全部 ' + session.questionIds.length + " 题（逐题改信心）</h2>" +
        '<div class="muted">模拟赛答题期按 §13.2 不收集信心，这里是唯一补记入口：给答对的题标「带猜测」→ 颜色变黄并按 8.3 进入错题本、掌握指数按 0.5 计权；再改回「有把握」→ 撤回本次计入并出册（回到改信心之前的错题本状态）。已在错题本的题按 8.3 更新连续「有把握答对」计数。</div>' +
        '<div class="table-wrap mt8" style="max-height:420px"><table><thead><tr><th class="num">#</th><th>题目</th><th>你的答案</th><th>正确答案</th><th>判定</th><th>信心 / 颜色</th></tr></thead><tbody>' +
        allRows + "</tbody></table></div></div>"
      );
    }

    var question = S.qById.get(M.paper.questionIds[M.idx]);
    var response = M.responses[question.id];
    var mode = CQP.responseModeOf(question);
    var optionsHtml = "";
    if (mode === "blank") {
      optionsHtml = '<div class="row"><input class="blank-input" type="text" id="mockBlank" value="' + esc(response.myAnswer.length ? response.myAnswer[0] : "") + '" placeholder="请输入答案"></div>';
    } else {
      var values = mode === "judge" ? ["对", "错"] : question.options.map(function (option) { return option.key; });
      for (var i = 0; i < values.length; i += 1) {
        var value = values[i];
        var text = mode === "judge" ? (value === "对" ? "对（正确）" : "错（错误）") : question.options[i] ? question.options[i].text : "";
        var checked = response.myAnswer.indexOf(value) >= 0 ? " checked" : "";
        optionsHtml += '<label class="option' + (checked ? " selected" : "") + '"><input type="' + (mode === "multiple" ? "checkbox" : "radio") +
          '" name="mockOpt" value="' + esc(value) + '" data-act="mock-opt"' + checked + '><span class="key">' +
          esc(mode === "judge" ? (value === "对" ? "√" : "×") : value) + "</span><span>" + esc(text) + "</span></label>";
      }
    }
    var answered = M.paper.questionIds.filter(function (qid) { return M.responses[qid].myAnswer.length > 0; }).length;
    var panel = M.paper.questionIds.map(function (qid, index) {
      var cls = "";
      if (M.responses[qid].myAnswer.length > 0) cls += " answered";
      if (M.marked[qid]) cls += " marked";
      if (index === M.idx) cls += " current";
      return '<button class="' + cls.trim() + '" data-act="mock-goto" data-index="' + index + '">' + (index + 1) + "</button>";
    }).join("");

    return (
      '<div class="card"><div class="row between"><div class="row">' +
      '<span>第 <b>' + (M.idx + 1) + "</b> / 100 题</span>" +
      '<span class="muted">已答 ' + answered + " 题 ｜ 未答 " + (100 - answered) + " 题</span></div>" +
      '<div class="row"><span id="mockTimer" class="timer' + (M.remaining <= 300 ? " danger" : "") + '">' + formatClock(M.remaining) + "</span>" +
      '<button data-act="mock-mark">' + (M.marked[question.id] ? "取消标记" : "标记待回看") + "</button>" +
      '<button class="danger" data-act="mock-submit">交卷</button></div></div></div>' +

      '<div class="split"><div class="card"><h3>题号面板</h3><div class="qpanel">' + panel + "</div>" +
      '<div class="muted mt8">蓝=已答，黄=已标记，深色=当前题。答题期间不显示对错与答案。</div>' +
      '<div class="row mt8"><button data-act="mock-goto" data-index="' + Math.max(0, M.idx - 1) + '">上一题</button>' +
      '<button class="primary" data-act="mock-goto" data-index="' + Math.min(99, M.idx + 1) + '">下一题</button></div></div>' +

      '<div class="card qcard"><div class="row between"><div class="muted">' + esc(question.chapterName) + " ｜ " + esc(question.typeName) +
      (question.printedNo ? " ｜ 打印第 " + question.printedNo + " 题" : "") + "</div><div>" +
      (question.tags || []).map(function (tag) { return '<span class="badge gray">' + esc(tag) + "</span>"; }).join("") + "</div></div>" +
      '<div class="stem">' + esc(question.stem) + "</div>" + optionsHtml +
      '<div class="row mt12"><button data-act="mock-prev">上一题</button><button class="primary" data-act="mock-next">下一题</button>' +
      '<span class="muted">切换题目时会结算本题用时。</span></div></div></div>'
    );
  }

  // ------------------------------------------------------------ 校对纠错 P9
  function renderReview() {
    var filter = S.reviewFilter;
    var keyword = filter.keyword.trim();
    var list = S.bank.questions.filter(function (question) {
      if (filter.chapter && question.chapterCode !== filter.chapter) return false;
      if (keyword && question.stem.indexOf(keyword) < 0 && question.id.indexOf(keyword) < 0) return false;
      var item = S.store.overrides.items[question.id];
      if (filter.kind === "flagged") return CQP.isFlagged(S.store.overrides, question.id);
      if (filter.kind === "needsReview") return question.needsReview === true;
      if (filter.kind === "changed") return !!(item && Array.isArray(item.answer) && item.answer.length > 0);
      return true;
    });
    var shown = list.slice(0, S.reviewLimit);

    var rows = shown.map(function (question) {
      var mode = CQP.responseModeOf(question);
      var item = S.store.overrides.items[question.id];
      var currentAnswer = question.answer && question.answer.length ? question.answer.join(" / ") : "（缺答案）";
      var flagged = CQP.isFlagged(S.store.overrides, question.id);
      return '<div class="card tight"><div class="row between"><div class="muted mono">' + esc(question.id) + " ｜ " + esc(question.chapterName) + " ｜ " + esc(question.typeName) +
        (question.printedNo ? " ｜ 打印第 " + question.printedNo + " 题" : " ｜ 未编号题") +
        (question.needsReview ? ' ｜ <span class="badge flag">待校对' + (question.reviewReason ? "：" + esc(question.reviewReason) : "") + "</span>" : "") +
        (flagged ? ' ｜ <span class="badge flag">已标疑问</span>' : "") +
        (item ? ' ｜ <span class="badge gray">覆盖层 rev' + item.rev + " · " + esc(item.updatedBy || "-") + "</span>" : "") + "</div>" +
        '<div class="muted">当前答案：<span class="mono">' + esc(currentAnswer) + "</span></div></div>" +
        '<div class="stem">' + esc(trim(question.stem, 400)) + "</div>" +
        (question.options.length ? '<div class="muted">' + question.options.map(function (option) { return esc(option.key + "." + option.text); }).join(" ｜ ") + "</div>" : "") +
        '<div class="row mt8"><label class="inline">改答案 <input type="text" data-act="review-answer" data-qid="' + esc(question.id) +
        '" value="' + esc(item && Array.isArray(item.answer) ? item.answer.join(",") : "") + '" placeholder="' +
        esc(mode === "blank" ? "多答案用逗号分隔，例如 SM4,SM4算法" : "例如 ABD") + '" style="min-width:220px"></label>' +
        '<label class="inline"><input type="checkbox" data-act="review-flag" data-qid="' + esc(question.id) + '"' + (flagged ? " checked" : "") + "> 标疑问</label>" +
        '<input type="text" data-act="review-note" data-qid="' + esc(question.id) + '" maxlength="200" placeholder="备注（≤200 字）" value="' + esc(item ? item.note : "") + '" style="min-width:220px">' +
        '<button class="primary small" data-act="review-save" data-qid="' + esc(question.id) + '">保存</button>' +
        '<button class="small" data-act="review-reset" data-qid="' + esc(question.id) + '">恢复原值</button></div></div>';
    });

    return (
      '<div class="card"><h1>校对 / 纠错</h1><div class="row">' +
      '<label class="inline">筛选 <select data-act="review-kind">' +
      option("flagged", "已标疑问", filter.kind) + option("needsReview", "待校对（题库缺陷）", filter.kind) +
      option("changed", "已改答案", filter.kind) + option("all", "全部题目", filter.kind) + "</select></label>" +
      '<label class="inline">章 <select data-act="review-chapter"><option value="">全部</option>' +
      S.bank.chapters.map(function (chapter) { return option(chapter.chapterCode, chapter.chapterName, filter.chapter); }).join("") + "</select></label>" +
      '<input type="text" data-act="review-keyword" placeholder="搜索题干或题号" value="' + esc(filter.keyword) + '" style="min-width:200px">' +
      '<span class="badge blue">命中 ' + list.length + " 题</span>" +
      '<span class="muted">修正本地立即生效，并随导出共享（按 updatedAt 后写覆盖）；导入他人文件后自动应用。</span></div></div>' +
      (rows.length ? rows.join("") : '<div class="card"><div class="muted">没有符合条件的题目。</div></div>') +
      (list.length > shown.length ? '<div class="card"><button data-act="review-more">显示更多（剩余 ' + (list.length - shown.length) + " 题）</button></div>" : "") +
      '<div class="card" style="border-color:#fca5a5"><h2>危险操作区</h2>' +
      '<div class="muted">以下操作不可撤销，建议先「导出全部备份」；覆盖层与作答记录都在本机浏览器里，清空后无法恢复。</div>' +
      '<div class="row mt8"><button data-act="export-backup">导出全部备份</button>' +
      '<button data-act="data-raw">导出原始存储内容（排查用）</button>' +
      '<button class="danger" data-act="clear-data">清空本地数据（二次确认）</button></div></div>'
    );
  }

  function saveReview(qid) {
    var answerInput = document.querySelector('[data-act="review-answer"][data-qid="' + qid + '"]');
    var flagInput = document.querySelector('[data-act="review-flag"][data-qid="' + qid + '"]');
    var noteInput = document.querySelector('[data-act="review-note"][data-qid="' + qid + '"]');
    var question = S.qById.get(qid);
    var mode = CQP.responseModeOf(question);
    var raw = answerInput ? answerInput.value : "";
    var parsed = raw.trim().length ? CQP.parseAnswerInput(raw, mode) : null;
    S.store.overrides = CQP.setOverride(S.store.overrides, qid, {
      answer: parsed,
      flagged: !!(flagInput && flagInput.checked),
      note: noteInput ? noteInput.value : "",
      updatedBy: nick(),
      nowISO: CQP.isoNow(),
    });
    refreshBank();
    persist();
    render();
    toast("已保存到覆盖层");
  }

  function resetReview(qid) {
    S.store.overrides = CQP.setOverride(S.store.overrides, qid, {
      answer: null,
      updatedBy: nick(),
      nowISO: CQP.isoNow(),
    });
    refreshBank();
    persist();
    render();
    toast("已恢复题库原答案（标疑问保留）");
  }

  function toggleFlag(qid, on) {
    S.store.overrides = CQP.setOverride(S.store.overrides, qid, { flagged: on, updatedBy: nick(), nowISO: CQP.isoNow() });
    refreshBank();
    persist();
  }

  // ------------------------------------------------------------ 路由与事件
  function go(page, skipGuard) {
    if (!skipGuard && S.mock && S.mock.phase === "running" && page !== "mock") {
      confirmBox("正在模拟赛中", "<p>离开将结束本次模拟赛：本次成绩作废，已答题目会保留为作答记录（计入学习统计）。</p>", function () {
        abandonMock(); // 作废 + 停表
        go(page, true);
      }, "离开并作废");
      return; // 用户点「取消」→ 留在考场，计时不受任何影响
    }
    // t31 F-02：只有真正离开模拟赛页（或场次未在运行）才停表。
    // 目标是 mock 页（含点击当前导航项「模拟选拔赛」）时必须保持计时，不得冻结倒计时。
    if (page !== "mock") stopMockTimer();
    S.page = page;
    render(); // renderMock() 内含 ensureMockTimer()，回到考场会自动恢复计时
  }

  function render() {
    var main = $("main");
    var html = "";
    if (!S.bank) {
      html = '<div class="card"><h1>无法启动</h1><p>内嵌题库缺失或损坏。</p></div>';
      main.innerHTML = html;
      return;
    }
    if (!S.store.meta.nickname) ensureNickname();
    switch (S.page) {
      case "setup": html = renderSetup(); break;
      case "practice": html = renderPractice(); break;
      case "result": html = renderResult(); break;
      case "wrongbook": html = renderWrongbook(); break;
      case "stats": html = renderStats(); break;
      case "team": html = renderTeam(); break;
      case "io": html = renderIO(); break;
      case "mock": html = renderMock(); break;
      case "review": html = renderReview(); break;
      default: html = renderHome(); break;
    }
    main.innerHTML = html;
    $("whoami").textContent = (S.store.meta.nickname || "未命名") + " ｜ 在册错题 " + CQP.wrongbookCountActive(S.store.wrongbook) + " ｜ 记录 " + S.store.records.length;
    var navButtons = document.querySelectorAll("#nav button");
    for (var i = 0; i < navButtons.length; i += 1) {
      var target = navButtons[i].getAttribute("data-nav");
      var active = target === S.page || (target === "setup" && (S.page === "practice" || S.page === "result"));
      navButtons[i].className = active ? "active" : "";
    }
    if (S.page === "practice" && S.practice) {
      var item = practiceItem(S.practice.idx);
      if (!item.submitted && !item.enteredAt) item.enteredAt = Date.now();
    }
  }

  function handleAction(act, el, event) {
    switch (act) {
      case "go": go(el.getAttribute("data-page")); break;
      case "io-page": go("io"); break;
      case "nick-edit": changeNickname(); break;
      case "sel-tag-clear": S.sel.tags = []; render(); break;
      case "sel-tag": {
        var tag = el.getAttribute("data-tag");
        // 防御：外部替换 S.sel 时 tags 可能缺失（t11 O-6）
        if (!Array.isArray(S.sel.tags)) S.sel.tags = [];
        var index = S.sel.tags.indexOf(tag);
        if (index >= 0) S.sel.tags.splice(index, 1); else S.sel.tags.push(tag);
        render();
        break;
      }
      case "start-practice": {
        var pool = candidatePool();
        if (pool.length === 0) { toast("没有符合条件的题目，请放宽筛选条件"); return; }
        var count = Math.max(1, Math.min(Number(S.sel.count) || 20, S.bank.questions.length));
        var questions = CQP.drawQuestions({
          bank: S.bank,
          chapters: S.sel.mode === "practice_random" ? [] : effectiveChapters(),
          types: S.sel.mode === "practice_random" ? [] : S.sel.types,
          tags: S.sel.mode === "practice_random" ? [] : S.sel.tags,
          count: count,
        });
        if (questions.length === 0) { toast("没有符合条件的题目，请放宽筛选条件"); return; }
        startPractice(S.sel.mode, questions, {
          title: S.sel.mode === "practice_random" ? "全库随机" : "分类练习",
        });
        break;
      }
      case "prac-submit": submitCurrent(); break;
      case "conf": setConfidence(el.getAttribute("data-conf")); break;
      case "prac-next": nextQuestion(); break;
      case "prac-skip": skipQuestion(); break;
      case "prac-prev": prevQuestion(); break;
      case "prac-finish": finishPractice(); break;
      case "prac-again": {
        var last = S.practice;
        S.practice = null;
        if (last && last.mode === "wrongbook") { go("wrongbook"); return; }
        go("setup");
        break;
      }
      case "flag-toggle": {
        var qidFlag = el.getAttribute("data-qid");
        toggleFlag(qidFlag, !CQP.isFlagged(S.store.overrides, qidFlag));
        render();
        toast("已更新标疑问");
        break;
      }
      case "review-q": go("review"); break;
      case "wrong-remove": {
        var qidRemove = el.getAttribute("data-qid");
        var removed = CQP.wrongbookRemoveManual(S.store.wrongbook, qidRemove, CQP.isoNow());
        S.store.wrongbook = removed.book;
        persist();
        render();
        toast("已手动移出错题本（作答记录保留）");
        break;
      }
      case "wrong-readd": {
        var qidAdd = el.getAttribute("data-qid");
        var questionAdd = S.qById.get(qidAdd);
        var fake = CQP.makeRecord({
          question: questionAdd,
          myAnswer: [],
          confidence: "confident",
          elapsedMs: 0,
          mode: "practice_chapter",
          nickname: nick(),
          bankVersion: bankVersion(),
          appVersion: CQP.VERSION,
          nowISO: CQP.isoNow(),
        });
        var reapplied = CQP.wrongbookApply(S.store.wrongbook, Object.assign({}, fake, { correct: false }), CQP.isoNow());
        S.store.wrongbook = reapplied.book;
        persist();
        render();
        toast("已重新加入错题本");
        break;
      }
      case "wrong-single": {
        var question = S.qById.get(el.getAttribute("data-qid"));
        startPractice("wrongbook", [question], { title: "错题重练（单题）" });
        break;
      }
      case "wrong-practice": {
        var active = CQP.wrongbookList(S.store.wrongbook, S.bank.questions, { state: "active" }).map(function (row) { return row.question; });
        if (active.length === 0) { toast("错题本为空"); return; }
        var drawn = CQP.drawQuestions({ bank: { questions: active }, count: active.length });
        startPractice("wrongbook", drawn, { title: "错题重练" });
        break;
      }
      case "stats-more": S.detailLimit += 60; render(); break;
      case "review-more": S.reviewLimit += 60; render(); break;
      case "review-save": saveReview(el.getAttribute("data-qid")); break;
      case "review-reset": resetReview(el.getAttribute("data-qid")); break;
      case "export": {
        // t41 F-03：阻断态导出必须能救命——改从磁盘原始数据组装，不再从空内存 store 取数
        if (S.storageBlocked) {
          var rescueDay = rescuePayload();
          downloadText(rescueFileName(), JSON.stringify(rescueDay, null, 2));
          toast("抢救模式：已导出浏览器里的原始数据（" + rescueDay.counts.records + " 条作答记录，本次未写入任何数据）");
          break;
        }
        var payload = CQP.exportPayload({
          store: S.store,
          scope: S.io.scope,
          from: S.io.scope === "all" ? null : S.io.from,
          to: S.io.scope === "range" ? S.io.to : S.io.scope === "day" ? S.io.from : null,
          nickname: nick(),
          bankVersion: bankVersion(),
          nowISO: CQP.isoNow(),
        });
        downloadText(CQP.exportFileName({ nickname: nick(), scope: S.io.scope, from: S.io.from, to: S.io.to }), JSON.stringify(payload, null, 2));
        toast("已导出 " + payload.counts.records + " 条作答记录");
        break;
      }
      case "export-backup": {
        if (S.storageBlocked) {
          var rescueAll = rescuePayload();
          downloadText(rescueFileName(), JSON.stringify(rescueAll, null, 2));
          toast("抢救模式：已导出浏览器里的原始数据（" + rescueAll.counts.records + " 条作答记录，本次未写入任何数据）");
          break;
        }
        var all = CQP.exportPayload({ store: S.store, scope: "all", nickname: nick(), bankVersion: bankVersion(), nowISO: CQP.isoNow() });
        downloadText(CQP.exportFileName({ nickname: nick(), scope: "all" }), JSON.stringify(all, null, 2));
        toast("已导出全部备份（" + all.counts.records + " 条记录）");
        break;
      }
      case "import-confirm": confirmImport(); break;
      case "import-cancel": S.io.pending = null; render(); break;
      case "clear-data": {
        // t41 F-03：只读抢救模式下不得清空——那会毁掉用户正要抢救的数据
        if (S.storageBlocked) {
          infoBox("只读抢救模式", "<p>当前本地数据不可用（" + esc(blockedReasonText()) + "），程序处于只读抢救模式：<b>不会写入、也不会清空任何数据</b>。请先用「导出抢救备份」把浏览器里的原始数据保存出来。</p>");
          break;
        }
        confirmBox("清空本地数据", "<p>将删除本机全部作答记录、错题本、覆盖层、模拟赛记录与导入台账（不可恢复）。建议先导出备份。</p>", function () {
          confirmBox("再次确认", "<p>确定要清空吗？此操作不可撤销。</p>", function () {
            CQP.storage.reset();
            CQP.resetMemoryStore();
            S.store = CQP.emptyStore();
            CQP.setStore(S.store);
            refreshBank();
            S.practice = null;
            S.mock = null;
            render();
            toast("本地数据已清空");
          }, "确定清空");
        }, "继续");
        break;
      }
      case "mock-start": startMock(); break;
      case "mock-goto": collectMockAnswer(S.qById.get(S.mock.paper.questionIds[S.mock.idx]), true); mockGoto(Number(el.getAttribute("data-index"))); break;
      case "mock-prev": collectMockAnswer(S.qById.get(S.mock.paper.questionIds[S.mock.idx]), true); mockGoto(S.mock.idx - 1); break;
      case "mock-next": collectMockAnswer(S.qById.get(S.mock.paper.questionIds[S.mock.idx]), true); mockGoto(S.mock.idx + 1); break;
      case "mock-mark": {
        var currentQid = S.mock.paper.questionIds[S.mock.idx];
        S.mock.marked[currentQid] = !S.mock.marked[currentQid];
        render();
        break;
      }
      case "mock-submit": {
        var M = mockState();
        var answered = M.paper.questionIds.filter(function (qid) { return M.responses[qid].myAnswer.length > 0; }).length;
        confirmBox("确认交卷？", "<p>已答 " + answered + " 题，未答 " + (100 - answered) + " 题（按错计分）。交卷后不能修改答卷。</p>", function () { submitMock(false); }, "交卷");
        break;
      }
      case "mock-again": S.mock = null; render(); break;
      case "mock-conf": setMockConfidence(el.getAttribute("data-qid"), el.getAttribute("data-conf")); break;
      case "stats-sort": {
        var table = el.getAttribute("data-table");
        var key = el.getAttribute("data-key");
        var current = S.statsSort[table] || { key: key, dir: "desc" };
        var textKeys = ["chapterCode", "chapterName", "qid", "typeName", "order"];
        S.statsSort[table] = current.key === key
          ? { key: key, dir: current.dir === "asc" ? "desc" : "asc" }
          : { key: key, dir: textKeys.indexOf(key) >= 0 ? "asc" : "desc" };
        render();
        break;
      }
      case "data-raw": {
        var backend = CQP.storage.backend();
        var dump = {};
        var storeKeys = CQP.storage.keys();
        for (var k = 0; k < storeKeys.length; k += 1) {
          try {
            dump[storeKeys[k]] = backend && backend.getItem ? backend.getItem(storeKeys[k]) : null;
          } catch (err) {
            dump[storeKeys[k]] = "(读取失败)";
          }
        }
        downloadText("密码赛原始存储_" + CQP.localStamp(new Date()) + ".txt", JSON.stringify(dump, null, 2));
        toast("已导出原始存储内容（用于排查）");
        break;
      }
      case "mock-wrong-to-book": {
        var session = S.mock.session;
        var added = 0;
        session.questionIds.forEach(function (qid) {
          var response = session.responses[qid];
          if (response.correct) return;
          var question = S.qById.get(qid);
          var record = CQP.makeRecord({
            question: question,
            myAnswer: response.myAnswer,
            confidence: "confident",
            elapsedMs: response.elapsedMs,
            mode: "mock",
            nickname: nick(),
            bankVersion: bankVersion(),
            appVersion: CQP.VERSION,
            sessionId: session.sessionId,
            nowISO: session.submittedAt,
          });
          var applied = CQP.wrongbookApply(S.store.wrongbook, record, CQP.isoNow(), { force: true });
          S.store.wrongbook = applied.book;
          if (applied.action === "added") added += 1;
        });
        persist();
        render();
        toast("已把 " + added + " 道错题加入错题本（其余已在册）");
        break;
      }
      case "modal-close": closeModal(); break;
      default: break;
    }
  }

  function bindEvents() {
    var main = $("main");
    main.addEventListener("click", function (event) {
      var target = event.target.closest("[data-act]");
      if (!target) return;
      var act = target.getAttribute("data-act");
      if (act === "opt" || act === "mock-opt" || act === "blank-input") return;
      if (target.tagName === "INPUT" && (target.type === "checkbox" || target.type === "radio")) return;
      handleAction(act, target, event);
    });
    main.addEventListener("change", function (event) {
      var target = event.target.closest("[data-act]");
      if (!target) return;
      var act = target.getAttribute("data-act");
      switch (act) {
        case "sel-mode": S.sel.mode = target.value; render(); break;
        case "sel-part": {
          var partCode = target.value;
          // 防御：外部替换 S.sel 时 parts 可能缺失（t11 O-6）
          if (!Array.isArray(S.sel.parts)) S.sel.parts = [];
          var partAt = S.sel.parts.indexOf(partCode);
          if (target.checked && partAt < 0) S.sel.parts.push(partCode);
          if (!target.checked && partAt >= 0) S.sel.parts.splice(partAt, 1);
          render();
          break;
        }
        case "sel-count": S.sel.count = Math.max(1, Math.min(Number(target.value) || 20, S.bank.questions.length)); render(); break;
        case "sel-chapter": case "sel-type": {
          var key = act === "sel-chapter" ? "chapters" : "types";
          var value = target.value;
          // 防御：外部替换 S.sel 时字段可能缺失（t11 O-6）
          if (!Array.isArray(S.sel[key])) S.sel[key] = [];
          var list = S.sel[key];
          var at = list.indexOf(value);
          if (target.checked && at < 0) list.push(value);
          if (!target.checked && at >= 0) list.splice(at, 1);
          render();
          break;
        }
        case "wrong-filter": S.wrongFilter[target.getAttribute("data-key")] = target.value; render(); break;
        case "stats-scope": S.statsRange.scope = target.value; render(); break;
        case "stats-date": {
          var key = target.getAttribute("data-key");
          S.statsRange[key] = target.value;
          if (S.statsRange.scope === "day") S.statsRange.from = target.value;
          render();
          break;
        }
        case "stats-nick": S.statsNick = target.value; render(); break;
        case "team-nick": S.teamNick = target.value; render(); break;
        case "io-scope": S.io.scope = target.value; render(); break;
        case "io-date": S.io[target.getAttribute("data-key")] = target.value; render(); break;
        case "review-kind": S.reviewFilter.kind = target.value; S.reviewLimit = 60; render(); break;
        case "review-chapter": S.reviewFilter.chapter = target.value; S.reviewLimit = 60; render(); break;
        case "review-flag": toggleFlag(target.getAttribute("data-qid"), target.checked); render(); break;
        case "importFile": if (target.files && target.files[0]) handleImportFile(target.files[0]); break;
        default: break;
      }
    });
    document.addEventListener("input", function (event) {
      var target = event.target.closest("[data-act]");
      if (!target) return;
      var act = target.getAttribute("data-act");
      if (act === "review-keyword") {
        S.reviewFilter.keyword = target.value;
        S.reviewLimit = 60;
        var position = target.selectionStart;
        render();
        var again = document.querySelector('[data-act="review-keyword"]');
        if (again) { again.focus(); try { again.setSelectionRange(position, position); } catch (err) { /* 忽略 */ } }
      }
    });
    document.getElementById("nav").addEventListener("click", function (event) {
      var target = event.target.closest("button[data-nav]");
      if (!target) return;
      go(target.getAttribute("data-nav"));
    });
    // 卸载兜底：提交即落库已是主路径，这里再 flush 一次（含进行中的模拟赛）
    window.addEventListener("beforeunload", flushPractice);
    window.addEventListener("pagehide", flushPractice);
    document.addEventListener("keydown", function (event) {
      var tag = (event.target && event.target.tagName) || "";
      var typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (event.key === "Escape") { closeModal(); return; }
      if (S.page === "practice" && S.practice) {
        var item = practiceItem(S.practice.idx);
        if (item.submitted) {
          if (!typing && event.key === "Enter") { event.preventDefault(); nextQuestion(); }
          return;
        }
        if (typing && tag === "INPUT") return;
        var index = ["a", "b", "c", "d"].indexOf(event.key.toLowerCase());
        if (index < 0) index = ["1", "2", "3", "4"].indexOf(event.key) ;
        if (index >= 0) {
          var question = S.practice.questions[S.practice.idx];
          var mode = CQP.responseModeOf(question);
          if (mode === "blank") return;
          var value = mode === "judge" ? (index === 0 ? "对" : "错") : String.fromCharCode(65 + index);
          var nodes = document.querySelectorAll('input[name="opt"]');
          for (var i = 0; i < nodes.length; i += 1) {
            if (nodes[i].value === value) {
              if (mode === "multiple") nodes[i].checked = !nodes[i].checked;
              else nodes[i].checked = true;
              event.preventDefault();
            }
          }
          return;
        }
        if (event.key === "Enter") { event.preventDefault(); submitCurrent(); }
      }
    });
  }

  // ---------------------------------------------------------------- 启动
  function boot() {
    initStorage();
    if (!initBank()) return;
    bindEvents();
    render();
    if (!S.storageOk) banner("error", "本地存储不可用，数据无法保存，请立即导出备份（当前会话仍可答题，刷新即丢失）");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.CQPUI = {
    go: go,
    state: S,
    render: render,
    refreshBank: refreshBank,
    // 测试钩子：驱动界面流程（供 node 下的 DOM shim 冒烟测试使用）
    __test: {
      action: handleAction,
      startPractice: startPractice,
      practiceItem: practiceItem,
      practiceRecords: practiceRecords,
      submitMock: submitMock,
      abandonMock: abandonMock,
      mockState: mockState,
      setMockConfidence: setMockConfidence,
      flushPractice: flushPractice,
      candidatePool: candidatePool,
      effectiveChapters: effectiveChapters,
      saveReview: saveReview,
      confirmImport: confirmImport,
      pending: function () { return S.io.pending; },
      setPending: function (pending) { S.io.pending = pending; },
      rescueExport: rescuePayload,
      rescueFileName: rescueFileName,
    },
  };
})();
