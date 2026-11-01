# 儿童识字练习软件 — 设计方案

## 1. 目标与约束

| 项目 | 说明 |
|---|---|
| 目标用户 | 5 岁左右儿童操作，家长负责读提示、讲解 |
| 核心玩法 | 田字格中显示 2/3/4/6/8/9 个汉字，孩子按提示点选目标字 |
| 记忆机制 | 按遗忘曲线安排复习，按错误次数与掌握程度编排后续练习 |
| 运行方式 | 纯静态页面：双击 `index.html` 离线运行，或把整个目录部署到任意静态服务器；无需构建与后端 |
| 数据存储 | 浏览器 localStorage，按小朋友隔离（按域名隔离，不跨设备同步） |
| 技术约束 | 原生 HTML/CSS/JS；不能用 `fetch` 加载字库/音频清单（`file://` 会被拦截），改用 `<script>` 全局变量；部署到服务器时可用 `fetch` 做音频预下载 |

**关键决策**：字库与音频清单都用 `<script>` 引入全局变量（`window.VOLUMES`、`window.SYLLABLE_AUDIO` 等），从而在 `file://` 与 `http(s)://` 下都能正常工作；家长只需编辑 `tools/data/volume-*.txt` 再运行生成脚本。同一套代码不做任何环境分支，`fetch` 预下载失败时自动退回原始音频地址。

---

## 2. 总体架构

```
┌─────────────────────────────────────────────────────┐
│ 表示层  index.html + css/style.css                  │
│ 9 个视图：home / volumes / volumeWords / settings   │
│           / quiz / result / history / card / admin  │
│           .hidden 切换                              │
└───────────────▲─────────────────────────────────────┘
                │ DOM 事件、class 切换
┌───────────────┴─────────────────────────────────────┐
│ 应用层  js/app.js                                   │
│ 视图渲染、练习会话（session）、答题判定、事件绑定     │
└───────┬───────────────┬───────────────┬─────────────┘
        │               │               │
┌───────▼──────┐ ┌──────▼───────┐ ┌─────▼────────────┐
│ 领域层        │ │ 数据层        │ │ 媒体层           │
│ quiz.js      │ │ storage.js   │ │ speaker.js       │
│ memory.js    │ │ localStorage │ │ sound.js         │
│ 选字/组卷/曲线 │ │ 用户/进度/历史│ │ 真人语音/音效     │
└──────────────┘ └──────────────┘ └──────────────────┘
        │
┌───────▼─────────────────────────────────────────────┐
│ 资源层  data/volumes.js（字库）                      │
│        assets/audio/**（预生成语音 + 清单 index.js） │
└─────────────────────────────────────────────────────┘
```

模块职责：

| 文件 | 职责 |
|---|---|
| `app.js` | 视图切换、会话状态、答题流程、设置/后台/历史/弹窗交互、事件绑定 |
| `quiz.js` | 目标字选择、干扰项生成、组卷 |
| `memory.js` | 复习间隔表、最大等级、薄弱权重 |
| `storage.js` | localStorage 统一读写、用户隔离、设置项 |
| `speaker.js` | 拼音键推导、音频路径定位、队列播放与打断、系统语音兜底 |
| `sound.js` | Web Audio 实时合成悬停/选中/答对/答错音效 |
| `data/volumes.js` | 自动生成的字库（册 → 条目） |
| `assets/audio/*/index.js` | 自动生成的音频清单，供前端判断文件是否存在 |

---

## 3. 数据模型

### 3.1 字库 `data/volumes.js`

```js
window.VOLUMES = [
  {
    id: "1",
    title: "一年级上册",
    entries: [
      { char: "天", pinyin: "tiān", words: "天空、白天" },
      // ...
    ],
  },
];
```

- 由 `tools/scripts/build_volumes.py` 从 `tools/data/volume-*.txt` 生成；按「汉字|拼音」**跨册去重**，同一组汉字+拼音只保留册号最小的一次出现（多音字同字不同音仍各算一条）。
- 当前字库：4 册，825 条字音（跨册去重后，多音字按读音分条）。
- 条目唯一键：`char + "|" + pinyin`（`Quiz.keyOf`），同一汉字不同读音是两条独立记录。

### 3.2 学习进度 `early-literacy-progress:{userId}`

```json
{
  "天|tiān": {
    "level": 3,
    "correct": 6,
    "wrong": 1,
    "lastReview": 1761724800000,
    "nextReview": 1762070400000
  }
}
```

| 字段 | 含义 |
|---|---|
| `level` | 记忆等级 0~6，0 表示新字或刚答错 |
| `correct` / `wrong` | 累计答对/答错次数（薄弱权重依据） |
| `lastReview` | 最近一次作答时间 |
| `nextReview` | 下次应复习时间戳，出题调度的核心依据 |

### 3.3 历史记录 `early-literacy-history:{userId}`

```json
{
  "stars": 8,
  "total": 10,
  "correct": 8,
  "chars": [
    { "c": "天", "pinyin": "tiān", "words": "天空、白天、天气", "ok": true },
    { "c": "地", "pinyin": "de", "words": "轻轻地、开心地", "ok": false }
  ],
  "volume": "一年级上册",
  "date": 1761728400000
}
```

每个用户最多保留最近 50 组（`Storage.HISTORY_MAX`）。`chars` 同时保存拼音与组词，点击汉字时可立即展示详情；旧记录只有 `c` / `ok`，渲染时按字库中该字首次出现的条目补齐拼音与组词。

### 3.4 用户与设置

| 键 | 内容 |
|---|---|
| `early-literacy-users` | `[{ id, name }]`，id 为时间戳 36 进制 + 随机串 |
| `early-literacy-current` | 当前用户 id |
| `early-literacy-quiz-options:{id}` | 该小朋友的每题候选字数 2 / 3 / 4 / 6 / 8 / 9 |
| `early-literacy-quiz-count:{id}` | 该小朋友的每组题数 5 ~ 20 |
| `early-literacy-sound` | 朗读总开关 |
| `early-literacy-pinyin` / `-words` / `-showchars` | 三个显示开关 |

显示开关统一约定：值为 `"0"` 表示关闭，其余（含未设置）视为开启（`Storage.pref`）。
练习设置未保存时使用默认值：每题 4 个候选字、每组 10 题（由 `Storage.quizOptions` / `quizCount` 内置回落）。

---

## 4. 核心算法

### 4.1 遗忘曲线（`js/memory.js`）

```js
INTERVALS = [10分钟, 1小时, 1天, 2天, 4天, 7天, 15天];
MAX_LEVEL = 6;
```

- **答对**：`level = min(level + 1, 6)`，`nextReview = now + INTERVALS[level]`
- **答错**：`level = 0`，`nextReview = now + INTERVALS[0]`（10 分钟后重现）
- **薄弱权重**：`1 + wrong × 2 + max(0, 5 - level)`，错得越多、等级越低越容易被抽中

### 4.2 选目标字（`Quiz.pickTargets`）

从当前册的条目中选 `count` 个题目标，**同一组内不重复出同一个汉字**（多音字只取一条），优先级：

1. **到期复习字**：`nextReview <= now`，按 `nextReview` 升序（拖得越久越先复习）
2. **新字**：没有任何进度记录，按字表顺序
3. **已学未到期字**：按薄弱权重随机，保证练熟的字也会偶尔出现
4. 字数不足时，能出几题出几题

### 4.3 干扰项（`Quiz.buildOptions`）

- `optionCount` 为卡片总数（2/3/4/6/8/9），干扰项数量为 `optionCount - 1`（至少 1 个）。
- 从本册条目中随机取，**按汉字去重**（含目标字本身），保证不会出现两张同字卡片。
- 目标字与干扰项混合后再洗牌，位置随机。

### 4.4 组卷（`Quiz.buildSession`）

```js
[{ target, options }, ...]
```

### 4.5 答题与计分（`app.js`）

- **选错**：只有点错的这张卡片加 `wrong`（左右晃动 0.4 秒，`pointer-events: none`），随后加 `dimmed` 变成淡红色；整组不锁定，孩子可以继续点其他卡片。每次选错都执行 `Storage.recordAnswer(target, false)`，累计 `wrong` 并提高该字的薄弱权重；不播放「正确答案是……」语音，避免提前泄露答案，只播答错音效。
- **选对**：无论之前是否选错，都锁定整组、其余卡片加 `dimmed`（灰色 0.32），正确卡片变绿并冒出一颗星星、播放夸奖语音，语音结束后自动进入下一题。之前选错的卡片保留 `.wrong.dimmed`（淡红 0.65），与未选过的灰色卡片明显区分。
- **计分**：只有本题没有出现过选错（`q.wrongPicks == 0`）才加星、`firstTryCorrect +1` 并记录 `recordAnswer(target, true)`；有过选错时只做视觉/语音反馈，不加星，也不改写已经记下的错误。
- **进度**：题目在选中正确卡片时才算完成，`q.counted` 保证 `done` 与 `answers` 只记录一次；历史记录按首答结果记为对/错。
- **烟花特效**：首答正确（`q.wrongPicks == 0`）时调用 `playFireworks(origin)`，`origin` 取自本次点击事件的 `clientX / clientY`（键盘触发坐标为 0 时退回卡片中心）；在 `#fx-canvas`（`position: fixed; inset: 0; pointer-events: none`）上以 `requestAnimationFrame` 播放：从该点连放 3 朵（0 / 190 / 360ms），共约 120 个粒子，按屏幕像素密度缩放画布，粒子受重力与空气阻力影响、透明度随寿命衰减并带短拖尾；粒子耗尽后自动隐藏画布。`fwGeneration` 防止多次触发时两套动画互相清屏。
- **跳过**：不记录对错、不得星，只把题号推进（`q.counted` 保证不重复计数）。
- **结束**：练习页顶部「结束」按钮，二次确认后清理定时器与语音，回到该小朋友的册目选择页；已作答记录保留。

### 4.6 结束页

- 写入一条历史记录，逐颗渲染星星（带 `animation-delay` 依次弹出）。
- 显示正确率与本组新学会的字。
- 语音播报顺序：完成语（或名字专属）→ `starsN.mp3` → 鼓励语；`N` 限制在 0~20。

---

## 5. 语音方案（`js/speaker.js`）

### 5.1 拼音键

统一转成「无调字母 + 声调数字」：

- `kàn` → `kan4`；`nǚ` → `nv3`（`ü` → `v`）；无调号按轻声 `5`。

### 5.2 资源定位

| 场景 | 路径 |
|---|---|
| 单字发音 | `syllables/<拼音键>.mp3`，同音字共享 |
| 组词讲解 | `words/<汉字>_<拼音键>.mp3` |
| 名字专属提示 | `users/<名字>/welcome|praise1~3|done|cheer.mp3` |
| 通用提示 | `phrases/welcome|find|help|praise1~3|done|cheer.mp3` |
| 星星播报 | `phrases/stars0~20.mp3` |

`phraseFile(key, name)` 统一决定「名字专属语音」还是「通用提示语」。`wrong.mp3` 仍由生成脚本产出，但应用已不再播放：选错只播音效，避免语音提前说出答案。
文件是否存在由自动生成的清单（`SYLLABLE_AUDIO` / `WORD_AUDIO` / `USER_AUDIO`）判断，避免 404 请求。

所有音频地址带 `?v=<CACHE_VERSION>`，清单 `index.js` 也带同一版本参数，防止浏览器缓存旧语音或旧清单。重新生成音频后只需递增 `index.html` 的 `CACHE_VERSION`。

音节音频按拼音生成，「发音代表字」优先选非多音字（避免 TTS 单字朗读时选错读音，如 hái 用「孩」而不是「还」）；多音字黑名单维护在 `tools/scripts/gen_syllable_audio.py` 的 `POLYPHONES`。

组词讲解默认读成「天空的天，白天的天」。少量字放在「的」后单独出现时会被 TTS 误读（如「的还」读成 huán），处理方式是在 `tools/scripts/gen_words_audio.py` 的 `PRONOUNCE_ALIAS` 例外表中按拼音登记一个读音固定的同音字（如 `"hái": "孩"`），句尾改用该字后只能读出正确读音（「还有的孩，还是的孩」），听感仍是「还有的还，还是的还」。

### 5.3 播放队列与预下载

- **预下载**：`Speaker.preload(urls)` 用 `fetch` 把音频转成内存 blob（`URL.createObjectURL`），播放时优先用 blob 地址。发布到网站后首次播放不再边下边播，避免「第一题没声音、点再听一遍才响」。单个文件 8 秒内没下完则退回原始地址，不阻塞答题。
- **预热时机**：进入册目页时预下载提示语与 `stars0~20`；开始一组练习时一次性预下载本组所有题目的单字与组词音频（约十几到几十个小文件）。
- `file://` 下 `fetch` 会被浏览器拦截，自动退回原始地址，离线使用不受影响。
- `play(list, onDone)` 顺序播放；每个 `Audio` 的 `onended` / `onerror` 都推进到下一段，缺文件自动跳过。
- 全站复用同一个 `Audio` 元素（`Speaker.player`）：微信内置浏览器与 iOS WebView 禁止无手势自动播放，页面在首次点按/触摸时先用它播放 0.08 秒内联静音 wav 完成"解锁"（`Speaker.unlock`），之后程序自动 `play()` 才会出声；点击「再听一遍」能响正是因为它自带用户手势。iOS 的 `volume` 只读，所以用静音音频而不是调音量。
- `tokens` 为播放版本号：每次 `stop()` 自增，旧序列的回调发现版本变化后停止，实现「新语音立即打断旧语音」。
- 朗读关闭时直接执行 `onDone`，不影响答题节奏。
- 首题问候语：有名字真人语音则使用 `users/<名字>/welcome.mp3`；没有则直接退回 `phrases/welcome.mp3` 通用提示语，不再用系统合成音念名字。
- 单字发音缺失时，整句交给系统语音；系统语音统一由 `speak(text, { rate, onDone, guard })` 处理。
- 单字详情页由 `readEntry(entry)` 朗读：先读汉字发音（`syllables/`），再读组词讲解（`words/`）；没有单字音频时退回系统语音。

### 5.4 音效（`js/sound.js`）

Web Audio API 实时合成，无文件：

- 悬停：1175Hz 极短轻「嘀」（80ms 节流，避免快速划过多张卡片时连响）
- 选中：880Hz 短促「叮」
- 答对：C-E-G（523/659/784Hz）上行
- 答错：220Hz → 165Hz 温和低音下行

首个 `pointerdown` 会提前初始化 AudioContext，否则纯悬停不算用户手势，音效会被浏览器自动播放策略静音。音效与朗读共用总开关。

---

## 6. 界面与布局

### 6.1 视图

| 视图 | 内容 |
|---|---|
| `home` | 标题、字库统计、小朋友列表、创建按钮、左下角后台齿轮、右下角创作者信息 |
| `volumes` | 当前小朋友、各册统计卡片（卡片内部右侧 📖 图标）、历史记录 / 练习设置 / 退出 |
| `volumeWords` | 某一册的汉字表：小喇叭 + 汉字 + 拼音 + 组词的列表；点小喇叭朗读，点整行进入 `card` 详情页（返回时回到本表），返回选册页 |
| `settings` | 当前小朋友的练习设置（候选字 2/3/4/6/8/9、每组题数 5~20）、返回选册页 |
| `quiz` | 顶部进度/星星/开关按钮、田字格、再听一遍 / 帮帮我、底部提示条与用户名 |
| `result` | 星星、正确率、新学会的字、返回首页 |
| `history` | 时间、星星、对/错汉字、汉字开关、清除记录、返回 |
| `card` | 通用单字详情：田字格 + 拼音、上方「读一读」、下方组词、返回 |
| `admin` | 小朋友管理（新增/删除） |

切换统一由 `show(name)` 给所有视图加 `.hidden`，再移除目标视图的 `.hidden`。

**单字详情页（通用）**：由 `openCharCard(entry, { onBack })` 渲染，`entry = { char, pinyin, words }`。其他页面需要展示某个字时可直接复用：`onBack` 决定返回去向，不传则隐藏返回按钮。练习记录中的汉字点击后传入当前记录条目并回到记录页；新记录自带拼音与组词，旧记录按字库查找。

### 6.2 田字格（纯 CSS）

- 卡片：正方形，实线外框 `#d1603d`，`::before` / `::after` 画内部十字虚线。
- 界面文字使用系统字体（`"Microsoft YaHei", "PingFang SC", …, sans-serif`）；只有田字格里的汉字使用内置的 Windows 楷体（SimKai）子集：`"Kaiti Web", "Kaiti SC", "KaiTi", "STKaiti", "楷体", serif`，字号为卡片边长的 58%。`Kaiti Web` 对应 `assets/fonts/kaiti.woff2`（约 110KB，只抽取字库中的汉字），保证各设备田字格字形一致；字体地址同样带 `?v=CACHE_VERSION`。
- 拼音绝对定位在卡片顶部，不参与居中计算。

**严格居中方案**：练习页的 `.grid` 使用 `position: absolute; inset: 0`，并用 `align-content: center; justify-content: center` 让卡片整体在**视口中心**居中；顶部栏与底部提示条不参与该区域布局，因此不会把田字格挤偏。`.grid` 本身 `pointer-events: none`，只有卡片 `pointer-events: auto`，空白处不遮挡按钮。

**列数与尺寸**：`app.js` 的 `GRID_LAYOUT` 按候选字数量与横竖屏写入 `--cols` / `--rows`，横屏行数少、竖屏列数少：

| 候选字数 | 横屏（列×行） | 竖屏（列×行） | 单卡上限 |
|---|---|---|---|
| 2 | 2×1 | 1×2 | `min(40vmin, 220px)` |
| 3 | 3×1 | 1×3 | `min(30vmin, 190px)` |
| 4 | 2×2 | 2×2 | `min(34vmin, 220px)` |
| 6 | 3×2 | 2×3 | `min(26vmin, 190px)` |
| 8 | 4×2 | 2×4 | `min(21vmin, 150px)` |
| 9 | 3×3 | 3×3 | `min(24vmin, 160px)` |

实际卡片边长同时受可用宽度、可用高度（预留顶部栏、再听一遍与底部提示条）和上限约束，任一超限自动缩小；转屏时监听 `resize` 重新计算，练习中即时重排：

```css
--card-size: min(
  calc((100vw - 24px - (var(--cols) - 1) * var(--card-gap)) / var(--cols)),
  calc((100vh - 220px - (var(--rows) - 1) * var(--card-gap)) / var(--rows)),
  var(--card-cap)
);
```

**再听一遍 / 帮帮我**按钮绝对定位在整组田字格上方：

```css
bottom: calc(
  50% + (var(--rows) * var(--card-size) + (var(--rows) - 1) * var(--card-gap)) / 2 +
    clamp(9px, 3vh, 30px)
);
```

从视口中线向上累加「整组高度的一半 + 空隙」，行数变为 3、4 时也不会与卡片重叠。两个按钮放在同一个 `.read-bar` 里居中排列，窄屏时自动换行。

**帮帮我动画**：点击后 `useHelp()` 给 `.grid` 加 `helping`，正确卡片加 `help-target`、其余加 `help-fade`（`opacity: 0`），同时播放 `phrases/help.mp3`。为了避免动画被悬停样式覆盖，`.help-target:hover` 与 `.help-target` 共用同一组 `transform`；JS 先用 `getBoundingClientRect()` 强制提交初始状态，再把位移写成内联 `transform: translate(dx,dy) scale(1.5)`，让卡片从原位平滑移动到屏幕中心并放大。`help-target` 内还会插入一个 `.help-wave`（及其 `::after`），两圈绿色细框以 0.9 秒错开、`1 → 1.45` 由内向外扩散并淡出，形成持续的水波效果，提醒孩子看这里。本题随后按跳过处理：只有再点中正确卡片才 `nextQuestion()`，不计分、不写入进度；`nextQuestion` 会清掉 `helping` 与按钮的 `used` 状态。

**底部区域**：`.quiz-bottom { margin-top: auto }`，内部包含提示条与用户名；即使组词提示隐藏（`.hint-bar` 被 `:has` 规则收起），用户名仍贴在页面底部。

### 6.3 视觉反馈

- 答对：绿色描边 + 背景，卡片位置弹出 ⭐（`star-pop`，1s 动画后移除）。
- 选错：卡片左右抖动后变为淡红色（`.wrong.dimmed`），不可再点；选对：正确卡片变绿、冒星星，其余卡片变灰淡出。
- 结束页星星：`starIn` 逐个弹出。
- 无数字输入（除练习设置里的题数），全部为点按操作。
- 全局禁用右键菜单与文本选择，减少误触。

---

## 7. 练习会话状态机

```
首页
 └─ 点小朋友 → 选册页
      ├─ 历史记录 → 历史页 → 返回选册页
      ├─ 练习设置 → 设置页（读写该小朋友的候选字数 / 题数）→ 返回选册页
      └─ 点某册 → startSession
            ├─ 组卷 buildSession（题数 / 候选字数来自设置）
            └─ nextQuestion
                  ├─ 队列空 → renderResult（写历史、播报、返回首页）
                  └─ 取出题目
                        ├─ 选错 → 该卡片抖动后淡红禁用，继续本题（每次计入错误权重）
                        ├─ 选对 → 锁定 → 冒星星 + 夸奖语音 → 自动下一题（首答错则不加星）
                        ├─ 帮帮我 → 正确卡居中放大、其余淡出、播提示语 → 再点正确卡 → 下一题（不计分）
                        └─ 跳过 → 只推进题号 → 下一题
```

`session` 关键字段：`queue`、`total`、`done`、`stars`、`firstTryCorrect`、`newLearned`、`answers`、`firstQuestion`、`userId`、`userName`、`volumeId`、`volume`、`optionCount`、`current`、`timer`。

题目对象：`{ target, options, locked, counted, helped, wrongPicks }`。`wrongPicks` 记录本题选错次数，用于判定是否首答正确。

---

## 8. 缓存与版本控制

全站使用**一个统一版本号** `CACHE_VERSION`，定义在 `index.html` 头部。所有 CSS、JS、音频清单与音频地址都自动拼接同一个 `?v=`：

```html
<script>
  var CACHE_VERSION = "62";
  window.APP_VERSION = CACHE_VERSION;
  document.write('<link rel="stylesheet" href="css/style.css?v=' + CACHE_VERSION + '">');
</script>
```

页面底部按依赖顺序注入业务脚本（`volumes → memory → storage → quiz → 音频清单 → speaker → sound → app`），`Speaker.audioUrl()` 也读取 `window.APP_VERSION`。因此：

- **修改任何 css/js/音频后，只需把 `CACHE_VERSION` +1**，全部缓存立即失效
- 无需再分别维护各文件的版本号
- `assets/audio/*/index.js` 同样随之刷新，避免旧清单导致误走系统语音兜底

注意：`index.html` 本身通常由浏览器重新验证；若更换后仍看到旧页面，强制刷新一次即可。

---

## 9. 音频生成流水线

```
tools/data/volume-*.txt
   ├─ tools/scripts/build_volumes.py ────────→ data/volumes.js
   ├─ tools/scripts/build_font.py ───────────→ assets/fonts/kaiti.woff2（由生成字库.bat 自动调用）
   ├─ tools/scripts/gen_syllable_audio.py ───→ assets/audio/syllables/*.mp3 + index.js
   └─ tools/scripts/gen_words_audio.py ──────→ assets/audio/words/*.mp3 + index.js

tools/data/names.txt
   └─ tools/scripts/gen_name_audio.py ───────→ assets/audio/users/<名字>/*.mp3 + index.js

固定提示语文本（脚本内置）
   └─ tools/scripts/gen_phrase_audio.py ─────→ assets/audio/phrases/welcome|find|help|praise1~3|wrong|done|cheer.mp3

tools/scripts/gen_star_audio.py ──────────────→ assets/audio/phrases/stars0~20.mp3
```

- 统一使用 `edge-tts` + `zh-CN-XiaoxiaoNeural`（rate `-5%`）。
- 字体子集使用 `fonttools` + `brotli`，只需安装一次；源字体在 `tools/fonts/SimKai.ttf`（仅自用）。
- 所有脚本幂等：目标文件存在且大小达标时跳过，可反复运行。
- 合成失败自动重试 3 次；`gen_syllable_audio.py` 还会优先复用旧的 `assets/audio/chars/<字>.mp3`。
- 生成结束会自动重写对应 `index.js` 清单，前端据此判断音频是否存在。

---

## 10. 扩展点

| 方向 | 做法 |
|---|---|
| 增加字库/册 | 新增 `tools/data/volume-N.txt` + `volume-titles.txt` 补一行 → 运行生成字库 |
| 增加小朋友真人语音 | 名字写入 `tools/data/names.txt` → 运行名字语音脚本 |
| 形近字干扰 | 在条目中增加 `similar` 字段，在 `buildOptions` 中优先取形近字 |
| 图片提示 | 条目增加 `image` 字段，卡片中渲染图片 |
| 进度导出/导入 | 导出 `progress:{id}` 与 `history:{id}` 的 JSON，换设备后导入 |
| 更细的复习策略 | 调整 `Memory.INTERVALS` 与 `weakWeight`，或在 `pickTargets` 中加入每日新字上限 |
| 家长报告 | 复用历史记录，统计每周正确率与待复习数量 |

---

## 11. 已验证清单

- 首页选择小朋友 / 创建小朋友 / 后台新增与删除
- 选册页统计、历史记录 / 练习设置入口与返回
- 选对（绿色 + 星星 + 自动下一题）、先错后对（淡红禁用 + 错误权重 + 不加星）、跳过、结束（回册目页）
- 答题页无「继续」按钮：选错后仍停留在本题，直到点中正确卡片才自动进入下一题
- 帮帮我（正确卡移到屏幕中心放大 1.5 倍、其余卡片淡出、提示语播放，再点正确卡进入下一题且不计分）
- 拼音 / 组词 / 历史汉字三个显示开关的即时显隐与持久化
- 练习设置（按小朋友独立）：候选字 2/3/4/6/8/9 与题数 5~20，练习页列数、卡片尺寸与题号随之变化
- 结束页星星数量与语音（stars0~20）
- 历史记录渲染与清除记录；记录页汉字可点击进入通用单字详情页（田字格 + 拼音、读一读、组词、返回），旧记录也能按字库补齐拼音
- 田字格水平/垂直居中、再听一遍 / 帮帮我按钮不遮挡、底部用户名贴底
