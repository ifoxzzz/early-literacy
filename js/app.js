// 主逻辑：视图切换、练习流程、对错反馈
(function () {
  const $ = (s) => document.querySelector(s);

  // 字库里可以用「汉字(拼音)」标注强制纠正朗读读音（如 快乐(lè)）；
  // 标注只给语音生成脚本用，界面展示时去掉括号与拼音，只留汉字。
  // 清洗规则与系统语音共用 speaker.js 的实现，避免两处正则不一致
  const displayText = (text) => Speaker.stripAnnotation(text);

  // 禁用鼠标右键菜单，避免小朋友误触后不知道如何处理
  document.addEventListener("contextmenu", (e) => e.preventDefault());

  /* ---------- 关闭页面确认 ---------- */
  // 浏览器不允许在页面卸载时展示自定义 DOM，只能通过 beforeunload 触发原生的
  // 「离开此网站？」确认框（文案由浏览器固定）；手机浏览器/微信 WebView 多数会忽略。
  let allowUnload = false;
  window.addEventListener("beforeunload", (e) => {
    if (allowUnload) return;
    e.preventDefault();
    e.returnValue = ""; // 兼容旧版浏览器，触发原生确认
  });

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
  let giftsReturnView = "quiz";
  let giftShelfMode = "shelf"; // "shelf" 收纳 / "list" 记录
  const GIFT_MODE_KEY = "early-literacy-gift-mode";

  function show(name) {
    Object.values(views).forEach((v) => v.classList.add("hidden"));
    views[name].classList.remove("hidden");
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
  }

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

  function showLoading(title) {
    $("#loading-title").textContent = title;
    $("#loading-fill").style.width = "0%";
    $("#loading-count").textContent = "0 / 0";
    $("#loading-mask").classList.remove("hidden");
  }

  function updateLoading(done, total) {
    const pct = total ? Math.round((done / total) * 100) : 100;
    $("#loading-fill").style.width = `${pct}%`;
    $("#loading-count").textContent = `${done} / ${total}`;
  }

  function hideLoading() {
    $("#loading-mask").classList.add("hidden");
  }

  // 点册后只预加载第一题的语音，就绪即进入练习页；
  // 后续题目在答题过程中由 prefetchUpcoming 后台滑窗预取（答题时间足够下载）
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

  // 后台预取接下来 5 题的语音（单字/组词/注解）：
  // 孩子答一题的时间足够下载好几题，滑到对应题目时基本已就绪
  function prefetchUpcoming() {
    const urls = [];
    session.queue.slice(0, 5).forEach((q) => {
      urls.push(...Speaker.entryUrls(q.target));
    });
    Speaker.preload(urls);
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
    // 本题语音未就绪时显示加载进度，加载完才出题；
    // 后台滑窗预取保证绝大多数情况瞬间完成、遮罩根本不出现
    let loadingShown = false;
    const showTimer = setTimeout(() => {
      loadingShown = true;
      showLoading("正在准备本题语音");
    }, 150);
    Speaker.preloadAll(Speaker.entryUrls(q.target), updateLoading).then(() => {
      clearTimeout(showTimer);
      if (gen !== session.gen) return;
      if (loadingShown) hideLoading();
      beginQuestion(q);
      prefetchUpcoming();
    });
  }

  function beginQuestion(q) {
    q.locked = false;
    session.current = q;

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

    const grid = $("#grid");
    grid.classList.remove("locked", "helping");
    grid.innerHTML = "";
    q.options.forEach((opt) => {
      const card = document.createElement("div");
      card.className = "card";
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

    const isFirst = session.firstQuestion;
    session.firstQuestion = false;
    Speaker.readQuestion(q.target, { welcome: isFirst, name: session.userName });
  }

  // 作答后记录已写入：correct==1 且 wrong==0 说明是第一次接触的新字
  function isNewChar(key) {
    const r = Storage.loadAll()[key];
    return r && r.correct === 1 && r.wrong === 0;
  }

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
    // 指尖点中田字格中心后，中心向外扩散三层同心水波（动画见 style.css 的 water-ripple）
    const ripple = document.createElement("span");
    ripple.className = "help-ripple";
    ripple.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 3; i++) {
      const ring = document.createElement("span");
      ring.className = "ripple-ring";
      ripple.appendChild(ring);
    }
    targetCard.appendChild(ripple);
    // 小手提示：从田字格下方的外部滑上来，指尖点中中心后轻点一下再淡出，循环提示孩子点这张卡片
    const hand = document.createElement("span");
    hand.className = "help-hand";
    hand.setAttribute("aria-hidden", "true");
    hand.innerHTML =
      '<svg viewBox="0 0 64 80" aria-hidden="true">' +
      '<rect x="26" y="3" width="14" height="44" rx="7" fill="#f5ad63"/>' +
      '<rect x="5" y="37" width="14" height="22" rx="7" transform="rotate(-22 12 48)" fill="#f5ad63"/>' +
      '<rect x="13" y="33" width="38" height="33" rx="15" fill="#f5ad63"/>' +
      '<rect x="16" y="63" width="32" height="9" rx="4.5" fill="#8ecfe0"/>' +
      "</svg>";
    targetCard.appendChild(hand);
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
    // 先一圈扩散光环，再彩色纸屑——范围加大，围绕每颗星星炸开一小团烟花
    const ring = document.createElement("span");
    ring.className = "confetti-ring";
    ring.style.left = `${cx}px`;
    ring.style.top = `${cy}px`;
    layer.appendChild(ring);
    setTimeout(() => ring.remove(), 900);
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
  let resultHandEl = null;
  let resultRippleEl = null;
  let resultRippleInterval = null;
  let resultResizeFn = null;

  function cleanupResultFx() {
    if (resultHandEl) { resultHandEl.remove(); resultHandEl = null; }
    if (resultRippleEl) { resultRippleEl.remove(); resultRippleEl = null; }
    if (resultRippleInterval) { clearInterval(resultRippleInterval); resultRippleInterval = null; }
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
    // 本组星星数决定礼物挑选次数：6 颗及以上 1 次，10 颗及以上 2 次
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

  // 礼物提示小手：固定层 SVG 小手指向 #btn-gift-open，循环"滑上来→轻点→停留→滑下"；
  // 目标按钮中心还会循环冒水波纹冒泡，引导点击。切页后 cleanupResultFx 统一清理。
  function showGiftHand() {
    const target = document.getElementById("btn-gift-open");
    if (!target) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // 先清理上一轮残留
    cleanupResultFx();

    // 小手
    resultHandEl = document.createElement("span");
    resultHandEl.className = "gift-hand";
    resultHandEl.setAttribute("aria-hidden", "true");
    resultHandEl.innerHTML =
      '<svg viewBox="0 0 64 80" aria-hidden="true">' +
      '<rect x="26" y="3" width="14" height="44" rx="7" fill="#f5ad63"/>' +
      '<rect x="5" y="37" width="14" height="22" rx="7" transform="rotate(-22 12 48)" fill="#f5ad63"/>' +
      '<rect x="13" y="33" width="38" height="33" rx="15" fill="#f5ad63"/>' +
      '<rect x="16" y="63" width="32" height="9" rx="4.5" fill="#8ecfe0"/>' +
      "</svg>";
    document.body.appendChild(resultHandEl);

    // 水波纹层（固定铺满视口，pointer-events: none）
    resultRippleEl = document.createElement("div");
    resultRippleEl.className = "gift-ripple-layer";
    document.body.appendChild(resultRippleEl);

    const updatePos = () => {
      const t = target.getBoundingClientRect();
      if (!t.width) return;
      const cx = t.left + t.width / 2;
      const cy = t.top + t.height / 2;
      const size = Math.max(64, Math.min(t.width, 110) * 0.45);
      // 起点：按钮中心往下一半的位置（原先从 viewport 底边，现在减半）
      const startTopY = cy + (window.innerHeight - cy) / 2;
      resultHandEl.style.setProperty("--start-top", `${startTopY - size * 0.0375}px`);
      resultHandEl.style.setProperty("--start-left", `${cx - size * 0.5}px`);
      // 终点：指尖在按钮中心
      resultHandEl.style.setProperty("--ex", `${cx - size * 0.5}px`);
      resultHandEl.style.setProperty("--ey", `${cy - size * 0.0375}px`);
      resultHandEl.style.setProperty("--size", `${size}px`);
      resultRippleEl.style.setProperty("--rx", `${cx}px`);
      resultRippleEl.style.setProperty("--ry", `${cy}px`);
    };
    updatePos();
    resultResizeFn = updatePos;
    window.addEventListener("resize", resultResizeFn);

    // 水波纹冒泡：每 900ms 生成一圈小圈，循环直到 cleanupResultFx
    const spawnRipple = () => {
      if (!resultRippleEl) return;
      if (document.getElementById("view-result").classList.contains("hidden")) return;
      const r = document.createElement("span");
      r.className = "gift-ripple";
      resultRippleEl.appendChild(r);
      setTimeout(() => r.remove(), 1500);
    };
    resultRippleInterval = setInterval(spawnRipple, 900);
    spawnRipple(); // 立即来一圈
  }

  /* ---------- 礼物兑换与展柜 ---------- */
  const giftCatalog = () => window.GIFTS || {};

  // 本组星星数决定挑选次数：6 颗及以上 1 件，10 颗及以上 2 件
  function giftQuotaFor(stars) {
    if (stars >= 10) return 3;
    if (stars >= 6) return 2;
    if (stars >= 5) return 1;
    return 0;
  }

  function giftLabel(name) {
    return `${giftCatalog()[name] || "🎁"} ${name}`;
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
      $("#gift-reward-tip").textContent = `已放入礼物橱窗：${giftPicked.map(giftLabel).join("、")}`;
      $("#btn-gift-open").textContent = "查看我的礼物 🎁";
    } else {
      $("#gift-reward-tip").textContent = `本组可以挑选 ${giftQuota} 件礼物！`;
      $("#btn-gift-open").textContent = "打开礼物清单 🎁";
    }
  }

  // 橱窗：两种模式切换（橱窗 / 记录），按 localStorage 记忆偏好
  // giftItems 是当前橱窗的礼物实例数组（拖拽排序时就地改它，松手后持久化）
  let giftItems = [];
  let giftDragId = null; // 正在拖拽的礼物实例 id
  let giftDragMoved = false; // 本次拖拽是否发生过移动（用来区分点击与拖拽）

  function renderGiftShelf() {
    const user = Storage.currentUser();
    const catalog = giftCatalog();
    const uid = user ? user.id : "";
    giftItems = Storage.gifts(uid);
    const total = giftItems.length;
    // 后台预取已拥有礼物的名称音频（通常只有几件），放大时即可秒播
    Speaker.preload(
      [...new Set(giftItems.map((g) => g.name))].map((n) => Speaker.giftAudio(n))
    );
    $("#gifts-owner").textContent = user
      ? `${user.name} 的礼物 · 共 ${total} 件`
      : `我的礼物 · 共 ${total} 件`;

    // 模式按钮 active 状态
    giftShelfMode = localStorage.getItem(GIFT_MODE_KEY) === "list" ? "list" : "shelf";
    document.querySelectorAll(".gift-mode-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === giftShelfMode);
    });
    const hasGifts = total > 0;
    $("#gift-shelf").classList.toggle("hidden", giftShelfMode !== "shelf" || !hasGifts);
    $("#gift-list").classList.toggle("hidden", giftShelfMode !== "list" || !hasGifts);
    // 垃圾篓只在橱窗模式且拖拽时才需要可见；平时常驻提示也可以，这里只在橱窗模式显示
    $("#gift-trash").classList.toggle("hidden", giftShelfMode !== "shelf" || !hasGifts);
    $("#gift-empty").classList.toggle("hidden", hasGifts);

    if (hasGifts && giftShelfMode === "shelf") {
      // 每件礼物实例一张卡片：同名礼物就是并列的多张卡片，可分别拖拽/删除
      $("#gift-shelf").innerHTML = giftItems
        .map(
          (g) => `<div class="gift-shelf-item${g.fresh ? " fresh" : ""}" draggable="true" data-id="${g.id}">
            <span class="gift-shelf-icon">${catalog[g.name] || "🎁"}</span>
            <span class="gift-shelf-name">${g.name}</span>
          </div>`
        )
        .join("");
    }

    if (hasGifts && giftShelfMode === "list") {
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
    }

    show("gifts");
  }

  // FLIP 动画：记录现有卡片位置 → 执行 DOM 变更 → 让受影响的卡片从旧位置平滑滑到新位置
  function flipShelf(mutate, skipEl) {
    const shelf = $("#gift-shelf");
    const cards = [...shelf.querySelectorAll(".gift-shelf-item")];
    const first = new Map(cards.map((el) => [el, el.getBoundingClientRect()]));
    mutate();
    cards.forEach((el) => {
      if (el === skipEl) return;
      const f = first.get(el);
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
  }

  // 点橱窗礼物：清除「新」标记（边框闪烁消失）并放大展示
  // 放大动画从被点卡片的位置开始：先平移+缩小到卡片处，再飞到屏幕中央变大；
  // giftZoomFrom 记住起飞偏移，关闭时缩回卡片位置，与展开相呼应
  let giftZoomFrom = null;

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

  function openGiftPicker() {
    if (giftClaimed || giftQuota <= 0) return;
    giftPicked = [];
    // 统计各礼物已有数量（实例数组按名字聚合计数）
    const owned = {};
    Storage.gifts(session.userId).forEach((g) => {
      owned[g.name] = (owned[g.name] || 0) + 1;
    });
    $("#gift-grid").innerHTML = Object.entries(giftCatalog())
      .map(([name, icon]) => {
        const count = owned[name] || 0;
        return `<button type="button" class="gift-item" data-name="${name}">
          <span class="gift-emoji">${icon}</span>
          <span class="gift-name">${name}</span>
          ${count > 0 ? `<span class="gift-owned">已有 ${count}</span>` : ""}
        </button>`;
      })
      .join("");
    updateGiftPickState();
    $("#gift-dialog").classList.remove("hidden");
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
      showLoading(`正在呼唤 ${user.name}`);
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
  // 册目列表、汉字表、练习记录滚动时更新边缘淡出与滚动条显隐；窗口尺寸变化时重新计算
  bindScrollFx($("#volume-list"));
  bindScrollFx($("#word-list"), $("#word-sheet"));
  bindScrollFx($("#history-list"));
  window.addEventListener("resize", () => {
    updateScrollFade($("#volume-list"));
    updateScrollFade($("#word-list"), $("#word-sheet"));
    updateScrollFade($("#history-list"));
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
    giftsReturnView = "quiz";
    renderGiftShelf();
  });
  // 结束页礼物入口：未领取时打开礼物清单，已领取时直接查看展柜
  $("#btn-gift-open").addEventListener("click", () => {
    cleanupResultFx(); // 点击后立即隐藏小手和水波纹，避免挡住礼物弹窗/展柜
    if (giftClaimed) {
      giftsReturnView = "result";
      renderGiftShelf();
    } else {
      openGiftPicker();
    }
  });
  $("#btn-gifts-back").addEventListener("click", () => {
    show(giftsReturnView);
    if (giftsReturnView === "quiz") applyGridLayout();
  });
  // 展柜模式切换（收纳 / 记录）：偏好存 localStorage
  document.querySelectorAll(".gift-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      giftShelfMode = btn.dataset.mode;
      localStorage.setItem(GIFT_MODE_KEY, giftShelfMode);
      renderGiftShelf();
    });
  });
  // 橱窗：点礼物卡片 → 清除「新」标记（边框闪烁消失）+ 居中放大
  $("#gift-shelf").addEventListener("click", (e) => {
    const item = e.target.closest(".gift-shelf-item");
    if (!item || giftDragMoved) return; // 刚结束拖拽时不触发点击
    const gift = giftItems.find((g) => g.id === item.dataset.id);
    if (!gift) return;
    if (gift.fresh) {
      gift.fresh = false;
      Storage.markGiftSeen(gift.id);
      item.classList.remove("fresh");
    }
    zoomGift(gift.name, item);
  });
  // 放大 overlay：点任意位置恢复——沿原路飞回卡片位置并缩小淡出，再隐藏遮罩
  $("#gift-zoom").addEventListener("click", (e) => {
    const overlay = e.currentTarget;
    const inner = overlay.querySelector(".gift-zoom-inner");
    overlay.classList.remove("active"); // 背景遮罩淡出
    if (giftZoomFrom) {
      // 回到起飞时的卡片中心位置
      inner.style.transform = `translate(${giftZoomFrom.dx}px, ${giftZoomFrom.dy}px) scale(0.3)`;
      inner.style.opacity = "0";
      giftZoomFrom = null;
    }
    setTimeout(() => overlay.classList.add("hidden"), 320);
  });

  /* ---------- 橱窗拖拽排序 + 垃圾篓删除 ---------- */
  const giftShelf = $("#gift-shelf");
  const giftTrash = $("#gift-trash");

  giftShelf.addEventListener("dragstart", (e) => {
    const item = e.target.closest(".gift-shelf-item");
    if (!item) return;
    giftDragId = item.dataset.id;
    giftDragMoved = false;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", giftDragId);
    // 让浏览器用半透明卡片做拖拽影像
    requestAnimationFrame(() => item.classList.add("dragging"));
    giftTrash.classList.add("ready");
  });

  giftShelf.addEventListener("dragover", (e) => {
    if (!giftDragId) return;
    e.preventDefault(); // 允许 drop
    e.dataTransfer.dropEffect = "move";
    const shelf = giftShelf;
    const cards = [...shelf.querySelectorAll(".gift-shelf-item")];
    const dragEl = cards.find((c) => c.dataset.id === giftDragId);
    if (!dragEl) return;
    // 计算光标应插入的位置：按阅读顺序逐卡片比较
    let targetIdx = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { targetIdx = i; break; }
      if (e.clientY < r.bottom && e.clientX < r.left + r.width / 2) { targetIdx = i; break; }
    }
    const curIdx = cards.indexOf(dragEl);
    // 目标位置恰好是自己或相邻时无需移动
    if (targetIdx === curIdx || targetIdx === curIdx + 1) return;
    giftDragMoved = true;
    flipShelf(() => {
      if (targetIdx >= cards.length) shelf.appendChild(dragEl);
      else shelf.insertBefore(dragEl, cards[targetIdx]);
    }, dragEl);
  });

  giftShelf.addEventListener("drop", (e) => {
    e.preventDefault();
    persistGiftOrder();
  });

  giftShelf.addEventListener("dragend", () => {
    persistGiftOrder();
    const dragEl = giftShelf.querySelector(".gift-shelf-item.dragging");
    if (dragEl) dragEl.classList.remove("dragging");
    giftTrash.classList.remove("ready", "hover");
    giftDragId = null;
    // 稍后复位标记，避免拖拽结束的 click 误触发放大
    setTimeout(() => { giftDragMoved = false; }, 50);
  });

  // 按当前 DOM 顺序回写 giftItems 并持久化
  function persistGiftOrder() {
    if (!giftDragId) return;
    const ids = [...giftShelf.querySelectorAll(".gift-shelf-item")].map((c) => c.dataset.id);
    giftItems.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    Storage.saveGifts(giftItems);
  }

  // 垃圾篓：拖入变大，松手删除并抖动恢复
  giftTrash.addEventListener("dragover", (e) => {
    if (!giftDragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    giftTrash.classList.add("hover");
  });
  giftTrash.addEventListener("dragleave", () => giftTrash.classList.remove("hover"));
  giftTrash.addEventListener("drop", (e) => {
    e.preventDefault();
    if (!giftDragId) return;
    const id = giftDragId;
    giftDragId = null;
    // 垃圾篓变大抖动特效
    giftTrash.classList.remove("hover", "gulp");
    void giftTrash.offsetWidth; // 重新触发动画
    giftTrash.classList.add("gulp");
    // 卡片缩小消失后重渲染
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
  });
  // 礼物清单：点一下选中，再点一下取消；超过可挑数量时提示先取消一件
  $("#gift-grid").addEventListener("click", (e) => {
    const item = e.target.closest(".gift-item");
    if (!item) return;
    const name = item.dataset.name;
    const idx = giftPicked.indexOf(name);
    if (idx >= 0) {
      giftPicked.splice(idx, 1);
    } else if (giftPicked.length < giftQuota) {
      giftPicked.push(name);
      Speaker.playGiftPick(name); // 勾选时播报「你选择了：<礼物名称>」
    } else {
      $("#gift-pick-tip").textContent = `最多选 ${giftQuota} 件，可以先取消一件`;
      return;
    }
    updateGiftPickState();
  });
  // 收下礼物：写入计数 + 领取日志；本组不能重复领取
  $("#btn-gift-ok").addEventListener("click", (e) => {
    e.stopPropagation();
    if (giftClaimed || giftPicked.length === 0) return;
    Storage.addGifts(giftPicked, session.userId);
    Storage.addGiftLog(giftPicked, session.stars, session.userId);
    giftClaimed = true;
    $("#gift-dialog").classList.add("hidden");
    Sound.play("correct");
    renderGiftReward();
  });
  // 关闭礼物弹窗：每组只有一次挑选机会，关闭即视为放弃未确认的选择
  function closeGiftPicker() {
    $("#gift-dialog").classList.add("hidden");
    if (!giftClaimed) {
      giftClaimed = true;
      giftPicked = [];
      renderGiftReward();
    }
  }
  $("#btn-gift-cancel").addEventListener("click", closeGiftPicker);
  $("#gift-dialog").addEventListener("click", (e) => {
    if (e.target === $("#gift-dialog")) closeGiftPicker();
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
    allowUnload = true; // 这是应用内的主动刷新，不再弹离站确认
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

  renderHome();
  // 首屏就绪：收起加载遮罩
  if (window.__boot) window.__boot.finish();
})();
