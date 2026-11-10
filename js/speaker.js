// 语音层：优先播放预生成的"晓晓"真人女声（assets/audio），缺失时回退系统语音
// 设计要点：
// - 所有音频路径都由"拼音键"推导，同音字共享文件，避免重复占用空间
// - 播放采用队列 + 版本号（tokens）机制：新语音会立即打断旧语音
// - 预下载与 blob 缓存由 Resource 统一管理（音频/字体/图片共用一条管线），
//   Speaker 只负责播放，进度条也由 Resource 统一统计
const Speaker = {
  AUDIO: "assets/audio/",
  current: null, // 当前播放的 Audio 实例
  tokens: 0, // 播放序列版本号，用于打断旧序列
  lastPraise: "", // 上一次播放的夸奖语键，避免连续两次抽到同一条

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

  // ---------- 播放控制 ----------
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

  // 音频地址用内容哈希（data/asset-manifest.js）而非全局版本号：
  // 文件没改 → hash 不变 → URL 不变，浏览器缓存直接命中；文件改了 → 只换这一个 URL。
  // 清单里查不到（新文件尚未生成清单）时退回全局版本号，保证仍能加载。
  // 额外带资源缓存标记（Resource.url）：清理资源缓存后会更换，让客户端重新下载更新后的资源
  audioUrl(rel) {
    const ver = Resource.hash(rel) || window.APP_VERSION || "1";
    return Resource.url(`${this.AUDIO}${rel}?h=${ver}`);
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

  // 注解讲解路径：如 我|wǒ -> note/我_wo3.mp3
  noteAudio(entry) {
    const key = `${entry.char}_${this.pinyinKey(entry.pinyin)}`;
    if (!this.noteSet) this.noteSet = new Set(window.NOTE_AUDIO || []);
    if (!this.noteSet.has(key)) return null;
    return this.audioUrl(`note/${encodeURIComponent(key)}.mp3`);
  },

  // 礼物名称语音路径：gifts/<名称>.mp3（清单见 assets/audio/gifts/index.js）
  giftAudio(name) {
    if (!this.giftSet) this.giftSet = new Set(window.GIFT_AUDIO || []);
    if (!this.giftSet.has(name)) return null;
    return this.audioUrl(`gifts/${encodeURIComponent(name)}.mp3`);
  },

  // 勾选礼物：播报「你挑选了：<礼物名称>」；名称语音缺失时只播前缀
  playGiftPick(name) {
    const list = [this.audioUrl("phrases/chose.mp3")];
    const url = this.giftAudio(name);
    if (url) list.push(url);
    this.play(list);
  },

  // 打开礼物袋时播报「你现在可以从礼物袋中挑选 N 件礼物」
  playGiftBagOpen(quota) {
    const url = this.audioUrl(`phrases/pickBag${quota}.mp3`);
    if (url) this.play([url]);
  },

  // 收下礼物后播报「礼物已经放进你的礼物橱窗，快去看看吧」
  playGiftSaved() {
    this.play([this.audioUrl("phrases/giftSaved.mp3")]);
  },

  // 进入礼物展柜时若有新礼物播报提示（onDone 用于接着播下一句）
  playGiftShelfNew(onDone) {
    this.play([this.audioUrl("phrases/giftNew.mp3")], onDone);
  },

  // 橱窗装不下、有礼物被推进收纳盒时播报提示
  playGiftBoxOverflow() {
    this.play([this.audioUrl("phrases/giftBoxOverflow.mp3")]);
  },

  // 橱窗放大礼物：只播礼物名称（音效由 Sound 负责）
  playGiftName(name) {
    const url = this.giftAudio(name);
    if (url) this.play([url]);
  },

  // 去掉字库里的「汉字(拼音)」读音标注，只留汉字（标注只给语音生成脚本用）
  // 界面展示（app.js 的 displayText）与系统语音兜底都复用这里，保证清洗规则一致
  stripAnnotation(text) {
    return (text || "").replace(/([\u4e00-\u9fff])\s*[（(]\s*[^（）()]+?\s*[）)]/g, "$1");
  },

  // 组词讲解文本："雨水的雨，下雨的雨"（音频缺失时交给系统语音朗读）
  explainText(entry) {
    return (entry.words || "")
      .split(/[、，,/；;]/)
      .map((w) => this.stripAnnotation(w).trim())
      .filter(Boolean)
      .map((w) => `${w}的${entry.char}`)
      .join("，");
  },

  // ---------- 预下载（委托 Resource） ----------
  // 预下载与 blob 缓存由 Resource 统一管理（音频/字体/图片共用一条管线，
  // 加载进度条也统一统计）。Speaker 只保留薄封装，app.js 现有调用无需改动。
  preload(urls) {
    return Resource.preload(urls);
  },
  preloadAll(urls, onProgress) {
    return Resource.preload(urls, onProgress);
  },

  // 进入选册页前的全局预热：提示语、名字语音、30 条夸奖语、星星播报、礼物提示，
  // 以及内置楷体字体文件。所有资源一起交给 Resource 预载，进度条统一统计。
  // 题目相关的单字/组词/注解语音不在这里加载（由 app.js 按首题阻塞 + 后台滑窗预取）
  preloadGlobal(name, onProgress) {
    const phrases = ["welcome", "done", "cheer"];
    for (let level = 1; level <= 5; level++) {
      for (let n = 1; n <= 6; n++) phrases.push(`praise${level}_${n}`);
    }
    const urls = phrases.map((k) => this.phraseFile(k, name));
    urls.push(this.audioUrl("phrases/find.mp3"));
    urls.push(this.audioUrl("phrases/help.mp3"));
    // 礼物相关语音：勾选前缀、礼物袋打开提示（1/2/3 件）、收下礼物提示、全部礼物名称
    urls.push(this.audioUrl("phrases/chose.mp3"));
    for (let q = 1; q <= 3; q++) urls.push(this.audioUrl(`phrases/pickBag${q}.mp3`));
    urls.push(this.audioUrl("phrases/giftSaved.mp3"));
    urls.push(this.audioUrl("phrases/giftNew.mp3"));
    urls.push(this.audioUrl("phrases/giftBoxOverflow.mp3"));
    const giftNames = window.GIFT_AUDIO || [];
    giftNames.forEach((n) => {
      const u = this.giftAudio(n);
      if (u) urls.push(u);
    });
    for (let i = 0; i <= 20; i++) urls.push(this.audioUrl(`phrases/stars${i}.mp3`));
    // 楷体字体也加入同一批预载，进度条自动把它算进去；下载完成后再安装字体
    const fontUrl = Resource.fontUrl();
    return Resource.preload([...urls, fontUrl], onProgress).then(() =>
      Resource.loadKaitiFont()
    );
  },

  // ---------- 播放 ----------
  // 顺序播放音频列表，可被打断；单个文件缺失/播放失败时自动跳过
  play(list, onDone) {
    if (list.length === 0) {
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
      Resource.resolveSrc(list[i]).then((src) => {
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
  // key：welcome / praise1_1~praise5_6 / done / cheer
  phraseFile(key, name) {
    return this.hasUserAudio(name)
      ? this.audioUrl(`${this.userDir(name)}${key}.mp3`)
      : this.audioUrl(`phrases/${key}.mp3`);
  },

  // 一个字的全部真人语音：单字、组词、注解（没有预生成文件的项目直接忽略）
  entryUrls(entry) {
    return [
      this.syllableAudio(entry.pinyin),
      this.wordAudio(entry),
      this.noteAudio(entry),
    ].filter((u, i, arr) => u && arr.indexOf(u) === i);
  },

  // 单字详情页：先读汉字发音，再读组词讲解，最后读注解
  readEntry(entry) {
    const charSrc = this.syllableAudio(entry.pinyin);
    const wordSrc = this.wordAudio(entry);
    const noteSrc = this.noteAudio(entry);
    const note = this.stripAnnotation(entry.note);
    if (charSrc) {
      const urls = [charSrc];
      if (wordSrc) urls.push(wordSrc);
      if (noteSrc) urls.push(noteSrc);
      this.preload(urls);
      // 注解音频缺失时用系统语音补读，保证「先组词、后注解」的顺序不变
      const after = noteSrc || !note ? null : () => this.speak(note);
      this.play(urls, after);
      return;
    }
    const explain = this.explainText(entry);
    this.speak(`${entry.char}${explain ? "，" + explain : ""}${note ? "。" + note : ""}`);
  },

  // ---------- 各场景播报 ----------
  // 出题：问候（仅本组第一题）+ "请找出：" + 目标字发音 + 组词讲解 + 注解
  readQuestion(target, opts) {
    const charSrc = this.syllableAudio(target.pinyin);
    const wordSrc = this.wordAudio(target);
    const noteSrc = this.noteAudio(target);
    const note = this.stripAnnotation(target.note);
    // 连单字发音都没有时，整句交给系统语音，避免只响一声提示音
    if (!charSrc) {
      const explain = this.explainText(target);
      this.speak(
        `请找出：${target.char}${explain ? "，" + explain : ""}${note ? "。" + note : ""}`
      );
      return;
    }
    const first = opts && opts.welcome;
    const name = (opts && opts.name) || "";
    const list = [];
    if (first) list.push(this.phraseFile("welcome", name));
    list.push(this.audioUrl("phrases/find.mp3"), charSrc);
    if (wordSrc) list.push(wordSrc);
    if (noteSrc) list.push(noteSrc);

    // 注解音频缺失时用系统语音补读；没有预生成名字语音时，
    // phraseFile 会自动退回通用提示语，不再插入系统合成音
    const after = noteSrc || !note ? null : () => this.speak(note);
    this.play(list, after);
  },

  // 答对：按连续首答正确次数选等级（1~2 / 3~4 / 5~6 / 7~8 / 9+ 次），
  // 每级 6 条随机播放；播完回调 onDone，用于安排下一题
  correct(onDone, name, streak) {
    const level = streak >= 9 ? 5 : streak >= 7 ? 4 : streak >= 5 ? 3 : streak >= 3 ? 2 : 1;
    let n = 1 + Math.floor(Math.random() * 6); // 1 ~ 6
    let key = `praise${level}_${n}`;
    if (key === this.lastPraise) {
      // 与上一次重复时顺延到下一条，保证连续两次不会播放同一句
      n = (n % 6) + 1;
      key = `praise${level}_${n}`;
    }
    this.lastPraise = key;
    this.play([this.phraseFile(key, name)], onDone);
  },

  // 帮帮我：提示语（动画由 app.js 负责）
  help() {
    this.play([this.audioUrl("phrases/help.mp3")]);
  },

  // 结束页：完成 + 星星数 + [有礼物时]礼物提示 + 鼓励
  // 星星数最多等于每组题数（练习设置可配 5~20），故音频上限为 20
  // opts.gift: 是否需要插入礼物提示；opts.onDone: 所有语音播完后回调
  result(stars, name, opts) {
    const { gift = false, onDone = null } = opts || {};
    const n = Math.max(0, Math.min(20, Math.round(stars)));
    const list = [
      this.phraseFile("done", name),
      this.audioUrl(`phrases/stars${n}.mp3`),
    ];
    if (gift) list.push(this.audioUrl("phrases/gift.mp3"));
    list.push(this.phraseFile("cheer", name));
    this.play(list, onDone);
  },
};

// 页面一加载就监听首次点按，用于解锁微信/iOS 的自动播放限制
Speaker.bindUnlock();
