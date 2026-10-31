# 生成通用提示语：assets/audio/phrases/ 下的 welcome / find / praise1~3 / wrong / done / cheer
# 与名字专属语音（users/<名字>/）使用同一个"晓晓"女声，句子去掉名字部分
# 已存在且大于 1KB 的文件会自动跳过，可重复运行
# 用法：双击 tools/生成通用提示语.bat，或 python tools/scripts/gen_phrase_audio.py
import asyncio, os
import edge_tts

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "assets", "audio", "phrases")
VOICE = "zh-CN-XiaoxiaoNeural"

# 文件名 -> 朗读文本（与 speaker.js 的 phraseFile 键名保持一致）
PHRASES = {
    "welcome": "小朋友，快来答题吧！",
    "find": "请找出：",
    "praise1": "答对啦，真棒！",
    "praise2": "太厉害啦！",
    "praise3": "答对了，你真聪明！",
    "wrong": "没关系，正确答案是：",
    "done": "这一组完成啦！",
    "cheer": "你今天真棒！",
}


async def synth(text, path, sem):
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        return "skip"
    async with sem:
        for _ in range(3):
            try:
                await edge_tts.Communicate(text, VOICE, rate="-5%").save(path)
                return "ok"
            except Exception as e:
                print("  重试:", text, repr(e))
                await asyncio.sleep(1)
    print("  失败:", text)
    return "fail"


async def main():
    os.makedirs(OUT, exist_ok=True)
    sem = asyncio.Semaphore(5)
    results = await asyncio.gather(
        *[
            synth(text, os.path.join(OUT, f"{key}.mp3"), sem)
            for key, text in PHRASES.items()
        ]
    )
    ok = sum(1 for r in results if r == "ok")
    skipped = sum(1 for r in results if r == "skip")
    failed = [key for key, r in zip(PHRASES, results) if r == "fail"]
    print(f"通用提示语：新生成 {ok} 个，跳过已存在 {skipped} 个")
    if failed:
        print("缺文件：", "、".join(f"{k}.mp3" for k in failed))


# Windows 下 Proactor 事件循环关闭时会抛出无害的 RuntimeError，改用 Selector 避免干扰输出
if os.name == "nt":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
asyncio.run(main())
