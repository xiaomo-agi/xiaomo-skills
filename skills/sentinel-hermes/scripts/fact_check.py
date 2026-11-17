#!/usr/bin/env python3
"""产出硬校验器（机器校验层 v1）

用法：python3 fact_check.py <产出文件.md> [--source <原文文件.md>]
exit 0 = 通过；exit 1 = 有 P0 问题（不过不登记，产出方必须修完再交）。

四道检查（全部确定性规则，零模型）：
1. 引用完整性：产出里出现的原文路径/链接，原文文件必须真实存在
2. 断言可追溯（--source 时）：产出中的数字（金额/天数/计数）必须能在原文中找到同一数字；
   找不到的数字列出 → 人工判断是编造还是换算
3. 残留标记：AI 生成痕迹（TODO/待填/占位/【】未闭合/审计占位符）= 不过
4. 结构最小要求：标题存在 + 正文≥50字（防交空壳）

设计契约（机器校验层思路，致谢 卡兹克）：
- 校验失败输出机器可读 JSON + 人话摘要
- 产出方（bot 或人）拿输出逐条修，修完重跑，exit 0 才许登记/投递
- 定时任务里接法：归档前跑本脚本，exit≠0 时不更新状态文件
"""
import json
import re
import sys
import os

P0 = []
WARN = []


def check_refs(text: str, base_dir: str) -> None:
    """产出里引用的本地路径必须存在。"""
    for m in re.findall(r"`?(/" + re.escape(os.path.expanduser("~")) + r"/[^\s`）)\]，。]*?)`?[，。）\s]", text):
        p = m.rstrip(".,;:）")
        if not re.search(r"\.(md|py|json|png|jpg|html|txt|sh)$", p):
            continue
        if "占位" in p or "example" in p:
            continue
        if not os.path.exists(p):
            P0.append(f"引用的本地文件不存在: {p}")


def check_numbers(text: str, source_text: str) -> None:
    """数字可追溯:产出的独立数字(≥2位或带单位)须在原文出现(忽略千分位差)。"""
    if not source_text:
        return
    src_norm = source_text.replace(",", "").replace("，", "")
    nums = re.findall(r"(?<![\d.])(\d{2,}(?:\.\d+)?)(?![\d.])", text)
    # 豁免规则:①短数字(≤3位,如 05/30/25)多为日期/页码/小计数,误报成本高于收益,只 WARN
    #          ②长数字(≥4位)是事实断言主体,原文找不到才 P0
    missing = []
    short_missing = []
    for n in set(nums):
        if n in src_norm:
            continue
        i = text.find(n)
        ctx = text[max(0, i - 8):i + len(n) + 8] if i >= 0 else ""
        entry = f"{n}（…{ctx.replace(chr(10),' ')}…）"
        (short_missing if len(n) <= 3 else missing).append(entry)
    if short_missing:
        WARN.append("短数字原文未见(多为日期/小计数,仅提示): " + "；".join(short_missing[:6]))
    if missing:
        P0.append("以下数字在原文中找不到，须人工确认不是编造: " + "；".join(missing[:8]))


def check_residue(text: str, allow_residue: bool = False) -> None:
    for pat, label in [
        (r"TODO[:：]", "TODO 残留"),
        (r"待填|待补【|【待", "待填占位"),
        (r"XXX|xxx占位", "xxx 占位"),
        (r"<？（?![)）]", "未闭合标记"),
    ]:
        if re.search(pat, text):
            if allow_residue:
                WARN.append(f"{label}（--allow-residue 已豁免，须人工确认是转写原文自带）: {label}")
            else:
                P0.append(f"{label}: {label}")
    if re.search(r"【[^】]*【", text):
        if not allow_residue:
            P0.append("【】嵌套未闭合")


def check_structure(text: str) -> None:
    if not re.search(r"^#\s+\S", text, re.M):
        P0.append("无一级标题")
    body = re.sub(r"\s", "", text)
    if len(body) < 50:
        P0.append(f"正文过短({len(body)}字),疑似空壳")


def main() -> None:
    args = sys.argv[1:]
    if not args or args[0].startswith("-"):
        print(json.dumps({"ok": False, "error": "用法: fact_check.py <产出.md> [--source <原文.md>]"}, ensure_ascii=False))
        sys.exit(2)
    target = args[0]
    source = ""
    # --allow-residue：显式豁免「残留标记」检查（仅用于转写原文自带 XXX/【待】等标记，
    # 且人工确认不能改原文的场合——豁免是显式动作，会记入 WARN，不是静默放过）
    allow_residue = "--allow-residue" in args
    if "--source" in args:
        i = args.index("--source")
        if i + 1 < len(args):
            try:
                source = open(args[i + 1], encoding="utf-8", errors="replace").read()
            except OSError as e:
                P0.append(f"原文文件读不到: {args[i+1]} ({e})")
    try:
        text = open(target, encoding="utf-8", errors="replace").read()
    except OSError as e:
        print(json.dumps({"ok": False, "error": f"产出文件读不到: {e}"}, ensure_ascii=False))
        sys.exit(2)

    check_structure(text)
    check_residue(text, allow_residue)
    check_refs(text, os.path.dirname(os.path.abspath(target)))
    check_numbers(text, source)

    result = {
        "ok": not P0,
        "file": target,
        "P0": P0,
        "warnings": WARN,
        "rule": "P0 不过不投递；修完重跑至 exit 0",
    }
    print(json.dumps(result, ensure_ascii=False, indent=1))
    sys.exit(0 if not P0 else 1)


if __name__ == "__main__":
    main()
