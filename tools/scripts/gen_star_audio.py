# 生成结束页"星星数量"语音：stars0.mp3 ~ stars20.mp3（与其它提示语同一个"晓晓"女声）
# 每组题数可在后台配成 5~20，所以星星数最多 20 颗
# 用法：python tools/scripts/gen_star_audio.py（已存在且大于 1KB 的文件会自动跳过）
import asyncio, os
import edge_tts

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "assets", "audio", "phrases")
VOICE = "zh-CN-XiaoxiaoNeural"

CN = {
    0: "零", 1: "一", 2: "二", 3: "三", 4: "四", 5: "五",
    6: "六", 7: "七", 8: "八", 9: "九", 10: "十",
    11: "十一", 12: "十二", 13: "十三", 14: "十四", 15: "十五",
    16: "十六", 17: "十七", 18: "十八", 19: "十九", 20: "二十",
}


def text(n):
    if n == 0:
        return "这次没有星星，下次加油！"
    return f"你得到了{CN[n]}颗星星！"


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
    os.makedirs(OUT, exist_ok=True)
    sem = asyncio.Semaphore(5)
    tasks = [synth(text(n), os.path.join(OUT, f"stars{n}.mp3"), sem) for n in range(0, 21)]
    await asyncio.gather(*tasks)
    missing = [n for n in range(0, 21) if not os.path.exists(os.path.join(OUT, f"stars{n}.mp3"))]
    print("完成：" if not missing else "缺文件：", missing if missing else "stars0 ~ stars20")


# Windows 下 Proactor 事件循环关闭时会抛出无害的 RuntimeError，改用 Selector 避免干扰输出
if os.name == "nt":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
asyncio.run(main())
