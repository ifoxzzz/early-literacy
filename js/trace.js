// 临摹页（写一写原型）：从单字详情页进入的独立页面，只新增不改现有逻辑。
// 布局与练习页一致：顶部一排 btn-skip 风格按钮（手势/语音开关 + 演示/重写/返回）。
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
      s.src =
        "assets/strokes/" + encodeURIComponent(char) + ".js?v=" + (window.APP_VERSION || "");
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
  const SAMPLE_STEP = 12; // 骨架重采样间距（1024 坐标系单位）
  const TOLERANCE = 64; // 判定半径：笔尖离骨架多近算描到
  const LOOKAHEAD = 8; // 每次事件最多向前推进的采样点数（防止跳笔作弊）
  const VOICE_INTERVAL = 7000; // 语音开启时，多久没进展重复播报一次当前笔画

  let strokes = []; // 每笔的 SVG path（轮廓，用于灰底与点亮）
  let samples = []; // 每笔重采样后的骨架点 [{x,y}...]
  let strokeNames = []; // 每笔名称（横竖撇捺点提折，由骨架几何推断）
  let litPaths = []; // 点亮层 path 元素
  let idx = 0; // 当前要写第几笔
  let prog = 0; // 当前笔已描到的采样点下标
  let ready = false; // 数据是否就绪（就绪前忽略描画）
  let pointerId = null; // 当前跟踪的触摸点（单指）
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
    svg.innerHTML = "";
    litPaths = [];
    flipG = null;
    goldG = null;
    goldPaths = [];
    progPath = null;
    guideG = null;
  }

  function el(tag, attrs, parent) {
    const node = document.createElementNS(NS, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }

  function build(data) {
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
  function showGuide() {
    if (!ready || demo || !gestureOn || idx >= strokes.length || !guideG) return;
    const pts = samples[idx];
    const d = "M" + pts.map((p) => `${p.x} ${p.y}`).join(" L");
    guideG.innerHTML = "";
    const dot = el("circle", { r: 46, class: "trace-guide-dot" }, guideG);
    // 用 SMIL animateMotion 沿骨架循环，删掉重建即可从头再播
    el(
      "animateMotion",
      {
        dur: Math.max(0.8, pathLen(pts) / 460).toFixed(2) + "s",
        repeatCount: "indefinite",
        path: d,
      },
      dot
    );
    guideG.classList.remove("hidden");
  }

  function hideGuide() {
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
    if (window.Sound) Sound.play("correct");
    idx++;
    prog = 0;
    if (idx >= strokes.length) {
      hideGuide();
      stopVoice();
      playStrokeGold(); // 整字写完：金色光丝沿笔画轮廓游走
      tipEl.textContent = "写得真棒！点「重写」再来一遍吧";
    } else {
      tipStroke();
      announceName(idx);
      scheduleVoice();
      showGuide();
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
    clearTimeout(finishTimer);
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
    // 快速划动时浏览器会合并事件，取出合并的中间点避免漏判
    const evts = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evts.length ? evts : [e]) {
      const p = toData(ev);
      if (p) advance(p);
    }
  });
  const endPointer = (e) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    if (!ready || demoOn) return;
    if (idx >= strokes.length) return; // 整字已写完，不恢复手势
    // 这一笔没写完就抬手（笔顺或轨迹不对）：清掉残笔痕迹，进度归零，
    // 重新出现手势，让用户从起笔处重新写这一笔
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
    $("#btn-trace-demo").classList.toggle("active", demoOn);
  }

  function open(char) {
    document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
    $("#view-trace").classList.remove("hidden");
    tipEl.textContent = "正在加载笔顺…";
    ready = false;
    pointerId = null;
    demoOn = false;
    clearSvg();
    refreshToggleBtns();
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
    stopDemo(false);
    clearTimeout(finishTimer);
    stopVoice();
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
  // 顶部按钮折叠 / 展开（与练习页一致）
  const toolsWrap = $("#trace-tools-wrap");
  const toolsHide = $("#btn-trace-tools-hide");
  const toolsShow = $("#btn-trace-tools-show");
  toolsHide.addEventListener("click", () => {
    toolsWrap.classList.add("collapsed");
    toolsHide.setAttribute("aria-expanded", "false");
    toolsShow.setAttribute("aria-expanded", "true");
  });
  toolsShow.addEventListener("click", () => {
    toolsWrap.classList.remove("collapsed");
    toolsHide.setAttribute("aria-expanded", "true");
    toolsShow.setAttribute("aria-expanded", "false");
  });
  $("#btn-trace-reset").addEventListener("click", () => {
    if (!ready) return;
    stopDemo(false);
    clearTimeout(finishTimer);
    resetBlank();
    tipStroke();
    showGuide();
    announceName(0);
    scheduleVoice();
  });
  $("#btn-trace-back").addEventListener("click", close);

  window.TraceView = { open, load: loadChar };
})();
