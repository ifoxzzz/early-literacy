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
    admin: $("#view-admin"),
    history: $("#view-history"),
    quiz: $("#view-quiz"),
    result: $("#view-result"),
  };

  // 本次练习状态
  const session = {
    queue: [], // 待出题队列（答错的题会重排到队尾）
    total: 0, // 初始题数（不含重练）
    done: 0, // 已完成的初始题数（无论对错）
    stars: 0,
    firstTryCorrect: 0,
    newLearned: [], // 本次新学且答对过的字
    answers: [], // 本组每个字的首次作答结果 [{ c, ok }]
    firstQuestion: false, // 本组第一题（播放欢迎语）
    userName: "", // 当前小朋友名字（用于语音问候）
    volume: "", // 当前学习的是哪一册
    entries: [], // 当前册的字表（重练时配干扰项用）
    current: null,
  };

  function show(name) {
    Object.values(views).forEach((v) => v.classList.add("hidden"));
    views[name].classList.remove("hidden");
  }

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
        <span class="volume-meta">共 ${s.total} 字 · 已学 ${s.learned} · 待复习 ${s.due}</span>`;
      list.appendChild(card);
    });
    show("volumes");
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
    refreshSettings();
    show("admin");
  }

  // 练习设置：每题候选字数（4/6/8）、每组题数（5~20）
  function refreshSettings() {
    const opt = Storage.quizOptions();
    $("#set-options")
      .querySelectorAll("button")
      .forEach((b) => b.classList.toggle("active", Number(b.dataset.v) === opt));
    $("#set-count").value = Storage.quizCount();
  }

  /* ---------- 历史记录 ---------- */
  function renderHistory() {
    const user = Storage.currentUser();
    $("#history-owner").textContent = user ? `${user.name} 的练习记录` : "";
    const list = Storage.loadHistory().slice().reverse(); // 最近一次在最上面
    const box = $("#history-list");
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
          // 本组学过的字：绿色答对、红色答错
          const chars = (r.chars || [])
            .map((a) => `<span class="hchar ${a.ok ? "ok" : "no"}">${a.c}</span>`)
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
    // 后台配置：每题候选字数 / 每组题数
    const optionCount = Storage.quizOptions();
    const questions = Quiz.buildSession(Storage.quizCount(), volume.entries, optionCount);
    if (questions.length === 0) return;
    // 候选字为 6/8 时改为 3 列 / 4 列，卡片自动缩小，田字格仍居中
    views.quiz.classList.toggle("cols-3", optionCount === 6);
    views.quiz.classList.toggle("cols-4", optionCount === 8);
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
      entries: volume.entries,
      optionCount,
      current: null,
    });
    show("quiz");
    $("#quiz-user").textContent = `${session.userName} · ${volume.title}`;
    // 本组所有题目的单字、组词音频一次性预热，后面的题目不再临时等下网络
    Speaker.preloadSession(session.userName, questions.map((q) => q.target));
    nextQuestion();
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
    $("#btn-next").classList.add("hidden");

    const grid = $("#grid");
    grid.classList.remove("locked");
    grid.innerHTML = "";
    q.options.forEach((opt) => {
      const card = document.createElement("div");
      card.className = "card";
      card.dataset.key = Quiz.keyOf(opt); // 多音字：字同音不同是不同卡片
      card.dataset.char = opt.char;
      card.innerHTML = `<span class="pinyin">${opt.pinyin}</span><span class="char">${opt.char}</span>`;
      card.addEventListener("click", () => onPick(card, opt, q));
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

  // 首次作答计入本组进度（答错的题会排到队尾重练，重练不计分、不重复记录）
  function countFirstTry(q, ok) {
    if (q.retried) return false;
    q.counted = true;
    session.done += 1;
    session.answers.push({ c: q.target.char, ok });
    return true;
  }

  function onPick(card, opt, q) {
    if (q.locked) return;
    q.locked = true;
    $("#grid").classList.add("locked");
    Sound.play("pick");
    const targetKey = Quiz.keyOf(q.target);
    const isCorrect = Quiz.keyOf(opt) === targetKey;

    if (isCorrect) {
      card.classList.add("correct");
      // 答对后其余卡片变淡且不可再点击，突出正确选项
      $("#grid")
        .querySelectorAll(".card")
        .forEach((c) => {
          if (c !== card) c.classList.add("dimmed");
        });
      popStar(card);
      Sound.play("correct");
      // 夸奖语音播完再进入下一题，避免被切断
      setTimeout(() => {
        if (session.current !== q) return;
        Speaker.correct(() => {
          if (session.current !== q) return;
          session.timer = setTimeout(nextQuestion, 600);
        }, session.userName);
      }, 400);
      Storage.recordAnswer(targetKey, true);
      if (countFirstTry(q, true)) {
        session.stars += 1;
        session.firstTryCorrect += 1;
        if (isNewChar(targetKey)) session.newLearned.push(q.target.char);
      }
      $("#quiz-stars").textContent = `⭐ ${session.stars}`;
    } else {
      card.classList.add("wrong");
      Sound.play("wrong");
      setTimeout(() => Speaker.wrong(q.target, session.userName), 400);
      Storage.recordAnswer(targetKey, false);
      // 高亮正确答案，其余卡片变淡；停留让家长讲解，点“继续”进入下一题
      document.querySelectorAll(".card").forEach((c) => {
        if (c.dataset.key === targetKey) c.classList.add("reveal");
        else c.classList.add("dimmed");
      });
      if (countFirstTry(q, false)) {
        // 首次答错：本组尾部重练一次（不再影响计分）
        session.queue.push({
          target: q.target,
          options: Quiz.buildOptions(q.target, session.entries, session.optionCount),
          retried: true,
        });
      }
      $("#btn-next").classList.remove("hidden");
    }
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
  // 跳过：不记录对错、不得星，仅推进题号进度（幂等，不重复计数）
  $("#btn-skip").addEventListener("click", () => {
    clearTimeout(session.timer);
    Speaker.stop();
    const q = session.current;
    if (q && !q.counted) {
      q.counted = true;
      session.done += 1;
    }
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
  // 选择某一册，开始练习
  $("#volume-list").addEventListener("click", (e) => {
    const card = e.target.closest(".volume-card");
    if (!card) return;
    const volume = window.VOLUMES.find((v) => String(v.id) === card.dataset.id);
    if (!volume) return;
    startSession(Storage.currentUser(), volume);
  });
  $("#btn-volume-back").addEventListener("click", renderHome);

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

  // 后台练习设置：候选字数、每组题数（改动后下一组练习生效）
  $("#set-options").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-v]");
    if (!btn) return;
    Storage.setQuizOptions(btn.dataset.v);
    refreshSettings();
  });
  $("#set-count").addEventListener("change", () => {
    $("#set-count").value = Storage.setQuizCount($("#set-count").value);
  });

  $("#btn-history").addEventListener("click", renderHistory);
  // 结束本组练习（已作答的记录保留），回到该小朋友的册目选择页
  $("#btn-quit").addEventListener("click", () => {
    if (!confirm("要结束这组练习吗？")) return;
    clearTimeout(session.timer);
    Speaker.stop();
    const user = Storage.users().find((u) => u.id === session.userId) || Storage.currentUser();
    if (user) renderVolumes(user);
    else renderHome();
  });
  // 历史记录从"选册页"进入，返回时回到该小朋友的选册页
  $("#btn-history-back").addEventListener("click", () => {
    const user = Storage.currentUser();
    if (user) renderVolumes(user);
    else renderHome();
  });
  // 清除当前小朋友的进度与历史（二次确认），清空后停留在本页
  $("#btn-reset").addEventListener("click", () => {
    if (confirm("确定要清除这位小朋友的所有练习记录吗？此操作不可恢复。")) {
      Storage.clearUserData();
      renderHistory();
    }
  });
  // 结束页“返回”：回到该小朋友的册目选择页
  $("#btn-again").addEventListener("click", () => {
    const user = Storage.users().find((u) => u.id === session.userId) || Storage.currentUser();
    if (user) renderVolumes(user);
    else renderHome();
  });
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
  $("#btn-next").addEventListener("click", nextQuestion);

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

  Storage.init();
  renderHome();
})();
