// 主逻辑：视图切换、练习流程、对错反馈
(function () {
  const $ = (s) => document.querySelector(s);

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
  };

  // 本次练习状态
  const session = {
    queue: [], // 本组剩余题目
    total: 0, // 本组题数
    done: 0, // 已完成题数（答对、跳过、求助后点对都算完成）
    stars: 0,
    firstTryCorrect: 0, // 首答正确题数
    newLearned: [], // 本次新学会的字
    answers: [], // 本组每个字的首次作答结果 [{ c, pinyin, words, ok }]
    firstQuestion: false, // 本组第一题（播放欢迎语）
    userId: "", // 本组属于哪位小朋友（结束页返回时用）
    userName: "", // 当前小朋友名字（用于语音问候）
    volumeId: "", // 本组所选册 id（结束页「继续答题」时用）
    volume: "", // 当前学习的是哪一册
    optionCount: 4, // 每题候选字数（决定田字格布局）
    current: null, // 当前题目
  };

  function show(name) {
    Object.values(views).forEach((v) => v.classList.add("hidden"));
    views[name].classList.remove("hidden");
  }

  // 候选字数量对应的行列：横屏行数少、竖屏列数少，避免卡片被拉得又宽又扁
  // cap 为单张卡片尺寸上限（随数量变化），实际尺寸还会受屏幕宽高约束（见 style.css）
  const GRID_LAYOUT = {
    2: { landscape: [2, 1], portrait: [1, 2], cap: "min(40vmin, 220px)" },
    3: { landscape: [3, 1], portrait: [1, 3], cap: "min(30vmin, 190px)" },
    4: { landscape: [2, 2], portrait: [2, 2], cap: "min(34vmin, 220px)" },
    6: { landscape: [3, 2], portrait: [2, 3], cap: "min(26vmin, 190px)" },
    8: { landscape: [4, 2], portrait: [2, 4], cap: "min(21vmin, 150px)" },
    9: { landscape: [3, 3], portrait: [3, 3], cap: "min(24vmin, 160px)" },
  };

  // 按当前数量 + 横竖屏写入行列变量；转屏时再次调用即可即时切换布局
  function applyGridLayout() {
    const conf = GRID_LAYOUT[session.optionCount] || GRID_LAYOUT[4];
    const portrait = window.innerHeight > window.innerWidth;
    const [cols, rows] = portrait ? conf.portrait : conf.landscape;
    views.quiz.style.setProperty("--cols", cols);
    views.quiz.style.setProperty("--rows", rows);
    views.quiz.style.setProperty("--card-cap", conf.cap);
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

  /* ---------- 选择学习内容：列出现有册 ---------- */
  function renderVolumes(user) {
    // 进入册目页就开始下载提示语与星星播报，给孩子挑选册的时间，避免练习第一题没声音
    if (user) Speaker.preloadSession(user.name, []);
    $("#volume-owner").textContent = user ? `${user.name} 想学哪一册？` : "";
    const list = $("#volume-list");
    list.innerHTML = "";
    window.VOLUMES.forEach((v) => {
      const s = Storage.statsFor(v.entries);
      const card = document.createElement("button");
      card.className = "volume-card";
      card.dataset.id = v.id;
      card.innerHTML = `<span class="volume-name">${v.title}</span>
        <span class="volume-meta">共 ${s.total} 字 · 已学 ${s.learned} · 待复习 ${s.due}</span>
        <span class="volume-icon" role="img" aria-label="查看本册汉字" title="查看本册汉字">📖</span>`;
      list.appendChild(card);
    });
    show("volumes");
  }

  /* ---------- 某一册的汉字表（册目页右侧图标进入） ---------- */
  let volumeWordVolume = null; // 当前汉字表对应的册（从详情页返回时要用）

  function renderVolumeWords(volume) {
    volumeWordVolume = volume;
    $("#words-subtitle").textContent = `${volume.title} · 共 ${volume.entries.length} 个字`;
    $("#word-list").innerHTML = volume.entries
      .map(
        (e, i) => `<div class="word-item" data-idx="${i}" title="查看「${e.char}」">
          <button class="word-play" data-idx="${i}" title="播放读音和组词">🔊</button>
          <span class="word-char">${e.char}</span>
          <span class="word-pinyin">${e.pinyin}</span>
          <span class="word-words">${e.words}</span>
        </div>`
      )
      .join("");
    show("volumeWords");
  }

  /* ---------- 后台管理 ---------- */
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
    $("#card-words").textContent = entry.words ? `组词：${entry.words}` : "";
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

  /* ---------- 历史记录 ---------- */
  // 当前历史页里每个可点击汉字对应的字库条目
  let historyEntries = [];
  let charEntryMap = null;

  // 新记录自带拼音与组词；旧记录只有汉字，按字库首次出现补齐
  function entryOfAnswer(a) {
    if (a.pinyin && a.words) {
      return { char: a.c, pinyin: a.pinyin, words: a.words };
    }
    if (!charEntryMap) {
      charEntryMap = new Map();
      VOLUMES.forEach((v) =>
        v.entries.forEach((e) => {
          if (!charEntryMap.has(e.char)) charEntryMap.set(e.char, e);
        })
      );
    }
    return charEntryMap.get(a.c) || { char: a.c, pinyin: "", words: "" };
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
          const chars = (r.chars || [])
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
    show("history");
  }

  /* ---------- 练习 ---------- */
  function startSession(user, volume) {
    // 该小朋友自己配置的候选字数 / 每组题数
    const uid = user ? user.id : Storage.currentId();
    const optionCount = Storage.quizOptions(uid);
    const questions = Quiz.buildSession(Storage.quizCount(uid), volume.entries, optionCount);
    if (questions.length === 0) return;
    Object.assign(session, {
      queue: questions,
      total: questions.length,
      done: 0,
      stars: 0,
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
    applyGridLayout(); // 按候选字数量与当前横竖屏决定列数与卡片尺寸
    show("quiz");
    $("#quiz-user").textContent = `${session.userName} · ${volume.title}`;
    // 本组所有题目的单字、组词音频一次性预热，后面的题目不再临时等下网络
    Speaker.preloadSession(session.userName, questions.map((q) => q.target));
    nextQuestion();
  }

  // 本题只计一次进度：答对、跳过、求助后点对都会调用
  function markDone(q) {
    if (q.counted) return;
    q.counted = true;
    session.done += 1;
  }

  function nextQuestion() {
    if (session.queue.length === 0) {
      renderResult();
      return;
    }
    const q = session.queue.shift();
    q.locked = false;
    session.current = q;

    $("#quiz-progress").textContent = `第 ${Math.min(session.done + 1, session.total)}/${session.total} 题`;
    $("#quiz-stars").textContent = `⭐ ${session.stars}`;
    $("#hint-text").textContent = `组词：${q.target.words}`;
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
    clearTimeout(session.timer);
    $("#btn-help").classList.add("used");
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
    // 放大后的田字格外圈叠加两圈向外扩散的波纹（动画见 style.css 的 help-wave）
    const wave = document.createElement("span");
    wave.className = "help-wave";
    wave.setAttribute("aria-hidden", "true");
    targetCard.appendChild(wave);
    // 读取一次位置会强制提交上面的初始状态，再写入位移，动画才会从原位平滑开始
    const rect = targetCard.getBoundingClientRect();
    const dx = window.innerWidth / 2 - (rect.left + rect.width / 2);
    const dy = window.innerHeight / 2 - (rect.top + rect.height / 2);
    targetCard.style.transform = `translate(${dx}px, ${dy}px) scale(1.5)`;
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
    popStar(card);
    Sound.play("correct");

    // 首答计分：本题出现过错选就不再加星，但答对时仍播放语音、冒出星星
    const firstTry = !q.wrongPicks;
    if (firstTry) {
      Storage.recordAnswer(targetKey, true);
      session.stars += 1;
      session.firstTryCorrect += 1;
      if (isNewChar(targetKey)) session.newLearned.push(q.target.char);
      // 烟花从孩子刚才点/摸的位置炸开；键盘触发（坐标 0）时退回卡片中心
      const rect = card.getBoundingClientRect();
      const origin =
        evt && (evt.clientX || evt.clientY)
          ? { x: evt.clientX, y: evt.clientY }
          : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      playFireworks(origin);
    }
    if (!q.counted) {
      session.answers.push({
        c: q.target.char,
        pinyin: q.target.pinyin,
        words: q.target.words,
        ok: firstTry,
      });
      markDone(q);
    }
    $("#quiz-stars").textContent = `⭐ ${session.stars}`;

    // 夸奖语音播完再进入下一题，避免被切断
    setTimeout(() => {
      if (session.current !== q) return;
      Speaker.correct(() => {
        if (session.current !== q) return;
        session.timer = setTimeout(nextQuestion, 600);
      }, session.userName);
    }, 400);
  }

  function popStar(card) {
    const rect = card.getBoundingClientRect();
    const star = document.createElement("div");
    star.className = "star-pop";
    star.textContent = "⭐";
    star.style.left = rect.left + rect.width / 2 - 32 + "px";
    star.style.top = rect.top + rect.height / 2 - 32 + "px";
    document.body.appendChild(star);
    setTimeout(() => star.remove(), 1000);
  }

  /* ---------- 烟花特效：首次选对时从点击位置连续绽放 ---------- */
  let fwGeneration = 0;
  let fwRaf = 0;

  function playFireworks(at) {
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

    const colors = ["#ff5252", "#ffca28", "#66bb6a", "#29b6f6", "#ab47bc", "#ff7043"];
    const cx = at ? at.x : w / 2;
    const cy = at ? at.y : h / 2;
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

  /* ---------- 结束页 ---------- */
  function renderResult() {
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
    $("#result-accuracy").textContent = `${session.volume} · 答对 ${session.firstTryCorrect} / ${session.total} 题`;
    $("#result-new").textContent =
      session.newLearned.length > 0 ? `新学会：${session.newLearned.join("、")}` : "";
    Speaker.result(session.stars, session.userName);
    show("result");
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
  function bindDisplaySwitch(key, hideClass, btn) {
    const isOn = () => Storage.pref(key);
    const refresh = () => {
      document.body.classList.toggle(hideClass, !isOn());
      btn.classList.toggle("active", isOn());
    };
    btn.addEventListener("click", () => {
      Storage.setPref(key, !isOn());
      refresh();
    });
    refresh();
  }
  // 拼音（即时生效） / 组词（只影响显示，语音仍会朗读） / 历史汉字
  bindDisplaySwitch(Storage.PREF_KEYS.PINYIN, "hide-pinyin", $("#btn-pinyin"));
  bindDisplaySwitch(Storage.PREF_KEYS.WORDS, "hide-words", $("#btn-words"));
  bindDisplaySwitch(Storage.PREF_KEYS.SHOWCHARS, "hide-history-chars", $("#btn-history-chars"));

  // 朗读总开关（状态持久化；静音时同时停止音效与语音）
  function refreshSoundBtn() {
    $("#btn-sound").textContent = Speaker.isEnabled() ? "🔊" : "🔇";
  }
  $("#btn-sound").addEventListener("click", () => {
    Speaker.setEnabled(!Speaker.isEnabled());
    refreshSoundBtn();
  });
  refreshSoundBtn();
  // 重读本题
  $("#btn-read").addEventListener("click", () => {
    if (session.current) Speaker.readQuestion(session.current.target);
  });
  // 帮帮我：亮出正确答案（本题不计分）
  $("#btn-help").addEventListener("click", useHelp);
  // 跳过：不记录对错、不得星，仅推进题号进度（幂等，不重复计数）
  $("#btn-skip").addEventListener("click", () => {
    clearTimeout(session.timer);
    Speaker.stop();
    const q = session.current;
    if (q) markDone(q);
    nextQuestion();
  });
  // 点击小朋友的名字，进入该小朋友的选册页
  $("#user-list").addEventListener("click", (e) => {
    const card = e.target.closest(".user-card");
    if (!card) return;
    const user = Storage.users().find((u) => u.id === card.dataset.id);
    if (!user) return;
    Storage.setCurrent(user.id);
    renderVolumes(user);
  });
  // 选择某一册，开始练习；点右侧图标则先查看该册汉字表
  $("#volume-list").addEventListener("click", (e) => {
    const card = e.target.closest(".volume-card");
    if (!card) return;
    const volume = window.VOLUMES.find((v) => String(v.id) === card.dataset.id);
    if (!volume) return;
    if (e.target.closest(".volume-icon")) {
      renderVolumeWords(volume);
      return;
    }
    startSession(Storage.currentUser(), volume);
  });
  // 汉字表：点小喇叭播放读音与组词，点整行进入通用单字详情页
  $("#word-list").addEventListener("click", (e) => {
    const row = e.target.closest(".word-item");
    if (!row) return;
    const entry = volumeWordVolume && volumeWordVolume.entries[Number(row.dataset.idx)];
    if (!entry) return;
    if (e.target.closest(".word-play")) {
      Speaker.readEntry(entry);
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
  // 后台：新增完成后若仍在后台页则刷新列表，否则回首页
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
  $("#btn-quit").addEventListener("click", () => {
    if (!confirm("要结束这组练习吗？")) return;
    clearTimeout(session.timer);
    Speaker.stop();
    backToVolumes();
  });
  // 历史记录从"选册页"进入，返回时回到该小朋友的选册页
  $("#btn-history-back").addEventListener("click", backToVolumes);
  // 练习记录里的汉字：点击进入通用单字详情页，返回时回到记录页
  $("#history-list").addEventListener("click", (e) => {
    const el = e.target.closest(".hchar");
    if (!el) return;
    const entry = historyEntries[Number(el.dataset.idx)];
    if (entry) openCharCard(entry, { onBack: renderHistory });
  });
  // 单字详情页：读音 + 组词
  $("#btn-card-read").addEventListener("click", () => {
    if (cardEntry) Speaker.readEntry(cardEntry);
  });
  $("#btn-card-back").addEventListener("click", () => {
    if (cardOnBack) cardOnBack();
  });
  // 清除当前小朋友的进度与历史（二次确认），清空后停留在本页
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
    startSession(user, volume);
  });
  // 后台入口（首页左下角小齿轮）
  $("#btn-admin").addEventListener("click", renderAdmin);
  $("#btn-admin-add").addEventListener("click", openUserDialog);
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
})();
