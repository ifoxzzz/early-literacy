// 统一资源加载与缓存管理：
//   - 资源缓存标记（音频/字体/笔顺/图片共用）
//   - 内容哈希查找（data/asset-manifest.js）
//   - 通用下载队列 + blob 缓存（音频、字体、未来图片都走这条管线）
//   - 楷体字体按需加载
//   - 清理资源缓存
// Speaker 只管音频播放，预下载与 blob 解析全部委托给 Resource。
const Resource = {
  EPOCH_KEY: "early-literacy-resource-cache", // 与 index.html 顶部保持一致

  // 发布后资源需要联网下载，第一次使用时边下边播容易卡顿/没声音。
  // 这里提前 fetch 成 blob 存在内存里，使用时直接用本地 blob 地址。
  // file:// 下 fetch 会被浏览器拦截，失败时自动退回原始地址，不影响离线使用。
  cache: new Map(), // 原始地址 -> { promise, request, blobUrl, resolve }
  // 下载队列：手机浏览器每个域名只允许 6 个并发连接，一次性发起几十个请求会让
  // 后面的请求长时间排队——而超时是从请求"真正开始"才算，否则排队的资源会
  // 在没下载前就超时。这里限制并发数。
  MAX_PARALLEL: 4,
  jobs: [], // 待下载队列 [{ url, entry }]
  running: 0, // 当前正在下载的数量

  // ---------- 资源缓存标记 ----------
  epoch() {
    const key = window.RESOURCE_EPOCH_KEY || this.EPOCH_KEY;
    try {
      return localStorage.getItem(key) || "";
    } catch (e) {
      return "";
    }
  },

  // 给资源地址追加资源缓存标记（若有），清理后让客户端重新下载
  url(rawUrl) {
    const epoch = this.epoch();
    if (!epoch) return rawUrl;
    return rawUrl + (rawUrl.includes("?") ? "&" : "?") + "c=" + epoch;
  },

  // 读取资源内容哈希（data/asset-manifest.js）；清单里查不到返回 ""
  hash(rel) {
    return (window.ASSET_HASH || {})[rel] || "";
  },

  // ---------- 通用下载队列 ----------
  // 批量预加载并按"已完成资源数"回调进度；失败/超时的资源也计入完成，
  // 保证加载界面不会一直卡住。返回 Promise，全部就绪后 resolve。
  // 任意类型资源（音频/字体/图片）都可传入，进度条统一统计。
  preload(urls, onProgress) {
    const list = [...new Set((urls || []).filter(Boolean))];
    let done = 0;
    if (onProgress) onProgress(0, list.length);
    return Promise.all(
      list.map((url) => {
        this._enqueue(url);
        return this.cache.get(url).promise.then(() => {
          done += 1;
          if (onProgress) onProgress(done, list.length);
        });
      })
    );
  },

  // 单资源入队（已在缓存中的跳过）；先把 promise 建好再排队等下载
  _enqueue(url) {
    if (!url || this.cache.has(url)) return;
    const entry = { blobUrl: null, promise: null, request: null };
    entry.promise = new Promise((resolve) => {
      entry.resolve = resolve;
    });
    this.cache.set(url, entry);
    this.jobs.push({ url, entry });
    this.pump();
  },

  // 按并发上限依次启动下载任务
  pump() {
    while (this.running < this.MAX_PARALLEL && this.jobs.length > 0) {
      const job = this.jobs.shift();
      this.running += 1;
      this.download(job.url, job.entry).then(() => {
        this.running -= 1;
        this.pump();
      });
    }
  },

  // 带缓存的 fetch：浏览器 HTTP 缓存里已有该文件（无论是否过期）就直接取本地副本，
  // 没有才发起网络请求。内存里的 blob 缓存只活一个页面会话。
  // 资源地址自带内容哈希（?h=）与清理标记，文件改动时 URL 才变化，旧缓存自然失效。
  fetchCached(url) {
    try {
      return fetch(url, { cache: "force-cache" });
    } catch (e) {
      return fetch(url); // 个别老浏览器不认识 cache 选项会同步抛错，退回普通请求
    }
  },

  // 实际下载：超时从此刻开始计（而不是入队时），保证排队的资源不会"还没开始就超时"。
  // 超时后请求仍在后台继续，晚到的资源照样换成 blob，之后使用直接取本地地址
  download(url, entry) {
    const request =
      typeof fetch === "function"
        ? this.fetchCached(url)
            .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(r.status))))
            .then((blob) => {
              entry.blobUrl = URL.createObjectURL(blob);
              return entry.blobUrl;
            })
            .catch(() => url)
        : Promise.resolve(url);
    entry.request = request;
    const timeout = new Promise((resolve) => setTimeout(() => resolve(url), 8000));
    return Promise.race([request, timeout]).then((src) => {
      entry.resolve(src);
      return src;
    });
  },

  // 同步取已缓存的 blob 地址；未缓存或下载未完成返回 null
  getBlobUrl(url) {
    const entry = this.cache.get(url);
    return entry ? entry.blobUrl : null;
  },

  // 播放/使用前取地址：已下载的直接用 blob；还在下载就等一小会儿（最多 600ms），
  // 拿不到就先播原始地址，避免两句语音之间出现长时间空白
  resolveSrc(url) {
    const entry = this.cache.get(url);
    if (!entry) return Promise.resolve(url);
    if (entry.blobUrl) return Promise.resolve(entry.blobUrl);
    const wait = entry.request || entry.promise;
    const fallback = new Promise((resolve) =>
      setTimeout(() => resolve(entry.blobUrl || url), 600)
    );
    return Promise.race([wait, fallback]);
  },

  // 释放内存中的 blob 副本（清理资源缓存时调用）
  clearBlobs() {
    this.cache.forEach((entry) => {
      if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
    });
    this.cache.clear();
    this.jobs.length = 0; // 排队中的任务一并作废
  },

  // ---------- 字体 ----------
  // 内置楷体（Kaiti Web）地址：内容哈希 + 资源缓存标记
  fontUrl() {
    const ver = this.hash("fonts/kaiti.woff2") || (window.APP_VERSION || "1");
    return this.url(`assets/fonts/kaiti.woff2?h=${ver}`);
  },

  // 楷体按需加载：走通用下载队列，再用 blob 地址装 FontFace。
  // 不在首页加载，由 preloadGlobal 与音频一并预载；单独调用时也能自洽。
  // 不支持 FontFace 或超时（8s）都不阻塞，CSS 回退到系统楷体。memoized。
  _kaitiPromise: null,
  loadKaitiFont() {
    if (this._kaitiPromise) return this._kaitiPromise;
    const url = this.fontUrl();
    this._kaitiPromise =
      typeof FontFace !== "undefined"
        ? this.preload([url]).then(() => {
            const blobUrl = this.getBlobUrl(url) || url;
            const face = new FontFace("Kaiti Web", `url("${blobUrl}") format("woff2")`);
            face.display = "swap";
            return Promise.race([
              face.load().then((f) => document.fonts.add(f)),
              new Promise((resolve) => setTimeout(resolve, 8000)),
            ]);
          })
        : Promise.resolve();
    return this._kaitiPromise;
  },

  // ---------- 清理资源缓存 ----------
  // 停止播放、释放内存 blob，并更换资源标记。
  // 之后所有资源 URL 都会带上新标记，客户端重新下载最新资源
  // （已加载进当前页面的字体、笔顺数据需要刷新后才会重新请求）
  clearCache() {
    if (typeof Speaker !== "undefined" && typeof Speaker.stop === "function") {
      Speaker.stop();
    }
    this.clearBlobs();
    const key = window.RESOURCE_EPOCH_KEY || this.EPOCH_KEY;
    try {
      localStorage.setItem(key, Date.now().toString(36));
    } catch (e) {}
  },
};
