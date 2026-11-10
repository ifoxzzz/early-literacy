// 临摹页（写一写）：从单字详情页进入的独立页面。
// 布局参考练习页：顶部抽屉按钮条（手势 / 语音开关 + 返回，✕ 可收起），
// 田字格上方是「演示 / 重写」按钮，下方是提示条。
// 判定参数来自「练习设置 → 临摹设置」的三档松紧，按小朋友保存在 localStorage。
// 数据来自 assets/strokes/<字>.js（tools/生成笔顺数据.bat 生成），按需用 <script> 标签加载，
// 兼容 file:// 直开（fetch 读本地文件会被浏览器拦截）。
(function () {
  "use strict";
  const $ = (sel) => document.querySelector(sel);
  const NS = "http://www.w3.org/2000/svg";

  /* ---------- 笔顺数据按需加载（带缓存） ---------- */
  const dataCache = {}; // char -> Promise<{strokes, medians} | null>
  function loadChar(char) {
    if (dataCache[char]) return dataCache[char];
    dataCache[char] = new Promise((resolve) => {
      const hit = window.STROKES_DATA && window.STROKES_DATA[char];
      if (hit) return resolve(hit);
      const s = document.createElement("script");
      s.src = resourceUrl(
        "assets/strokes/" + encodeURIComponent(char) + ".js?v=" + (window.APP_VERSION || "")
      );
      s.onload = () => resolve((window.STROKES_DATA && window.STROKES_DATA[char]) || null);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
    return dataCache[char];
  }

  /* ---------- 开关状态（手势/语音），localStorage 记忆 ---------- */
  function loadPref(key, def) {
    try {
      const v = localStorage.getItem("early-literacy-trace:" + key);
      return v === null ? def : v === "1";
    } catch (e) {
      return def;
    }
  }
  function savePref(key, val) {
    try {
      localStorage.setItem("early-literacy-trace:" + key, val ? "1" : "0");
    } catch (e) {}
  }
  let gestureOn = loadPref("gesture", true); // 手势引导：默认开
  let voiceOn = loadPref("voice", false); // 语音播报：默认关，避免意外出声

  /* ---------- 描画会话状态 ---------- */
  /* 判定松紧（可在「练习设置 → 临摹设置」里切换，按小朋友保存）
     tolerance：判定半径，笔尖离骨架多近算描到（1024 坐标系单位，越大越宽松）
     lookahead：每次指针事件最多向前推进的采样点数（越大越能容忍快速、跳跃的笔）
     step     ：骨架重采样间距（越小点越密，判定越细腻） */
  const TRACE_LEVELS = {
    loose: { tolerance: 96, lookahead: 16, step: 10 }, // 宽松（默认，适合初学）
    normal: { tolerance: 76, lookahead: 10, step: 12 }, // 标准
    strict: { tolerance: 52, lookahead: 6, step: 12 }, // 严格
  };
  let SAMPLE_STEP = TRACE_LEVELS.loose.step;
  let TOLERANCE = TRACE_LEVELS.loose.tolerance;
  let LOOKAHEAD = TRACE_LEVELS.loose.lookahead;
  const VOICE_INTERVAL = 7000; // 语音开启时，多久没进展重复播报一次当前笔画
  const GUIDE_SPEED = 460; // 手势圆点沿骨架移动的速度（1024 坐标单位/秒）

  // 进入每个字前按当前小朋友的「临摹设置」应用一次
  function applyLevel() {
    const v = typeof Storage !== "undefined" ? Storage.traceLevel() : "loose";
    const cfg = TRACE_LEVELS[v] || TRACE_LEVELS.loose;
    SAMPLE_STEP = cfg.step;
    TOLERANCE = cfg.tolerance;
    LOOKAHEAD = cfg.lookahead;
  }

  let strokes = []; // 每笔的 SVG path（轮廓，用于灰底与点亮）
  let samples = []; // 每笔重采样后的骨架点 [{x,y}...]
  let strokeNames = []; // 每笔名称（横竖撇捺点提折，由骨架几何推断）
  let litPaths = []; // 点亮层 path 元素
  let idx = 0; // 当前要写第几笔
  let prog = 0; // 当前笔已描到的采样点下标
  let ready = false; // 数据是否就绪（就绪前忽略描画）
  let pointerId = null; // 当前跟踪的触摸点（单指）
  let liftGate = false; // 一笔写完后必须抬手才能写下一笔，防止一次划动连续过掉多笔
  let voiceTimer = 0; // 语音定时播报
  let demo = null; // 演示动画单轮状态（非 null 表示本轮进行中）
  let demoOn = false; // 「演示」开关：开启后循环演示，直到用户点任意位置停止
  let demoRaf = 0;
  let demoDot = null;
  let finishTimer = 0; // 一轮演示结束后下一轮开演的定时器

  /* ---------- DOM ---------- */
  const svg = $("#trace-svg");
  const tipEl = $("#trace-tip");
  let flipG = null; // 字形层（翻转坐标）
  let goldG = null; // 完成特效：金色光丝沿笔画轮廓游走
  let goldPaths = []; // 轮廓副本（金色描边层）
  let goldTimer = 0; // 光丝游走结束后收起的定时器
  let progPath = null; // 当前笔描画进度的粗线
  let guideG = null; // 手势引导动画层

  /* ---------- 骨架重采样：把稀疏关键点变成均匀密点，便于逐点判定 ---------- */
  function resample(points, step) {
    const pts = points.map((p) => ({ x: p[0], y: p[1] }));
    if (pts.length < 2) return [pts[0] || { x: 0, y: 0 }, pts[0] || { x: 0, y: 0 }];
    const out = [pts[0]];
    let carry = 0; // 上一段末尾不足一个 step 的余量
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      let t = step - carry;
      while (t <= len) {
        out.push({ x: a.x + (dx * t) / len, y: a.y + (dy * t) / len });
        t += step;
      }
      carry = len - (t - step);
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  function pathLen(pts) {
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    return len;
  }

  // 沿骨架走 dist 距离后的位置，以及覆盖到的点列（用于演示动画的进度线）
  function pointAt(pts, dist) {
    const upto = [pts[0]];
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      if (acc + seg >= dist) {
        const t = seg ? (dist - acc) / seg : 0;
        const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        upto.push(p);
        return { x: p.x, y: p.y, upto };
      }
      upto.push(b);
      acc += seg;
    }
    return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y, upto };
  }

  /* ---------- 笔画名称推断：按骨架的方向、长短、转折粗分为 横竖撇捺点提折 ---------- */
  function inferStrokeName(points) {
    const pts = points.map((p) => ({ x: p[0], y: p[1] }));
    const len = pathLen(pts);
    const a = pts[0];
    const b = pts[pts.length - 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y; // 数据坐标 y 向上

    // 转折检测：相邻骨架段方向突变超过约 55° 视为折（钩的小回勾由长度门槛滤掉）
    let maxTurn = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const a1 = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
      const a2 = Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x);
      let turn = Math.abs(a2 - a1);
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      if (turn > maxTurn) maxTurn = turn;
    }
    if (maxTurn > 0.96 && len > 200) return "折";

    // 短笔：向右上为提，其余（多为向右下按笔）为点
    if (len < 160) return dy > 20 && dx > 0 ? "提" : "点";

    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax > 0 && ay / ax < 0.35) return "横";
    if (ay > 0 && ax / ay < 0.35) return "竖";
    if (dx < 0 && dy < 0) return "撇";
    if (dx > 0 && dy < 0) return "捺";
    if (dx > 0 && dy > 0) return "提";
    if (dx < 0 && dy > 0) return "撇"; // 撇尖上挑收尾的撇
    return "横";
  }

  // 笔画名 -> 拼音：优先复用音节语音库（与应用同款发音），缺的走系统语音
  const STROKE_PINYIN = {
    横: "héng",
    竖: "shù",
    撇: "piě",
    捺: "nà",
    点: "diǎn",
    提: "tí",
    折: "zhé",
  };

  function announceName(i) {
    if (!voiceOn || typeof Speaker === "undefined" || i >= strokeNames.length) return;
    const name = strokeNames[i];
    const url = Speaker.syllableAudio(STROKE_PINYIN[name]);
    if (url) Speaker.play([url]);
    else Speaker.speak(name);
  }

  function scheduleVoice() {
    clearTimeout(voiceTimer);
    if (!voiceOn || !ready || demo || idx >= strokes.length) return;
    voiceTimer = setTimeout(() => {
      announceName(idx);
      scheduleVoice();
    }, VOICE_INTERVAL);
  }

  function stopVoice() {
    clearTimeout(voiceTimer);
    voiceTimer = 0;
  }

  /* ---------- 渲染 ---------- */
  function clearSvg() {
    stopGuide();
    svg.innerHTML = "";
    litPaths = [];
    flipG = null;
    goldG = null;
    goldPaths = [];
    progPath = null;
    guideG = null;
    guideDot = null;
    guidePts = null;
  }

  function el(tag, attrs, parent) {
    const node = document.createElementNS(NS, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }

  function build(data) {
    applyLevel();
    strokes = data.strokes;
    samples = data.medians.map((m) => resample(m, SAMPLE_STEP));
    strokeNames = data.medians.map((m) => inferStrokeName(m));
    idx = 0;
    prog = 0;
    clearSvg();

    // 田字格中心十字虚线（外框由容器边框提供，与练习页卡片一致；6% 内边距对齐 .card 伪元素）
    const grid = el("g", {}, svg);
    el("line", { x1: 512, y1: 61, x2: 512, y2: 963, class: "trace-dash" }, grid);
    el("line", { x1: 61, y1: 512, x2: 963, y2: 512, class: "trace-dash" }, grid);

    // 字形层：数据坐标 y 向上，翻转成屏幕坐标（screen_y = 900 - data_y）
    flipG = el("g", { transform: "scale(1,-1) translate(0,-900)" }, svg);
    const gBase = el("g", {}, flipG);
    const gLit = el("g", {}, flipG);
    strokes.forEach((d) => {
      el("path", { d, class: "trace-base" }, gBase);
      litPaths.push(el("path", { d, class: "trace-lit" }, gLit));
    });

    // 完成特效：复制每笔轮廓做金色描边层，描边用短虚线 + 移动 dashoffset 形成游走光丝
    goldG = el("g", { class: "trace-gold hidden" }, flipG);
    // 总时长 = 单圈时长 × 圈数，与 CSS 动画及收尾定时器保持一致
    goldG.style.setProperty("--gold-dur", GOLD_DURATION * GOLD_LOOPS + "s");
    goldPaths = [];
    strokes.forEach((d) => {
      const p = el("path", { d, class: "trace-gold-path" }, goldG);
      const len = p.getTotalLength() || 0;
      const seg = Math.min(70, len * 0.45); // 光丝长度（占轮廓的一小段）
      p.style.strokeDasharray = `${seg} ${Math.max(len - seg, 1)}`;
      p.style.setProperty("--shift", String(-len * GOLD_LOOPS)); // 虚线偏移走完整圈 × 圈数
      goldPaths.push(p);
    });

    progPath = el("path", { d: "", class: "trace-prog" }, flipG);
    guideG = el("g", { class: "hidden" }, flipG);
  }

  /* ---------- 手势引导：蓝色圆点沿当前笔骨架循环走一遍（「手势」开关控制） ---------- */
  let guideDot = null;
  let guidePts = null;
  let guideLen = 0;
  let guideStart = 0;
  let guideRAF = 0;

  function showGuide() {
    if (!ready || demo || !gestureOn || idx >= strokes.length || !guideG) return;
    stopGuide();
    guideG.innerHTML = "";
    guidePts = samples[idx];
    guideLen = pathLen(guidePts);
    guideDot = el("circle", { r: 46, class: "trace-guide-dot" }, guideG);
    placeGuide(0); // 先把圆点放在起笔处，避免出现从别处滑过来的过渡
    guideStart = 0;
    guideG.classList.remove("hidden");
    guideRAF = requestAnimationFrame(guideStep);
  }

  // 用 rAF 逐帧算位置，而不是 SMIL：animateMotion 的 begin 参照文档时间原点，
  // 元素晚插入时会从已流逝的相位开始；且动画内部状态不可见，出问题时难以排查。
  // 逐帧计算后，每次重建都确定从起笔处出发。
  function placeGuide(dist) {
    if (!guideDot || !guidePts) return;
    const p = pointAt(guidePts, Math.max(0, Math.min(dist, guideLen)));
    guideDot.setAttribute("cx", p.x);
    guideDot.setAttribute("cy", p.y);
  }

  function guideStep(ts) {
    guideRAF = 0;
    if (!guideDot || !guideG || guideG.classList.contains("hidden")) return;
    if (!guideStart) guideStart = ts;
    const dist = guideLen > 1 ? (((ts - guideStart) / 1000) * GUIDE_SPEED) % guideLen : 0;
    placeGuide(dist);
    guideRAF = requestAnimationFrame(guideStep);
  }

  function stopGuide() {
    if (guideRAF) cancelAnimationFrame(guideRAF);
    guideRAF = 0;
  }

  function hideGuide() {
    stopGuide();
    if (guideG) guideG.classList.add("hidden");
  }

  /* ---------- 描画判定 ---------- */
  function tipStroke() {
    if (idx < strokes.length) {
      tipEl.textContent = `第 ${idx + 1} 笔：${strokeNames[idx]}（共 ${strokes.length} 笔）`;
    }
  }

  function paintProg() {
    if (!progPath || idx >= samples.length) return;
    const pts = samples[idx].slice(0, prog + 1);
    progPath.setAttribute("d", pts.length ? "M" + pts.map((p) => `${p.x} ${p.y}`).join(" L") : "");
  }

  // 笔尖位于 p：在当前笔骨架的 prog 之后一小段窗口内找能到达的最远点
  function advance(p) {
    if (idx >= strokes.length) return;
    const pts = samples[idx];
    const limit = Math.min(prog + LOOKAHEAD, pts.length - 1);
    for (let i = limit; i > prog; i--) {
      const dx = p.x - pts[i].x;
      const dy = p.y - pts[i].y;
      if (dx * dx + dy * dy <= TOLERANCE * TOLERANCE) {
        prog = i;
        break;
      }
    }
    // 收笔容错：已经写到接近终点时，笔尖进入终点 1.5 倍判定半径就直接收笔，
    // 避免"只差一点点"反复失败。没写到接近终点时不做这个放宽，
    // 否则从起笔处划到终点附近就能跳过整笔（密集字会被一划带过）
    if (prog < pts.length - 1 && pts.length - 1 - prog <= LOOKAHEAD) {
      const last = pts[pts.length - 1];
      const dx = p.x - last.x;
      const dy = p.y - last.y;
      const r = TOLERANCE * 1.5;
      if (dx * dx + dy * dy <= r * r) prog = pts.length - 1;
    }
    paintProg();
    if (prog >= pts.length - 1) {
      completeStroke();
    } else {
      scheduleVoice(); // 有进展就重置播报倒计时
    }
  }

  function completeStroke() {
    litPaths[idx].classList.add("on");
    progPath.setAttribute("d", "");
    idx++;
    prog = 0;
    const finished = idx >= strokes.length;
    // 一笔写完必须抬手再写下一笔：密集字里一次划动可能同时擦过后面几笔的骨架，
    // 不拦住的话按住不放就能把整个字"划"完
    liftGate = !finished;
    // 整字写完播"流光"音（与金光特效同步），单笔完成仍是答对音
    // 注意：sound.js 用顶层 const 声明，不会有 window.Sound，只能用 typeof 探测
    if (typeof Sound !== "undefined") Sound.play(finished ? "sparkle" : "correct");
    if (finished) {
      hideGuide();
      stopVoice();
      playStrokeGold(); // 整字写完：金色光丝沿笔画轮廓游走
      tipEl.textContent = "写得真棒！点「重写」再来一遍吧";
    } else {
      tipStroke();
      announceName(idx);
      scheduleVoice();
      // 不在这里显示手势：手指可能还按着，等抬手由 endPointer 显示，
      // 否则圆点会在拖动途中就开始走下一笔，抬手重建时看起来像被拉回起点
    }
  }

  /* ---------- 完成特效：金色光丝沿每一笔的轮廓边缘游走两圈，第二圈逐渐透明消失 ---------- */
  const GOLD_STAGGER = 0.06; // 笔与笔之间错开的秒数
  const GOLD_DURATION = 1.6; // 单笔光丝走完一圈的秒数（放慢一点，显得从容）
  const GOLD_LOOPS = 2; // 游走圈数

  function playStrokeGold() {
    if (!goldG || !goldPaths.length) return;
    clearTimeout(goldTimer);
    goldG.classList.remove("hidden");
    goldPaths.forEach((p, i) => {
      p.classList.remove("run");
      p.style.animationDelay = (i * GOLD_STAGGER).toFixed(2) + "s";
    });
    void goldG.getBoundingClientRect(); // 强制重排，确保重复完成时动画能从头播放
    goldPaths.forEach((p) => p.classList.add("run"));
    // 全部走完后收起金色层，恢复干净的字形
    goldTimer = setTimeout(() => {
      goldG.classList.add("hidden");
      goldPaths.forEach((p) => p.classList.remove("run"));
    }, (goldPaths.length * GOLD_STAGGER + GOLD_DURATION * GOLD_LOOPS) * 1000 + 600);
  }

  /* ---------- 演示：开关式，开启后循环把整字一笔一画写出来，点任意位置停止 ---------- */
  const DEMO_SPEED = 0.55; // 骨架单位 / 毫秒
  const DEMO_PAUSE = 240; // 笔与笔之间的停顿（毫秒）
  const DEMO_ROUND_GAP = 1400; // 一轮写完到下一轮开演的间隔（毫秒）

  // 演示一轮：清空后从第 1 笔开始写
  function beginRound() {
    resetBlank();
    demo = { i: 0, start: 0, pauseStart: 0 };
    demoDot = el("circle", { r: 42, class: "trace-demo-dot" }, flipG);
    const p0 = samples[0][0];
    demoDot.setAttribute("cx", p0.x);
    demoDot.setAttribute("cy", p0.y);
    tipEl.textContent = `看好了：第 1 笔 ${strokeNames[0]}`;
    announceName(0);
    demoRaf = requestAnimationFrame(demoTick);
  }

  function removeDemoDot() {
    if (demoDot && demoDot.parentNode) demoDot.parentNode.removeChild(demoDot);
    demoDot = null;
  }

  function startDemo() {
    if (!ready || demoOn) return;
    stopVoice();
    hideGuide();
    demoOn = true;
    refreshToggleBtns();
    beginRound();
  }

  // restore=true 表示交还给用户描画（停止并清场）
  function stopDemo(restore) {
    demoOn = false;
    demo = null;
    cancelAnimationFrame(demoRaf);
    clearTimeout(finishTimer);
    removeDemoDot();
    resetBlank();
    refreshToggleBtns();
    if (restore) {
      tipStroke();
      showGuide();
      scheduleVoice();
    }
  }

  function demoTick(ts) {
    if (!demo) return;
    const pts = samples[demo.i];
    const total = pathLen(pts);
    const dur = Math.max(400, total / DEMO_SPEED);

    if (!demo.start) {
      // 落笔前的停顿（第一笔也先停一下，让用户看清起笔位置）
      if (!demo.pauseStart) demo.pauseStart = ts;
      if (ts - demo.pauseStart < DEMO_PAUSE) {
        demoRaf = requestAnimationFrame(demoTick);
        return;
      }
      demo.start = ts;
    }

    const t = Math.min(1, (ts - demo.start) / dur);
    const at = pointAt(pts, total * t);
    demoDot.setAttribute("cx", at.x);
    demoDot.setAttribute("cy", at.y);
    progPath.setAttribute(
      "d",
      "M" + at.upto.map((p) => `${p.x} ${p.y}`).join(" L")
    );

    if (t >= 1) {
      // 一笔写完：点亮，停一下再写下一笔
      litPaths[demo.i].classList.add("on");
      progPath.setAttribute("d", "");
      demo.i++;
      demo.start = 0;
      demo.pauseStart = 0;
      if (demo.i >= strokes.length) {
        // 一轮写完：停一会儿后循环下一轮，直到用户停止
        demo = null;
        cancelAnimationFrame(demoRaf);
        removeDemoDot();
        tipEl.textContent = "看清楚了吗？再演一遍…";
        finishTimer = setTimeout(() => {
          if (demoOn) beginRound();
        }, DEMO_ROUND_GAP);
        return;
      }
      tipEl.textContent = `看好了：第 ${demo.i + 1} 笔 ${strokeNames[demo.i]}`;
      announceName(demo.i);
    }
    demoRaf = requestAnimationFrame(demoTick);
  }

  /* ---------- 指针事件（鼠标 / 触摸统一走 Pointer Events） ---------- */
  // 屏幕坐标 → 数据坐标（先映射到 viewBox 的 1024 坐标系，再按翻转公式还原）
  function toData(e) {
    const m = svg.getScreenCTM();
    if (!m) return null;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(m.inverse());
    return { x: p.x, y: 900 - p.y };
  }

  svg.addEventListener("pointerdown", (e) => {
    if (!ready || pointerId !== null || demoOn) return;
    e.preventDefault();
    pointerId = e.pointerId;
    liftGate = false; // 新的一次落笔
    try {
      svg.setPointerCapture(pointerId);
    } catch (_) {}
    hideGuide();
    const p = toData(e);
    if (p) advance(p);
  });
  svg.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pointerId || demoOn) return;
    e.preventDefault();
    if (liftGate) return; // 上一笔已写完，等抬手后再写下一笔
    // 快速划动时浏览器会合并事件，取出合并的中间点避免漏判
    const evts = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evts.length ? evts : [e]) {
      if (liftGate) break;
      const p = toData(ev);
      if (p) advance(p);
    }
  });
  const endPointer = (e) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    liftGate = false;
    if (!ready || demoOn) return;
    if (idx >= strokes.length) return; // 整字已写完，不恢复手势
    // 一笔结束（无论写完还是没写完）：清掉残笔痕迹、进度归零，
    // 从下一笔的起笔处重新显示手势。手势只在这里出现，
    // 不在拖动途中就显示，避免圆点沿下一笔走了半截后又被重建拉回起点
    prog = 0;
    if (progPath) progPath.setAttribute("d", "");
    showGuide();
  };
  svg.addEventListener("pointerup", endPointer);
  svg.addEventListener("pointercancel", endPointer);

  /* ---------- 打开 / 关闭 / 状态重置 ---------- */
  function resetBlank() {
    idx = 0;
    prog = 0;
    liftGate = false;
    litPaths.forEach((p) => p.classList.remove("on"));
    if (progPath) progPath.setAttribute("d", "");
    // 中断完成特效：收起金色光丝层
    clearTimeout(goldTimer);
    goldPaths.forEach((p) => p.classList.remove("run"));
    if (goldG) goldG.classList.add("hidden");
  }

  function refreshToggleBtns() {
    $("#btn-trace-gesture").classList.toggle("active", gestureOn);
    $("#btn-trace-voice").classList.toggle("active", voiceOn);
  }

  function open(char) {
    document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
    $("#view-trace").classList.remove("hidden");
    tipEl.textContent = "正在加载笔顺…";
    ready = false;
    pointerId = null;
    liftGate = false;
    stopDemo(false); // 若上一轮演示的 rAF 仍在跑，先停掉并清场（含 finishTimer、演示圆点）
    stopVoice();
    clearSvg();
    loadChar(char).then((data) => {
      if ($("#view-trace").classList.contains("hidden")) return; // 已退出，丢弃结果
      if (!data) {
        tipEl.textContent = `抱歉，「${char}」还没有笔顺数据`;
        return;
      }
      build(data);
      ready = true;
      tipStroke();
      showGuide();
      announceName(0);
      scheduleVoice();
    });
  }

  function close() {
    stopDemo(false); // 停演示、清残笔与金色光丝层
    clearTimeout(drawerTimer); // 抽屉若正处于折叠延时中，退出后不再改动原页面
    drawerTimer = 0;
    stopVoice();
    hideGuide();
    ready = false;
    pointerId = null;
    $("#view-trace").classList.add("hidden");
    $("#view-card").classList.remove("hidden"); // 回到单字详情页（内容保持原样）
  }

  /* ---------- 顶部按钮（风格与练习页一致） ---------- */
  $("#btn-trace-gesture").addEventListener("click", () => {
    gestureOn = !gestureOn;
    savePref("gesture", gestureOn);
    refreshToggleBtns();
    if (gestureOn) showGuide();
    else hideGuide();
  });
  $("#btn-trace-voice").addEventListener("click", () => {
    voiceOn = !voiceOn;
    savePref("voice", voiceOn);
    refreshToggleBtns();
    if (voiceOn) {
      announceName(idx);
      scheduleVoice();
    } else {
      stopVoice();
    }
  });
  $("#btn-trace-demo").addEventListener("click", () => {
    // 「演示」是开关：开 = 循环演示，关（或点页面任意位置）= 停止
    if (demoOn) stopDemo(true);
    else startDemo();
  });
  // 演示中点页面任意位置终止（「演示」按钮本身除外，它走自己的开关逻辑）
  $("#view-trace").addEventListener(
    "pointerdown",
    (e) => {
      if (demoOn && !e.target.closest("#btn-trace-demo")) stopDemo(true);
    },
    true
  );
  // 顶部按钮折叠 / 展开（与练习页一致：按钮先滑进灰色关闭区，滑完再折叠面板）
  const toolsWrap = $("#trace-tools-wrap");
  const toolsHide = $("#btn-trace-tools-hide");
  const toolsShow = $("#btn-trace-tools-show");
  let drawerTimer = 0;
  toolsHide.addEventListener("click", () => {
    if (toolsWrap.classList.contains("drawer-out")) return;
    toolsWrap.classList.add("drawer-out");
    drawerTimer = setTimeout(() => {
      drawerTimer = 0;
      toolsWrap.classList.remove("drawer-out");
      toolsWrap.classList.add("collapsed");
    }, 200);
    toolsHide.setAttribute("aria-expanded", "false");
    toolsShow.setAttribute("aria-expanded", "true");
  });
  toolsShow.addEventListener("click", () => {
    clearTimeout(drawerTimer);
    drawerTimer = 0;
    toolsWrap.classList.remove("drawer-out");
    toolsWrap.classList.remove("collapsed");
    toolsHide.setAttribute("aria-expanded", "true");
    toolsShow.setAttribute("aria-expanded", "false");
  });
  $("#btn-trace-reset").addEventListener("click", () => {
    if (!ready) return;
    stopDemo(false); // 已含 resetBlank：清点亮、进度、金色光丝与演示状态
    tipStroke();
    showGuide();
    announceName(0);
    scheduleVoice();
  });
  $("#btn-trace-back").addEventListener("click", close);

  window.TraceView = { open, load: loadChar };
})();
