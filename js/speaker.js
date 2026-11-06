// 语音层：优先播放预生成的"晓晓"真人女声（assets/audio），缺失时回退系统语音
// 设计要点：
// - 所有音频路径都由"拼音键"推导，同音字共享文件，避免重复占用空间
// - 播放采用队列 + 版本号（tokens）机制：新语音会立即打断旧语音
const Speaker = {
  AUDIO: "assets/audio/",
  AUDIO_EPOCH_KEY: "early-literacy-audio-cache", // 音频缓存标记：清理后更换，迫使浏览器重新下载
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

  // 给音频路径加版本参数：与 index.html 的 CACHE_VERSION 保持一致，避免浏览器缓存旧语音
  // 额外带一个缓存标记：在应用设置里清理音频缓存后会更换，让客户端重新下载更新后的音频
  audioUrl(rel) {
    const epoch = this.audioEpoch();
    return `${this.AUDIO}${rel}?v=${window.APP_VERSION || "1"}${epoch ? `&c=${epoch}` : ""}`;
  },

  audioEpoch() {
    try {
      return localStorage.getItem(this.AUDIO_EPOCH_KEY) || "";
    } catch (e) {
      return "";
    }
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

  // ---------- 预下载 ----------
  // 发布到网站后音频需要联网下载，第一次播放时边下边播容易“没声音”。
  // 这里提前 fetch 成 blob 存在内存里，播放时直接用本地 blob 地址。
  // file:// 下 fetch 会被浏览器拦截，失败时自动退回原始地址，不影响离线使用。
  cache: new Map(), // 原始地址 -> { promise, blobUrl }
  // 下载队列：手机浏览器每个域名只允许 6 个并发连接，一次性发起几十个请求会让
  // 后面的请求长时间排队——而 8 秒超时是从请求"真正开始"才算，否则排队的文件会
  // 在没下载前就超时、永久退化成边下边播，首次进入因此卡顿。这里限制并发数。
  MAX_PARALLEL: 4,
  jobs: [], // 待下载队列 [{ url, entry }]
  running: 0, // 当前正在下载的数量

  // 清理本地音频缓存：停止播放、释放内存中的 blob，并更换缓存标记，
  // 之后 audioUrl 会带上新的参数，浏览器与 audio 元素都会重新下载最新音频
  clearAudioCache() {
    this.stop();
    this.cache.forEach((entry) => {
      if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
    });
    this.cache.clear();
    this.jobs.length = 0; // 排队中的任务一并作废
    try {
      localStorage.setItem(this.AUDIO_EPOCH_KEY, Date.now().toString(36));
    } catch (e) {}
  },

  preload(urls) {
    (Array.isArray(urls) ? urls : [urls]).forEach((url) => {
      if (!url || this.cache.has(url)) return;
      // 先把 promise 建好（preloadAll 与 resolveSrc 会立刻用到），再排队等下载
      const entry = { blobUrl: null, promise: null };
      entry.promise = new Promise((resolve) => {
        entry.resolve = resolve;
      });
      this.cache.set(url, entry);
      this.jobs.push({ url, entry });
    });
    this.pump();
  },

  // 按并发上限依次启动下载任务
  pump() {
    while (this.running < this.MAX_PARALLEL && this.jobs.length > 0) {
      const job = this.jobs.shift();
      this.running += 1;
      this.download(job.url, job.entry).then(() => {
        this.running -= 1;
        this.pump();
      });
    }
  },

  // 带缓存的 fetch：浏览器 HTTP 缓存里已有该文件（无论是否过期）就直接取本地副本，
  // 没有才发起网络请求。内存里的 blob 缓存只活一个页面会话，刷新/关闭后就没了；
  // 之前不带 cache 选项，缓存过期后 300 多个文件每次重进都要逐个回源验证，像重新下载。
  // 音频地址自带 ?v= 版本号与缓存标记，更新资源时 URL 变化，旧缓存自然失效，不必担心拿到旧文件
  fetchCached(url) {
    try {
      return fetch(url, { cache: "force-cache" });
    } catch (e) {
      return fetch(url); // 个别老浏览器不认识 cache 选项会同步抛错，退回普通请求
    }
  },

  // 实际下载：超时从此刻开始计（而不是入队时），保证排队的文件不会"还没开始就超时"。
  // 超时后请求仍在后台继续，晚到的文件照样换成 blob，之后播放直接用本地地址
  download(url, entry) {
    const request =
      typeof fetch === "function"
        ? this.fetchCached(url)
            .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(r.status))))
            .then((blob) => {
              entry.blobUrl = URL.createObjectURL(blob);
              return entry.blobUrl;
            })
            .catch(() => url)
        : Promise.resolve(url);
    entry.request = request; // resolveSrc 用它判断"还在下载"
    const timeout = new Promise((resolve) => setTimeout(() => resolve(url), 8000));
    return Promise.race([request, timeout]).then((src) => {
      entry.resolve(src);
      return src;
    });
  },

  // 批量预加载并按“已完成文件数”回调进度；失败/超时的文件也会计入完成，
  // 保证加载界面不会一直卡住。返回 Promise，全部就绪后 resolve
  preloadAll(urls, onProgress) {
    const list = [...new Set((urls || []).filter(Boolean))];
    let done = 0;
    if (onProgress) onProgress(0, list.length);
    return Promise.all(
      list.map((url) => {
        this.preload(url);
        return this.cache.get(url).promise.then(() => {
          done += 1;
          if (onProgress) onProgress(done, list.length);
        });
      })
    );
  },

  // 播放前取地址：已预下载的直接用 blob；还在下载就等一小会儿（最多 600ms），
  // 拿不到就先播原始地址，避免两句语音之间出现长时间空白
  resolveSrc(url) {
    const entry = this.cache.get(url);
    if (!entry) return Promise.resolve(url);
    if (entry.blobUrl) return Promise.resolve(entry.blobUrl);
    const wait = entry.request || entry.promise;
    const fallback = new Promise((resolve) =>
      setTimeout(() => resolve(entry.blobUrl || url), 600)
    );
    return Promise.race([wait, fallback]);
  },

  // 进入选册页前的全局预热：提示语、名字语音、30 条夸奖语、星星播报、礼物提示，
  // 以及内置楷体字体文件。全部就绪后才放行，避免练习/结算页边下边播。
  // 题目相关的单字/组词/注解语音不在这里加载（由 app.js 按首题阻塞 + 后台滑窗预取）
  preloadGlobal(name, onProgress) {
    const phrases = ["welcome", "done", "cheer"];
    for (let level = 1; level <= 5; level++) {
      for (let n = 1; n <= 6; n++) phrases.push(`praise${level}_${n}`);
    }
    const urls = phrases.map((k) => this.phraseFile(k, name));
    urls.push(this.audioUrl("phrases/find.mp3"));
    urls.push(this.audioUrl("phrases/help.mp3"));
    // 礼物相关语音：勾选前缀、礼物袋打开提示（1/2/3 件）、全部礼物名称
    urls.push(this.audioUrl("phrases/chose.mp3"));
    for (let q = 1; q <= 3; q++) urls.push(this.audioUrl(`phrases/pickBag${q}.mp3`));
    const giftNames = window.GIFT_AUDIO || [];
    giftNames.forEach((n) => {
      const u = this.giftAudio(n);
      if (u) urls.push(u);
    });
    for (let i = 0; i <= 20; i++) urls.push(this.audioUrl(`phrases/stars${i}.mp3`));
    // 字体与语音并行加载；不支持 Font Loading API 或超时都不阻塞进入
    const fontReady =
      "fonts" in document && document.fonts.load
        ? Promise.race([
            document.fonts.load('32px "Kaiti Web"', "字").catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, 8000)),
          ])
        : Promise.resolve();
    return Promise.all([this.preloadAll(urls, onProgress), fontReady]);
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
