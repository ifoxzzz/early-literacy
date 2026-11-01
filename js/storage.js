// 数据持久化层：localStorage 读写封装（用户、进度、历史、练习设置、显示开关）
//
// 关键设计：
// - 多用户隔离：进度与历史按用户 id 分别存储；用户列表与"当前用户"全局共享
// - 条目唯一键：`汉字|拼音`，多音字的不同读音各自独立记录
// - 全部数据留在本机，不依赖网络；页面走 file:// 时也能正常读写
const Storage = {
  // ---------- localStorage 键 ----------
  USERS_KEY: "early-literacy-users", // [{ id, name }]
  CURRENT_KEY: "early-literacy-current", // 当前用户 id
  HISTORY_MAX: 50, // 每个用户只保留最近 50 组记录

  // 显示开关（默认开启，存 "0" 表示关闭）
  PREF_KEYS: {
    PINYIN: "early-literacy-pinyin", // 卡片拼音
    WORDS: "early-literacy-words", // 底部组词提示
    SHOWCHARS: "early-literacy-showchars", // 历史记录里的汉字
  },

  // 练习设置（按小朋友独立保存，见 quizOptionsKey / quizCountKey）
  OPTION_VALUES: [2, 3, 4, 6, 8, 9], // 每题候选字数可选值

  // ---------- 通用 JSON 读写 ----------
  // 解析失败时返回 fallback，避免脏数据让整个应用崩溃
  readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const value = JSON.parse(raw);
      return value == null ? fallback : value;
    } catch (e) {
      return fallback;
    }
  },

  writeJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },

  // ---------- 用户 ----------
  users() {
    return this.readJSON(this.USERS_KEY, []);
  },

  saveUsers(list) {
    this.writeJSON(this.USERS_KEY, list);
  },

  currentId() {
    return localStorage.getItem(this.CURRENT_KEY) || "";
  },

  setCurrent(id) {
    localStorage.setItem(this.CURRENT_KEY, id);
  },

  currentUser() {
    return this.users().find((u) => u.id === this.currentId()) || null;
  },

  addUser(name) {
    const user = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name,
    };
    this.saveUsers([...this.users(), user]);
    this.setCurrent(user.id); // 新建后自动切换为当前用户
    return user;
  },

  // 删除用户：连同其练习进度、历史与练习设置一起清除
  removeUser(id) {
    this.saveUsers(this.users().filter((u) => u.id !== id));
    localStorage.removeItem(this.progressKey(id));
    localStorage.removeItem(this.historyKey(id));
    localStorage.removeItem(this.quizOptionsKey(id));
    localStorage.removeItem(this.quizCountKey(id));
    if (this.currentId() === id) localStorage.removeItem(this.CURRENT_KEY);
  },

  // ---------- 当前用户的存储键 ----------
  // 传入 id 可操作指定用户；不传时用当前用户
  progressKey(id) {
    return `early-literacy-progress:${id || this.currentId()}`;
  },

  historyKey(id) {
    return `early-literacy-history:${id || this.currentId()}`;
  },

  quizOptionsKey(id) {
    return `early-literacy-quiz-options:${id || this.currentId()}`;
  },

  quizCountKey(id) {
    return `early-literacy-quiz-count:${id || this.currentId()}`;
  },

  // ---------- 学习进度 ----------
  // 数据结构：{ "汉字|拼音": { level, correct, wrong, lastReview, nextReview } }
  loadAll() {
    return this.readJSON(this.progressKey(), {});
  },

  saveAll(data) {
    this.writeJSON(this.progressKey(), data);
  },

  // 记录一次作答，按遗忘曲线更新记忆等级与下次复习时间
  // 答对：等级 +1；答错：等级归零（调度间隔见 memory.js）
  recordAnswer(key, isCorrect) {
    const data = this.loadAll();
    const r = data[key] || {
      level: 0,
      correct: 0,
      wrong: 0,
      lastReview: 0,
      nextReview: 0,
    };
    if (isCorrect) {
      r.correct += 1;
      r.level = Math.min(r.level + 1, Memory.MAX_LEVEL);
    } else {
      r.wrong += 1;
      r.level = 0;
    }
    r.lastReview = Date.now();
    r.nextReview = Date.now() + Memory.INTERVALS[r.level];
    data[key] = r;
    this.saveAll(data);
  },

  // 某一册的统计：总条目数 / 已学 / 到期待复习（用于选册页）
  statsFor(entries) {
    const data = this.loadAll();
    const now = Date.now();
    let learned = 0;
    let due = 0;
    (entries || []).forEach((e) => {
      const r = data[`${e.char}|${e.pinyin}`];
      if (!r) return;
      learned += 1;
      if (r.nextReview <= now) due += 1;
    });
    return { total: (entries || []).length, learned, due };
  },

  // ---------- 历史记录 ----------
  loadHistory() {
    return this.readJSON(this.historyKey(), []);
  },

  // 一组练习结束时调用：{ stars, total, correct, chars, volume }
  // 超出 HISTORY_MAX 时丢弃最旧的记录
  addHistory(record) {
    const list = this.loadHistory();
    list.push({ ...record, date: Date.now() });
    this.writeJSON(this.historyKey(), list.slice(-this.HISTORY_MAX));
  },

  // 清空当前用户的进度与历史
  clearUserData() {
    localStorage.removeItem(this.progressKey());
    localStorage.removeItem(this.historyKey());
  },

  // ---------- 显示开关（拼音 / 组词 / 历史汉字） ----------
  // 未设置过或值为 "1" 时视为开启
  pref(key) {
    return localStorage.getItem(key) !== "0";
  },

  setPref(key, on) {
    localStorage.setItem(key, on ? "1" : "0");
  },

  // ---------- 练习设置（按小朋友独立保存） ----------
  // 每题候选字数：只支持 2 / 3 / 4 / 6 / 8 / 9，非法值回落到 4
  quizOptions(id) {
    const v = parseInt(localStorage.getItem(this.quizOptionsKey(id)), 10);
    return this.OPTION_VALUES.includes(v) ? v : 4;
  },

  setQuizOptions(v, id) {
    const n = this.OPTION_VALUES.includes(Number(v)) ? Number(v) : 4;
    localStorage.setItem(this.quizOptionsKey(id), String(n));
    return n;
  },

  // 每组题数：5 ~ 20，非法值回落到 10
  quizCount(id) {
    const v = parseInt(localStorage.getItem(this.quizCountKey(id)), 10);
    return v >= 5 && v <= 20 ? v : 10;
  },

  setQuizCount(v, id) {
    const n = Math.max(5, Math.min(20, parseInt(v, 10) || 10));
    localStorage.setItem(this.quizCountKey(id), String(n));
    return n;
  },
};
