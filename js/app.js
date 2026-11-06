// 主逻辑：视图切换、练习流程、对错反馈
(function () {
  const $ = (s) => document.querySelector(s);

  // 字库里可以用「汉字(拼音)」标注强制纠正朗读读音（如 快乐(lè)）；
  // 标注只给语音生成脚本用，界面展示时去掉括号与拼音，只留汉字。
  // 清洗规则与系统语音共用 speaker.js 的实现，避免两处正则不一致
  const displayText = (text) => Speaker.stripAnnotation(text);

  // 禁用鼠标右键菜单，避免小朋友误触后不知道如何处理
  document.addEventListener("contextmenu", (e) => e.preventDefault());

  /* ---------- 鼠标气泡特效：光标移动时冒出小气泡，帮助孩子找到箭头 ---------- */
  let bubbleTime = 0;
  let bubbleX = 0;
  let bubbleY = 0;
  document.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return; // 触屏不冒泡
    const now = performance.now();
    // 节流：70ms 内或几乎没移动时不再冒泡，避免拖出一长串气泡
    if (now - bubbleTime < 70) return;
    if (Math.abs(e.clientX - bubbleX) < 8 && Math.abs(e.clientY - bubbleY) < 8) return;
    bubbleTime = now;
    bubbleX = e.clientX;
    bubbleY = e.clientY;

    const bubble = document.createElement("span");
    bubble.className = "cursor-bubble";
    const size = 6 + Math.random() * 6; // 6~12px，随机大小更自然
    bubble.style.width = bubble.style.height = `${size}px`;
    bubble.style.left = `${e.clientX + Math.random() * 16 - 8}px`;
    bubble.style.top = `${e.clientY + Math.random() * 16 - 8}px`;
    bubble.addEventListener("animationend", () => bubble.remove()); // 动画结束即回收
    document.body.appendChild(bubble);
  });

  const views = {
    home: $("#view-home"),
    volumes: $("#view-volumes"),
    settings: $("#view-settings"),
    admin: $("#view-admin"),
    history: $("#view-history"),
    card: $("#view-card"),
    volumeWords: $("#view-volume-words"),
    quiz: $("#view-quiz"),
    result: $("#view-result"),
    gifts: $("#view-gifts"),
  };

  // 本次练习状态
  const session = {
    queue: [], // 本组剩余题目
    total: 0, // 本组题数
    done: 0, // 已完成题数（答对、跳过、求助后点对都算完成）
    stars: 0,
    streak: 0, // 连续首次答对的题数（决定烟花周围绕转的星星数量）
    firstTryCorrect: 0, // 首答正确题数
    newLearned: [], // 本次新学会的字
    answers: [], // 本组每个字的首次作答结果 [{ c, pinyin, words, note, ok }]
    firstQuestion: false, // 本组第一题（播放欢迎语）
    userId: "", // 本组属于哪位小朋友（结束页返回时用）
    userName: "", // 当前小朋友名字（用于语音问候）
    volumeId: "", // 本组所选册 id（结束页「继续答题」时用）
    volume: "", // 当前学习的是哪一册
    optionCount: 4, // 每题候选字数（决定田字格布局）
    current: null, // 当前题目
    gen: 0, // 会话代次：重新开始或退出时自增，用于作废上一组残留的延时回调
    timer: null, // 进入下一题的 600ms 延时
    delayTimer: null, // 答对后播放夸奖语音前的 400ms 延时
    guardTimer: null, // 夸奖语音结束回调的 6 秒兜底
  };

  // 礼物兑换状态：本组可挑选数量、已选礼物、是否已领取；giftsReturnView 记录展柜返回去向
  let giftQuota = 0;
  let giftPicked = [];
  let giftClaimed = false;
  let giftBagRefreshed = false; // 本次打开的礼物袋是否已用过「换一批」（每袋只能用一次）
  let giftsReturnView = "quiz";
  let giftShelfMode = "shelf"; // "shelf" 橱窗 / "box" 收纳盒 / "list" 记录

  function show(name) {
    Object.values(views).forEach((v) => v.classList.add("hidden"));
    views[name].classList.remove("hidden");
    // 离开首页就停掉气泡漂移，避免后台空转
    if (name !== "home") stopBubbles();
    // 离开结束页时清理小手和水波纹
    if (name !== "result") cleanupResultFx();
    // 练习页保持屏幕常亮，离开练习页立即释放
    if (name === "quiz") WakeLock.enable();
    else WakeLock.disable();
  }

  /* ---------- 屏幕常亮：练习时避免手机自动息屏 ---------- */
  // 使用 Screen Wake Lock API（安卓 Chrome、iOS Safari 16.4+ 支持，需 HTTPS 或 localhost）
  const WakeLock = {
    lock: null,
    wanted: false, // 当前页面是否希望保持常亮

    async request() {
      if (!("wakeLock" in navigator)) return; // 不支持的浏览器直接跳过
      try {
        this.lock = await navigator.wakeLock.request("screen");
        this.lock.addEventListener("release", () => {
          this.lock = null;
        });
      } catch (e) {
        this.lock = null; // 电量过低、系统限制等原因会失败，静默忽略
      }
    },

    async enable() {
      this.wanted = true;
      if (!this.lock) await this.request();
    },

    async disable() {
      this.wanted = false;
      const lock = this.lock;
      if (!lock) return;
      this.lock = null;
      try {
        await lock.release();
      } catch (e) {}
    },
  };

  // 切到后台再回来时系统会释放锁，需要重新申请；请求失败时也不必重试
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && WakeLock.wanted && !WakeLock.lock) {
      WakeLock.request();
    }
  });

  // 候选字数量对应的行列：横屏行数少、竖屏列数少，避免卡片被拉得又宽又扁
  // 实际卡片尺寸由 applyGridLayout 按可用空间实时计算
  const GRID_LAYOUT = {
    2: { landscape: [2, 1], portrait: [1, 2] },
    3: { landscape: [3, 1], portrait: [1, 3] },
    4: { landscape: [2, 2], portrait: [2, 2] },
    6: { landscape: [3, 2], portrait: [2, 3] },
    8: { landscape: [4, 2], portrait: [2, 4] },
    9: { landscape: [3, 3], portrait: [3, 3] },
  };

  const quizStage = $("#quiz-stage");
  const quizHint = $("#view-quiz .hint-bar");
  const readBar = $("#read-bar");
  const btnRead = $("#btn-read");
  const btnHelp = $("#btn-help");
  // 上一次测量时底部提示条的高度：组词/注解文字换行会让提示条变高，
  // 高度一变就说明舞台被挤小了，需要重新算一次卡片尺寸
  let layoutHintH = -1;

  // 按当前数量 + 横竖屏计算行列与卡片尺寸；转屏时再次调用即可即时重排
  // 原则：田字格尽可能大，且绝不与顶部按钮、底部提示条或「再听一遍/帮帮我」重叠
  function applyGridLayout() {
    const conf = GRID_LAYOUT[session.optionCount] || GRID_LAYOUT[4];
    const portrait = window.innerHeight > window.innerWidth;
    const [cols, rows] = portrait ? conf.portrait : conf.landscape;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const gap = Math.min((3 * Math.min(vw, vh)) / 100, 20); // 与 --card-gap 保持一致
    // 悬停时卡片会 scale(1.07)，边缘卡片会向屏幕外/上下内容膨胀；
    // 计算尺寸时把四周膨胀量和一点安全余量预留出来，保证放大后仍完整可见
    const hoverGrow = 0.07;
    const safePad = 10;
    const cap = Math.min(Math.min(vw, vh) * 0.72, 420); // 超大屏时避免单字过大
    const fitSize = (w, h) =>
      Math.min(
        (w - (cols - 1) * gap - safePad * 2) / (cols + hoverGrow),
        (h - (rows - 1) * gap - safePad * 2) / (rows + hoverGrow),
        cap
      );

    views.quiz.style.setProperty("--cols", cols);
    views.quiz.style.setProperty("--rows", rows);
    views.quiz.style.setProperty("--card-gap", `${gap}px`);
    views.quiz.classList.remove("quiz-side");

    const stageW = quizStage.clientWidth;
    const stageH = quizStage.clientHeight;
    if (!stageW || !stageH) return;
    const stageGap = parseFloat(getComputedStyle(quizStage).rowGap) || 0;
    const availW = stageW; // 田字格可用宽度：竖屏时靠收窄视图左右内边距获得

    // 默认：按钮在田字格上方（竖屏或左右空间不足时）
    const availH = stageH - readBar.offsetHeight - stageGap;
    const topSize = fitSize(availW, availH);
    let size = topSize;

    // 横屏且左右放得下按钮时：把「再听一遍」「帮帮我」移到田字格两侧垂直居中
    // 这样纵向空间全部留给田字格，也就不会遮住顶部按钮
    if (!portrait) {
      views.quiz.classList.add("quiz-side");
      const reserve = Math.max(btnRead.offsetWidth, btnHelp.offsetWidth) + gap;
      const sideSize = fitSize(availW - reserve * 2, stageH);
      if (sideSize > topSize) size = sideSize;
      else views.quiz.classList.remove("quiz-side");
    }

    views.quiz.style.setProperty("--card-size", `${Math.max(0, Math.floor(size))}px`);
    layoutHintH = quizHint.offsetHeight;
  }

  // 题目文字填入提示条后再检查一次：组词/注解较长换行时提示条会变高，
  // 舞台随之变矮，需要把田字格缩到新的可用空间
  function fitGridToHint() {
    if (views.quiz.classList.contains("hidden")) return;
    if (quizHint.offsetHeight !== layoutHintH) applyGridLayout();
  }

  window.addEventListener("resize", () => {
    if (!views.quiz.classList.contains("hidden")) applyGridLayout();
  });

  /* ---------- 首页：选择小朋友 ---------- */
  function renderHome() {
    const users = Storage.users();
    const list = $("#user-list");
    list.innerHTML = "";
    users.forEach((u) => {
      const card = document.createElement("button");
      card.className = "user-card";
      card.dataset.id = u.id;
      card.textContent = u.name;
      list.appendChild(card);
    });
    const total = window.VOLUMES.reduce((s, v) => s + v.entries.length, 0);
    $("#home-stats").textContent =
      users.length === 0
        ? `字库共 ${total} 字，先创建一个小朋友吧`
        : "点小朋友的名字，开始练习";
    show("home");
    startBubbles();
  }

  /* ---------- 首页气泡：名字气泡悬浮漂移 + 相互碰撞 ---------- */
  // 名字按钮做成彩色气泡：缓慢漂浮，撞到边框或彼此就弹开（QQ 弹弹）。
  // 每帧只改 transform、不写 left/top；离开首页、没有名字或系统要求减少动态时立即停下。
  // 留白按外阴影的实际伸展量给：投影向下偏移 10px、模糊 24px、收拢 12px，
  // 所以底部要留约 22px，否则气泡贴到底边时阴影会被容器裁掉
  const BUBBLE_PAD_X = 14; // 左右：阴影向两侧各扩约 12px
  const BUBBLE_PAD_TOP = 10; // 上方：阴影基本不向上扩
  const BUBBLE_PAD_BOTTOM = 26; // 下方：给投影留足空间，气泡不会飘到最下区域
  const BUBBLE_GAP = 14; // 初始排布时气泡之间的间距
  const BUBBLE_SPEED = 20; // 基础漂移速度（px/s），慢一些方便小朋友点中

  const bubbles = {
    el: null, // 气泡容器 #user-list
    items: [], // [{ el, x, y, hw, hh, vx, vy, phase }]
    box: { w: 0, h: 0 }, // 活动场尺寸
    raf: 0,
    last: 0,
    running: false,
  };

  function prefersReducedMotion() {
    return !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  // 气泡是两端半圆的胶囊。把每个气泡看成"一条水平线段 + 半径"：
  // 两条线段的最近距离小于两端半径之和，才是真正碰到。
  // 用线段距离（而不是椭圆近似）可以保证接触瞬间刚好贴边，不会先压进去一块。
  function capsuleGap(a, b) {
    const ar = Math.max(0, a.hw - a.hh); // 胶囊"芯"的半长（两端半圆的圆心范围）
    const br = Math.max(0, b.hw - b.hh);
    const dx = Math.abs(b.x - a.x) - (ar + br); // 两条芯线段的水平间隙
    const gapX = Math.max(0, dx);
    const gapY = Math.abs(b.y - a.y);
    const dist = Math.hypot(gapX, gapY);

    let nx = 0;
    let ny = b.y >= a.y ? 1 : -1;
    if (gapX > 0) {
      // 芯线段在水平方向错开：最近点落在两段相邻的端点上，法线沿这两个端点的连线
      const dir = b.x >= a.x ? 1 : -1;
      const cxA = a.x + ar * dir;
      const cxB = b.x - br * dir;
      const len = Math.hypot(cxB - cxA, b.y - a.y) || 1;
      nx = (cxB - cxA) / len;
      ny = (b.y - a.y) / len;
    }
    return { dist, nx, ny };
  }

  // 贪心换行：每行尽量多放，超出可用宽度就另起一行
  function packBubbleRows(sizes, availW) {
    const rows = [];
    let row = null;
    sizes.forEach((item) => {
      if (!row || row.w + BUBBLE_GAP + item.w > availW) {
        row = { items: [], w: 0, h: 0 };
        rows.push(row);
      }
      row.w += (row.items.length ? BUBBLE_GAP : 0) + item.w;
      row.h = Math.max(row.h, item.h);
      row.items.push(item);
    });
    return rows;
  }

  // 初始排布：先按自然尺寸排；放不下就等比缩小字号重排，保证气泡都在场内且不重叠
  function layoutBubbles() {
    const el = bubbles.el;
    if (!el) return;
    const availW = bubbles.box.w - BUBBLE_PAD_X * 2;
    const availH = bubbles.box.h - BUBBLE_PAD_TOP - BUBBLE_PAD_BOTTOM;
    if (availW <= 40 || availH <= 40) return;

    let scale = 1;
    let rows = [];
    for (let i = 0; i < 5; i++) {
      el.style.setProperty("--bscale", scale.toFixed(3));
      const sizes = bubbles.items.map((b) => ({
        b,
        w: b.el.offsetWidth,
        h: b.el.offsetHeight,
      }));
      rows = packBubbleRows(sizes, availW);
      const widest = Math.max(...sizes.map((s) => s.w));
      const needH = rows.reduce((s, r) => s + r.h, 0) + BUBBLE_GAP * (rows.length - 1);
      if (widest > availW) {
        scale *= Math.max(0.55, availW / widest); // 单个气泡比场地还宽：只能整体缩小
        continue;
      }
      if (needH > availH) {
        scale *= Math.max(0.55, availH / needH); // 行数太多放不下：整体缩小
        continue;
      }
      break;
    }

    // 行内水平居中、整体在"去掉上下留白后的区域"内垂直居中；坐标记的是气泡中心
    const totalH = rows.reduce((s, r) => s + r.h, 0) + BUBBLE_GAP * (rows.length - 1);
    let y = BUBBLE_PAD_TOP + Math.max(0, (availH - totalH) / 2);
    rows.forEach((row) => {
      let x = (bubbles.box.w - row.w) / 2;
      row.items.forEach((item) => {
        const b = item.b;
        b.hw = item.w / 2;
        b.hh = item.h / 2;
        b.x = x + b.hw;
        b.y = y + row.h / 2;
        x += item.w + BUBBLE_GAP;
      });
      y += row.h + BUBBLE_GAP;
    });
  }

  // 把气泡中心拉回活动场内（撞墙翻转在下一帧的位移里做）
  function clampBubble(b) {
    const midX = bubbles.box.w / 2;
    const midY = bubbles.box.h / 2;
    const minX = Math.min(b.hw + BUBBLE_PAD_X, midX);
    const maxX = Math.max(bubbles.box.w - b.hw - BUBBLE_PAD_X, midX);
    const minY = Math.min(b.hh + BUBBLE_PAD_TOP, midY);
    const maxY = Math.max(bubbles.box.h - b.hh - BUBBLE_PAD_BOTTOM, midY);
    b.x = Math.min(maxX, Math.max(minX, b.x));
    b.y = Math.min(maxY, Math.max(minY, b.y));
  }

  // 等质量弹性碰撞：交换沿碰撞法线方向的速度分量，切向不变，就像两个球撞在一起
  function collideBubbles(a, b) {
    const gap = capsuleGap(a, b);
    const minDist = a.hh + b.hh; // 两端半圆半径之和
    if (gap.dist >= minDist) return;

    const nx = gap.nx;
    const ny = gap.ny;
    // 各自让开一半，并多留 0.3px 缝隙：既消除视觉重叠，也避免贴边抖动
    const overlap = minDist - gap.dist + 0.3;
    a.x -= nx * overlap * 0.5;
    a.y -= ny * overlap * 0.5;
    b.x += nx * overlap * 0.5;
    b.y += ny * overlap * 0.5;

    const va = a.vx * nx + a.vy * ny;
    const vb = b.vx * nx + b.vy * ny;
    if (va - vb > 0) {
      a.vx += (vb - va) * nx;
      a.vy += (vb - va) * ny;
      b.vx += (va - vb) * nx;
      b.vy += (va - vb) * ny;
    }
  }

  // 一帧内：先漂移并撞墙反弹，再处理气泡互撞，最后统一写 transform
  function stepBubbles(dt) {
    const items = bubbles.items;
    items.forEach((b) => {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      const midX = bubbles.box.w / 2;
      const midY = bubbles.box.h / 2;
      const minX = Math.min(b.hw + BUBBLE_PAD_X, midX);
      const maxX = Math.max(bubbles.box.w - b.hw - BUBBLE_PAD_X, midX);
      const minY = Math.min(b.hh + BUBBLE_PAD_TOP, midY);
      const maxY = Math.max(bubbles.box.h - b.hh - BUBBLE_PAD_BOTTOM, midY);
      if (b.x < minX) {
        b.x = minX;
        b.vx = Math.abs(b.vx);
      } else if (b.x > maxX) {
        b.x = maxX;
        b.vx = -Math.abs(b.vx);
      }
      if (b.y < minY) {
        b.y = minY;
        b.vy = Math.abs(b.vy);
      } else if (b.y > maxY) {
        b.y = maxY;
        b.vy = -Math.abs(b.vy);
      }
    });
    // 先处理气泡互撞，再统一写 transform
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        collideBubbles(items[i], items[j]);
      }
    }
    items.forEach(clampBubble);
  }

  // 气泡外观：位置之外只保留极轻的呼吸起伏；碰撞不再改变大小
  function paintBubble(b, now) {
    const k = 1 + Math.sin(now / 1100 + b.phase) * 0.012;
    b.el.style.transform =
      `translate3d(${(b.x - b.hw).toFixed(2)}px, ${(b.y - b.hh).toFixed(2)}px, 0) ` +
      `scale(${k.toFixed(3)})`;
  }

  function tickBubbles(now) {
    if (!bubbles.running) return;
    if (views.home.classList.contains("hidden")) {
      stopBubbles(); // 已经不在首页，别继续空转
      return;
    }
    const dt = bubbles.last ? Math.min(0.05, (now - bubbles.last) / 1000) : 0;
    bubbles.last = now;
    if (dt > 0) stepBubbles(dt);
    bubbles.items.forEach((b) => paintBubble(b, now));
    bubbles.raf = requestAnimationFrame(tickBubbles);
  }

  function stopBubbles() {
    bubbles.running = false;
    if (bubbles.raf) cancelAnimationFrame(bubbles.raf);
    bubbles.raf = 0;
    bubbles.last = 0;
  }

  // 进入首页时调用：排布气泡并启动漂移（系统开启"减少动态"时只静态排布）
  function startBubbles() {
    stopBubbles();
    const el = $("#user-list");
    bubbles.el = el;
    const cards = Array.from(el.querySelectorAll(".user-card"));
    bubbles.items = cards.map((card) => ({
      el: card,
      x: 0,
      y: 0,
      hw: 0,
      hh: 0,
      vx: 0,
      vy: 0,
      phase: Math.random() * Math.PI * 2,
    }));
    if (!cards.length) return;
    bubbles.box = { w: el.clientWidth, h: el.clientHeight };
    if (!bubbles.box.w || !bubbles.box.h) return; // 视图尚未显示，等下次进入时再排

    layoutBubbles();
    bubbles.items.forEach(clampBubble);
    // 起漂方向：只有一个小朋友时随便漂；有多个时先朝场地中心靠拢，
    // 这样很快就能看到它们撞在一起，之后各自弹开
    const speed = BUBBLE_SPEED * (bubbles.items.length > 1 ? 1.15 : 0.6);
    bubbles.items.forEach((b) => {
      const toCenter = Math.atan2(
        bubbles.box.h / 2 - b.y,
        bubbles.box.w / 2 - b.x
      );
      const ang =
        bubbles.items.length > 1
          ? toCenter + (Math.random() - 0.5) * Math.PI * 0.6
          : Math.random() * Math.PI * 2;
      const sp = speed * (0.75 + Math.random() * 0.5);
      b.vx = Math.cos(ang) * sp;
      b.vy = Math.sin(ang) * sp;
    });
    bubbles.items.forEach((b) => paintBubble(b, 0));
    if (prefersReducedMotion()) return;

    bubbles.running = true;
    bubbles.last = 0;
    bubbles.raf = requestAnimationFrame(tickBubbles);
  }

  // 窗口尺寸变化后重新排布（手机横竖屏切换、地址栏收起等）
  window.addEventListener("resize", () => {
    if (!views.home.classList.contains("hidden")) startBubbles();
  });

  /* ---------- 滚动容器效果：边缘淡出 + 滚动条自动隐藏 ---------- */
  // 内容超出时给容器加 fade-top / fade-bottom，滚到顶/底则取消对应一侧
  // fadeEl 省略时类加在容器自身（用遮罩）；汉字表传外层 .word-sheet（用渐变层），
  // 因为它的滚动区上方还有独立表头，遮罩会把表头一起淡掉
  function updateScrollFade(el, fadeEl) {
    if (!el || !el.clientHeight) return; // 所在视图隐藏时不计算
    const target = fadeEl || el;
    target.classList.toggle("fade-top", el.scrollTop > 2);
    target.classList.toggle(
      "fade-bottom",
      el.scrollTop + el.clientHeight < el.scrollHeight - 2
    );
  }

  // 滚动条只在滚动/拖动时露出：滚动时加 scrolling 类，停手 0.6 秒后移除
  const scrollTimers = new WeakMap();
  function showScrollbarTemporarily(el) {
    el.classList.add("scrolling");
    clearTimeout(scrollTimers.get(el));
    scrollTimers.set(el, setTimeout(() => el.classList.remove("scrolling"), 600));
  }

  function bindScrollFx(el, fadeEl) {
    el.addEventListener("scroll", () => {
      updateScrollFade(el, fadeEl);
      showScrollbarTemporarily(el);
    });
  }

  /* ---------- 选择学习内容：列出现有册 ---------- */
  function renderVolumes(user) {
    // 拼音 / 注解开关按小朋友保存，切换小朋友后要重新应用
    refreshDisplaySwitches();
    $("#volume-owner").textContent = user ? `${user.name} 想学哪一册？` : "";
    const list = $("#volume-list");
    list.innerHTML = "";
    // 最近点开过的册排到第一项，并用不同配色 + 分隔线与其他册区分（按小朋友保存）
    const lastId = user ? Storage.lastVolume(user.id) : "";
    const volumes = window.VOLUMES.slice();
    const recentIndex = lastId ? volumes.findIndex((v) => String(v.id) === lastId) : -1;
    const hasRecent = recentIndex >= 0;
    if (recentIndex > 0) volumes.unshift(volumes.splice(recentIndex, 1)[0]);
    volumes.forEach((v, i) => {
      const s = Storage.statsFor(v.entries);
      const card = document.createElement("button");
      card.className = hasRecent && i === 0 ? "volume-card recent" : "volume-card";
      card.dataset.id = v.id;
      card.innerHTML = `<span class="volume-name">${v.title}</span>
        <span class="volume-meta">共 ${s.total} 字 · 已学 ${s.learned} · 待复习 ${s.due}</span>
        <span class="volume-icon" role="img" aria-label="查看本册汉字" title="查看本册汉字">📖</span>`;
      list.appendChild(card);
      if (hasRecent && i === 0) {
        const divider = document.createElement("div");
        divider.className = "volume-divider";
        divider.setAttribute("aria-hidden", "true");
        list.appendChild(divider);
      }
    });
    show("volumes");
    updateScrollFade($("#volume-list"));
  }

  /* ---------- 某一册的汉字表（册目页右侧图标进入） ---------- */
  let volumeWordVolume = null; // 当前汉字表对应的册（从详情页返回时要用）

  function renderVolumeWords(volume) {
    volumeWordVolume = volume;
    $("#words-subtitle").textContent = `${volume.title} · 共 ${volume.entries.length} 个字`;
    // 表头独立于滚动区域，列宽与数据行共用同一套网格，既不会盖住数据也不会被淡出
    $("#word-head").innerHTML = `
        <span></span>
        <span>汉字</span>
        <span>拼音</span>
        <span>组词</span>
        <span>注解</span>
        <span>要求</span>`;
    $("#word-list").innerHTML = volume.entries
        .map(
          (e, i) => `<div class="word-item" data-idx="${i}" title="查看「${e.char}」">
          <button class="word-play" data-idx="${i}" title="播放读音、组词和注解">🔊</button>
          <span class="word-char">${e.char}</span>
          <span class="word-pinyin">${e.pinyin}</span>
          <span class="word-words">${displayText(e.words)}</span>
          <span class="word-note">${displayText(e.note)}</span>
          <span class="word-level">${e.level}</span>
        </div>`
        )
        .join("");
    show("volumeWords");
    updateScrollFade($("#word-list"), $("#word-sheet"));
  }

  /* ---------- 应用设置 ---------- */
  function renderAdmin() {
    const users = Storage.users();
    const box = $("#admin-users");
    box.innerHTML = "";
    if (users.length === 0) {
      box.innerHTML = `<p class="admin-tip">还没有小朋友，点下面按钮新增。</p>`;
    }
    users.forEach((u) => {
      const row = document.createElement("div");
      row.className = "admin-user";
      const name = document.createElement("span");
      name.className = "admin-user-name";
      name.textContent = u.name;
      const del = document.createElement("button");
      del.className = "btn btn-danger btn-small";
      del.textContent = "删除";
      del.dataset.id = u.id;
      row.append(name, del);
      box.appendChild(row);
    });
    refreshClickSound();
    show("admin");
  }

  /* ---------- 练习设置（按小朋友独立保存） ---------- */
  function renderSettings() {
    const user = Storage.currentUser();
    $("#settings-owner").textContent = user ? `${user.name} 的练习设置` : "";
    refreshSettings(user);
    show("settings");
  }

  // 读取该小朋友的设置并回填按钮与题数
  function refreshSettings(user) {
    const id = user ? user.id : Storage.currentId();
    const opt = Storage.quizOptions(id);
    $("#set-options")
      .querySelectorAll("button")
      .forEach((b) => b.classList.toggle("active", Number(b.dataset.v) === opt));
    $("#set-count").value = Storage.quizCount(id);
  }

  /* ---------- 通用单字详情页 ---------- */
  // 其他页面想展示某个字时都可复用 openCharCard(entry, { onBack })
  let cardEntry = null;
  let cardOnBack = null;

  function openCharCard(entry, opts) {
    cardEntry = entry;
    cardOnBack = (opts && opts.onBack) || null;
    $("#btn-card-back").classList.toggle("hidden", !cardOnBack);
    $("#card-words").textContent = entry.words ? `「${displayText(entry.words)}」` : "";
    const cardNote = displayText(entry.note);
    $("#card-note").textContent = cardNote;
    $("#card-note").classList.toggle("hidden", !cardNote);
    const grid = $("#card-grid");
    grid.innerHTML = "";
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<span class="pinyin">${entry.pinyin || ""}</span><span class="char">${
      entry.char || ""
    }</span>`;
    grid.appendChild(card);
    show("card");
  }

  /* ---------- 练习记录 ---------- */
  // 当前记录页里每个可点击汉字对应的字库条目
  let historyEntries = [];

  // 每条作答记录自带拼音、组词与注解，直接取出展示
  function entryOfAnswer(a) {
    return { char: a.c, pinyin: a.pinyin, words: a.words, note: a.note };
  }

  function renderHistory() {
    const user = Storage.currentUser();
    $("#history-owner").textContent = user ? `${user.name} 的练习记录` : "";
    const list = Storage.loadHistory().slice().reverse(); // 最近一次在最上面
    const box = $("#history-list");
    historyEntries = [];
    if (list.length === 0) {
      box.innerHTML = `<p class="history-empty">还没有练习记录，快去练一组吧！</p>`;
    } else {
      box.innerHTML = list
        .map((r) => {
          const d = new Date(r.date);
          const when = `${d.getMonth() + 1}月${d.getDate()}日 ${String(
            d.getHours()
          ).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}${
            r.volume ? ` · ${r.volume}` : ""
          }`;
          // 星星不用数字，得几颗就画几颗
          const stars =
            r.stars > 0
              ? `<span class="history-stars">${"⭐".repeat(r.stars)}</span>`
              : `<span class="history-stars none">还没有星星</span>`;
          // 本组学过的字：绿色答对、红色答错；每个字都可点击查看详情
          const chars = r.chars
            .map((a) => {
              const idx = historyEntries.length;
              historyEntries.push(entryOfAnswer(a));
              return `<button class="hchar ${a.ok ? "ok" : "no"}" data-idx="${idx}">${
                a.c
              }</button>`;
            })
            .join("");
          const charsRow = chars
            ? `<div class="history-chars">${chars}</div>`
            : `<div class="history-chars"><span class="history-chars-empty">本组没有作答记录</span></div>`;
          return `<div class="history-item">
            <div class="history-head"><span class="history-date">${when}</span>${stars}</div>
            ${charsRow}
          </div>`;
        })
        .join("");
    }
    // 没有记录时不显示「清除记录」
    $("#btn-reset").classList.toggle("hidden", list.length === 0);
    show("history");
    updateScrollFade($("#history-list"));
  }

  /* ---------- 练习 ---------- */
  let enteringVolume = false; // 加载遮罩显示期间忽略重复点册

  // 加载进度条前端的小图标（会一颠一颠地往前跑）：可自由增删，每次加载随机取一个
  const LOADING_ICONS = ["🚗", "🚕", "🚓", "🛺", "🚌", "🦖", "🐢", "🐌", "🐠", "🚴"];

  function showLoading(title) {
    // 每次显示加载页随机换一个图标，避免每次都一样
    const icons = LOADING_ICONS.length ? LOADING_ICONS : ["🚗"];
    const icon = $("#loading-icon");
    icon.classList.remove("loading-icon-out", "loading-icon-in"); // 清掉可能残留的换装动画
    loadingIconSwapping = false; // 上一次换装若因遮罩提前隐藏而中断，这里重置
    icon.textContent = icons[Math.floor(Math.random() * icons.length)];
    $("#loading-title").textContent = title;
    $("#loading-fill").style.width = "0%";
    icon.style.left = "0%";
    $("#loading-count").textContent = "0 / 0";
    $("#loading-mask").classList.remove("hidden");
  }

  function updateLoading(done, total) {
    const pct = total ? Math.round((done / total) * 100) : 100;
    $("#loading-fill").style.width = `${pct}%`;
    $("#loading-icon").style.left = `${pct}%`; // 小图标跟着进度前端走
    $("#loading-count").textContent = `${done} / ${total}`;
  }

  function hideLoading() {
    $("#loading-mask").classList.add("hidden");
  }

  // 点击进度条上的小图标：随机换一个（不与当前相同），
  // 旧图标缩小淡出 → 新图标从小放大到略大于正常尺寸 → 回弹到正常，然后恢复跑动动画
  let loadingIconSwapping = false;

  function nextLoadingIcon(current) {
    const icons = LOADING_ICONS.length ? LOADING_ICONS : ["🚗"];
    if (icons.length <= 1) return icons[0];
    let next = current;
    while (next === current) {
      next = icons[Math.floor(Math.random() * icons.length)];
    }
    return next;
  }

  $("#loading-icon").addEventListener("click", () => {
    const icon = $("#loading-icon");
    if (loadingIconSwapping) return; // 动画进行中忽略重复点击
    loadingIconSwapping = true;
    icon.classList.add("loading-icon-out");
  });

  $("#loading-icon").addEventListener("animationend", (e) => {
    const icon = e.currentTarget;
    if (e.animationName === "loading-icon-out") {
      // 旧图标已收缩淡出：换成新图标，接着播放放大回弹
      icon.classList.remove("loading-icon-out");
      icon.textContent = nextLoadingIcon(icon.textContent);
      void icon.offsetWidth; // 强制重排，让下一段动画从头开始
      icon.classList.add("loading-icon-in");
    } else if (e.animationName === "loading-icon-in") {
      // 新图标已恢复到正常尺寸：清掉类名，交还给跑动动画
      icon.classList.remove("loading-icon-in");
      loadingIconSwapping = false;
    }
  });

  // 点册后只预加载第一题的语音，就绪即进入练习页；
  // 之后每出一题就后台预取下一题（prefetchUpcoming）
  function enterVolume(user, volume) {
    if (enteringVolume) return;
    // 该小朋友自己配置的候选字数 / 每组题数
    const uid = user ? user.id : Storage.currentId();
    const optionCount = Storage.quizOptions(uid);
    const questions = Quiz.buildSession(Storage.quizCount(uid), volume.entries, optionCount);
    if (questions.length === 0) return;
    enteringVolume = true;
    // 全部资源已缓存时可能瞬间完成，延迟一点再显示遮罩，避免进度条一闪而过
    let loadingShown = false;
    const showTimer = setTimeout(() => {
      loadingShown = true;
      showLoading(`正在准备「${volume.title}」`);
    }, 150);
    // 失败或超过 8 秒的文件会退回原始地址，同样计入进度，不会卡在加载页
    Speaker.preloadAll(Speaker.entryUrls(questions[0].target), updateLoading).then(() => {
      clearTimeout(showTimer);
      enteringVolume = false;
      if (loadingShown) hideLoading();
      startSession(user, volume, questions, optionCount);
    });
  }

  function startSession(user, volume, questions, optionCount) {
    if (questions.length === 0) return;
    // 换组时先作废旧代次并清掉上一组可能挂起的回调
    clearSessionTimers();
    session.gen += 1;
    Object.assign(session, {
      queue: questions,
      total: questions.length,
      done: 0,
      stars: 0,
      streak: 0,
      firstTryCorrect: 0,
      newLearned: [],
      answers: [],
      firstQuestion: true,
      userId: user ? user.id : "",
      userName: user ? user.name : "",
      volumeId: String(volume.id), // 结束页“继续答题”时回到同一册
      volume: volume.title,
      optionCount,
      current: null,
    });
    show("quiz");
    refreshQuizTools(); // 恢复该小朋友上次的顶部按钮展开状态
    nextQuestion(); // 第一题语音已由 enterVolume 预加载；后续题目由滑窗预取接力
    // 首次进入必须量一次尺寸；下一帧再量一次，避开手机浏览器地址栏/字体回流的时序差
    applyGridLayout();
    requestAnimationFrame(() => {
      if (!views.quiz.classList.contains("hidden")) applyGridLayout();
    });
  }

  // 本题只计一次进度：答对、跳过、求助后点对都会调用
  function markDone(q) {
    if (q.counted) return;
    q.counted = true;
    session.done += 1;
  }

  // 清掉本组练习挂起的全部延时回调。跳题、退出或重新组卷时必须调用，
  // 否则上一组的回调会在后台继续出题、朗读，甚至重复写入练习记录
  function clearSessionTimers() {
    clearTimeout(session.timer);
    clearTimeout(session.delayTimer);
    clearTimeout(session.guardTimer);
    session.timer = session.delayTimer = session.guardTimer = null;
  }

  // 后台预取下一题的语音（单字/组词/注解）：
  // 本题讲解播完后孩子还要作答，这段时间足够把下一题下完，下一题通常不必等进度条
  function prefetchUpcoming() {
    const next = session.queue[0];
    if (next) Speaker.preload(Speaker.entryUrls(next.target));
  }

  function nextQuestion() {
    if (session.queue.length === 0) {
      // 本组结束：清空当前题，避免已结算的旧题继续被延时回调当作“仍在作答”
      session.current = null;
      renderResult();
      return;
    }
    const q = session.queue.shift();
    const gen = session.gen; // 加载期间若退出/换组，作废旧回调
    // 本题资源未就绪时显示遮罩，加载完才出题；出题后已预取下一题，绝大多数情况瞬间完成、遮罩根本不出现
    let loadingShown = false;
    const showTimer = setTimeout(() => {
      loadingShown = true;
      showLoading("正在准备本题资源");
    }, 150);
    Speaker.preloadAll(Speaker.entryUrls(q.target), updateLoading).then(() => {
      clearTimeout(showTimer);
      if (gen !== session.gen) return;
      if (loadingShown) hideLoading();
      beginQuestion(q);
      prefetchUpcoming(); // 出题即预取下一题；本题音频已在 blob 里，不占网络
    });
  }

  // 换题时田字格退场动画时长（与 CSS 的 card-out 保持一致）
  const CARD_OUT_MS = 260;

  function beginQuestion(q) {
    q.locked = false;
    session.current = q;
    const gen = session.gen;
    const isFirst = session.firstQuestion;
    session.firstQuestion = false;
    const grid = $("#grid");

    const render = () => {
      if (gen !== session.gen || session.current !== q) return;

      // 题号并入底部信息行：小朋友 · 册名 · 第 x/x 题
      $("#quiz-user").textContent =
        `${session.userName} · ${session.volume} · 第 ${Math.min(session.done + 1, session.total)}/${session.total} 题`;
      setStars(session.stars, false);
      // 第一行组词（用「」包起来），第二行注解；拼音标注只给语音脚本，展示时去掉
      const words = displayText(q.target.words);
      $("#hint-words").textContent = words ? `「${words}」` : "";
      const hintNote = displayText(q.target.note);
      $("#hint-note").textContent = hintNote;
      $("#hint-note").classList.toggle("hidden", !hintNote);
      $("#btn-help").classList.remove("used"); // 新题目重新允许求助

      grid.classList.remove("locked", "helping", "leaving");
      grid.innerHTML = "";
      q.options.forEach((opt, i) => {
        const card = document.createElement("div");
        // card-in：由小变大、由透明到清晰，按序号依次浮现
        card.className = "card card-in";
        card.style.setProperty("--card-in-delay", `${i * 35}ms`);
        card.dataset.key = Quiz.keyOf(opt); // 多音字：字同音不同是不同卡片
        card.dataset.char = opt.char;
        card.innerHTML = `<span class="pinyin">${opt.pinyin}</span><span class="char">${opt.char}</span>`;
        card.addEventListener("click", (e) => onPick(card, opt, q, e));
        // 鼠标悬停高亮卡片时播放轻音效；触屏的 pointerenter 不触发
        card.addEventListener("pointerenter", (e) => {
          if (e.pointerType === "mouse" && !q.locked) Sound.play("hover");
        });
        grid.appendChild(card);
      });

      fitGridToHint(); // 组词/注解文字换行导致提示条变高时，立即缩小田字格

      Speaker.readQuestion(q.target, { welcome: isFirst, name: session.userName });
    };

    // 上一题的田字格先由大到小、逐渐淡化退场，播完再换上新题；
    // 本组第一题没有旧卡片，直接出题
    const leaving = grid.querySelectorAll(".card");
    if (leaving.length && !isFirst && !prefersReducedMotion()) {
      grid.classList.add("leaving");
      leaving.forEach((card) => card.classList.add("card-out"));
      setTimeout(render, CARD_OUT_MS);
    } else {
      render();
    }
  }

  // 作答后记录已写入：correct==1 且 wrong==0 说明是第一次接触的新字
  function isNewChar(key) {
    const r = Storage.loadAll()[key];
    return r && r.correct === 1 && r.wrong === 0;
  }

  /* ---------- 通用「手指引导 + 水波」特效 ---------- */
  // 手指 SVG：指尖位于顶部，宽度由调用方决定
  const HAND_SVG =
    '<svg viewBox="0 0 64 80" aria-hidden="true">' +
    '<rect x="26" y="3" width="14" height="44" rx="7" fill="#f5ad63"/>' +
    '<rect x="5" y="37" width="14" height="22" rx="7" transform="rotate(-22 12 48)" fill="#f5ad63"/>' +
    '<rect x="13" y="33" width="38" height="33" rx="15" fill="#f5ad63"/>' +
    '<rect x="16" y="63" width="32" height="9" rx="4.5" fill="#8ecfe0"/>' +
    "</svg>";

  let fingerGuideLayer = null;

  function hideFingerGuide() {
    if (fingerGuideLayer) {
      fingerGuideLayer.remove();
      fingerGuideLayer = null;
    }
  }

  // 通用接口：传入起点坐标、终点坐标、水波直径、手指宽度，即可在任意位置播放引导特效
  // container 默认 document.body（坐标为视口坐标）；传入元素时坐标相对该元素，特效随元素一起移动
  function showFingerGuide({
    from,
    to,
    rippleSize,
    fingerSize,
    container = document.body,
    color = "87, 166, 90",
  } = {}) {
    hideFingerGuide();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;

    const layer = document.createElement("div");
    layer.className = "finger-guide-layer";
    if (container === document.body) layer.classList.add("is-fixed");
    layer.setAttribute("aria-hidden", "true");
    layer.style.setProperty("--guide-color", color);
    layer.style.setProperty("--ripple-size", `${rippleSize}px`);
    layer.style.setProperty("--finger-size", `${fingerSize}px`);
    layer.style.setProperty("--hand-left", `${to.x - fingerSize / 2}px`);
    // 让食指（手指区域）的中心对准终点，而不是用指尖对准，视觉上整体略微上移
    // 0.20 = 食指中心在 SVG 中的高度占比
    layer.style.setProperty("--hand-top", `${to.y - fingerSize * 0.20}px`);
    layer.style.setProperty("--from-dx", `${from.x - to.x}px`);
    layer.style.setProperty("--from-dy", `${from.y - to.y}px`);

    const ripple = document.createElement("span");
    ripple.className = "finger-guide-ripple";
    ripple.style.left = `${to.x}px`;
    ripple.style.top = `${to.y}px`;
    for (let i = 0; i < 3; i++) {
      const ring = document.createElement("span");
      ring.className = "finger-guide-ring";
      ripple.appendChild(ring);
    }
    layer.appendChild(ripple);

    const hand = document.createElement("span");
    hand.className = "finger-guide-hand";
    hand.innerHTML = HAND_SVG;
    layer.appendChild(hand);

    container.appendChild(layer);
    fingerGuideLayer = layer;
    return layer;
  }

  window.FingerGuide = { show: showFingerGuide, hide: hideFingerGuide };

  // 「帮帮我」：正确答案移到屏幕中央并放大，其余卡片淡出，同时播放提示语
  // 揭示后必须由孩子自己点中正确卡片才进入下一题（本题不计分）
  function useHelp() {
    const q = session.current;
    if (!q || q.locked || q.helped) return; // 已作答或已求助过，忽略
    q.helped = true;
    session.streak = 0; // 求助后本题不算首次答对，连续链中断
    clearSessionTimers();
    $("#btn-help").classList.add("used");
    Sound.play("help");
    Speaker.help();

    const targetKey = Quiz.keyOf(q.target);
    const grid = $("#grid");
    let targetCard = null;
    grid.classList.add("helping");
    grid.querySelectorAll(".card").forEach((c) => {
      if (c.dataset.key === targetKey) {
        c.classList.add("help-target");
        targetCard = c;
      } else {
        c.classList.add("help-fade");
      }
    });
    if (!targetCard) return;
    // 小手从田字格下方滑上来，指尖点中中心后轻点，同时中心向外扩散三层同心水波
    const cardW = targetCard.offsetWidth;
    const cardH = targetCard.offsetHeight;
    showFingerGuide({
      container: targetCard,
      from: { x: cardW / 2, y: cardH / 2 + cardW * 0.64 },
      to: { x: cardW / 2, y: cardH / 2 },
      rippleSize: cardW * 0.36,
      fingerSize: cardW * 0.24,
    });
    // 读取一次位置会强制提交上面的初始状态，再写入位移，动画才会从原位平滑开始
    const rect = targetCard.getBoundingClientRect();
    // 移到田字格舞台的中心（而不是整个视口中心），与新的居中布局保持一致
    const stageRect = quizStage.getBoundingClientRect();
    // 小屏时自动收小放大幅度，保证放大后的卡片仍完整落在舞台内
    const scale = Math.max(
      1,
      Math.min(1.5, (stageRect.width - 16) / rect.width, (stageRect.height - 16) / rect.height)
    );
    const dx = stageRect.left + stageRect.width / 2 - (rect.left + rect.width / 2);
    const dy = stageRect.top + stageRect.height / 2 - (rect.top + rect.height / 2);
    targetCard.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
  }

  function onPick(card, opt, q, evt) {
    if (q.locked) return;
    if (card.classList.contains("wrong")) return; // 已选错的卡片不再响应
    // 已用「帮帮我」：只有点中正确卡片才继续，本题按跳过处理（不计分、不记录对错）
    if (q.helped) {
      if (Quiz.keyOf(opt) === Quiz.keyOf(q.target)) {
        markDone(q);
        nextQuestion();
      }
      return;
    }

    const targetKey = Quiz.keyOf(q.target);
    const isCorrect = Quiz.keyOf(opt) === targetKey;

    // 选错：这张卡片晃动几下后变淡并禁用，本题继续；每次选错都计入复习权重
    if (!isCorrect) {
      q.wrongPicks = (q.wrongPicks || 0) + 1;
      session.streak = 0; // 选错即中断「连续首次答对」
      Storage.recordAnswer(targetKey, false);
      Sound.play("wrong");
      card.classList.add("wrong");
      setTimeout(() => card.classList.add("dimmed"), 450); // 抖动结束再变淡
      return;
    }

    // 选对：锁定整组、其余卡片变淡、冒星星、播放夸奖语音，随后自动下一题
    q.locked = true;
    $("#grid").classList.add("locked");
    Sound.play("pick");
    card.classList.add("correct");
    $("#grid")
      .querySelectorAll(".card")
      .forEach((c) => {
        if (c !== card) c.classList.add("dimmed");
      });
    Sound.play("correct");

    // 首答计分：本题出现过错选就不再加星，但答对时仍播放语音、冒出星星
    const firstTry = !q.wrongPicks;
    if (firstTry) {
      Storage.recordAnswer(targetKey, true);
      session.stars += 1;
      session.streak += 1;
      session.firstTryCorrect += 1;
      if (isNewChar(targetKey)) session.newLearned.push(q.target.char);
      // 烟花从孩子刚才点/摸的位置炸开；键盘触发（坐标 0）时退回卡片中心
      const rect = card.getBoundingClientRect();
      const origin =
        evt && (evt.clientX || evt.clientY)
          ? { x: evt.clientX, y: evt.clientY }
          : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      // 环绕星星从连续第 2 次首答正确才开始显示：第 1 次不显示，第 2 次 2 颗，之后随连对次数增加
      playFireworks(origin, session.streak >= 2 ? session.streak : 0);
      // 田字格里的星星飞到左上角计数处，抵达时才让数字滚动并弹一下星星图标
      popStar(card, () => setStars(session.stars, true));
    }
    if (!q.counted) {
      session.answers.push({
        c: q.target.char,
        pinyin: q.target.pinyin,
        words: q.target.words,
        note: q.target.note || "",
        ok: firstTry,
      });
      markDone(q);
    }

    // 非首次答对（先选错过）：仍在卡片位置弹一下星星，但不计入左上角
    if (!firstTry) popStar(card);

    // 夸奖语音播完再进入下一题；若语音中途被打断（如关闭声音、
    // 播放异常）导致回调不触发，用兜底定时器保证流程不会卡在本页。
    // 所有延时都登记在 session 上，并由会话代次校验：跳题/退出后立即作废，
    // 不会再出现“退出后仍自动出题”或“结束页重复写入记录”
    const gen = session.gen;
    session.delayTimer = setTimeout(() => {
      session.delayTimer = null;
      if (gen !== session.gen || session.current !== q) return;
      let moved = false;
      const go = () => {
        if (moved || gen !== session.gen || session.current !== q) return;
        moved = true;
        clearTimeout(session.guardTimer);
        session.guardTimer = null;
        session.timer = setTimeout(nextQuestion, 600);
      };
      session.guardTimer = setTimeout(go, 6000);
      Speaker.correct(go, session.userName, session.streak);
    }, 400);
  }

  // 左上角星星计数：数量增加时星星图标弹一下，新数字从下往上把旧数字顶掉
  function setStars(next, animate) {
    const wrap = $("#quiz-stars");
    const num = $("#quiz-star-num");
    const icon = wrap.querySelector(".qs-icon");
    const prev = Number(wrap.dataset.count || 0);
    wrap.dataset.count = String(next);
    if (!animate || next <= prev) {
      num.textContent = String(next);
      return;
    }
    icon.classList.remove("bump");
    void icon.offsetWidth; // 强制回流，让弹跳动画重新开始
    icon.classList.add("bump");
    num.innerHTML =
      `<span class="qs-num-out">${prev}</span><span class="qs-num-in">${next}</span>`;
    setTimeout(() => {
      if (wrap.dataset.count === String(next)) num.textContent = String(next);
    }, 320);
  }

  // 答对时田字格冒出星星：首次答对时飞向左上角计数处，抵达后触发数字滚动；
  // 非首次答对仍在原位弹一下后淡出
  function popStar(card, onArrive) {
    const rect = card.getBoundingClientRect();
    const fromX = rect.left + rect.width / 2;
    const fromY = rect.top + rect.height / 2;
    const star = document.createElement("div");
    star.className = onArrive ? "star-pop star-fly" : "star-pop";
    star.textContent = "⭐";
    star.style.left = fromX - 32 + "px";
    star.style.top = fromY - 32 + "px";
    if (onArrive) {
      // 目标：左上角计数里的星星图标
      const target = $("#quiz-stars .qs-icon");
      const tRect = target.getBoundingClientRect();
      star.style.setProperty("--dx", `${tRect.left + tRect.width / 2 - fromX}px`);
      star.style.setProperty("--dy", `${tRect.top + tRect.height / 2 - fromY}px`);
    }
    document.body.appendChild(star);
    if (onArrive) {
      star.addEventListener("animationend", () => {
        star.remove();
        onArrive();
      });
    } else {
      setTimeout(() => star.remove(), 1000);
    }
  }

  /* ---------- 烟花特效：首次选对时从点击位置连续绽放 ---------- */
  const FIREWORK_COLORS = ["#ff5252", "#ffca28", "#66bb6a", "#29b6f6", "#ab47bc", "#ff7043"];
  let fwGeneration = 0;
  let fwRaf = 0;

  // 连续首次答对时，让星星绕着烟花炸点旋转（连续第 1 次不显示，从第 2 次起为 2 颗）
  // 数量按面额折算：3 颗星 = 1 颗月亮，3 颗月亮 = 1 颗太阳（即 9 颗星 = 1 颗太阳）
  function spawnOrbitStars(cx, cy, count) {
    // 新一次烟花开始前清掉上一组残留的环绕星星
    document.querySelectorAll(".fw-orbit").forEach((el) => el.remove());
    if (!count) return;
    const tokens = [];
    for (let n = count; n >= 9; n -= 9) tokens.push("☀️");
    count %= 9;
    for (let n = count; n >= 3; n -= 3) tokens.push("🌙");
    count %= 3;
    for (let i = 0; i < count; i++) tokens.push("⭐");
    tokens.forEach((text, i) => {
      const orbit = document.createElement("span");
      orbit.className = "fw-orbit";
      orbit.style.left = `${cx}px`;
      orbit.style.top = `${cy}px`;
      orbit.style.setProperty("--r", `${68 + (i % 2) * 16}px`);
      orbit.style.setProperty("--start", `${(360 / tokens.length) * i}deg`);
      orbit.style.animationDelay = `${i * 0.05}s`;
      const star = document.createElement("span");
      star.className = "fw-orbit-star";
      star.textContent = text;
      orbit.appendChild(star);
      document.body.appendChild(orbit);
      // 烟花约 2 秒结束，之后星星再绕转约 2 秒才消失（含出场错开的时间）
      setTimeout(() => orbit.remove(), 4200 + i * 50);
    });
  }

  function playFireworks(at, orbitCount) {
    const canvas = $("#fx-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // 若上一次烟花还没放完，先停掉它，避免两套动画互相清屏
    const gen = ++fwGeneration;
    if (fwRaf) cancelAnimationFrame(fwRaf);
    // 按屏幕像素密度放大画布，保证高分屏也清晰
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.display = "block";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const colors = FIREWORK_COLORS;
    const cx = at ? at.x : w / 2;
    const cy = at ? at.y : h / 2;
    spawnOrbitStars(cx, cy, orbitCount);
    // 点击位置连放三朵，颜色与力度略有差异，像真的烟花一簇簇炸开
    const bursts = [
      { at: 0, count: 46, min: 220, max: 430, color: 0 },
      { at: 190, count: 38, min: 190, max: 370, color: 1 },
      { at: 360, count: 38, min: 190, max: 350, color: 3 },
    ];
    const particles = [];
    let nextBurst = 0;
    let elapsed = 0;
    let last = performance.now();

    function spawn(burst) {
      // 炸点围绕点击位置轻微偏移，避免三朵完全同心
      const ox = cx + (Math.random() - 0.5) * 40;
      const oy = cy + (Math.random() - 0.5) * 40;
      for (let i = 0; i < burst.count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const power = burst.min + Math.random() * (burst.max - burst.min);
        particles.push({
          x: ox,
          y: oy,
          vx: Math.cos(angle) * power,
          vy: Math.sin(angle) * power,
          life: 0,
          maxLife: 1.1 + Math.random() * 0.5,
          color: colors[(burst.color + (i % 3 === 0 ? 1 : 0)) % colors.length],
          size: 2 + Math.random() * 2.2,
        });
      }
    }

    function frame(now) {
      if (gen !== fwGeneration) return; // 已被新一轮烟花接管
      // 限制单帧步长：切到后台再回来时粒子不会瞬移
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      elapsed += dt * 1000;

      while (nextBurst < bursts.length && elapsed >= bursts[nextBurst].at) {
        spawn(bursts[nextBurst++]);
      }

      // 每帧用透明度递减重绘，形成拖尾
      ctx.clearRect(0, 0, w, h);
      const drag = Math.pow(0.35, dt); // 空气阻力
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life += dt;
        if (p.life >= p.maxLife) {
          particles.splice(i, 1);
          continue;
        }
        p.vx *= drag;
        p.vy = p.vy * drag + 240 * dt; // 重力
        p.x += p.vx * dt;
        p.y += p.vy * dt;

        ctx.globalAlpha = 1 - p.life / p.maxLife;
        ctx.strokeStyle = p.color;
        ctx.fillStyle = p.color;
        ctx.lineWidth = p.size * 0.9;
        ctx.beginPath();
        ctx.moveTo(p.x - p.vx * 0.02, p.y - p.vy * 0.02);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (nextBurst < bursts.length || particles.length > 0) {
        fwRaf = requestAnimationFrame(frame);
      } else {
        fwRaf = 0;
        canvas.style.display = "none";
        ctx.clearRect(0, 0, w, h);
      }
    }

    fwRaf = requestAnimationFrame(frame);
  }

  /* ---------- 结束页：每颗星星弹出时放一圈小礼花 ---------- */
  let resultFx = null;

  function ensureResultFx() {
    if (!resultFx) {
      resultFx = document.createElement("div");
      resultFx.id = "result-fx";
      document.body.appendChild(resultFx);
    }
    return resultFx;
  }

  function popStarConfetti(star) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const rect = star.getBoundingClientRect();
    if (!rect.width) return; // 页面已切走或星星已被重建
    const layer = ensureResultFx();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    // 彩色纸屑围绕每颗星星炸开一小团烟花
    const count = 26;
    for (let i = 0; i < count; i++) {
      const piece = document.createElement("span");
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const dist = 80 + Math.random() * 90;
      piece.className = "confetti-piece";
      piece.style.left = `${cx}px`;
      piece.style.top = `${cy}px`;
      piece.style.width = `${6 + Math.random() * 4}px`;
      piece.style.height = `${9 + Math.random() * 6}px`;
      piece.style.background = FIREWORK_COLORS[i % FIREWORK_COLORS.length];
      if (i % 3 === 0) piece.style.borderRadius = "50%";
      piece.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
      piece.style.setProperty("--dy", `${Math.sin(angle) * dist + 28}px`);
      piece.style.setProperty("--rot", `${(Math.random() - 0.5) * 360}deg`);
      layer.appendChild(piece);
      setTimeout(() => piece.remove(), 1200);
    }
  }

  // 与星星弹出的动画延迟对齐，在每颗星弹到最大的时候炸开一圈
  function queueStarConfetti() {
    document.querySelectorAll("#result-stars .result-star").forEach((star, i) => {
      setTimeout(() => popStarConfetti(star), i * 90 + 260);
    });
  }

  /* ---------- 结束页 ---------- */
  let resultResizeFn = null;

  function cleanupResultFx() {
    FingerGuide.hide();
    if (resultResizeFn) { window.removeEventListener("resize", resultResizeFn); resultResizeFn = null; }
  }

  function renderResult() {
    cleanupResultFx();
    Storage.addHistory({
      stars: session.stars,
      total: session.total,
      correct: session.firstTryCorrect,
      chars: session.answers,
      volume: session.volume,
    });
    $("#result-user").textContent = session.userName ? `${session.userName}，你真棒！` : "";
    // 星星逐个画出来，不用数字
    if (session.stars > 0) {
      $("#result-stars").innerHTML = Array.from(
        { length: session.stars },
        (_, i) =>
          `<span class="result-star" style="animation-delay:${(i * 0.09).toFixed(2)}s">⭐</span>`
      ).join("");
    } else {
      $("#result-stars").textContent = "这一组还没有星星，下次加油！";
    }
    // 新学会的字：小田字格样式，绿色底
    const newWrap = $("#result-new");
    if (session.newLearned.length > 0) {
      newWrap.innerHTML =
        `<span class="result-new-label">新学会：</span>` +
        session.newLearned
          .map((c) => `<span class="new-learned-item">${c}</span>`)
          .join("");
    } else {
      newWrap.innerHTML = "";
    }
    // 底部：用户名 · 册名（参考练习页底部信息行）
    $("#result-footer").textContent =
      session.userName && session.volume ? `${session.userName} · ${session.volume}` : "";
    // 本组星星数决定礼物挑选次数：5 颗 1 件，6~9 颗 2 件，10 颗及以上 3 件
    giftQuota = giftQuotaFor(session.stars);
    giftPicked = [];
    giftClaimed = false;
    renderGiftReward();
    show("result");
    // 星星渲染完成后再取位置放礼花，避免量到 0 尺寸
    if (session.stars > 0) {
      queueStarConfetti();
      // 每颗星的 confetti 持续 1.2s，最后一颗起点 (n-1)*90+260ms，再加 200ms 缓冲
      // 烟花全部结束后立即启动小手（语音还在后台播，两者并行）
      const delay = (session.stars - 1) * 90 + 260 + 1400;
      setTimeout(() => {
        if (giftQuota > 0 && giftQuotaFor(session.stars) > 0 && !document.getElementById("view-result").classList.contains("hidden")) {
          showGiftHand();
        }
      }, delay);
    }
    // 语音播放链：done → starsN → [gift] → cheer（独立播，不阻塞小手启动）
    Speaker.result(session.stars, session.userName, { gift: giftQuota > 0 });
  }

  // 礼物提示小手：用通用 FingerGuide 指向 #btn-gift-open，循环滑动 + 水波引导点击。
  // 切页或点击礼物按钮后由 cleanupResultFx 统一清理。
  function showGiftHand() {
    const target = document.getElementById("btn-gift-open");
    if (!target) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    cleanupResultFx();

    const t = target.getBoundingClientRect();
    if (!t.width) return;
    const cx = t.left + t.width / 2;
    const cy = t.top + t.height / 2;
    const size = Math.max(64, Math.min(t.width, 110) * 0.45);
    FingerGuide.show({
      color: "242, 165, 65",
      from: { x: cx, y: cy + (window.innerHeight - cy) / 2 },
      to: { x: cx, y: cy },
      rippleSize: size * 1.05,
      fingerSize: size,
    });

    resultResizeFn = () => {
      if (!document.getElementById("view-result").classList.contains("hidden")) showGiftHand();
    };
    window.addEventListener("resize", resultResizeFn);
  }

  /* ---------- 礼物兑换与展柜 ---------- */
  const giftCatalog = () => window.GIFTS || {};

  // 礼物袋固定礼物：window.GIFTS_FIXED 里的图标每次打开都必须在袋中
  // 图标按礼物清单反查名称；清单里没有该图标、或同一图标对应多个名称时直接报错
  function fixedGiftNames() {
    const raw = (window.GIFTS_FIXED || "").replace(/\s+/g, "");
    if (!raw) return [];
    const catalog = giftCatalog();
    const byIcon = new Map();
    Object.keys(catalog).forEach((name) => {
      const icon = catalog[name];
      if (byIcon.has(icon)) {
        throw new Error(`礼物清单存在重复图标：${icon}（${byIcon.get(icon)} / ${name}）`);
      }
      byIcon.set(icon, name);
    });
    // 按字素切分，避免带变体选择符或多个码点的 emoji 被拆开
    const icons =
      typeof Intl !== "undefined" && Intl.Segmenter
        ? [...new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(raw)].map((s) => s.segment)
        : Array.from(raw);
    return icons.map((icon) => {
      const name = byIcon.get(icon);
      if (!name) throw new Error(`GIFTS_FIXED 中的图标不在礼物清单里：${icon}`);
      return name;
    });
  }

  // 本组星星数决定挑选次数：5 颗 1 件，6~9 颗 2 件，10 颗及以上 3 件
  function giftQuotaFor(stars) {
    if (stars >= 10) return 3;
    if (stars >= 6) return 2;
    if (stars >= 5) return 1;
    return 0;
  }

  // 结束页「已放入礼物橱窗：」后只展示图标，不显示名字
  function giftIconOnly(name) {
    return giftCatalog()[name] || "🎁";
  }

  // 结束页的礼物入口：未领取显示挑选按钮，已领取显示放入展柜的礼物
  function renderGiftReward() {
    const box = $("#gift-reward");
    if (giftQuota <= 0 || Object.keys(giftCatalog()).length === 0) {
      box.classList.add("hidden");
      return;
    }
    box.classList.remove("hidden");
    if (giftClaimed) {
      // 已领取：展示成果；放弃机会（一件没选就关闭）：整个入口隐藏
      if (giftPicked.length === 0) {
        box.classList.add("hidden");
        return;
      }
      $("#gift-reward-tip").textContent = `已放入礼物橱窗：${giftPicked.map(giftIconOnly).join(" ")}`;
      $("#btn-gift-open").textContent = "查看我的礼物 🎁";
    } else {
      $("#gift-reward-tip").textContent = `本组可以挑选 ${giftQuota} 件礼物！`;
      $("#btn-gift-open").textContent = "打开礼物袋 🎁";
    }
  }

  // 橱窗：三种状态（橱窗 / 收纳盒 / 记录），按 localStorage 记忆「橱窗 / 记录」偏好
  // giftItems 是礼物实例数组，顺序即摆放顺序：前 N 件在橱窗，其余进入收纳盒（纯界面派生，不额外存储）
  let giftItems = [];
  let giftShelfCapacity = 0; // 当前窗口下橱窗能完整放下的礼物数量
  let giftShelfCols = 1;
  let giftShelfRows = 1;
  let giftDragId = null; // 正在拖拽的礼物实例 id
  let giftDragMoved = false; // 本次拖拽是否发生过移动（用来区分点击与拖拽）
  let giftDragOverId = null; // 最近一次交换的目标卡片 id，避免同一位置反复交换
  let giftOverflowPending = 0; // 刚领取的新礼物数：进柜时把被挤出的卡片飞进收纳盒
  let giftOverflowUid = ""; // 上面的数量属于哪位小朋友
  let lastShelfIds = null; // 上一次渲染时橱窗里的礼物 id，用于判断谁被挤进/补进
  let lastBoxIds = null; // 上一次渲染时收纳盒里的礼物 id
  let lastGiftUid = ""; // 上一次渲染属于哪位小朋友
  let giftReflowTimer = 0; // 窗口尺寸变化后延迟重排

  // 计算橱窗容量：按当前设备能完整放下的行列数得出（如 4 行 3 列 = 12 件），保证橱窗不出现滚动条
  // 测量时即使最终要显示收纳盒/记录，也先让展柜参与布局，量完立即恢复
  function measureGiftShelf() {
    const frame = $("#gift-shelf-frame");
    const shelf = $("#gift-shelf");
    const actions = $(".gift-actions");
    frame.classList.remove("hidden");
    const view = views.gifts;
    const viewCs = getComputedStyle(view);
    const viewRect = view.getBoundingClientRect();
    const padBottom = parseFloat(viewCs.paddingBottom) || 0;
    const frameTop = frame.getBoundingClientRect().top;
    const frameCs = getComputedStyle(frame);
    const marginBottom = parseFloat(frameCs.marginBottom) || 0;
    const borderY =
      (parseFloat(frameCs.borderTopWidth) || 0) + (parseFloat(frameCs.borderBottomWidth) || 0);
    const availH = Math.max(
      0,
      viewRect.bottom - padBottom - frameTop - marginBottom - actions.offsetHeight
    );

    // 用一张隐藏的示例卡片量出真实行高（字号随视口变化，不能写死）
    const probe = document.createElement("div");
    probe.className = "gift-shelf-item";
    probe.style.visibility = "hidden";
    probe.innerHTML = `<span class="gift-shelf-icon">🎁</span><span class="gift-shelf-name">有轨电车</span>`;
    shelf.appendChild(probe);
    const cardH = probe.getBoundingClientRect().height || 0;
    probe.remove();

    const shelfCs = getComputedStyle(shelf);
    const gap = parseFloat(shelfCs.rowGap) || 10;
    const padY = (parseFloat(shelfCs.paddingTop) || 0) + (parseFloat(shelfCs.paddingBottom) || 0);
    const padX = (parseFloat(shelfCs.paddingLeft) || 0) + (parseFloat(shelfCs.paddingRight) || 0);
    const innerW = Math.max(0, shelf.clientWidth - padX);
    const innerH = Math.max(0, availH - borderY);
    // 与 CSS 的 repeat(auto-fill, minmax(92px, 1fr)) 保持同样的列数
    const cols = Math.max(1, Math.floor((innerW + gap + 0.01) / (92 + gap)));
    const rows = Math.max(1, Math.floor((innerH - padY + gap + 0.01) / (cardH + gap)));
    giftShelfCols = cols;
    giftShelfRows = rows;
    giftShelfCapacity = Math.max(1, cols * rows);
    return giftShelfCapacity;
  }

  // 打开礼物展柜：每次进入都先显示橱窗
  function openGiftView(returnView) {
    giftsReturnView = returnView;
    giftShelfMode = "shelf";
    renderGiftShelf();
  }

  // 窗口尺寸变化（电脑拖动窗口 / 手机转屏）后橱窗容量会变，重新拆分橱窗与收纳盒
  function scheduleGiftReflow() {
    if (views.gifts.classList.contains("hidden")) return;
    clearTimeout(giftReflowTimer);
    giftReflowTimer = setTimeout(() => {
      giftReflowTimer = 0;
      if (views.gifts.classList.contains("hidden")) return;
      renderGiftShelf();
    }, 160);
  }

  function renderGiftShelf() {
    const user = Storage.currentUser();
    const catalog = giftCatalog();
    const uid = user ? user.id : "";
    giftItems = Storage.gifts(uid);
    const total = giftItems.length;
    // 新礼物的闪烁只在本次首次进入橱窗时展示：拿到 fresh 状态后立即标记为已看，
    // 本次渲染保留闪烁，后续再次进入页面或切换模式都不会再闪
    giftItems.filter((g) => g.fresh).forEach((g) => Storage.markGiftSeen(g.id));
    // 后台预取已拥有礼物的名称音频（通常只有几件），放大时即可秒播
    Speaker.preload(
      [...new Set(giftItems.map((g) => g.name))].map((n) => Speaker.giftAudio(n))
    );
    $("#gifts-owner").textContent = user
      ? `${user.name} 的礼物 · 共 ${total} 件`
      : `我的礼物 · 共 ${total} 件`;

    // 先显示页面再测量：隐藏状态下量不到展柜的位置与尺寸
    show("gifts");

    // 按容量切分：前面的摆在橱窗，后面（超出的）进入收纳盒
    const capacity = total > 0 ? measureGiftShelf() : 0;
    const shelfItems = giftItems.slice(0, capacity);
    const boxItems = giftItems.slice(capacity);
    const boxActive = boxItems.length > 0;

    // 「记录」按钮就是收纳盒入口：有礼物时改为「收纳盒」，为空时恢复「记录」
    if (boxActive && giftShelfMode === "list") giftShelfMode = "box";
    if (!boxActive && giftShelfMode === "box") giftShelfMode = "list";
    const mode = giftShelfMode;

    // 判断本次渲染中谁被挤进收纳盒、谁从收纳盒补进橱窗（用于飞行动画）
    const sameUser = lastGiftUid === uid;
    const prevShelf = sameUser && lastShelfIds ? new Set(lastShelfIds) : null;
    const prevBox = sameUser && lastBoxIds ? new Set(lastBoxIds) : null;
    const pushed = prevShelf
      ? boxItems.filter((g) => prevShelf.has(g.id))
      : giftOverflowPending > 0 && giftOverflowUid === uid
        ? boxItems.slice(0, Math.min(giftOverflowPending, boxItems.length))
        : [];
    const filled = prevBox ? shelfItems.filter((g) => prevBox.has(g.id)) : [];
    giftOverflowPending = 0;
    giftOverflowUid = "";
    lastGiftUid = uid;
    lastShelfIds = shelfItems.map((g) => g.id);
    lastBoxIds = boxItems.map((g) => g.id);

    // 模式按钮：第一个固定为「橱窗」，第二个在收纳盒有礼物时显示「收纳盒」，否则显示「记录」
    const modeBtns = document.querySelectorAll(".gift-mode-btn");
    modeBtns.forEach((btn) => {
      if (btn.dataset.mode === "shelf") {
        btn.classList.toggle("active", mode === "shelf");
        return;
      }
      btn.dataset.mode = boxActive ? "box" : "list";
      btn.textContent = boxActive ? "盒子" : "记录";
      btn.classList.toggle("active", mode === btn.dataset.mode);
    });

    const hasGifts = total > 0;
    $("#gift-shelf-frame").classList.toggle("hidden", !(hasGifts && mode === "shelf"));
    $("#gift-list").classList.toggle("hidden", !(hasGifts && mode === "list"));
    $("#gift-box").classList.toggle("hidden", !(hasGifts && mode === "box"));
    // 垃圾篓只在橱窗模式且拖拽时才需要可见；平时常驻提示也可以，这里只在橱窗模式显示
    $("#gift-trash").classList.toggle("hidden", !(hasGifts && mode === "shelf"));
    $("#gift-empty").classList.toggle("hidden", hasGifts);

    // 每件礼物实例一张卡片：同名礼物就是并列的多张卡片，可分别拖拽/删除
    $("#gift-shelf").innerHTML =
      hasGifts && mode === "shelf"
        ? shelfItems
            .map(
              (g) => `<div class="gift-shelf-item${g.fresh ? " fresh" : ""}" data-id="${g.id}">
            <span class="gift-shelf-icon">${catalog[g.name] || "🎁"}</span>
            <span class="gift-shelf-name">${g.name}</span>
          </div>`
            )
            .join("")
        : "";

    // 收纳盒：卡片只有图标、排列更紧凑；礼物太多时内部滚动
    $("#gift-box").innerHTML =
      hasGifts && mode === "box"
        ? boxItems
            .map(
              (g) => `<button type="button" class="gift-box-item" data-id="${g.id}" title="${g.name}" aria-label="${g.name}">
            <span class="gift-box-icon">${catalog[g.name] || "🎁"}</span>
          </button>`
            )
            .join("")
        : "";
    if (mode === "box") $("#gift-box").scrollTop = 0;

    if (hasGifts && mode === "list") {
      const log = Storage.giftLog(uid);
      // 倒序展示，最新在最上面
      const rows = [...log].reverse().map((rec) => {
        const icon = catalog[rec.name] || "🎁";
        const d = new Date(rec.time);
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        const hh = String(d.getHours()).padStart(2, "0");
        const mi = String(d.getMinutes()).padStart(2, "0");
        const timeStr = `${d.getFullYear()}/${mm}/${dd} ${hh}:${mi}`;
        return `<div class="gift-list-row">
          <span class="gift-list-icon">${icon}</span>
          <span class="gift-list-name">${rec.name}</span>
          <span class="gift-list-stars">⭐ ${rec.stars}</span>
          <span class="gift-list-time">${timeStr}</span>
        </div>`;
      });
      $("#gift-list").innerHTML = rows.join("");
    } else {
      $("#gift-list").innerHTML = "";
    }

    // 视图显示后再计算当前模式滚动区的上下渐隐（内容少时两侧都不显示）
    requestAnimationFrame(() => {
      if (!hasGifts) return;
      const scroller =
        mode === "shelf" ? $("#gift-shelf") : mode === "box" ? $("#gift-box") : $("#gift-list");
      updateScrollFade(scroller);
    });

    // 飞行动画：被挤进收纳盒的卡片飞向收纳盒按钮；补进橱窗的卡片从收纳盒按钮飞入
    if (hasGifts && mode === "shelf" && (pushed.length || filled.length)) {
      const secondBtn = modeBtns[1];
      requestAnimationFrame(() => {
        if (pushed.length) flyGiftsIntoBox(pushed, secondBtn);
        if (filled.length) flyGiftsIntoWardrobe(filled, secondBtn);
      });
    }
  }

  // 被挤进收纳盒：卡片从橱窗最后一行的位置飞向收纳盒按钮，缩小淡出后消失
  function flyGiftsIntoBox(items, boxBtn) {
    const shelf = $("#gift-shelf");
    const cards = shelf.querySelectorAll(".gift-shelf-item");
    if (!boxBtn || !cards.length) return;
    const first = cards[0].getBoundingClientRect();
    const gap = 10;
    const cardW = first.width;
    const cardH = first.height;
    const cols = Math.max(1, giftShelfCols);
    const rows = Math.max(1, giftShelfRows);
    const end = boxBtn.getBoundingClientRect();
    const catalog = giftCatalog();
    const ghosts = [];
    items.slice(0, 8).forEach((g, i) => {
      const left = first.left + (i % cols) * (cardW + gap);
      const top = first.top + (rows - 1) * (cardH + gap);
      const ghost = document.createElement("div");
      ghost.className = "gift-fly-ghost";
      ghost.style.width = cardW + "px";
      ghost.style.height = cardH + "px";
      ghost.style.left = left + "px";
      ghost.style.top = top + "px";
      ghost.innerHTML = `<span class="gift-fly-icon">${catalog[g.name] || "🎁"}</span><span class="gift-fly-name">${g.name}</span>`;
      document.body.appendChild(ghost);
      ghosts.push({
        ghost,
        dx: end.left + end.width / 2 - (left + cardW / 2),
        dy: end.top + end.height / 2 - (top + cardH / 2),
        delay: i * 70,
      });
    });
    if (!ghosts.length) return;
    requestAnimationFrame(() => {
      ghosts.forEach(({ ghost, dx, dy, delay }) => {
        ghost.style.transition =
          `transform 0.5s cubic-bezier(0.5, 0.05, 0.7, 0.4) ${delay}ms, ` +
          `opacity 0.16s ease ${delay + 360}ms`;
        ghost.style.transform = `translate(${dx}px, ${dy}px) scale(0.16) rotate(14deg)`;
        ghost.style.opacity = "0";
      });
      const total = 600 + (ghosts.length - 1) * 70;
      setTimeout(() => {
        ghosts.forEach(({ ghost }) => ghost.remove());
        // 收纳盒按钮接住礼物后弹一下
        boxBtn.classList.remove("receive");
        void boxBtn.offsetWidth;
        boxBtn.classList.add("receive");
      }, total);
    });
  }

  // 收纳盒补给橱窗：卡片从收纳盒按钮的位置飞进它在橱窗中的新格子
  function flyGiftsIntoWardrobe(items, boxBtn) {
    const shelf = $("#gift-shelf");
    if (!boxBtn || !shelf) return;
    // 礼物从盒子里取出时，盒子按钮同样弹一下
    boxBtn.classList.remove("receive");
    void boxBtn.offsetWidth;
    boxBtn.classList.add("receive");
    const end = boxBtn.getBoundingClientRect();
    items.slice(0, 8).forEach((g, i) => {
      const card = shelf.querySelector(`.gift-shelf-item[data-id="${g.id}"]`);
      if (!card) return;
      const r = card.getBoundingClientRect();
      const dx = end.left + end.width / 2 - (r.left + r.width / 2);
      const dy = end.top + end.height / 2 - (r.top + r.height / 2);
      card.style.transition = "none";
      // 从盒子按钮位置以缩小状态直接出现（不做透明渐变），让小朋友看清是从盒子里飞出来的
      card.style.transform = `translate(${dx}px, ${dy}px) scale(0.3)`;
      setTimeout(() => {
        card.style.transition = "transform 0.5s cubic-bezier(0.2, 1.1, 0.4, 1)";
        card.style.transform = "";
        setTimeout(() => {
          card.style.transition = "";
        }, 600);
      }, i * 60);
    });
  }

  // 交换两张卡片在 DOM 中的位置，并用 FLIP 动画让被交换的非拖拽卡片平滑滑到新位置
  // 落位后拖拽卡片执行一次「变大 → 摇晃 → 恢复」的强调动画，确认交换完成
  function swapShelf(a, b) {
    Sound.play("swap"); // 互换音效
    // 参与交换的新礼物，交换后不再显示新礼物特效
    a.classList.remove("fresh");
    b.classList.remove("fresh");
    const shelf = $("#gift-shelf");
    const cards = [...shelf.querySelectorAll(".gift-shelf-item")];
    const first = new Map(cards.map((el) => [el, el.getBoundingClientRect()]));
    // 用占位节点互换 a、b 的位置，避免相邻/不相邻两种情况分支判断
    const ph = document.createElement("div");
    a.parentNode.insertBefore(ph, a);
    b.parentNode.insertBefore(a, b);
    ph.parentNode.insertBefore(b, ph);
    ph.remove();
    // FLIP：非拖拽卡片从旧位置平滑滑到新位置（拖拽卡片本身跟随光标，不做动画）
    cards.forEach((el) => {
      if (el === a) return;
      const f = first.get(el);
      if (!f) return;
      const l = el.getBoundingClientRect();
      const dx = f.left - l.left;
      const dy = f.top - l.top;
      if (dx || dy) {
        el.style.transition = "none";
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        requestAnimationFrame(() => {
          el.style.transition = "transform 0.25s ease";
          el.style.transform = "";
        });
      }
    });
    emphasizeGiftEl(a);
  }

  // 给元素加一次「变大 → 摇晃 → 恢复」强调动画，动画结束自动移除类
  function emphasizeGiftEl(el) {
    if (!el) return;
    el.classList.remove("emph");
    void el.offsetWidth; // 强制重排，连续触发时重启动画
    el.classList.add("emph");
    el.addEventListener(
      "animationend",
      (e) => {
        if (e.animationName === "gift-card-emph") el.classList.remove("emph");
      },
      { once: true }
    );
  }

  // 点橱窗礼物：清除「新」标记（边框闪烁消失）并放大展示
  // 放大动画从被点卡片的位置开始：先平移+缩小到卡片处，再飞到屏幕中央变大；
  // giftZoomFrom 记住起飞偏移，关闭时缩回卡片位置，与展开相呼应
  let giftZoomFrom = null;
  let giftZoomEl = null; // 记录被放大的橱窗卡片，关闭大图后图标做一次强调动画

  function zoomGift(name, fromEl) {
    const catalog = giftCatalog();
    const count = giftItems.filter((g) => g.name === name).length;
    $("#gift-zoom-icon").textContent = catalog[name] || "🎁";
    $("#gift-zoom-name").textContent = name;
    $("#gift-zoom-count").textContent = count > 1 ? `共 ${count} 件` : "";
    Sound.play("correct"); // 先播音效，再播礼物名称
    Speaker.playGiftName(name);
    const overlay = $("#gift-zoom");
    const inner = overlay.querySelector(".gift-zoom-inner");
    overlay.classList.remove("hidden");
    // 起始状态：定位到卡片中心（视口中心为原点计算偏移），缩小、半透明
    giftZoomFrom = null;
    giftZoomEl = fromEl || null;
    inner.style.transition = "none";
    if (fromEl) {
      const r = fromEl.getBoundingClientRect();
      giftZoomFrom = {
        dx: r.left + r.width / 2 - window.innerWidth / 2,
        dy: r.top + r.height / 2 - window.innerHeight / 2,
      };
      inner.style.transform = `translate(${giftZoomFrom.dx}px, ${giftZoomFrom.dy}px) scale(0.3)`;
      inner.style.opacity = "0.4";
    } else {
      inner.style.transform = "scale(0.6)";
      inner.style.opacity = "0";
    }
    // 等一帧后清掉内联起始值并加 active，CSS 过渡接管：飞到中央并放大
    requestAnimationFrame(() => {
      inner.style.transition = "";
      inner.style.transform = "";
      inner.style.opacity = "";
      overlay.classList.add("active");
    });
  }

  // 点礼物袋里的礼物：图标放大、摇晃再恢复（与橱窗放大的手感一致）
  function popGiftEmoji(item) {
    const icon = item.querySelector(".gift-emoji");
    if (!icon) return;
    icon.classList.remove("pop");
    void icon.offsetWidth; // 强制重排，保证连续点击都能重新播放
    icon.classList.add("pop");
  }

  function updateGiftPickState() {
    $("#gift-pick-tip").textContent =
      giftPicked.length > 0
        ? `已选 ${giftPicked.length} / ${giftQuota} 件`
        : `可以挑 ${giftQuota} 件礼物，点一下图标选中`;
    document.querySelectorAll("#gift-grid .gift-item").forEach((el) => {
      el.classList.toggle("selected", giftPicked.includes(el.dataset.name));
    });
    $("#btn-gift-ok").disabled = giftPicked.length === 0;
  }

  // 组装一批礼物（每批 50 件，顺序随机）：
  // withFixed=true 为首批，GIFTS_FIXED 里的礼物必在；false 为「换一批」，完全不含固定礼物
  function buildGiftBag(withFixed) {
    const fixed = fixedGiftNames();
    const all = Object.keys(giftCatalog());
    const bagSize = Math.min(50, all.length);
    if (fixed.length > bagSize) {
      throw new Error(`GIFTS_FIXED 固定礼物有 ${fixed.length} 件，超过礼物袋容量 ${bagSize} 件`);
    }
    if (new Set(fixed).size !== fixed.length) {
      throw new Error("GIFTS_FIXED 中存在重复配置的礼物");
    }
    const pool = all.filter((name) => !fixed.includes(name));
    if (!withFixed) return Quiz.shuffle(pool).slice(0, Math.min(bagSize, pool.length));
    return Quiz.shuffle(fixed.concat(Quiz.shuffle(pool).slice(0, bagSize - fixed.length)));
  }

  // 把一批礼物渲染到弹窗网格；animate=true 时卡片逐个弹入（换一批使用）
  function renderGiftBag(bag, animate) {
    // 统计各礼物已有数量（实例数组按名字聚合计数）
    const owned = {};
    Storage.gifts(session.userId).forEach((g) => {
      owned[g.name] = (owned[g.name] || 0) + 1;
    });
    $("#gift-grid").innerHTML = bag
      .map((name, i) => {
        const icon = giftCatalog()[name];
        const count = owned[name] || 0;
        // --i 供消失/弹入动画计算逐张延迟；位置索引同时是卡片序号
        return `<button type="button" class="gift-item${animate ? " bag-in" : ""}" data-name="${name}" style="--i:${i}">
          <span class="gift-emoji">${icon}</span>
          <span class="gift-name">${name}</span>
          ${count > 0 ? `<span class="gift-owned">已有 ${count}</span>` : ""}
        </button>`;
      })
      .join("");
  }

  function openGiftPicker() {
    if (giftClaimed || giftQuota <= 0) return;
    giftPicked = [];
    giftBagRefreshed = false;
    $("#btn-gift-refresh").classList.remove("hidden");
    renderGiftBag(buildGiftBag(true), false);
    updateGiftPickState();
    $("#gift-dialog").classList.remove("hidden");
    // 弹窗显示后再计算礼物网格的上下渐隐（未滚动时只显示底部淡出）
    requestAnimationFrame(() => updateScrollFade($("#gift-grid")));
    Speaker.playGiftBagOpen(giftQuota); // 打开礼物袋时播报可挑件数
  }

  /* ---------- 事件绑定 ---------- */
  // 多个页面共用的“返回”：回到当前小朋友的选册页；没有小朋友则回首页
  function backToVolumes() {
    const user = Storage.currentUser();
    if (user) renderVolumes(user);
    else renderHome();
  }

  // 通用显示开关：状态存 localStorage，按钮高亮 + body 挂 class 控制显隐
  // 默认开启；关闭时给 body 加 hideClass
  // 拼音、注解按小朋友保存，切换小朋友时需要重新刷新
  const displayRefreshers = [];
  function refreshDisplaySwitches() {
    displayRefreshers.forEach((fn) => fn());
  }

  function bindDisplaySwitch(key, hideClass, btn) {
    const isOn = () => Storage.pref(key);
    const refresh = () => {
      document.body.classList.toggle(hideClass, !isOn());
      btn.classList.toggle("active", isOn());
    };
    btn.addEventListener("click", () => {
      Storage.setPref(key, !isOn());
      refresh();
      // 注解（组词 + 注解两行）显示/收起会改变底部提示条高度，练习中要重新按新空间缩放田字格，
      // 否则卡片会溢出到提示条、顶部按钮或「再听一遍/帮帮我」上
      if (!views.quiz.classList.contains("hidden")) applyGridLayout();
    });
    displayRefreshers.push(refresh);
    refresh();
  }
  // 拼音（即时生效） / 注解（只影响显示，语音仍会朗读） / 记录汉字
  bindDisplaySwitch(Storage.PREF_KEYS.PINYIN, "hide-pinyin", $("#btn-pinyin"));
  bindDisplaySwitch(Storage.PREF_KEYS.NOTE, "hide-note", $("#btn-note"));
  bindDisplaySwitch(Storage.PREF_KEYS.SHOWCHARS, "hide-history-chars", $("#btn-history-chars"));

  // 按钮音效开关（全局设置，默认开启）：只控制按钮点击音，不影响语音朗读
  // 单个按钮同时显示当前状态：开启时高亮并显示「开启」，关闭时变灰并显示「关闭」
  function refreshClickSound() {
    const on = Storage.pref(Storage.PREF_KEYS.CLICK);
    const btn = $("#btn-click-sound");
    btn.classList.toggle("active", on);
    btn.textContent = on ? "开启" : "关闭";
    btn.setAttribute("aria-pressed", String(on));
  }

  // 练习页顶部悬浮面板展开/收起：按小朋友保存（默认展开）
  let drawerTimer = 0;

  function refreshQuizTools() {
    clearTimeout(drawerTimer);
    drawerTimer = 0;
    const on = Storage.pref(Storage.PREF_KEYS.TOOLS);
    const wrap = $("#quiz-tools-wrap");
    wrap.classList.remove("drawer-out");
    wrap.classList.toggle("collapsed", !on);
    $("#btn-tools-hide").setAttribute("aria-expanded", String(on));
    $("#btn-tools-show").setAttribute("aria-expanded", String(on));
  }

  // 折叠/展开的 0.24s 内舞台高度持续变化，逐帧重算田字格尺寸才能平滑缩放
  let toolsResizeRaf = 0;
  function resizeWhileToolsAnimate() {
    cancelAnimationFrame(toolsResizeRaf);
    const until = performance.now() + 260;
    const tick = (now) => {
      if (views.quiz.classList.contains("hidden")) return;
      applyGridLayout();
      toolsResizeRaf = now < until ? requestAnimationFrame(tick) : 0;
    };
    toolsResizeRaf = requestAnimationFrame(tick);
  }

  function setToolsExpanded(on) {
    Storage.setPref(Storage.PREF_KEYS.TOOLS, on);
    if (on) {
      refreshQuizTools();
      resizeWhileToolsAnimate();
      return;
    }
    const wrap = $("#quiz-tools-wrap");
    if (wrap.classList.contains("drawer-out")) return;
    // 抽屉：按钮先整体向右滑进灰色关闭区，滑完再折叠面板
    wrap.classList.add("drawer-out");
    drawerTimer = setTimeout(() => {
      drawerTimer = 0;
      refreshQuizTools();
      resizeWhileToolsAnimate();
    }, 200);
  }
  $("#btn-tools-hide").addEventListener("click", () => setToolsExpanded(false));
  $("#btn-tools-show").addEventListener("click", () => setToolsExpanded(true));
  displayRefreshers.push(refreshQuizTools);

  // 重读本题（答对后正在播夸奖语音并即将进入下一题，此时重读会打断语音回调，忽略）
  $("#btn-read").addEventListener("click", () => {
    const q = session.current;
    if (!q || q.locked) return;
    Speaker.readQuestion(q.target);
  });
  // 帮帮我：亮出正确答案（本题不计分）
  $("#btn-help").addEventListener("click", useHelp);
  // 跳过：不记录对错、不得星，仅推进题号进度（幂等，不重复计数）
  $("#btn-skip").addEventListener("click", () => {
    clearSessionTimers(); // 取消上一题未走完的“夸奖后进入下一题”流程
    Speaker.stop();
    session.streak = 0; // 跳过不算首次答对，连续链中断
    const q = session.current;
    if (q) markDone(q);
    nextQuestion();
  });
  // 点击小朋友的名字：先加载全局资源（内置字体、提示语、名字语音、星星播报），
  // 全部就绪后才进入选册页；题目语音留到点册/答题过程中按需加载
  let enteringUser = false;
  $("#user-list").addEventListener("click", (e) => {
    const card = e.target.closest(".user-card");
    if (!card || enteringUser) return;
    const user = Storage.users().find((u) => u.id === card.dataset.id);
    if (!user) return;
    Storage.setCurrent(user.id);
    enteringUser = true;
    let loadingShown = false;
    const showTimer = setTimeout(() => {
      loadingShown = true;
      showLoading(`正在为${user.name}更新应用资源`);
    }, 150);
    Speaker.preloadGlobal(user.name, updateLoading).then(() => {
      clearTimeout(showTimer);
      enteringUser = false;
      if (loadingShown) hideLoading();
      renderVolumes(user);
    });
  });
  // 选择某一册，开始练习；点右侧图标则先查看该册汉字表
  $("#volume-list").addEventListener("click", (e) => {
    const card = e.target.closest(".volume-card");
    if (!card) return;
    const volume = window.VOLUMES.find((v) => String(v.id) === card.dataset.id);
    if (!volume) return;
    // 记住最近点开的册，下次进入该小朋友的选册页时排在第一项
    Storage.setLastVolume(volume.id);
    if (e.target.closest(".volume-icon")) {
      renderVolumeWords(volume);
      return;
    }
    enterVolume(Storage.currentUser(), volume);
  });
  // 册目列表、汉字表、练习记录、礼物橱窗、礼物记录与礼物袋网格滚动时更新边缘淡出与滚动条显隐；窗口尺寸变化时重新计算
  bindScrollFx($("#volume-list"));
  bindScrollFx($("#word-list"), $("#word-sheet"));
  bindScrollFx($("#history-list"));
  bindScrollFx($("#gift-shelf"));
  bindScrollFx($("#gift-list"));
  bindScrollFx($("#gift-box"));
  bindScrollFx($("#gift-grid"));
  window.addEventListener("resize", () => {
    updateScrollFade($("#volume-list"));
    updateScrollFade($("#word-list"), $("#word-sheet"));
    updateScrollFade($("#history-list"));
    updateScrollFade($("#gift-shelf"));
    updateScrollFade($("#gift-list"));
    updateScrollFade($("#gift-box"));
    scheduleGiftReflow(); // 展柜打开时按新窗口重新计算橱窗容量
  });
  // 汉字表小喇叭：先加载该字的语音（未缓存时显示进度条），就绪后再播放
  let loadingWordAudio = false;

  function playEntryAudio(entry) {
    if (loadingWordAudio) return;
    const urls = Speaker.entryUrls(entry);
    // 全部已缓存时直接播放，不弹加载框
    if (urls.every((u) => Speaker.cache.has(u))) {
      Speaker.readEntry(entry);
      return;
    }
    loadingWordAudio = true;
    let shown = false;
    let progress = [0, urls.length];
    // 与进入练习页一致：加载很快时不闪进度条，超过 150ms 才显示
    const showTimer = setTimeout(() => {
      shown = true;
      showLoading(`正在加载「${entry.char}」的语音`);
      updateLoading(progress[0], progress[1]);
    }, 150);
    Speaker.preloadAll(urls, (done, total) => {
      progress = [done, total];
      if (shown) updateLoading(done, total);
    }).then(() => {
      clearTimeout(showTimer);
      loadingWordAudio = false;
      if (shown) hideLoading();
      Speaker.readEntry(entry);
    });
  }

  // 汉字表：点小喇叭播放读音、组词和注解，点整行进入通用单字详情页
  $("#word-list").addEventListener("click", (e) => {
    const row = e.target.closest(".word-item");
    if (!row) return;
    const entry = volumeWordVolume && volumeWordVolume.entries[Number(row.dataset.idx)];
    if (!entry) return;
    if (e.target.closest(".word-play")) {
      playEntryAudio(entry);
      return;
    }
    openCharCard(entry, { onBack: () => renderVolumeWords(volumeWordVolume) });
  });
  // 汉字表返回册目页
  $("#btn-words-back").addEventListener("click", backToVolumes);
  $("#btn-volume-back").addEventListener("click", renderHome);
  // 选册页「练习设置」：按当前小朋友读取并展示设置
  $("#btn-settings").addEventListener("click", renderSettings);
  $("#btn-settings-back").addEventListener("click", backToVolumes);

  // 创建小朋友：输入名字
  const dialog = $("#user-dialog");
  const nameInput = $("#user-name-input");
  function openUserDialog() {
    nameInput.value = "";
    dialog.classList.remove("hidden");
    nameInput.focus();
  }
  function closeUserDialog() {
    dialog.classList.add("hidden");
  }
  $("#btn-create-user").addEventListener("click", openUserDialog);
  $("#btn-user-cancel").addEventListener("click", closeUserDialog);
  // 应用设置：新增完成后若仍在应用设置页则刷新列表，否则回首页
  function afterUserAdded() {
    closeUserDialog();
    if (views.admin.classList.contains("hidden")) renderHome();
    else renderAdmin();
  }
  $("#btn-user-ok").addEventListener("click", () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    Storage.addUser(name);
    afterUserAdded();
  });
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#btn-user-ok").click();
  });

  // 练习设置：候选字数、每组题数（只写当前小朋友，改动后下一组练习生效）
  $("#set-options").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-v]");
    if (!btn) return;
    Storage.setQuizOptions(btn.dataset.v, Storage.currentId());
    refreshSettings(Storage.currentUser());
  });
  $("#set-count").addEventListener("change", () => {
    $("#set-count").value = Storage.setQuizCount($("#set-count").value, Storage.currentId());
  });

  $("#btn-history").addEventListener("click", renderHistory);
  // 结束本组练习（已作答的记录保留），回到该小朋友的册目选择页
  // 不用系统 confirm：手机端 WebView 的系统对话框可能触发返回或关闭页面等不一致行为；
  // 改为应用内对话框，点「确定」才结束，点屏幕其他位置直接关闭对话框
  $("#btn-quit").addEventListener("click", () => {
    $("#quit-dialog").classList.remove("hidden");
  });
  $("#quit-dialog").addEventListener("click", () => {
    $("#quit-dialog").classList.add("hidden");
  });
  $("#btn-quit-ok").addEventListener("click", (e) => {
    e.stopPropagation(); // 避免触发遮罩的关闭逻辑
    $("#quit-dialog").classList.add("hidden");
    // 退出时作废代次、清空当前题并清掉全部延时，防止离开后仍自动出题或补写记录
    session.gen += 1;
    session.current = null;
    clearSessionTimers();
    Speaker.stop();
    backToVolumes();
  });
  // 练习记录从"选册页"进入，返回时回到该小朋友的选册页
  $("#btn-history-back").addEventListener("click", backToVolumes);
  // 练习记录里的汉字：点击进入通用单字详情页，返回时回到记录页
  $("#history-list").addEventListener("click", (e) => {
    const el = e.target.closest(".hchar");
    if (!el) return;
    const entry = historyEntries[Number(el.dataset.idx)];
    if (entry) openCharCard(entry, { onBack: renderHistory });
  });
  // 单字详情页：读音 + 组词 + 注解
  $("#btn-card-read").addEventListener("click", () => {
    if (cardEntry) Speaker.readEntry(cardEntry);
  });
  $("#btn-card-back").addEventListener("click", () => {
    if (cardOnBack) cardOnBack();
  });
  // 清除当前小朋友的进度与记录（二次确认），清空后停留在本页
  $("#btn-reset").addEventListener("click", () => {
    if (confirm("确定要清除这位小朋友的所有练习记录吗？此操作不可恢复。")) {
      Storage.clearUserData();
      renderHistory();
    }
  });
  // 结束页“返回”：回到该小朋友的册目选择页
  $("#btn-again").addEventListener("click", backToVolumes);
  // 继续答题：沿用上一组所选册，立即开始新一组
  $("#btn-continue").addEventListener("click", () => {
    const volume = window.VOLUMES.find((v) => String(v.id) === session.volumeId);
    if (!volume) {
      renderHome();
      return;
    }
    const user = Storage.users().find((u) => u.id === session.userId) || Storage.currentUser();
    enterVolume(user, volume);
  });
  // 练习页顶部的礼物图标：进入当前小朋友的礼物展柜，返回时回到练习页
  $("#btn-gift").addEventListener("click", () => {
    openGiftView("quiz");
  });
  // 结束页礼物入口：未领取时打开礼物袋，已领取时直接查看展柜
  $("#btn-gift-open").addEventListener("click", () => {
    cleanupResultFx(); // 点击后立即隐藏小手和水波纹，避免挡住礼物弹窗/展柜
    if (giftClaimed) {
      openGiftView("result");
    } else {
      openGiftPicker();
    }
  });
  $("#btn-gifts-back").addEventListener("click", () => {
    show(giftsReturnView);
    if (giftsReturnView === "quiz") applyGridLayout();
  });
  // 展柜模式切换（橱窗 / 盒子 / 记录）：收纳盒是临时状态，不记忆
  document.querySelectorAll(".gift-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      giftShelfMode = btn.dataset.mode;
      renderGiftShelf();
    });
  });
  // 橱窗：点礼物卡片 → 居中放大
  $("#gift-shelf").addEventListener("click", (e) => {
    const item = e.target.closest(".gift-shelf-item");
    if (!item || giftDragMoved) return; // 刚结束拖拽时不触发点击
    const gift = giftItems.find((g) => g.id === item.dataset.id);
    if (!gift) return;
    item.classList.remove("fresh"); // 点开看过之后，新礼物特效消失
    zoomGift(gift.name, item);
  });
  // 收纳盒：点礼物卡片 → 晃动 + 与橱窗一样放大展示（不支持拖拽/换位）
  $("#gift-box").addEventListener("click", (e) => {
    const item = e.target.closest(".gift-box-item");
    if (!item) return;
    const gift = giftItems.find((g) => g.id === item.dataset.id);
    if (!gift) return;
    item.classList.remove("pop");
    void item.offsetWidth; // 强制重排，连续点击都能重新播放
    item.classList.add("pop");
    zoomGift(gift.name, item);
  });
  // 点击大图上的礼物图标：左右晃动 + 点击音效（不会关闭大图）
  $("#gift-zoom-icon").addEventListener("click", (e) => {
    e.stopPropagation();
    const icon = e.currentTarget;
    Sound.play("click");
    icon.classList.remove("shaking");
    void icon.offsetWidth; // 强制重排以重启动画
    icon.classList.add("shaking");
  });
  $("#gift-zoom-icon").addEventListener("animationend", (e) => {
    if (e.animationName === "gift-icon-shake") e.currentTarget.classList.remove("shaking");
  });
  // 放大 overlay：只有点卡片外区域才恢复——沿原路飞回卡片位置并缩小淡出，再隐藏遮罩
  $("#gift-zoom").addEventListener("click", (e) => {
    if (e.target.closest(".gift-zoom-inner")) return; // 点大图卡片内部不关闭
    const overlay = e.currentTarget;
    const inner = overlay.querySelector(".gift-zoom-inner");
    overlay.classList.remove("active"); // 背景遮罩淡出
    if (giftZoomFrom) {
      // 回到起飞时的卡片中心位置
      inner.style.transform = `translate(${giftZoomFrom.dx}px, ${giftZoomFrom.dy}px) scale(0.3)`;
      inner.style.opacity = "0";
      giftZoomFrom = null;
    }
    // 大图飞回卡片后，卡片上的图标做一次「变大 → 摇晃 → 恢复」强调动画
    const zoomedCard = giftZoomEl;
    giftZoomEl = null;
    setTimeout(() => {
      overlay.classList.add("hidden");
      if (zoomedCard) emphasizeGiftEl(zoomedCard.querySelector(".gift-shelf-icon, .gift-box-icon"));
    }, 320);
  });

  /* ---------- 橱窗拖拽排序 + 垃圾篓删除（统一用 Pointer Events，兼容鼠标/触摸/触控笔） ---------- */
  const giftShelf = $("#gift-shelf");
  const giftTrash = $("#gift-trash");
  let pointerDrag = null; // { id, ghost, offX, offY, pointerId, lastTarget, started }
  let pointerStart = null; // { id, x, y, pointerId } 记录按下位置，移动超过阈值才启动拖拽

  giftShelf.addEventListener("pointerdown", (e) => {
    if (giftShelfMode !== "shelf") return;
    if (e.button !== undefined && e.button !== 0) return;
    const item = e.target.closest(".gift-shelf-item");
    if (!item) return;
    // 不在 pointerdown 里 preventDefault，否则 click 事件会被吞掉，点击放大会失效；
    // 只记录起始位置，等移动超过阈值再正式启动拖拽
    pointerStart = { id: item.dataset.id, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
  });

  giftShelf.addEventListener("pointermove", (e) => {
    // 还没按下，或已经启动了拖拽
    if (!pointerStart) return;
    if (e.pointerId !== pointerStart.pointerId) return;

    if (!pointerDrag) {
      // 尚未启动拖拽：判断移动距离是否超过阈值（5px），超过才视为拖拽而非点击
      const dx = e.clientX - pointerStart.x;
      const dy = e.clientY - pointerStart.y;
      if (Math.hypot(dx, dy) < 5) return;
      // 启动拖拽
      const item = giftShelf.querySelector(`.gift-shelf-item[data-id="${pointerStart.id}"]`);
      if (!item) { pointerStart = null; return; }
      const rect = item.getBoundingClientRect();
      const ghost = item.cloneNode(true);
      ghost.classList.add("gift-touch-ghost");
      ghost.style.width = rect.width + "px";
      ghost.style.left = (e.clientX - (pointerStart.x - rect.left)) + "px";
      ghost.style.top = (e.clientY - (pointerStart.y - rect.top)) + "px";
      document.body.appendChild(ghost);
      item.classList.add("dragging");
      giftDragId = item.dataset.id;
      giftDragMoved = false;
      giftTrash.classList.add("ready");
      pointerDrag = {
        id: item.dataset.id,
        ghost,
        offX: pointerStart.x - rect.left,
        offY: pointerStart.y - rect.top,
        pointerId: e.pointerId,
        lastTarget: null,
        started: true,
      };
      try { item.setPointerCapture(e.pointerId); } catch (err) {}
    }

    // 已在拖拽中：移动幽灵 + 命中检测
    e.preventDefault();
    const g = pointerDrag.ghost;
    g.style.left = (e.clientX - pointerDrag.offX) + "px";
    g.style.top = (e.clientY - pointerDrag.offY) + "px";
    g.style.display = "none";
    const dragEl = giftShelf.querySelector(`.gift-shelf-item[data-id="${pointerDrag.id}"]`);
    if (dragEl) { dragEl.style.visibility = "hidden"; dragEl.style.pointerEvents = "none"; }
    const offset = e.pointerType === "touch" ? 24 : 0;
    const hit = document.elementFromPoint(e.clientX, e.clientY - offset);
    if (dragEl) { dragEl.style.visibility = ""; dragEl.style.pointerEvents = ""; }
    g.style.display = "";
    giftShelf.querySelectorAll(".gift-shelf-item.drag-over").forEach((c) => c.classList.remove("drag-over"));
    if (hit && giftTrash.contains(hit)) {
      giftTrash.classList.add("hover");
      pointerDrag.lastTarget = "__trash__";
      return;
    }
    giftTrash.classList.remove("hover");
    const targetCard = hit ? hit.closest(".gift-shelf-item") : null;
    if (targetCard && targetCard.dataset.id !== pointerDrag.id) {
      targetCard.classList.add("drag-over");
      pointerDrag.lastTarget = targetCard.dataset.id;
    } else {
      pointerDrag.lastTarget = null;
    }
  });

  function endPointerDrag(e) {
    if (pointerStart && e.pointerId === pointerStart.pointerId) {
      // 如果没启动拖拽（点击），直接清理，让 click 事件正常触发放大
      if (!pointerDrag) {
        pointerStart = null;
        return;
      }
    }
    if (!pointerDrag || e.pointerId !== pointerDrag.pointerId) return;
    giftDragMoved = true; // 已发生拖拽，阻止后续 click 触发放大
    const pd = pointerDrag;
    const g = pd.ghost;
    g.style.display = "none";
    const dragEl = giftShelf.querySelector(`.gift-shelf-item[data-id="${pd.id}"]`);
    if (dragEl) { dragEl.style.visibility = "hidden"; dragEl.style.pointerEvents = "none"; }
    const offset = e.pointerType === "touch" ? 24 : 0;
    const hit = document.elementFromPoint(e.clientX, e.clientY - offset);
    if (dragEl) { dragEl.style.visibility = ""; dragEl.style.pointerEvents = ""; dragEl.classList.remove("dragging"); }
    g.style.display = "";
    g.remove();
    const targetEl = giftShelf.querySelector(".gift-shelf-item.drag-over");
    giftShelf.querySelectorAll(".gift-shelf-item.drag-over").forEach((c) => c.classList.remove("drag-over"));
    giftTrash.classList.remove("ready", "hover");
    if (hit && giftTrash.contains(hit)) {
      giftDragId = null;
      deleteGift(pd.id);
    } else if (dragEl && targetEl && targetEl !== dragEl) {
      swapShelf(dragEl, targetEl);
      persistGiftOrder();
      giftDragId = null;
    } else {
      persistGiftOrder();
      giftDragId = null;
    }
    giftDragOverId = null;
    pointerDrag = null;
    pointerStart = null;
    setTimeout(() => { giftDragMoved = false; }, 50);
  }
  giftShelf.addEventListener("pointerup", endPointerDrag);
  giftShelf.addEventListener("pointercancel", endPointerDrag);

  // 按当前橱窗 DOM 顺序回写 giftItems 并持久化
  // 收纳盒里的礼物不在橱窗 DOM 中，必须保持在它们后面，不能被排到前面
  function persistGiftOrder() {
    if (!giftDragId) return;
    const ids = [...giftShelf.querySelectorAll(".gift-shelf-item")].map((c) => c.dataset.id);
    const shelfItems = ids.map((id) => giftItems.find((g) => g.id === id)).filter(Boolean);
    const rest = giftItems.filter((g) => !ids.includes(g.id));
    giftItems = shelfItems.concat(rest);
    Storage.saveGifts(giftItems);
  }

  // 删除指定礼物：垃圾篓抖动 + 卡片缩小消失后重渲染
  function deleteGift(id) {
    Sound.play("trash"); // 删除音效
    // 垃圾篓变大抖动特效
    giftTrash.classList.remove("hover", "gulp");
    void giftTrash.offsetWidth; // 重新触发动画
    giftTrash.classList.add("gulp");
    const el = giftShelf.querySelector(`.gift-shelf-item[data-id="${id}"]`);
    if (el) {
      el.style.transition = "transform 0.25s ease, opacity 0.25s ease";
      el.style.transform = "scale(0.3)";
      el.style.opacity = "0";
    }
    setTimeout(() => {
      giftItems = giftItems.filter((g) => g.id !== id);
      Storage.removeGiftItem(id);
      giftTrash.classList.remove("ready", "gulp");
      renderGiftShelf();
    }, 260);
  }
  // 礼物袋：点一下选中，再点一下取消；超过可挑数量时提示先取消一件
  $("#gift-grid").addEventListener("click", (e) => {
    const item = e.target.closest(".gift-item");
    if (!item) return;
    const name = item.dataset.name;
    const idx = giftPicked.indexOf(name);
    if (idx >= 0) {
      giftPicked.splice(idx, 1);
      popGiftEmoji(item);
    } else if (giftPicked.length < giftQuota) {
      giftPicked.push(name);
      popGiftEmoji(item);
      Sound.play("pick"); // 先播选中音效，再播「你从礼物袋中挑选了：<礼物名称>」
      Speaker.playGiftPick(name);
    } else {
      // 已选满：不播放放大动画，改用偏低的提示音，与选中音（高音"叮"）区分
      $("#gift-pick-tip").textContent = `最多选 ${giftQuota} 件，可以先取消一件`;
      Sound.play("full");
      return;
    }
    updateGiftPickState();
  });
  // 换一批（每个礼物袋仅一次）：旧礼物逐张缩小消失，再从非固定礼物中换一批弹入
  $("#btn-gift-refresh").addEventListener("click", () => {
    if (giftBagRefreshed || giftClaimed) return;
    giftBagRefreshed = true;
    $("#btn-gift-refresh").classList.add("hidden");
    Sound.play("swap");
    // 旧批次的已选项立即作废（否则动画期间还能点「收下礼物」领走旧礼物）
    giftPicked = [];
    updateGiftPickState();
    const grid = $("#gift-grid");
    grid.querySelectorAll(".gift-item").forEach((el) => el.classList.add("bag-out"));
    // 等旧卡片全部消失（0.2s 动画 + 逐张延迟）后再替换内容
    setTimeout(() => {
      renderGiftBag(buildGiftBag(false), true);
      grid.scrollTop = 0;
      grid.classList.remove("fade-top", "fade-bottom");
      requestAnimationFrame(() => updateScrollFade(grid));
    }, 400);
  });
  // 收下礼物：写入计数 + 领取日志；每组只有一次挑选机会，
  // 没有取消按钮，点其他区域也不会关闭，只有选中礼物后点此按钮才关闭弹窗
  $("#btn-gift-ok").addEventListener("click", () => {
    if (giftClaimed || giftPicked.length === 0) return;
    const pickedCount = giftPicked.length;
    Storage.addGifts(giftPicked, session.userId);
    Storage.addGiftLog(giftPicked, session.stars, session.userId);
    giftClaimed = true;
    // 新礼物摆在橱窗顶部；进柜时若有旧礼物被挤进收纳盒，按这个数量播放飞入动画
    giftOverflowPending += pickedCount;
    giftOverflowUid = session.userId;
    $("#gift-dialog").classList.add("hidden");
    Sound.play("correct");
    renderGiftReward();
  });
  // 应用设置入口（首页左下角小齿轮）
  $("#btn-admin").addEventListener("click", renderAdmin);
  $("#btn-admin-add").addEventListener("click", openUserDialog);
  // 按钮音效开关（全局设置）：点一下切换开启/关闭
  $("#btn-click-sound").addEventListener("click", () => {
    Storage.setPref(Storage.PREF_KEYS.CLICK, !Storage.pref(Storage.PREF_KEYS.CLICK));
    refreshClickSound();
  });
  // 清理音频缓存（应用设置）：释放本地缓存的音频并让后续请求重新下载
  $("#btn-clear-audio-cache").addEventListener("click", () => {
    Speaker.clearAudioCache();
    const btn = $("#btn-clear-audio-cache");
    btn.textContent = "已清理";
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = "清理音频缓存";
      btn.disabled = false;
    }, 1200);
  });
  // 清空所有数据（应用设置）：需二次确认，删除全部小朋友、进度、记录、设置与缓存后刷新
  $("#btn-clear-all-data").addEventListener("click", () => {
    if (
      !confirm(
        "确定要清空所有数据吗？\n这将删除全部小朋友、学习进度、练习记录、设置与缓存，且不可恢复。"
      )
    )
      return;
    Speaker.clearAudioCache();
    Storage.clearAll();
    location.reload();
  });
  $("#btn-admin-back").addEventListener("click", renderHome);
  $("#admin-users").addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-danger");
    if (!btn) return;
    const user = Storage.users().find((u) => u.id === btn.dataset.id);
    if (!user) return;
    if (!confirm(`确定删除「${user.name}」吗？该小朋友的练习记录会一并删除。`)) return;
    Storage.removeUser(user.id);
    renderAdmin();
  });

  // 首页右下角版本号：与 index.html 里的 CACHE_VERSION 保持一致
  $("#home-version").textContent = "v" + (window.APP_VERSION || "");

  // 作者信息浮层：点底部站点地址打开，点浮层以外区域关闭
  const aboutMask = $("#about-mask");
  const openAbout = () => aboutMask.classList.remove("hidden");
  const closeAbout = () => aboutMask.classList.add("hidden");
  $("#btn-about").addEventListener("click", openAbout);
  $("#btn-about-close").addEventListener("click", closeAbout);
  // 遮罩本身铺满全屏，只有点在遮罩上（即浮层以外区域）才关闭
  aboutMask.addEventListener("click", (e) => {
    if (e.target === aboutMask) closeAbout();
  });

  renderHome();
  // 首屏就绪：收起加载遮罩
  if (window.__boot) window.__boot.finish();
})();
