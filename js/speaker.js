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
      const a = new Audio(list[i]);
      this.current = a;
      // 播放失败（文件缺失、解码失败）同样跳到下一段，保证流程继续
      a.onended = () => next(i + 1);
      a.onerror = () => next(i + 1);
      a.play().catch(() => next(i + 1));
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

  // 用系统语音念小朋友的名字（名字任意、无法预生成），念完再播真人问候语
  speakName(name, onDone) {
    this.speak(name, { rate: 1, onDone, guard: true });
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
  // key：welcome / praise1~3 / wrong / done / cheer
  phraseFile(key, name) {
    return this.hasUserAudio(name)
      ? this.audioUrl(`${this.userDir(name)}${key}.mp3`)
      : this.audioUrl(`phrases/${key}.mp3`);
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

    // 没有预生成名字语音时，先用系统语音念名字，再播问候语
    if (first && name && !this.hasUserAudio(name) && "speechSynthesis" in window) {
      this.stop();
      const token = this.tokens;
      this.speakName(name, () => {
        if (token !== this.tokens) return; // 已被新语音打断
        this.play(list);
      });
      return;
    }
    this.play(list);
  },

  // 答对：随机夸奖（播完回调 onDone，用于安排下一题）
  correct(onDone, name) {
    const n = 1 + Math.floor(Math.random() * 3); // 1 ~ 3
    this.play([this.phraseFile(`praise${n}`, name)], onDone);
  },

  // 答错："没关系，正确答案是：" + 正确字发音
  wrong(target, name) {
    const list = [this.phraseFile("wrong", name)];
    const charSrc = this.syllableAudio(target.pinyin);
    if (charSrc) list.push(charSrc);
    this.play(list);
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
