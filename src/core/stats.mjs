// 个人统计与团队统计（docs/需求规格.md 8.5 / 8.6 / 9.12）
import { cn_CHAPTER_CODES, cn_TYPES, cn_WRONG_THRESHOLD_USERS } from "./constants.mjs";
import { ms_groupSummary, ms_masteryOfAttempts, ms_round1 } from "./mastery.mjs";

export function st_compareNickname(a, b) {
  const x = typeof a === "string" ? a : "";
  const y = typeof b === "string" ? b : "";
  try {
    const r = x.localeCompare(y, "zh-Hans-CN");
    if (r !== 0) return r < 0 ? -1 : 1;
  } catch (err) {
    /* 无 ICU 时退化为码点比较 */
  }
  return x < y ? -1 : x > y ? 1 : 0;
}

function st_indexQuestions(questions) {
  const map = new Map();
  for (const q of questions) if (q && typeof q.id === "string") map.set(q.id, q);
  return map;
}

function st_emptyGroup() {
  return { answered: 0, correct: 0, accuracy: null, mastery: { attempts: 0, index: null, insufficient: true } };
}

function st_recordsOf(records, nickname) {
  return records.filter((r) => r && r.nickname === nickname);
}

// 个人易错题（8.6）：判错过至少 1 次
export function st_personalWrongQuestions(mine, qById) {
  const byQid = new Map();
  for (const r of mine) {
    let row = byQid.get(r.qid);
    if (!row) {
      row = { qid: r.qid, wrongCount: 0, correctCount: 0, guessedCorrect: 0, lastWrongAt: null, attempts: [] };
      byQid.set(r.qid, row);
    }
    row.attempts.push(r);
    if (r.correct) {
      row.correctCount += 1;
      if (r.confidence === "guessed") row.guessedCorrect += 1;
    } else {
      row.wrongCount += 1;
      if (row.lastWrongAt === null || r.ts > row.lastWrongAt) row.lastWrongAt = r.ts;
    }
  }
  const rows = [];
  for (const row of byQid.values()) {
    if (row.wrongCount < 1) continue;
    const m = ms_masteryOfAttempts(row.attempts);
    rows.push({
      qid: row.qid,
      question: qById.get(row.qid) || null,
      wrongCount: row.wrongCount,
      correctCount: row.correctCount,
      guessedCorrect: row.guessedCorrect,
      lastWrongAt: row.lastWrongAt,
      masteryIndex: m.index,
      insufficient: m.insufficient,
      attempts: m.attempts,
    });
  }
  rows.sort((a, b) => {
    if (b.wrongCount !== a.wrongCount) return b.wrongCount - a.wrongCount;
    if (b.guessedCorrect !== a.guessedCorrect) return b.guessedCorrect - a.guessedCorrect;
    const at = a.lastWrongAt || "";
    const bt = b.lastWrongAt || "";
    if (at !== bt) return at < bt ? 1 : -1;
    return a.qid < b.qid ? -1 : 1;
  });
  return rows;
}

function st_mockStats(sessions, nickname) {
  let best = null;
  let count = 0;
  for (const s of sessions) {
    if (!s || s.nickname !== nickname || !s.result) continue;
    count += 1;
    const score = typeof s.result.score === "number" ? s.result.score : 0;
    if (best === null || score > best) best = score;
  }
  return { mockBest: best, mockCount: count };
}

// CQP.personalStats({records, questions, nickname, sessions?})
export function st_personalStats(input) {
  if (!input || typeof input !== "object") throw new TypeError("personalStats(input): input must be an object");
  const { records, questions, nickname } = input;
  if (!Array.isArray(records)) throw new TypeError("personalStats(input): input.records must be an array");
  if (!Array.isArray(questions)) throw new TypeError("personalStats(input): input.questions must be an array");
  if (typeof nickname !== "string" || nickname.length === 0) {
    throw new TypeError("personalStats(input): input.nickname must be a non-empty string");
  }
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const qById = st_indexQuestions(questions);
  const mine = st_recordsOf(records, nickname);
  let correct = 0;
  let wrong = 0;
  let guessedCorrect = 0;
  let confidentCorrect = 0;
  for (const r of mine) {
    if (r.correct) {
      correct += 1;
      if (r.confidence === "guessed") guessedCorrect += 1;
      else confidentCorrect += 1;
    } else {
      wrong += 1;
    }
  }
  const mastery = ms_masteryOfAttempts(mine);
  const byType = ms_groupSummary(mine, questions, (q) => q.sectionType);
  for (const t of cn_TYPES) if (!byType[t]) byType[t] = st_emptyGroup();
  const byChapter = ms_groupSummary(mine, questions, (q) => q.chapterCode);
  for (const c of cn_CHAPTER_CODES) if (!byChapter[c]) byChapter[c] = st_emptyGroup();
  const wrongQuestions = st_personalWrongQuestions(mine, qById);
  const mock = st_mockStats(sessions, nickname);
  return {
    nickname,
    answered: mine.length,
    correct,
    wrong,
    guessedCorrect,
    confidentCorrect,
    accuracy: mine.length === 0 ? null : ms_round1((correct / mine.length) * 100),
    mastery: { attempts: mastery.attempts, index: mastery.index, insufficient: mastery.insufficient },
    byType,
    byChapter,
    wrongQuestions,
    wrongQuestionCount: wrongQuestions.length,
    mockBest: mock.mockBest,
    mockCount: mock.mockCount,
  };
}

// CQP.teamStats({records, questions, minWrongUsers?, sessions?})
export function st_teamStats(input) {
  if (!input || typeof input !== "object") throw new TypeError("teamStats(input): input must be an object");
  const { records, questions } = input;
  if (!Array.isArray(records)) throw new TypeError("teamStats(input): input.records must be an array");
  if (!Array.isArray(questions)) throw new TypeError("teamStats(input): input.questions must be an array");
  const minWrongUsers = Number.isInteger(input.minWrongUsers) ? input.minWrongUsers : cn_WRONG_THRESHOLD_USERS;
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const qById = st_indexQuestions(questions);

  const agg = new Map();
  const nickSet = new Set();
  for (const r of records) {
    if (!r || typeof r.qid !== "string" || typeof r.nickname !== "string" || r.nickname.length === 0) continue;
    nickSet.add(r.nickname);
    let row = agg.get(r.qid);
    if (!row) {
      row = {
        qid: r.qid,
        answeredUsers: new Set(),
        wrongUsers: new Map(),
        wrongCount: 0,
        correctCount: 0,
        guessedCorrect: 0,
        attempts: [],
        lastWrongAt: null,
      };
      agg.set(r.qid, row);
    }
    row.answeredUsers.add(r.nickname);
    row.attempts.push(r);
    if (r.correct) {
      row.correctCount += 1;
      if (r.confidence === "guessed") row.guessedCorrect += 1;
    } else {
      row.wrongCount += 1;
      row.wrongUsers.set(r.nickname, (row.wrongUsers.get(r.nickname) || 0) + 1);
      if (row.lastWrongAt === null || r.ts > row.lastWrongAt) row.lastWrongAt = r.ts;
    }
  }

  const teamWrongQuestions = [];
  for (const row of agg.values()) {
    const wrongUsers = row.wrongUsers.size;
    if (wrongUsers < minWrongUsers) continue;
    const m = ms_masteryOfAttempts(row.attempts);
    const answeredUsers = row.answeredUsers.size;
    teamWrongQuestions.push({
      qid: row.qid,
      question: qById.get(row.qid) || null,
      wrongUsers,
      wrongUserNames: Array.from(row.wrongUsers.keys()).sort(st_compareNickname),
      wrongCount: row.wrongCount,
      answeredUsers,
      correctCount: row.correctCount,
      guessedCorrect: row.guessedCorrect,
      wrongRate: answeredUsers === 0 ? null : ms_round1((wrongUsers / answeredUsers) * 100),
      lastWrongAt: row.lastWrongAt,
      teamMasteryIndex: m.index,
      insufficient: m.insufficient,
      attempts: m.attempts,
    });
  }
  teamWrongQuestions.sort((a, b) => {
    if (b.wrongUsers !== a.wrongUsers) return b.wrongUsers - a.wrongUsers;
    if (b.wrongCount !== a.wrongCount) return b.wrongCount - a.wrongCount;
    return a.qid < b.qid ? -1 : a.qid > b.qid ? 1 : 0;
  });

  const nicknames = Array.from(nickSet).sort(st_compareNickname);
  const members = nicknames.map((nickname) => {
    const p = st_personalStats({ records, questions, nickname, sessions });
    return {
      nickname,
      answered: p.answered,
      correct: p.correct,
      wrong: p.wrong,
      guessedCorrect: p.guessedCorrect,
      confidentCorrect: p.confidentCorrect,
      accuracy: p.accuracy,
      mastery: p.mastery,
      wrongQuestionCount: p.wrongQuestionCount,
      mockBest: p.mockBest,
      mockCount: p.mockCount,
    };
  });

  const matrix = teamWrongQuestions.map((row) => {
    const cells = nicknames.map((nickname) => {
      const list = records.filter((r) => r && r.qid === row.qid && r.nickname === nickname);
      let cell = "未做";
      if (list.length > 0) {
        const hasWrong = list.some((r) => !r.correct);
        if (hasWrong) cell = "错";
        else if (list.some((r) => r.confidence === "guessed")) cell = "猜对";
        else cell = "对";
      }
      return { nickname, cell, attempts: list.length };
    });
    return { qid: row.qid, question: row.question, cells };
  });

  const teamMastery = ms_masteryOfAttempts(records.filter((r) => r && typeof r.qid === "string" && typeof r.nickname === "string"));

  return {
    teamWrongQuestions,
    members,
    matrix,
    nicknames,
    teamMastery: { attempts: teamMastery.attempts, index: teamMastery.index, insufficient: teamMastery.insufficient },
    totalRecords: records.length,
    minWrongUsers,
  };
}
