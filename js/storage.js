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
  LEGACY_PROGRESS: "early-literacy-progress", // 旧版单用户进度（仅用于迁移）
  LEGACY_HISTORY: "early-literacy-history", // 旧版单用户历史（仅用于迁移）
  HISTORY_MAX: 50, // 每个用户只保留最近 50 组记录

  // 显示开关（默认开启，存 "0" 表示关闭）
  PREF_KEYS: {
    PINYIN: "early-literacy-pinyin", // 卡片拼音
    WORDS: "early-literacy-words", // 底部组词提示
    SHOWCHARS: "early-literacy-showchars", // 历史记录里的汉字
  },

  // 练习设置（家长在后台配置，对所有用户生效）
  QUIZ_OPTIONS_KEY: "early-literacy-quiz-options", // 每题候选字数：4 / 6 / 8
  QUIZ_COUNT_KEY: "early-literacy-quiz-count", // 每组题数：5 ~ 20

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

  // ---------- 初始化与旧数据迁移 ----------
  // 首次启动：把旧版单用户数据迁移给默认用户"小朋友"
  init() {
    if (this.users().length === 0) {
      const oldProgress = localStorage.getItem(this.LEGACY_PROGRESS);
      const oldHistory = localStorage.getItem(this.LEGACY_HISTORY);
      if (oldProgress || oldHistory) {
        this.addUser("小朋友");
        if (oldProgress) localStorage.setItem(this.progressKey(), oldProgress);
        if (oldHistory) localStorage.setItem(this.historyKey(), oldHistory);
        localStorage.removeItem(this.LEGACY_PROGRESS);
        localStorage.removeItem(this.LEGACY_HISTORY);
      }
    }
    this.migrateProgress();
  },

  // 旧版进度以"汉字"为键；新格式为"汉字|拼音"。
  // 同一个字只有一个旧读音时直接换键，多个读音时取字库中靠前的那条
  migrateProgress() {
    // 建立 汉字 -> [汉字|拼音, ...] 的索引，便于为旧键找到新键
    const byChar = {};
    (window.VOLUMES || []).forEach((v) =>
      v.entries.forEach((e) => {
        (byChar[e.char] = byChar[e.char] || []).push(`${e.char}|${e.pinyin}`);
      })
    );
    this.users().forEach((u) => {
      const key = this.progressKey(u.id);
      const data = this.readJSON(key, null);
      if (!data) return;
      let changed = false;
      const next = {};
      Object.keys(data).forEach((k) => {
        if (k.includes("|")) {
          next[k] = data[k]; // 已是新格式
          return;
        }
        const cands = byChar[k];
        if (!cands || !cands.length) {
          next[k] = data[k]; // 字库里已没有的字，原样保留
          return;
        }
        next[cands[0]] = data[k];
        changed = true;
      });
      if (changed) this.writeJSON(key, next);
    });
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

  // 删除用户：连同其练习进度与历史一起清除
  removeUser(id) {
    this.saveUsers(this.users().filter((u) => u.id !== id));
    localStorage.removeItem(this.progressKey(id));
    localStorage.removeItem(this.historyKey(id));
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

  clearHistory() {
    localStorage.removeItem(this.historyKey());
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

  // ---------- 练习设置 ----------
  // 每题候选字数：只支持 4 / 6 / 8，非法值回落到 4
  quizOptions() {
    const v = parseInt(localStorage.getItem(this.QUIZ_OPTIONS_KEY), 10);
    return [4, 6, 8].includes(v) ? v : 4;
  },

  setQuizOptions(v) {
    const n = [4, 6, 8].includes(Number(v)) ? Number(v) : 4;
    localStorage.setItem(this.QUIZ_OPTIONS_KEY, String(n));
    return n;
  },

  // 每组题数：5 ~ 20，非法值回落到 10
  quizCount() {
    const v = parseInt(localStorage.getItem(this.QUIZ_COUNT_KEY), 10);
    return v >= 5 && v <= 20 ? v : 10;
  },

  setQuizCount(v) {
    const n = Math.max(5, Math.min(20, parseInt(v, 10) || 10));
    localStorage.setItem(this.QUIZ_COUNT_KEY, String(n));
    return n;
  },
};
