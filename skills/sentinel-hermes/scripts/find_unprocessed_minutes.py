#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""定位「扫描到但没落地」的妙记欠账。

什么时候跑：怀疑有稿漏归档（「我明明录过这条」/「应该不止这几条」）时跑这个脚本，
先定位欠账再回答，不要凭记忆。

用法：
    python3 find_unprocessed_minutes.py                        # 只比对本地状态与档案
    python3 find_unprocessed_minutes.py --live-hours 48        # 额外拉一次线上搜索兜底
    python3 find_unprocessed_minutes.py --segmented-hours 720  # 分段扫（推荐，30天）
    python3 find_unprocessed_minutes.py --watchdog-out <dir>   # 从 cron 输出目录提取「报过的」

分段扫为什么必需：`lark-cli minutes +search` 单次最多返回 50 条，且 `has_more`
可能是 false（拿不到更多页）——窗口内超过 50 条时排在后面的会被静默丢掉。
所以「感觉应该不止」时，不要重拉同一整窗，直接分段扫。

只读脚本，不写任何文件。纯标准库，兼容 python3.9。
路径从环境变量读：SENTINEL_ARCHIVE（必配）/ SENTINEL_REG（可选）。
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

TOKEN_RE = re.compile(r"obcn[a-z0-9]{16,}")
HEADER_RE = re.compile(r"^minute_token[_0-9]*:\s*(\S+)", re.M)

ARCHIVE = os.environ.get("SENTINEL_ARCHIVE", "")
REG = os.environ.get("SENTINEL_REG", "")

# +search 单次硬上限；每段返回条数必须 < 50 才可信
SEARCH_CAP = 50


def read(path):
    try:
        with open(path, encoding="utf-8", errors="ignore") as f:
            return f.read()
    except OSError:
        return ""


def collect_reported(roots):
    """从 cron/monitor 的历史输出存档里提取「报过的 token」+ 首次报出的文件（可选来源）。"""
    reported = {}
    for root in roots:
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, files in os.walk(root):
            for fn in files:
                if not fn.endswith(".md"):
                    continue
                path = os.path.join(dirpath, fn)
                text = read(path)
                for tok in set(TOKEN_RE.findall(text)):
                    reported.setdefault(tok, path)
    return reported


def collect_archived(archive_dir):
    found = {}
    for dirpath, _dirs, files in os.walk(archive_dir):
        if os.sep + ".state" in dirpath:
            continue
        for fn in files:
            if not fn.endswith(".md"):
                continue
            path = os.path.join(dirpath, fn)
            for tok in HEADER_RE.findall(read(path)[:4000]):
                found.setdefault(tok, path)
    return found


def collect_state(state_path):
    processed, failed = set(), set()
    raw = read(state_path)
    if not raw:
        return processed, failed
    try:
        data = json.loads(raw)
    except ValueError:
        return processed, failed
    for item in data.get("processed", []) or []:
        processed.add(item if isinstance(item, str) else item.get("minute_token", ""))
    for item in data.get("failed", []) or []:
        failed.add(item if isinstance(item, str) else item.get("minute_token", ""))
    return processed, failed


def _search(start, end, owner="me"):
    """调一次 +search。owner 用 'me'（服务端过滤）；传 open_id 会报 99992361。"""
    args = ["lark-cli", "minutes", "+search", "--as", "user",
            "--start", str(start), "--end", str(end), "--format", "json"]
    if owner:
        args += ["--owner-ids", owner]
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=120,
                              env={**os.environ, "LARK_CLI_NO_PROXY": "1"})
    except (OSError, subprocess.SubprocessError):
        return []
    raw = proc.stdout or ""
    i = raw.find("{")
    if i < 0:
        return []
    try:
        data = json.loads(raw[i:])
    except ValueError:
        return []
    return (data.get("data") or {}).get("items") or []


def live_search(hours):
    """线上搜索兜底：捕捉还没进档案的稿（索引滞后时会出现）。"""
    end = int(time.time())
    start = end - hours * 3600
    return {it.get("token"): "" for it in _search(start, end) if it.get("token")}


def segmented_search(hours, segment_hours=12, owner="me"):
    """分段扫：每段独立调 +search，避开 50 条硬截断。

    段长不按固定天数拍脑袋——每段实际返回条数必须 < 50 才可信；段返回满 50 时
    说明这段仍被截断，应缩短段长重扫该段。
    """
    end = int(time.time())
    start = end - hours * 3600
    found = {}
    truncated = []
    cursor = end
    while cursor > start:
        seg_end = cursor
        seg_start = max(start, cursor - segment_hours * 3600)
        items = _search(seg_start, seg_end, owner=owner)
        if len(items) >= SEARCH_CAP:
            truncated.append((seg_start, seg_end, len(items)))
        for it in items:
            tok = it.get("token")
            if tok:
                found[tok] = it
        cursor = seg_start
    return found, truncated


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive-dir", default=ARCHIVE)
    ap.add_argument("--registry", default=REG)
    ap.add_argument("--state", default=os.path.join(ARCHIVE, ".state/state.json") if ARCHIVE else "")
    ap.add_argument("--watchdog-out", action="append", default=None,
                    help="可选：cron 输出/monitor 存档目录（提取「报过的 token」）")
    ap.add_argument("--live-hours", type=int, default=0)
    ap.add_argument("--segmented-hours", type=int, default=0,
                    help="分段扫的总跨度小时数（>0 时启用，推荐 720=30天）")
    ap.add_argument("--segment-hours", type=int, default=12, help="每段跨度小时数")
    ap.add_argument("--all-owners", action="store_true",
                    help="不限 owner（会拉到别人的稿，需按外部素材口径处理）")
    args = ap.parse_args()

    if not args.archive_dir:
        print("ERROR: 未配置归档根目录（--archive-dir 或环境变量 SENTINEL_ARCHIVE）")
        return 1

    roots = args.watchdog_out or []
    reported = collect_reported(roots)
    archived = collect_archived(args.archive_dir)
    registered = set(TOKEN_RE.findall(read(args.registry))) if args.registry else set()
    processed, failed = collect_state(args.state) if args.state else (set(), set())

    if args.live_hours:
        for tok in live_search(args.live_hours):
            reported.setdefault(tok, "(线上搜索)")

    known = registered | processed | set(archived)

    print("== 欠账：报过但未落地 ==")
    debt = sorted(t for t in reported if t not in known)
    if not debt:
        print("  (无)")
    for tok in debt:
        print("  %s  报于 %s" % (tok, os.path.basename(reported.get(tok, "?"))))
    if failed:
        print("\n== state.failed 里的失败项 ==")
        for tok in sorted(failed):
            print("  %s" % tok)

    print("\n== 已登记但档案文件缺失（确认是否有意删除）==")
    missing = sorted(t for t in (registered | processed) if t not in archived)
    if not missing:
        print("  (无)")
    for tok in missing:
        print("  %s" % tok)

    if args.segmented_hours:
        owner = None if args.all_owners else "me"
        found, truncated = segmented_search(args.segmented_hours,
                                            args.segment_hours, owner=owner)
        seg_known = known | set(found)
        print("\n== 分段扫（%d 小时 / 每段 %d 小时%s）==" % (
            args.segmented_hours, args.segment_hours,
            " / 不限 owner" if args.all_owners else ""))
        print("  拉到 %d 条" % len(found))
        if truncated:
            print("  ⚠️ 以下分段返回满 %d 条 → 仍被截断，需缩短段长重扫：" % SEARCH_CAP)
            for s, e, n in truncated:
                print("     %s ~ %s (%d 条)" % (
                    time.strftime("%m-%d %H:%M", time.localtime(s)),
                    time.strftime("%m-%d %H:%M", time.localtime(e)), n))
        seg_pending = sorted(t for t in found if t not in known)
        print("  分段扫到的未处理 token: %d" % len(seg_pending))
        for tok in seg_pending:
            print("    %s" % tok)

    print("\n汇总：扫描记录 %d / 档案 %d / 登记表 %d / state %d → 欠账 %d"
          % (len(reported), len(archived), len(registered), len(processed), len(debt)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
