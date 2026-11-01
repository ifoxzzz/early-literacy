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
  // 优先级：1) 到期复习字（过期越久越靠前） 2) 新字（按字表顺序） 3) 已学未到期字（按薄弱权重）
  pickTargets(count, entries) {
    const all = entries || [];
    const progress = Storage.loadAll();
    const now = Date.now();
    const recordOf = (e) => progress[this.keyOf(e)];

    // 1. 到期复习：按 nextReview 升序，先复习拖得最久的字
    const due = all
      .filter((e) => recordOf(e) && recordOf(e).nextReview <= now)
      .sort((a, b) => recordOf(a).nextReview - recordOf(b).nextReview);
    // 2. 新字：从未学过（没有任何进度记录）
    const fresh = all.filter((e) => !recordOf(e));
    // 3. 已学但还没到复习时间的字，作为兜底池
    const weak = all.filter((e) => recordOf(e) && recordOf(e).nextReview > now);

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

    while (targets.length < count) {
      let t = due.length ? take(due) : null;
      if (!t && fresh.length) t = take(fresh);
      if (!t) {
        // 兜底：按薄弱权重随机，权重见 Memory.weakWeight
        const pool = weak.filter((e) => !used.has(e.char));
        if (pool.length) {
          const pick = this.weightedPick(pool, (e) => Memory.weakWeight(recordOf(e)));
          weak.splice(weak.indexOf(pick), 1);
          used.add(pick.char);
          t = pick;
        }
      }
      if (!t) break; // 本册字数不足，能出几题出几题
      targets.push(t);
    }
    return targets;
  },

  // 为目标字配干扰项并随机排布
  // optionCount 是卡片总数（2 / 3 / 4 / 6 / 8 / 9），故干扰项数量为 optionCount - 1（至少 1 个）
  buildOptions(target, entries, optionCount) {
    const want = Math.max(1, (optionCount || 4) - 1);
    const others = [];
    const seen = new Set([target.char]); // 同字不同音也只保留一张卡片
    for (const e of this.shuffle(entries || [])) {
      if (seen.has(e.char)) continue;
      seen.add(e.char);
      others.push(e);
      if (others.length >= want) break;
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
};
