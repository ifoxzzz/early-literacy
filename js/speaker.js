// 语音层：优先播放预生成的"晓晓"真人女声（assets/audio），缺失时回退系统语音
// 设计要点：
// - 所有音频路径都由"拼音键"推导，同音字共享文件，避免重复占用空间
// - 播放采用队列 + 版本号（tokens）机制：新语音会立即打断旧语音
// - 是否朗读受总开关 early-literacy-sound 控制（静音时直接回调，不阻塞流程）
const Speaker = {
  KEY: "early-literacy-sound",
  AUDIO: "assets/audio/",
  current: null, // 当前播放的 Audio 实例
  tokens: 0, // 播放序列版本号，用于打断旧序列

  // 运行时生成 0.08 秒静音 wav（iOS 上 volume 只读，不能靠调音量静音）
  silenceUri() {
    const sr = 8000;
    const samples = 640;
    const size = 44 + samples * 2;
    const buf = new ArrayBuffer(size);
    const v = new DataView(buf);
    const tag = (off, s) => {
      for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    };
    tag(0, "RIFF");
    v.setUint32(4, size - 8, true);
    tag(8, "WAVE");
    tag(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, 1, true); // 单声道
    v.setUint32(24, sr, true);
    v.setUint32(28, sr * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    tag(36, "data");
    v.setUint32(40, samples * 2, true);
    let bin = "";
    new Uint8Array(buf).forEach((b) => (bin += String.fromCharCode(b)));
    return "data:audio/wav;base64," + btoa(bin);
  },

  // 微信内置浏览器 / iOS WebView 不允许"没有用户手势"的自动播放：
  // 首次点按时用同一个 Audio 元素播放一段极短静音来解锁，之后程序自动 play() 才能发声。
  // （点击"再听一遍"能响，正是因为那一次点按属于用户手势）
  player: null, // 全站复用的 Audio 元素，解锁后一直用它播放
  unlocked: false,

  ensurePlayer() {
    if (!this.player) this.player = new Audio();
    return this.player;
  },

  // 首次用户手势时调用（只能成功解锁一次）
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    const a = this.ensurePlayer();
    const token = this.tokens;
    const finish = () => {
      // 解锁期间如果已经开始播放正式语音，就不要打断它
      if (token === this.tokens) {
        a.pause();
        try {
          a.currentTime = 0;
        } catch (e) {}
      }
    };
    a.src = this.silenceUri();
    a.play().then(() => setTimeout(finish, 120)).catch(finish);
  },

  // 监听首次点按/触摸/按键，以及微信 JSBridge 就绪事件
  bindUnlock() {
    const once = () => this.unlock();
    ["pointerdown", "mousedown", "touchstart", "click", "keydown"].forEach((ev) =>
      document.addEventListener(ev, once, { once: true, passive: true })
    );
    document.addEventListener("WeixinJSBridgeReady", once, { once: true });
  },

  // ---------- 开关 ----------
  isEnabled() {
    return localStorage.getItem(this.KEY) !== "0";
  },

  setEnabled(on) {
    localStorage.setItem(this.KEY, on ? "1" : "0");
    if (!on) this.stop();
  },

  // 停止当前播放并让进行中的序列失效
  stop() {
    this.tokens += 1;
    if (this.current) {
      this.current.pause();
      this.current = null;
    }
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  },

  // ---------- 拼音 -> 文件名 ----------
  // 拼音转音频键：kàn -> kan4、nǚ -> nv3、轻声（无调号）-> 5
  pinyinKey(pinyin) {
    const TONE = {
      "ā": ["a", 1], "á": ["a", 2], "ǎ": ["a", 3], "à": ["a", 4],
      "ē": ["e", 1], "é": ["e", 2], "ě": ["e", 3], "è": ["e", 4],
      "ī": ["i", 1], "í": ["i", 2], "ǐ": ["i", 3], "ì": ["i", 4],
      "ō": ["o", 1], "ó": ["o", 2], "ǒ": ["o", 3], "ò": ["o", 4],
      "ū": ["u", 1], "ú": ["u", 2], "ǔ": ["u", 3], "ù": ["u", 4],
      "ǖ": ["v", 1], "ǘ": ["v", 2], "ǚ": ["v", 3], "ǜ": ["v", 4],
    };
    let tone = 5;
    let out = "";
    for (const ch of (pinyin || "").trim().toLowerCase()) {
      if (TONE[ch]) {
        out += TONE[ch][0];
        tone = TONE[ch][1];
      } else if (ch === "ü") {
        out += "v";
      } else if (/[a-z]/.test(ch)) {
        out += ch;
      }
    }
    return out ? out + tone : "";
  },

  // 给音频路径加版本参数：与 index.html 的 CACHE_VERSION 保持一致，避免浏览器缓存旧语音
  audioUrl(rel) {
    return `${this.AUDIO}${rel}?v=${window.APP_VERSION || "1"}`;
  },

  // 单字发音路径：同音字共享一个文件（清单见 assets/audio/syllables/index.js）
  syllableAudio(pinyin) {
    const key = this.pinyinKey(pinyin);
    if (!key) return null;
    if (!this.syllableSet) this.syllableSet = new Set(window.SYLLABLE_AUDIO || []);
    if (!this.syllableSet.has(key)) return null; // 没有预生成音频，走系统语音兜底
    return this.audioUrl(`syllables/${key}.mp3`);
  },

  // 组词讲解路径：如 我|wǒ -> words/我_wo3.mp3
  wordAudio(entry) {
    const key = `${entry.char}_${this.pinyinKey(entry.pinyin)}`;
    if (!this.wordSet) this.wordSet = new Set(window.WORD_AUDIO || []);
    if (!this.wordSet.has(key)) return null;
    return this.audioUrl(`words/${encodeURIComponent(key)}.mp3`);
  },

  // 组词讲解文本："雨水的雨，下雨的雨"（音频缺失时交给系统语音朗读）
  explainText(entry) {
    return (entry.words || "")
      .split(/[、，,/；;]/)
      .map((w) => w.trim())
      .filter(Boolean)
      .map((w) => `${w}的${entry.char}`)
      .join("，");
  },

  // ---------- 预下载 ----------
  // 发布到网站后音频需要联网下载，第一次播放时边下边播容易“没声音”。
  // 这里提前 fetch 成 blob 存在内存里，播放时直接用本地 blob 地址。
  // file:// 下 fetch 会被浏览器拦截，失败时自动退回原始地址，不影响离线使用。
  cache: new Map(), // 原始地址 -> { promise, blobUrl }

  preload(urls) {
    (Array.isArray(urls) ? urls : [urls]).forEach((url) => {
      if (!url || this.cache.has(url)) return;
      const entry = { promise: null, blobUrl: null };
      // 8 秒内没下载完就先用原地址播放（Audio 自己会继续下载），避免卡住答题流程
      const timeout = new Promise((resolve) => setTimeout(() => resolve(url), 8000));
      entry.promise = Promise.race([
        fetch(url)
          .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(r.status))))
          .then((blob) => {
            entry.blobUrl = URL.createObjectURL(blob);
            return entry.blobUrl;
          })
          .catch(() => url),
        timeout,
      ]);
      this.cache.set(url, entry);
    });
  },

  // 播放前取地址：已预下载的直接用 blob；还在下载就等它（最多 8 秒）
  resolveSrc(url) {
    const entry = this.cache.get(url);
    return entry ? entry.promise : Promise.resolve(url);
  },

  // 为一组练习预热：提示语、星星播报、全部题目涉及的单字与组词音频
  preloadSession(name, targets) {
    // 「请找出」始终用通用提示语，名字语音里没有这个文件
    const urls = ["welcome", "praise1", "praise2", "praise3", "done", "cheer"].map((k) =>
      this.phraseFile(k, name)
    );
    urls.push(this.audioUrl("phrases/find.mp3"));
    urls.push(this.audioUrl("phrases/help.mp3"));
    for (let i = 0; i <= 20; i++) urls.push(this.audioUrl(`phrases/stars${i}.mp3`));
    (targets || []).forEach((t) => {
      const syl = this.syllableAudio(t.pinyin);
      if (syl) urls.push(syl);
      const word = this.wordAudio(t);
      if (word) urls.push(word);
    });
    this.preload(urls);
  },

  // ---------- 播放 ----------
  // 顺序播放音频列表，可被打断；单个文件缺失/播放失败时自动跳过
  play(list, onDone) {
    if (!this.isEnabled() || list.length === 0) {
      if (onDone) onDone();
      return;
    }
    this.stop();
    const token = this.tokens;
    const next = (i) => {
      if (token !== this.tokens) return; // 已被新语音打断
      if (i >= list.length) {
        if (onDone) onDone();
        return;
      }
      this.resolveSrc(list[i]).then((src) => {
        if (token !== this.tokens) return;
        // 复用同一个 Audio 元素：微信里解锁后才能继续自动播放
        const a = this.ensurePlayer();
        this.current = a;
        // 播放失败（文件缺失、解码失败）同样跳到下一段，保证流程继续
        a.onended = () => next(i + 1);
        a.onerror = () => next(i + 1);
        a.src = src;
        a.play().catch(() => {
          if (token === this.tokens) next(i + 1);
        });
      });
    };
    next(0);
  },

  // 系统语音朗读（兜底：字库新增字、任意名字）
  // opts.rate 语速；opts.onDone 播放结束回调；opts.guard 为个别环境 onend 不触发时加定时兜底
  speak(text, opts) {
    const { rate = 0.9, onDone = null, guard = false } = opts || {};
    if (!("speechSynthesis" in window)) {
      if (onDone) onDone();
      return;
    }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-CN";
    u.rate = rate;
    const v = speechSynthesis.getVoices().find((x) => /zh|Chinese/i.test(x.lang + x.name));
    if (v) u.voice = v;
    if (onDone) {
      let fired = false;
      const done = () => {
        if (fired) return;
        fired = true;
        onDone();
      };
      u.onend = done;
      u.onerror = done;
      if (guard) setTimeout(done, 600 + text.length * 350);
    }
    speechSynthesis.speak(u);
  },

  // ---------- 真人语音资源定位 ----------
  // 是否有为该名字预生成的真人人声（清单见 assets/audio/users/index.js）
  hasUserAudio(name) {
    if (name && !this.userSet) this.userSet = new Set(window.USER_AUDIO || []);
    return !!(name && this.userSet && this.userSet.has(name));
  },

  userDir(name) {
    return `users/${encodeURIComponent(name)}/`;
  },

  // 提示语路径：优先用"带名字"的真人语音，否则用通用提示语
  // key：welcome / praise1~3 / done / cheer
  phraseFile(key, name) {
    return this.hasUserAudio(name)
      ? this.audioUrl(`${this.userDir(name)}${key}.mp3`)
      : this.audioUrl(`phrases/${key}.mp3`);
  },

  // 单字详情页：先读汉字发音，再读组词讲解
  readEntry(entry) {
    const charSrc = this.syllableAudio(entry.pinyin);
    const wordSrc = this.wordAudio(entry);
    if (charSrc) {
      const urls = wordSrc ? [charSrc, wordSrc] : [charSrc];
      this.preload(urls);
      this.play(urls);
      return;
    }
    const explain = this.explainText(entry);
    this.speak(`${entry.char}${explain ? "，" + explain : ""}`);
  },

  // ---------- 各场景播报 ----------
  // 出题：问候（仅本组第一题）+ "请找出：" + 目标字发音 + 组词讲解
  readQuestion(target, opts) {
    const charSrc = this.syllableAudio(target.pinyin);
    const wordSrc = this.wordAudio(target);
    // 连单字发音都没有时，整句交给系统语音，避免只响一声提示音
    if (!charSrc) {
      const explain = this.explainText(target);
      this.speak(`请找出：${target.char}${explain ? "，" + explain : ""}`);
      return;
    }
    const first = opts && opts.welcome;
    const name = (opts && opts.name) || "";
    const list = [];
    if (first) list.push(this.phraseFile("welcome", name));
    list.push(this.audioUrl("phrases/find.mp3"), charSrc);
    if (wordSrc) list.push(wordSrc);

    // 没有预生成名字语音时，phraseFile 会自动退回通用提示语，不再插入系统合成音
    this.play(list);
  },

  // 答对：随机夸奖（播完回调 onDone，用于安排下一题）
  correct(onDone, name) {
    const n = 1 + Math.floor(Math.random() * 3); // 1 ~ 3
    this.play([this.phraseFile(`praise${n}`, name)], onDone);
  },

  // 帮帮我：提示语（动画由 app.js 负责）
  help() {
    this.play([this.audioUrl("phrases/help.mp3")]);
  },

  // 结束页：完成 + 星星数 + 鼓励
  // 星星数最多等于每组题数（后台可配 5~20），故音频上限为 20
  result(stars, name) {
    const n = Math.max(0, Math.min(20, Math.round(stars)));
    this.play([
      this.phraseFile("done", name),
      this.audioUrl(`phrases/stars${n}.mp3`),
      this.phraseFile("cheer", name),
    ]);
  },
};

// 页面一加载就监听首次点按，用于解锁微信/iOS 的自动播放限制
Speaker.bindUnlock();
