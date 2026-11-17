#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""宽窗分段复查扫描器（默认30天/12h一段），带 sleep + 指数退避 + 断点续跑。

背景（实测）：`minutes +search` 高频调用会触发 99991400
`request trigger frequency limit`。「50 条硬截断」和「调太快被限流」是两个独立的坑，
分段扫描把调用量放大 60~120 倍，撞限流是必然的 —— 所以写宽窗扫描脚本必须默认带上三件套：
  ① 段间 sleep 2.5s
  ② 失败指数退避 4→8→16→32→64 秒，最多 5 次
  ③ 断点续跑（进度写 progress 文件），重跑跳过已完成段

⚠️ 断点续跑只允许用于「同一轮扫描中断后接着跑」（--resume）。
每轮开新扫描时进度必须重置 —— 段的时间窗是相对锚点 anchor 计算的，
沿用上一轮的进度文件会把 60 段全部 skip 掉（本轮形同没扫），复用的 items 还是旧窗口的。
实测发现并修复：进度文件改为带 run_now 锚点，跨轮自动重置。

用法:
    python3 wide_scan.py me      # owner=me（服务端过滤，只查自己的稿）
    python3 wide_scan.py all     # 不限 owner（含别人主持的外部内容）
    python3 wide_scan.py me --hours 720 --seg 12
    python3 wide_scan.py me --resume   # 同一轮中断后续跑（不重置进度）

产物（都在 scratch 目录，不落档案树，避免被 git add . 带进仓库）:
    wide_progress_<mode>.json   分段进度 {"run_now": <anchor>, "segs": {"0": 12, ...}}
    wide_items_<mode>.json       拉到的全量 items（token -> item）
    union.json                  去重并集（脚本自动生成）
"""
import argparse
import html
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

# 妙记时间统一北京时间；其他时区用户可用 SENTINEL_TZ_OFFSET 覆盖（小时数）
TZ = timezone(timedelta(hours=int(os.environ.get("SENTINEL_TZ_OFFSET", "8"))))
# 脚本暂存目录（进度文件等），不落档案树
SCR = os.environ.get("SENTINEL_SCRATCH",
                     os.path.join(os.path.expanduser("~"), ".cache", "sentinel-hermes")) + os.sep
SEARCH_CAP = 50          # +search 单次硬上限；每段返回必须 < 50 才可信
SEG_SLEEP = 2.5          # 段间休眠
PAGE_SLEEP = 1.5         # 页间休眠
BACKOFF = [4, 8, 16, 32, 64]


def pull(start, end, owner="me"):
    """拉一个时间窗的所有页。owner="me" 服务端过滤；None/all = 不限。返回 items 列表。"""
    cmd = ["lark-cli", "minutes", "+search", "--start", str(int(start)),
           "--end", str(int(end)), "--as", "user", "--format", "json"]
    if owner and owner != "all":
        cmd += ["--owner-ids", owner]
    out, token = [], None
    for _ in range(6):
        c = list(cmd)
        if token:
            c += ["--page-token", token]
        try:
            p = subprocess.run(c, capture_output=True, text=True, timeout=120)
        except subprocess.TimeoutExpired:
            raise RuntimeError("timeout after 120s")
        if p.returncode != 0:
            raise RuntimeError("rc=%s %s" % (p.returncode, (p.stderr or p.stdout)[:300]))
        raw = p.stdout or ""
        i = raw.find("{")
        if i < 0:
            raise RuntimeError("nojson %s" % raw[:200])
        d = json.loads(raw[i:])
        if not d.get("ok"):
            raise RuntimeError("notok %s" % raw[:200])
        data = d.get("data") or {}
        page = data.get("items") or []
        out.extend(page)
        nxt = data.get("page_token")
        if not data.get("has_more") or not nxt or nxt == token or not page:
            break
        token = nxt
        time.sleep(PAGE_SLEEP)
    return out


def pull_with_backoff(start, end, label, owner="me"):
    for attempt in range(len(BACKOFF) + 1):
        try:
            return pull(start, end, owner=owner)
        except Exception as e:
            if attempt >= len(BACKOFF):
                print("FAILED_SEG %s : %s" % (label, str(e)[:200]), flush=True)
                return None
            d = BACKOFF[attempt]
            print("RETRY seg=%s attempt=%d sleep=%d err=%s"
                  % (label, attempt + 1, d, str(e)[:120]), flush=True)
            time.sleep(d)
    return None


def build_union(archive, registry, state_path):
    """去重并集：state.json processed（+ 可选共享登记表）+ 档案 frontmatter。"""
    known = set()
    try:
        st = json.load(open(state_path, encoding="utf-8"))
        for it in st.get("processed", []) or []:
            known.add(it if isinstance(it, str) else it.get("minute_token", ""))
    except Exception:
        pass
    if registry and os.path.exists(registry):
        try:
            for line in open(registry, encoding="utf-8", errors="ignore"):
                m = re.search(r"obcn[a-z0-9]+", line)
                if m:
                    known.add(m.group(0))
        except OSError:
            pass
    hdr = re.compile(r"minute_token[_0-9]*:\s*(obcn[a-z0-9]+)")
    for root, dirs, files in os.walk(archive):
        if os.sep + ".state" in root:
            continue
        for fn in files:
            if not fn.endswith(".md"):
                continue
            try:
                txt = open(os.path.join(root, fn), encoding="utf-8", errors="ignore").read(2000)
            except OSError:
                continue
            for m in hdr.finditer(txt):
                known.add(m.group(1))
    return known


def load_progress(path, anchor, resume):
    """读进度；跨轮自动重置（只在 --resume 时沿用上一轮的进度与锚点）。"""
    if not os.path.exists(path):
        return {}, anchor
    try:
        raw = json.load(open(path, encoding="utf-8"))
    except Exception:
        return {}, anchor
    if not isinstance(raw, dict) or "segs" not in raw:
        # 旧格式（裸 {index: count}）→ 无法确认锚点，跨轮不可信 → 重置
        print("PROGRESS_RESET mode=%s reason=legacy_format" % os.path.basename(path), flush=True)
        return {}, anchor
    segs = raw.get("segs") or {}
    prev_anchor = raw.get("run_now")
    if resume and prev_anchor:
        print("RESUME mode=%s segs_done=%d anchor=%s"
              % (os.path.basename(path), len(segs), prev_anchor), flush=True)
        return segs, int(prev_anchor)
    if segs:
        print("PROGRESS_RESET mode=%s reason=new_round prev_segs=%d prev_anchor=%s"
              % (os.path.basename(path), len(segs), prev_anchor), flush=True)
    return {}, anchor


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", nargs="?", default="me", help="me | all")
    ap.add_argument("--hours", type=int, default=720, help="总跨度小时数，默认 720=30天")
    ap.add_argument("--seg", type=int, default=12, help="每段小时数，默认 12")
    ap.add_argument("--resume", action="store_true", help="同一轮中断后续跑（不重置进度）")
    ap.add_argument("--archive", default=os.environ.get("SENTINEL_ARCHIVE", ""),
                    help="归档根目录（默认读 SENTINEL_ARCHIVE 环境变量）")
    ap.add_argument("--registry", default=os.environ.get("SENTINEL_REG", ""),
                    help="可选共享登记表（默认读 SENTINEL_REG，未配则跳过）")
    args = ap.parse_args()

    if not args.archive:
        print("ERROR: 未配置归档根目录（--archive 或环境变量 SENTINEL_ARCHIVE）", flush=True)
        return 1
    if not os.path.isdir(args.archive):
        print("ERROR: 归档目录不存在：%s" % args.archive, flush=True)
        return 1
    if args.seg <= 0:
        print("ERROR: --seg 必须 > 0", flush=True)
        return 1
    owner = None if args.mode == "all" else "me"

    os.makedirs(SCR, exist_ok=True)
    prog_path = SCR + "wide_progress_%s.json" % args.mode
    items_path = SCR + "wide_items_%s.json" % args.mode

    now = int(datetime.now(TZ).timestamp())
    progress, anchor = load_progress(prog_path, now, args.resume)

    items = {}
    if os.path.exists(items_path):
        try:
            items = json.load(open(items_path, encoding="utf-8"))
        except Exception:
            items = {}
    if not progress:
        # 新一轮 → items 也重置，避免混入上一轮旧窗口的条目
        items = {}

    seg = args.seg * 3600
    n_seg = max(1, args.hours * 3600 // seg)
    for i in range(n_seg):
        e = anchor - i * seg
        s = e - seg
        key = "%d" % i
        if key in progress:
            continue
        got = pull_with_backoff(s, e, "seg%d[%d-%d]" % (i, s, e), owner=owner)
        if got is None:
            continue
        if len(got) >= SEARCH_CAP:
            print("TRUNC_SEG seg%d got=%d（段长仍太长，需再细分）" % (i, len(got)), flush=True)
        for it in got:
            tok = it.get("token")
            if tok:
                items[tok] = it
        progress[key] = len(got)
        json.dump({"run_now": anchor, "segs": progress}, open(prog_path, "w"))
        json.dump(items, open(items_path, "w"))
        time.sleep(SEG_SLEEP)

    print("MODE=%s segments_done=%d total_items=%d" % (args.mode, len(progress), len(items)), flush=True)
    known = build_union(args.archive, args.registry, os.path.join(args.archive, ".state/state.json"))
    json.dump(sorted(known), open(SCR + "union.json", "w"))
    pend = sorted(t for t in items if t not in known)
    print("UNION=%d PENDING_COUNT=%d" % (len(known), len(pend)), flush=True)
    for t in pend:
        di = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html.unescape(items[t].get("display_info") or ""))).strip()
        print("PENDING %s | %s" % (t, di[:280]), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
