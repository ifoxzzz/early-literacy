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

  // 练习设置（按小朋友独立保存，见 quizOptionsKey / quizCountKey / dailyNewLimitKey）
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
    localStorage.removeItem(this.dailyNewLimitKey(id));
    localStorage.removeItem(this.quizOrderKey(id));
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

  dailyNewLimitKey(id) {
    return `early-literacy-quiz-daily-new:${id || this.currentId()}`;
  },

  quizOrderKey(id) {
    return `early-literacy-quiz-order:${id || this.currentId()}`;
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
  //   fresh 新获得标记：true 时橱窗卡片带边框闪烁，首次展示后立即清除
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
    // 新礼物放在最前面（橱窗从第一件开始摆放），装不下的旧礼物会按顺序进入收纳盒
    const added = (names || []).map((name) => this._giftItem(name, true));
    this.writeJSON(this.giftsKey(id), added.concat(arr));
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

  // 清除某件礼物的「新」标记（首次展示后边框闪烁不再出现）
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
  // 数据结构：{ "汉字|拼音": { level, correct, wrong, lastReview, nextReview, firstLearned } }
  // firstLearned 是第一次学习时间，用于统计每日生字数量；旧数据没有该字段时不参与统计
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
    const now = Date.now();
    const r = data[key] || {
      level: 0,
      correct: 0,
      wrong: 0,
      lastReview: 0,
      nextReview: 0,
      firstLearned: now, // 首次学习即视为当天的生字
    };
    if (isCorrect) {
      r.correct += 1;
      r.level = Math.min(r.level + 1, Memory.MAX_LEVEL);
    } else {
      r.wrong += 1;
      r.level = 0;
    }
    r.lastReview = now;
    r.nextReview = now + Memory.INTERVALS[r.level];
    data[key] = r;
    this.saveAll(data);
  },

  // 本地当天 0 点的毫秒时间戳（每日生字上限按本地自然日重置）
  todayStart() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  },

  // 今天第一次学习的汉字集合（同一汉字的不同读音只算一个字）
  todayLearnedChars(progress) {
    const data = progress || this.loadAll();
    const start = this.todayStart();
    const chars = new Set();
    Object.keys(data).forEach((k) => {
      const r = data[k];
      if (r && r.firstLearned >= start) chars.add(k.split("|")[0]);
    });
    return chars;
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

  // 每日生字上限：5 ~ 50；未设置时默认 30，值非法时直接报错
  dailyNewLimit(id) {
    const raw = localStorage.getItem(this.dailyNewLimitKey(id));
    if (raw == null) return 30;
    const v = parseInt(raw, 10);
    if (!(v >= 5 && v <= 50)) {
      throw new Error(`练习设置（每日生字上限）值非法：${raw}`);
    }
    return v;
  },

  setDailyNewLimit(v, id) {
    const n = Math.max(5, Math.min(50, parseInt(v, 10) || 30));
    localStorage.setItem(this.dailyNewLimitKey(id), String(n));
    return n;
  },

  // 出题优先顺序：review（复习优先，默认）/ new（生字优先）
  quizOrder(id) {
    const raw = localStorage.getItem(this.quizOrderKey(id));
    if (raw == null) return "review";
    if (raw !== "review" && raw !== "new") {
      throw new Error(`练习设置（优先顺序）值非法：${raw}`);
    }
    return raw;
  },

  setQuizOrder(v, id) {
    const order = v === "new" ? "new" : "review";
    localStorage.setItem(this.quizOrderKey(id), order);
    return order;
  },

  // ---------- 数据导入 / 导出 ----------
  // 备份文件结构：{ format, version, exportedAt, user, data }
  // data 内含该小朋友的全部本地数据：学习进度、练习记录、礼物、设置与显示开关
  EXPORT_FORMAT: "early-literacy-backup",
  EXPORT_VERSION: 1,

  exportUserData(id) {
    const uid = id || this.currentId();
    const user = this.users().find((u) => u.id === uid) || null;
    // 设置项遇到历史脏数据时会抛错，导出时退回默认值，保证备份文件始终可用
    const safeRead = (fn, fallback) => {
      try {
        return fn();
      } catch (e) {
        return fallback;
      }
    };
    return {
      format: this.EXPORT_FORMAT,
      version: this.EXPORT_VERSION,
      exportedAt: Date.now(),
      user: { id: uid, name: user ? user.name : "" },
      data: {
        progress: this.readJSON(this.progressKey(uid), {}),
        history: this.readJSON(this.historyKey(uid), []),
        gifts: this.gifts(uid),
        giftLog: this.giftLog(uid),
        quizOptions: safeRead(() => this.quizOptions(uid), 4),
        quizCount: safeRead(() => this.quizCount(uid), 10),
        dailyNewLimit: safeRead(() => this.dailyNewLimit(uid), 30),
        quizOrder: safeRead(() => this.quizOrder(uid), "review"),
        lastVolume: this.lastVolume(uid),
        prefs: {
          pinyin: this.pref(this.PREF_KEYS.PINYIN, uid),
          note: this.pref(this.PREF_KEYS.NOTE, uid),
          tools: this.pref(this.PREF_KEYS.TOOLS, uid),
        },
      },
    };
  },

  // 校验备份文件内容，合法时返回 data，非法时抛出带中文原因的 Error
  // 覆盖导入后会写入的所有字段，避免脏数据破坏应用
  validateUserData(raw) {
    const fail = (msg) => {
      throw new Error(msg);
    };
    const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
    const isNum = (v) => typeof v === "number" && Number.isFinite(v);
    const isNonNegNum = (v) => isNum(v) && v >= 0;
    const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;

    if (!isObj(raw)) fail("文件内容不是有效的备份数据。");
    if (raw.format !== this.EXPORT_FORMAT) fail("这不是本应用导出的备份文件。");
    if (!Number.isInteger(raw.version) || raw.version < 1 || raw.version > this.EXPORT_VERSION) {
      fail("备份文件版本不支持，请升级应用后重试。");
    }
    const d = raw.data;
    if (!isObj(d)) fail("备份文件缺少 data 数据。");

    // 学习进度：{ "汉字|拼音": { level, correct, wrong, lastReview, nextReview, firstLearned? } }
    if (!isObj(d.progress)) fail("学习进度格式不正确。");
    Object.keys(d.progress).forEach((key) => {
      const r = d.progress[key];
      if (!key.includes("|")) fail(`学习进度条目「${key}」缺少拼音分隔符。`);
      if (!isObj(r)) fail(`学习进度条目「${key}」格式不正确。`);
      if (!isNonNegInt(r.level) || r.level > Memory.MAX_LEVEL) {
        fail(`学习进度条目「${key}」的记忆等级无效。`);
      }
      if (!isNonNegInt(r.correct) || !isNonNegInt(r.wrong)) {
        fail(`学习进度条目「${key}」的答题次数无效。`);
      }
      if (!isNonNegNum(r.lastReview) || !isNonNegNum(r.nextReview)) {
        fail(`学习进度条目「${key}」的复习时间无效。`);
      }
      if (r.firstLearned != null && !isNonNegNum(r.firstLearned)) {
        fail(`学习进度条目「${key}」的首次学习时间无效。`);
      }
    });

    // 练习记录：[{ stars, total, correct, chars: [{ c, pinyin, words, note, ok }], volume, date }]
    if (!Array.isArray(d.history)) fail("练习记录格式不正确。");
    d.history.forEach((h, i) => {
      const no = i + 1;
      if (!isObj(h)) fail(`第 ${no} 条练习记录格式不正确。`);
      if (!isNonNegInt(h.stars) || !isNonNegInt(h.total) || !isNonNegInt(h.correct)) {
        fail(`第 ${no} 条练习记录的星星或题数无效。`);
      }
      if (!isNonNegNum(h.date)) fail(`第 ${no} 条练习记录的时间无效。`);
      if (!Array.isArray(h.chars)) fail(`第 ${no} 条练习记录的汉字列表无效。`);
      h.chars.forEach((c) => {
        if (!isObj(c) || typeof c.c !== "string" || typeof c.ok !== "boolean") {
          fail(`第 ${no} 条练习记录中的汉字条目无效。`);
        }
      });
      if (h.volume != null && typeof h.volume !== "string") {
        fail(`第 ${no} 条练习记录所属册目无效。`);
      }
    });

    // 礼物橱窗：[{ id, name, fresh? }]
    if (!Array.isArray(d.gifts)) fail("礼物数据格式不正确。");
    d.gifts.forEach((g, i) => {
      if (
        !isObj(g) ||
        typeof g.id !== "string" ||
        !g.id ||
        typeof g.name !== "string" ||
        !g.name
      ) {
        fail(`第 ${i + 1} 件礼物数据无效。`);
      }
      if (g.fresh != null && typeof g.fresh !== "boolean") {
        fail(`第 ${i + 1} 件礼物的新获得标记无效。`);
      }
    });

    // 礼物领取记录：[{ name, stars, time }]
    if (!Array.isArray(d.giftLog)) fail("礼物领取记录格式不正确。");
    d.giftLog.forEach((g, i) => {
      if (
        !isObj(g) ||
        typeof g.name !== "string" ||
        !isNonNegNum(g.stars) ||
        !isNonNegNum(g.time)
      ) {
        fail(`第 ${i + 1} 条礼物领取记录无效。`);
      }
    });

    // 练习设置与显示开关
    if (!this.OPTION_VALUES.includes(d.quizOptions)) fail("每题候选字数设置无效。");
    if (!Number.isInteger(d.quizCount) || d.quizCount < 5 || d.quizCount > 20) {
      fail("每组题数设置无效。");
    }
    if (!Number.isInteger(d.dailyNewLimit) || d.dailyNewLimit < 5 || d.dailyNewLimit > 50) {
      fail("每日生字上限设置无效。");
    }
    if (d.quizOrder !== "review" && d.quizOrder !== "new") fail("每日出题顺序设置无效。");
    if (typeof d.lastVolume !== "string") fail("最近选中的册格式不正确。");
    if (d.prefs != null) {
      if (!isObj(d.prefs)) fail("显示开关格式不正确。");
      ["pinyin", "note", "tools"].forEach((k) => {
        if (d.prefs[k] != null && typeof d.prefs[k] !== "boolean") {
          fail("显示开关格式不正确。");
        }
      });
    }

    return d;
  },

  // 将备份数据写入指定用户（默认当前用户）；返回导入的条目数，用于结果提示
  importUserData(raw, id) {
    const uid = id || this.currentId();
    const d = this.validateUserData(raw);
    // 与正常写入保持一致的上限，避免一次导入塞入过多历史
    const history = d.history.slice(-this.HISTORY_MAX);
    const giftLog = d.giftLog.slice(-500);
    this.writeJSON(this.progressKey(uid), d.progress);
    this.writeJSON(this.historyKey(uid), history);
    this.writeJSON(this.giftsKey(uid), d.gifts);
    this.writeJSON(this.giftLogKey(uid), giftLog);
    localStorage.setItem(this.quizOptionsKey(uid), String(d.quizOptions));
    localStorage.setItem(this.quizCountKey(uid), String(d.quizCount));
    localStorage.setItem(this.dailyNewLimitKey(uid), String(d.dailyNewLimit));
    localStorage.setItem(this.quizOrderKey(uid), d.quizOrder);
    if (d.lastVolume) this.setLastVolume(d.lastVolume, uid);
    else localStorage.removeItem(this.lastVolumeKey(uid));
    // 显示开关缺省为开启，与 Storage.pref 的默认行为一致
    const prefs = { pinyin: true, note: true, tools: true };
    if (d.prefs) {
      ["pinyin", "note", "tools"].forEach((k) => {
        if (typeof d.prefs[k] === "boolean") prefs[k] = d.prefs[k];
      });
    }
    this.setPref(this.PREF_KEYS.PINYIN, prefs.pinyin, uid);
    this.setPref(this.PREF_KEYS.NOTE, prefs.note, uid);
    this.setPref(this.PREF_KEYS.TOOLS, prefs.tools, uid);
    return {
      progress: Object.keys(d.progress).length,
      history: history.length,
      gifts: d.gifts.length,
      giftLog: giftLog.length,
    };
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
