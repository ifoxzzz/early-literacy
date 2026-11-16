// 出题逻辑：选目标字（到期复习 > 新字 > 薄弱权重兜底）+ 配干扰项 + 组卷
// 约定：一个字以「汉字|拼音」为唯一标识，多音字的不同读音视为不同条目
const Quiz = {
  // 条目唯一键（与进度记录、卡片 dataset 保持一致）
  keyOf(entry) {
    return `${entry.char}|${entry.pinyin}`;
  },

  // Fisher-Yates 洗牌，返回新数组，不修改入参
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  // 按权重随机抽取：权重越大的元素越容易被选中
  weightedPick(items, weightFn) {
    const total = items.reduce((sum, it) => sum + weightFn(it), 0);
    let r = Math.random() * total;
    for (const it of items) {
      r -= weightFn(it);
      if (r <= 0) return it;
    }
    return items[items.length - 1];
  },

  // 从本册候选中选 count 个目标字，同一组内不重复出同一个汉字（多音字只取一条）
  // 每日生字上限：今天第一次学的汉字数达到上限后，本组不再引入新字，只出已学过的字
  // 未达上限时的顺序由「每日出题顺序」设置决定：
  //   复习优先（默认）：到期复习字 > 新字 > 已学未到期字（薄弱权重）
  //   生字优先：新字 > 到期复习字 > 已学未到期字（薄弱权重）
  // 达到上限后两种设置一致：今天学过的字 > 到期复习字 > 其余已学字（薄弱权重）
  pickTargets(count, entries) {
    const all = entries || [];
    const progress = Storage.loadAll();
    const now = Date.now();
    const recordOf = (e) => progress[this.keyOf(e)];

    // 今天学过的汉字（按字去重）与本次最多还能引入的新字数量
    const todayChars = Storage.todayLearnedChars(progress);
    const limit = Storage.dailyNewLimit();
    let freshQuota = Math.max(0, limit - todayChars.size);
    const newFirst = Storage.quizOrder() === "new";

    // 1. 到期复习：按 nextReview 升序，先复习拖得最久的字
    const due = all
      .filter((e) => recordOf(e) && recordOf(e).nextReview <= now)
      .sort((a, b) => recordOf(a).nextReview - recordOf(b).nextReview);
    // 2. 新字：从未学过（没有任何进度记录）
    const fresh = all.filter((e) => !recordOf(e));
    // 3. 已学但还没到复习时间的字，作为兜底池
    const weak = all.filter((e) => recordOf(e) && recordOf(e).nextReview > now);
    // 4. 今天学过的字：达到上限后优先出这些字
    const today = all.filter((e) => recordOf(e) && todayChars.has(e.char));

    const used = new Set(); // 已出过的汉字（按字去重）
    const targets = [];
    // 依次从队列里取一个未用过的字；队列空了返回 null
    const take = (arr) => {
      while (arr.length) {
        const e = arr.shift();
        if (!used.has(e.char)) {
          used.add(e.char);
          return e;
        }
      }
      return null;
    };
    // 兜底：按薄弱权重随机，权重见 Memory.weakWeight
    const pickWeak = () => {
      const pool = weak.filter((e) => !used.has(e.char));
      if (!pool.length) return null;
      const pick = this.weightedPick(pool, (e) => Memory.weakWeight(recordOf(e)));
      weak.splice(weak.indexOf(pick), 1);
      used.add(pick.char);
      return pick;
    };

    while (targets.length < count) {
      let t = null;
      if (freshQuota > 0) {
        if (newFirst) {
          // 生字优先：新字 > 到期复习 > 已学兜底
          if (fresh.length) {
            t = take(fresh);
            if (t) freshQuota -= 1;
          }
          if (!t && due.length) t = take(due);
          if (!t) t = pickWeak();
        } else {
          // 复习优先：到期复习 > 新字 > 已学兜底
          if (due.length) t = take(due);
          if (!t && fresh.length) {
            t = take(fresh);
            if (t) freshQuota -= 1;
          }
          if (!t) t = pickWeak();
        }
      } else {
        // 已达每日上限：今天学过的字 > 到期复习 > 已学兜底
        if (today.length) t = take(today);
        if (!t && due.length) t = take(due);
        if (!t) t = pickWeak();
        // 本册一个已学字都没有时退回新字，避免开不了练习
        if (!t && fresh.length) t = take(fresh);
      }
      if (!t) break; // 本册字数不足，能出几题出几题
      targets.push(t);
    }
    return targets;
  },

  // 为目标字配干扰项并随机排布
  // optionCount 是卡片总数（2 / 3 / 4 / 6 / 8 / 9），故干扰项数量为 optionCount - 1（至少 1 个）
  // 分配策略：
  //   1) 没有已学过的字 → 干扰项全用生字；
  //   2) 有已学过的字 → 学过的字与生字各占一半（奇数个时学过的字多一个）
  //      原因：避免孩子在复习时只找见过的字或是学新字时只找没见过的字来蒙答案
  buildOptions(target, entries, optionCount) {
    const want = Math.max(1, (optionCount || 4) - 1);
    const progress = Storage.loadAll();
    const isLearned = (e) => !!progress[this.keyOf(e)];

    // 候选池：排除目标字本身（同字不同音也只保留一张卡片）
    const candidates = (entries || []).filter((e) => e.char !== target.char);
    const learned = candidates.filter(isLearned); // 已学过的字
    const fresh = candidates.filter((e) => !isLearned(e)); // 生字

    const others = [];
    const seenChars = new Set();
    // 从 pool 中抽取，直到 others 数量达到 target（或 pool 耗尽）
    const pickFrom = (pool, target) => {
      for (const e of this.shuffle(pool)) {
        if (seenChars.has(e.char)) continue;
        seenChars.add(e.char);
        others.push(e);
        if (others.length >= target) return;
      }
    };

    if (learned.length === 0) {
      // 没有已学过的字，干扰项全用生字
      pickFrom(fresh, want);
    } else {
      // 有已学过的字：学过的字与生字各占一半
      const learnedCount = Math.ceil(want / 2);
      pickFrom(learned, learnedCount);
      if (others.length < want) pickFrom(fresh, want);
      // 生字不够时，用剩余的已学字补满（反之已学不够时上面已由生字补齐）
      if (others.length < want) pickFrom(learned, want);
    }

    return this.shuffle([target, ...others]);
  },

  // 组卷：返回本次练习的题目队列 [{ target, options }]
  buildSession(count, entries, optionCount) {
    return this.pickTargets(count, entries).map((target) => ({
      target,
      options: this.buildOptions(target, entries, optionCount),
    }));
  },

  // 写字页：挑出推荐练习的字（占满推荐区两行），其余作为「其他汉字」
  // - 同一册里的多音字只保留一张田字格（临摹的是字形，按汉字去重）
  // - 临摹次数达到「推荐换字阈值」的字不再进入推荐区，下放到「其他汉字」
  // - 推荐区先取 level="书写" 的字，不够再用 level="认识" 的字补齐，组内保持字库顺序
  // - 「其他汉字」= 有临摹次数的字（次数降序）+ 未临摹的书写字 + 未临摹的认识字
  // - scope="write" 时整页只使用要求书写的字
  pickWriting(entries, counts, limit, scope, recommendCount) {
    const max = Math.max(1, limit || 10);
    const want = Math.max(1, recommendCount || 10);
    const seen = new Set();
    const pool = [];
    (entries || []).forEach((e) => {
      if (!e || seen.has(e.char)) return;
      seen.add(e.char);
      pool.push(e);
    });
    const list = scope === "write" ? pool.filter((e) => e.level === "书写") : pool;
    const countOf = (e) => {
      const n = counts && counts[e.char];
      return Number.isInteger(n) && n > 0 ? n : 0;
    };
    const isWriting = (e) => e.level === "书写";
    // 练够阈值的字退出推荐区，交给「其他汉字」
    const eligible = (e) => countOf(e) < max;
    // 推荐区：书写字优先，书写字不够时用认识字补齐，组内保持字库顺序
    const recommend = [
      ...list.filter((e) => isWriting(e) && eligible(e)),
      ...list.filter((e) => !isWriting(e) && eligible(e)),
    ].slice(0, want);
    const picked = new Set(recommend.map((e) => e.char));
    const rest = list.filter((e) => !picked.has(e.char));
    // Array.prototype.sort 在现代浏览器是稳定排序，同次数的字自然保持字库顺序
    const practiced = rest
      .filter((e) => countOf(e) > 0)
      .sort((a, b) => countOf(b) - countOf(a));
    const others = [
      ...practiced,
      ...rest.filter((e) => countOf(e) === 0 && isWriting(e)),
      ...rest.filter((e) => countOf(e) === 0 && !isWriting(e)),
    ];
    return { recommend, others };
  },
};
