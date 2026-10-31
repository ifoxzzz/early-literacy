// 音效封装：Web Audio API 实时合成，无需音频文件
// 跟随朗读总开关（Speaker.isEnabled）
const Sound = {
  ctx: null,
  lastHover: 0, // 上次悬停音效时间，用于节流

  // AudioContext 需在用户手势后创建/恢复（浏览器自动播放策略）
  ensureCtx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!this.ctx) this.ctx = new AC();
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
    if (!Speaker.isEnabled()) return;
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
    } else if (name === "wrong") {
      this.tone(220, 0, 0.18, "sine", 0.18); // 答错：温和低音下行
      this.tone(165, 0.14, 0.28, "sine", 0.18);
    }
  },
};

// 首次交互时初始化音频上下文：悬停（mousemove/pointerenter）不算用户手势，
// 若等到第一次答题才创建，之前的悬停音效会被浏览器自动播放策略静音
document.addEventListener("pointerdown", () => Sound.ensureCtx(), { once: true });
