// 音效封装：Web Audio API 实时合成，无需音频文件
// 按钮音效受应用设置「按钮音效」全局开关控制（Storage.PREF_KEYS.CLICK），其余答题反馈音效始终开启
const Sound = {
  ctx: null,
  lastHover: 0, // 上次悬停音效时间，用于节流

  // AudioContext 需在用户手势后创建/恢复（浏览器自动播放策略）
  ensureCtx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!this.ctx) {
      this.ctx = new AC();
      // iOS / 微信 WebView 的音频引擎必须在用户手势中真正"启动"一次：
      // 用 1 帧静音缓冲播放，此后同一个上下文里的合成音效才能正常发声
      try {
        const buf = this.ctx.createBuffer(1, 1, 22050);
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.ctx.destination);
        src.start(0);
      } catch (e) {}
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  },

  // 单个音：频率、起始延迟、时长、波形、音量
  tone(freq, delay, dur, type = "sine", vol = 0.2) {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur); // 淡出防爆音
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur);
  },

  play(name) {
    // 只有按钮音效受「按钮音效」开关控制；正确/错误/求助等答题反馈音效不受影响
    if (name === "click" && !Storage.pref(Storage.PREF_KEYS.CLICK)) return;
    if (name === "pick") {
      this.tone(880, 0, 0.09, "sine", 0.12); // 选中：短促轻"叮"
    } else if (name === "hover") {
      // 悬停：更轻更短的"嘀"，快速划过卡片时 80ms 内只响一次
      const now = performance.now();
      if (now - this.lastHover < 80) return;
      this.lastHover = now;
      this.tone(1175, 0, 0.035, "triangle", 0.06);
    } else if (name === "correct") {
      this.tone(523, 0, 0.14, "triangle"); // 答对：do-mi-sol 上行
      this.tone(659, 0.11, 0.14, "triangle");
      this.tone(784, 0.22, 0.28, "triangle");
    } else if (name === "help") {
      // 求助：清脆的"叮~"，两段高音叠加，尾音稍长
      this.tone(880, 0, 0.22, "sine", 0.18);
      this.tone(1320, 0.04, 0.5, "sine", 0.12);
    } else if (name === "click") {
      // 通用按钮：短促柔和的"嘀"，比答题选中音更轻，避免喧宾夺主
      this.tone(720, 0, 0.05, "sine", 0.08);
    } else if (name === "wrong") {
      // 答错：温和的低音下行。手机小扬声器对 200Hz 以下的低频衰减很重，
      // 因此把音高抬到 349/262Hz 并略提高音量，保证手机上也能听见
      this.tone(349, 0, 0.16, "triangle", 0.22);
      this.tone(262, 0.13, 0.26, "triangle", 0.22);
    } else if (name === "swap") {
      // 礼物卡片互换：两声清脆的"叮-叮"，第二声略高，表示两张卡换位
      this.tone(880, 0, 0.08, "sine", 0.14);
      this.tone(1175, 0.09, 0.1, "sine", 0.14);
    } else if (name === "trash") {
      // 礼物删除（拖入垃圾篓）：下行"咻"声，从高到低表示东西被收走
      this.tone(659, 0, 0.08, "triangle", 0.18);
      this.tone(523, 0.07, 0.08, "triangle", 0.18);
      this.tone(392, 0.14, 0.18, "triangle", 0.18);
    }
  },
};

// 首次交互时初始化音频上下文：悬停（mousemove/pointerenter）不算用户手势，
// 若等到第一次答题才创建，之前的悬停音效会被浏览器自动播放策略静音
document.addEventListener("pointerdown", () => Sound.ensureCtx(), { once: true });

// 所有按钮统一点击音效：按下即响。
// - 只匹配 <button> 与模拟按钮行为的 .word-item（汉字表整行）；
// - 田字格卡片是 div.card，答题时的 pick/correct/wrong 由 app.js 单独播放，此处排除；
// - 用捕获阶段，保证按下反馈先于按钮自身的逻辑（例如先响再切换开关）。
document.addEventListener(
  "pointerdown",
  (e) => {
    const target = e.target;
    if (!target || !target.closest) return;
    const el = target.closest("button, .word-item");
    if (!el || el.disabled) return;
    if (el.closest(".card, .grid")) return;
    Sound.play("click");
  },
  true
);
