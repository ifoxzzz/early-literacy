# 按组词生成整句语音：assets/audio/words/<字>_<拼音键>.mp3
# 朗读内容为「第一个词的X，第二个词的X」，如 雨 -> "雨水的雨，下雨的雨"
# 已存在则跳过，可重复运行；副作用：会刷新 words/index.js 清单
# 可选参数：传入文件名（不含 .mp3）强制重新生成，如 python gen_words_audio.py 还_hai2
import asyncio, os, re, sys
import edge_tts

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.path.join(ROOT, "tools", "data")
OUT_DIR = os.path.join(ROOT, "assets", "audio", "words")
VOICE = "zh-CN-XiaoxiaoNeural"

TONE = {
    "ā": ("a", 1), "á": ("a", 2), "ǎ": ("a", 3), "à": ("a", 4),
    "ē": ("e", 1), "é": ("e", 2), "ě": ("e", 3), "è": ("e", 4),
    "ī": ("i", 1), "í": ("i", 2), "ǐ": ("i", 3), "ì": ("i", 4),
    "ō": ("o", 1), "ó": ("o", 2), "ǒ": ("o", 3), "ò": ("o", 4),
    "ū": ("u", 1), "ú": ("u", 2), "ǔ": ("u", 3), "ù": ("u", 4),
    "ǖ": ("v", 1), "ǘ": ("v", 2), "ǚ": ("v", 3), "ǜ": ("v", 4),
}


def pinyin_key(py):
    tone, out = 5, ""
    for ch in py.strip().lower():
        if ch in TONE:
            base, tone = TONE[ch]
            out += base
        elif ch == "ü":
            out += "v"
        elif re.match("[a-z]", ch):
            out += ch
    return out + str(tone)


def load_entries():
    """读取所有册的生字，按「汉字+拼音」跨册去重，只保留首次出现"""
    entries, seen, dup = [], set(), 0
    # 按册号数字排序，保证 volume-10 不会排在 volume-2 前面
    files = []
    for fn in os.listdir(DATA):
        m = re.match(r"volume-(\d+)\.txt$", fn)
        if m:
            files.append((int(m.group(1)), fn))
    files.sort()

    for _, fn in files:
        for i, line in enumerate(open(os.path.join(DATA, fn), encoding="utf-8-sig").read().splitlines()):
            parts = [p.strip() for p in line.split("\t")]
            if i == 0 and parts[0].startswith("汉字"):
                continue
            if len(parts) >= 3 and parts[0] and parts[1]:
                key = f"{parts[0]}|{parts[1]}"
                if key in seen:
                    dup += 1
                    continue
                seen.add(key)
                entries.append((parts[0], parts[1], parts[2]))
    return entries, dup


# 例外表：拼音 -> 同音替代字（替代字必须读音固定、不是多音字）
# 有些字放在「X的X」句尾时，TTS 会按上下文选错读音（如「的还」被读成 huán）。
# 把句尾的字换成读音完全相同、但只有一个读音的同音字，TTS 就只能读出正确读音。
# 遇到新的误读，往表里加一行即可；改到已生成过的字时，用文件名参数强制重新生成。
PRONOUNCE_ALIAS = {
    "hái": "孩",  # 还有/还是 的「的还」会被读成 huán，用「孩」锁定 hái
}

# 命令行传入的文件名（不含 .mp3）强制重新生成，例如：还_hai2
FORCE = set(sys.argv[1:])


def split_words(words):
    return [w.strip() for w in re.split("[、，,/；;]", words) if w.strip()]


def speech_text(char, py, words):
    # 句尾使用替代字发音；组词本身读音由词语确定，不需要替换
    tail = PRONOUNCE_ALIAS.get(py, char)
    return "，".join(f"{w}的{tail}" for w in split_words(words))


async def synth(text, path, sem):
    async with sem:
        for _ in range(3):
            try:
                await edge_tts.Communicate(text, VOICE, rate="-5%").save(path)
                return True
            except Exception as e:
                print("  重试:", text, repr(e))
                await asyncio.sleep(1)
    return False


async def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    sem = asyncio.Semaphore(5)
    tasks, skipped = [], 0
    entries, dup = load_entries()
    for char, py, words in entries:
        stem = f"{char}_{pinyin_key(py)}"
        path = os.path.join(OUT_DIR, stem + ".mp3")
        if stem not in FORCE and os.path.exists(path) and os.path.getsize(path) > 500:
            skipped += 1
            continue
        tasks.append(synth(speech_text(char, py, words), path, sem))
    if tasks:
        await asyncio.gather(*tasks)

    keys = sorted(f[:-4] for f in os.listdir(OUT_DIR) if f.endswith(".mp3"))
    with open(os.path.join(OUT_DIR, "index.js"), "w", encoding="utf-8") as f:
        f.write("// 已有组词语音清单（由生成脚本自动维护，无需手动编辑）\n")
        f.write("window.WORD_AUDIO = " + str(keys).replace("'", '"') + ";\n")
    dup_note = f"，跨册重复跳过 {dup} 条" if dup else ""
    print(f"组词语音：本次新生成 {len(tasks)} 个，跳过已存在 {skipped} 个，共 {len(keys)} 个{dup_note}")


# Windows 下 Proactor 事件循环关闭时会抛出无害的 RuntimeError，改用 Selector 避免干扰输出
if os.name == "nt":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
asyncio.run(main())
