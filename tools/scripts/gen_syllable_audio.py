# 按拼音生成音节音频：assets/audio/syllables/<拼音>数字.mp3（如 kan4.mp3）
# 同音字共享一个文件；已存在的文件跳过，可重复运行
# 优先复用同音字的单字音频（chars 目录仍存在时），否则用 edge-tts 合成
import asyncio, os, re, shutil
import edge_tts

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC_DIR = os.path.join(ROOT, "assets", "audio", "chars")
OUT_DIR = os.path.join(ROOT, "assets", "audio", "syllables")
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
    """kàn -> kan4，nǚ -> nv3；无调号按轻声 5"""
    tone, out = 5, ""
    for ch in py.strip().lower():
        if ch in TONE:
            base, tone = TONE[ch]
            out += base
        elif ch == "ü":
            out += "v"
        else:
            out += ch
    return out + str(tone)


def load_pairs():
    """读取 tools/data/volume-*.txt 的字音对，按出现顺序去重"""
    pairs, seen = [], set()
    data_dir = os.path.join(ROOT, "tools", "data")
    for fn in sorted(os.listdir(data_dir)):
        if not re.match(r"volume-\d+\.txt$", fn):
            continue
        lines = open(os.path.join(data_dir, fn), encoding="utf-8-sig").read().splitlines()
        for i, line in enumerate(lines):
            parts = [p.strip() for p in line.split("\t")]
            if i == 0 and parts[0].startswith("汉字"):
                continue
            if len(parts) >= 2 and parts[0] and parts[1]:
                key = (parts[0], parts[1])
                if key not in seen:
                    seen.add(key)
                    pairs.append(key)
    return pairs


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


# 常见多音字：TTS 单字朗读时可能选到另一个读音（如“还”读成 huán），
# 因此选发音代表字时尽量避开，改用同音的非多音字（如 hái 改用“孩”）
POLYPHONES = set(
    "还和都长行重干发好教乐便得地空数中少相种处当传差结给只丽落薄血校觉会"
    "为调转系应几朝曲弹担量磨难宁片强散舍省似宿提挑兴要与载占正更单角卷圈"
    "任盛石术刷台吓鲜削畜旋咽钥炸折轴爪钻作"
)


async def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    pairs = load_pairs()
    # 每个拼音收集所有候选字（按字库出现顺序）
    cands = {}
    for char, py in pairs:
        cands.setdefault(pinyin_key(py), [])
        if char not in cands[pinyin_key(py)]:
            cands[pinyin_key(py)].append(char)
    # 代表字优先选非多音字；整组都是多音字时退回第一个
    reps = {}
    for key, chars in cands.items():
        reps[key] = next((c for c in chars if c not in POLYPHONES), chars[0])

    copied, tasks = 0, []
    sem = asyncio.Semaphore(5)
    for key, char in reps.items():
        target = os.path.join(OUT_DIR, f"{key}.mp3")
        if os.path.exists(target) and os.path.getsize(target) > 500:
            continue
        src = os.path.join(SRC_DIR, f"{char}.mp3")
        if os.path.exists(src):
            shutil.copyfile(src, target)
            copied += 1
        else:
            tasks.append(synth(char, target, sem))
    if tasks:
        await asyncio.gather(*tasks)

    keys = sorted(f[:-4] for f in os.listdir(OUT_DIR) if f.endswith(".mp3"))
    with open(os.path.join(OUT_DIR, "index.js"), "w", encoding="utf-8") as f:
        f.write("// 已有音节音频清单（由生成脚本自动维护，无需手动编辑）\n")
        f.write("window.SYLLABLE_AUDIO = " + str(keys).replace("'", '"') + ";\n")
    print(f"汉字 {len(pairs)} 个，唯一音节 {len(reps)} 个；本次复制 {copied} 个，合成 {len(tasks)} 个")


# Windows 下 Proactor 事件循环关闭时会抛出无害的 RuntimeError，改用 Selector 避免干扰输出
if os.name == "nt":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
asyncio.run(main())
