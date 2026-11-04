// 数据持久化层：localStorage 读写封装（用户、进度、记录、练习设置、显示开关）
//
// 关键设计：
// - 多用户隔离：进度与记录按用户 id 分别存储；用户列表与"当前用户"全局共享
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
    NOTE: "early-literacy-note", // 底部组词 + 注解提示（按钮名为「注解」）
    SHOWCHARS: "early-literacy-showchars", // 练习记录里的汉字
    TOOLS: "early-literacy-quiz-tools", // 练习页顶部按钮行是否展开
    CLICK: "early-literacy-click-sound", // 按钮音效（全局设置）
  },

  // 按小朋友隔离的显示开关：拼音、注解、顶部按钮行按当前用户分别保存
  // 其余开关（记录汉字、按钮音效）为全局设置；键值直接复用 PREF_KEYS，避免重复维护
  get USER_PREF_KEYS() {
    return [this.PREF_KEYS.PINYIN, this.PREF_KEYS.NOTE, this.PREF_KEYS.TOOLS];
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

  // 删除用户：连同其练习进度、记录与练习设置一起清除
  removeUser(id) {
    this.saveUsers(this.users().filter((u) => u.id !== id));
    localStorage.removeItem(this.progressKey(id));
    localStorage.removeItem(this.historyKey(id));
    localStorage.removeItem(this.quizOptionsKey(id));
    localStorage.removeItem(this.quizCountKey(id));
    localStorage.removeItem(this.lastVolumeKey(id));
    localStorage.removeItem(this.giftsKey(id));
    localStorage.removeItem(this.giftLogKey(id));
    // 拼音、注解开关也按小朋友保存，删除时一并清理
    this.USER_PREF_KEYS.forEach((k) => localStorage.removeItem(this.prefKey(k, id)));
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

  lastVolumeKey(id) {
    return `early-literacy-last-volume:${id || this.currentId()}`;
  },

  giftsKey(id) {
    return `early-literacy-gifts:${id || this.currentId()}`;
  },

  // ---------- 礼物橱窗（按小朋友独立保存） ----------
  // 数据结构：[{ id, name, fresh }]
  //   id    每件礼物实例的唯一标识（同名礼物是两件独立物品，可分别排序/删除）
  //   name  与 data/gifts.js 清单对应的礼物名
  //   fresh 新获得标记：true 时橱窗卡片带边框闪烁，点击后清除
  gifts(id) {
    const raw = this.readJSON(this.giftsKey(id), []);
    return Array.isArray(raw) ? raw : [];
  },

  _giftItem(name, fresh) {
    return {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name,
      fresh: !!fresh,
    };
  },

  addGifts(names, id) {
    const arr = this.gifts(id);
    (names || []).forEach((name) => arr.push(this._giftItem(name, true)));
    this.writeJSON(this.giftsKey(id), arr);
  },

  // 整体保存顺序（拖拽排序后用）
  saveGifts(arr, id) {
    this.writeJSON(this.giftsKey(id), Array.isArray(arr) ? arr : []);
  },

  // 删除某一件礼物（拖进垃圾篓）
  removeGiftItem(giftId, id) {
    const arr = this.gifts(id).filter((g) => g.id !== giftId);
    this.writeJSON(this.giftsKey(id), arr);
  },

  // 清除某件礼物的「新」标记（点击后边框闪烁消失）
  markGiftSeen(giftId, id) {
    const arr = this.gifts(id);
    const item = arr.find((g) => g.id === giftId);
    if (item && item.fresh) {
      item.fresh = false;
      this.writeJSON(this.giftsKey(id), arr);
    }
  },

  // ---------- 礼物领取日志（按小朋友独立保存） ----------
  // 记录每次领取时的星星数和时间戳，用于展柜的"列表模式"展示
  // 数据结构：[{ name, stars, time }]，按时间升序
  giftLogKey(id) {
    return `early-literacy-gift-log:${id || this.currentId()}`;
  },

  giftLog(id) {
    const data = this.readJSON(this.giftLogKey(id), []);
    return Array.isArray(data) ? data : [];
  },

  // 追加一组领取记录：names 是礼物名数组，stars 是本组星星数
  addGiftLog(names, stars, id) {
    const list = this.giftLog(id);
    const now = Date.now();
    (names || []).forEach((name) => {
      list.push({ name, stars: stars || 0, time: now });
    });
    // 限制最多 500 条（约每天 2 组可用一年半）
    const trimmed = list.slice(-500);
    this.writeJSON(this.giftLogKey(id), trimmed);
  },

  // ---------- 最近选中的册（按小朋友独立保存） ----------
  // 选册页把它排到列表第一项并用不同配色区分
  lastVolume(id) {
    return localStorage.getItem(this.lastVolumeKey(id)) || "";
  },

  setLastVolume(volumeId, id) {
    localStorage.setItem(this.lastVolumeKey(id), String(volumeId));
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

  // ---------- 练习记录 ----------
  loadHistory() {
    return this.readJSON(this.historyKey(), []);
  },

  // 一组练习结束时调用：{ stars, total, correct, chars, volume }
  // chars 内每条为 { c, pinyin, words, note, ok }
  // 超出 HISTORY_MAX 时丢弃最旧的记录
  addHistory(record) {
    const list = this.loadHistory();
    list.push({ ...record, date: Date.now() });
    this.writeJSON(this.historyKey(), list.slice(-this.HISTORY_MAX));
  },

  // 清空当前用户的进度与记录
  clearUserData() {
    localStorage.removeItem(this.progressKey());
    localStorage.removeItem(this.historyKey());
  },

  // ---------- 显示开关（拼音 / 注解 / 记录汉字） ----------
  // 未设置过或值为 "1" 时视为开启
  // 拼音、注解按小朋友隔离；记录汉字为全局设置
  prefKey(key, id) {
    if (!this.USER_PREF_KEYS.includes(key)) return key;
    const uid = id || this.currentId();
    return uid ? `${key}:${uid}` : key;
  },

  pref(key, id) {
    return localStorage.getItem(this.prefKey(key, id)) !== "0";
  },

  setPref(key, on, id) {
    localStorage.setItem(this.prefKey(key, id), on ? "1" : "0");
  },

  // ---------- 练习设置（按小朋友独立保存） ----------
  // 每题候选字数：只支持 2 / 3 / 4 / 6 / 8 / 9；未设置时默认 4，值非法时直接报错
  quizOptions(id) {
    const raw = localStorage.getItem(this.quizOptionsKey(id));
    if (raw == null) return 4;
    const v = parseInt(raw, 10);
    if (!this.OPTION_VALUES.includes(v)) {
      throw new Error(`练习设置（候选字数）值非法：${raw}`);
    }
    return v;
  },

  setQuizOptions(v, id) {
    const n = this.OPTION_VALUES.includes(Number(v)) ? Number(v) : 4;
    localStorage.setItem(this.quizOptionsKey(id), String(n));
    return n;
  },

  // 每组题数：5 ~ 20；未设置时默认 10，值非法时直接报错
  quizCount(id) {
    const raw = localStorage.getItem(this.quizCountKey(id));
    if (raw == null) return 10;
    const v = parseInt(raw, 10);
    if (!(v >= 5 && v <= 20)) {
      throw new Error(`练习设置（每组题数）值非法：${raw}`);
    }
    return v;
  },

  setQuizCount(v, id) {
    const n = Math.max(5, Math.min(20, parseInt(v, 10) || 10));
    localStorage.setItem(this.quizCountKey(id), String(n));
    return n;
  },

  // ---------- 清空全部数据 ----------
  // 删除本应用写入 localStorage 的所有键（前缀 early-literacy-），
  // 用于「应用设置 - 清空所有数据」。调用方需自行刷新页面以重建内存状态
  clearAll() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("early-literacy-")) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
    return keys.length;
  },
};
