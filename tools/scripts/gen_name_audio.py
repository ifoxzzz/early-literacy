# 为 tools/data/names.txt 里的每个名字生成"晓晓"真人语音，输出到 assets/audio/users/<名字>/
# 已存在的文件自动跳过，可重复运行；新增名字后重新运行即可
import asyncio, os, re
import edge_tts

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NAMES_FILE = os.path.join(ROOT, "tools", "data", "names.txt")
OUT_ROOT = os.path.join(ROOT, "assets", "audio", "users")
VOICE = "zh-CN-XiaoxiaoNeural"

# 每个名字要生成的句子：文件名 -> 文本模板
PHRASES = {
    "welcome": "{name}小朋友，快来答题吧！",
    "praise1": "{name}，答对啦，真棒！",
    "praise2": "{name}，太厉害啦！",
    "praise3": "{name}，答对了，你真聪明！",
    "wrong": "{name}，没关系，正确答案是：",
    "done": "{name}，这一组完成啦！",
    "cheer": "{name}，你今天真棒！",
}


def read_names():
    if not os.path.exists(NAMES_FILE):
        print("找不到 tools/data/names.txt")
        return []
    names = []
    with open(NAMES_FILE, encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            if s not in names:
                names.append(s)
    return names


async def synth(text, path, sem):
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        return True
    async with sem:
        for _ in range(3):
            try:
                await edge_tts.Communicate(text, VOICE, rate="-5%").save(path)
                return True
            except Exception as e:
                print("  重试:", text, repr(e))
                await asyncio.sleep(1)
    print("  失败:", text)
    return False


async def main():
    names = read_names()
    if not names:
        print("names.txt 里还没有名字")
        return
    sem = asyncio.Semaphore(5)
    tasks = []
    for name in names:
        out = os.path.join(OUT_ROOT, name)
        os.makedirs(out, exist_ok=True)
        for key, tpl in PHRASES.items():
            tasks.append(synth(tpl.format(name=name), os.path.join(out, f"{key}.mp3"), sem))
    await asyncio.gather(*tasks)

    # 生成清单供前端判断哪些名字已有真人语音
    available = [d for d in sorted(os.listdir(OUT_ROOT))
                 if os.path.isdir(os.path.join(OUT_ROOT, d))]
    with open(os.path.join(OUT_ROOT, "index.js"), "w", encoding="utf-8") as f:
        f.write("// 已有名字语音的名字清单（由生成脚本自动维护，无需手动编辑）\n")
        f.write("window.USER_AUDIO = " + str(available).replace("'", '"') + ";\n")
    print("完成：", "、".join(available) if available else "无")


# Windows 下 Proactor 事件循环关闭时会抛出无害的 RuntimeError，改用 Selector 避免干扰输出
if os.name == "nt":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
asyncio.run(main())
