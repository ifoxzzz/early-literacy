# 把 tools/data/volume-*.txt（汉字、拼音、组词）转换成 data/volumes.js
# 用法：双击 tools/生成字库.bat，或运行 python tools/scripts/build_volumes.py
import json, os, re

# tools/scripts/ 上三级为项目根目录
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.path.join(ROOT, "tools", "data")
TITLES_FILE = os.path.join(DATA, "volume-titles.txt")
OUT_FILE = os.path.join(ROOT, "data", "volumes.js")


def load_titles():
    # volume-1=一年级上册；没配置时用"第 N 册"
    titles = {}
    if not os.path.exists(TITLES_FILE):
        return titles
    for line in open(TITLES_FILE, encoding="utf-8-sig"):
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        titles[k.strip()] = v.strip()
    return titles


def parse_volume(path):
    entries, skipped = [], 0
    for i, line in enumerate(open(path, encoding="utf-8-sig").read().splitlines()):
        parts = [p.strip() for p in line.split("\t")]
        if i == 0 and parts[0].startswith("汉字"):  # 表头
            continue
        if len(parts) < 3 or not parts[0] or not parts[1]:
            if line.strip():
                skipped += 1
            continue
        entries.append({"char": parts[0], "pinyin": parts[1], "words": parts[2]})
    return entries, skipped


def dedupe(entries, seen):
    """按 char+pinyin 去重（多音字同字不同音算两条）

    seen 跨册共享：同一组汉字+拼音只保留首次出现，
    后续册里再出现会被丢弃。
    """
    out, dup = [], 0
    for e in entries:
        k = f"{e['char']}|{e['pinyin']}"
        if k in seen:
            dup += 1
            continue
        seen.add(k)
        out.append(e)
    return out, dup


def main():
    titles = load_titles()
    volumes = []
    # 先按册号数字排序（避免 volume-10 排在 volume-2 前面），保证“首次出现”顺序正确
    files = []
    for fn in os.listdir(DATA):
        m = re.match(r"volume-(\d+)\.txt$", fn)
        if m:
            files.append((int(m.group(1)), fn))
    files.sort()

    seen = set()  # 跨册去重集合
    for num, fn in files:
        entries, skipped = parse_volume(os.path.join(DATA, fn))
        entries, dup = dedupe(entries, seen)
        volumes.append({
            "id": str(num),
            "title": titles.get(f"volume-{num}", f"第 {num} 册"),
            "entries": entries,
        })
        note = f"，跳过 {skipped} 行格式错误" if skipped else ""
        if dup:
            note += f"，去重 {dup} 条（含与其他册重复）"
        print(f"{fn} -> {len(entries)} 字{note}")

    if not volumes:
        print("没有找到 tools/data/volume-*.txt")
        return

    lines = ["// 自动生成，请勿手改；修改 tools/data/volume-*.txt 后运行 tools/生成字库.bat", "window.VOLUMES = ["]
    for i, v in enumerate(volumes):
        lines.append("  {")
        lines.append(f'    id: {json.dumps(str(v["id"]), ensure_ascii=False)},')
        lines.append(f'    title: {json.dumps(v["title"], ensure_ascii=False)},')
        lines.append("    entries: [")
        for e in v["entries"]:
            lines.append(
                "      { char: %s, pinyin: %s, words: %s },"
                % (
                    json.dumps(e["char"], ensure_ascii=False),
                    json.dumps(e["pinyin"], ensure_ascii=False),
                    json.dumps(e["words"], ensure_ascii=False),
                )
            )
        lines.append("    ],")
        lines.append("  }," if i < len(volumes) - 1 else "  }")
    lines.append("];")

    with open(OUT_FILE, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    total = sum(len(v["entries"]) for v in volumes)
    print(f"已生成 data/volumes.js：{len(volumes)} 册，共 {total} 条")


main()
