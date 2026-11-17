# -*- coding: utf-8 -*-
# 妙记扫描器（哨兵 · Hermes 版）
#
# 作用：扫最近 N 小时妙记，列出「未归档 且 已出稿」的新稿，结果直接打印到终端。
#       本 skill 是静默哨兵——本脚本不发任何消息、不写任何飞书数据，只做本地输出。
# 去重两道必查：state.json processed ∪ 档案 frontmatter；
# 可选第三道：共享登记表（SENTINEL_REG）/ 外部已处理目录（SENTINEL_EXTRA_PROCESSED_DIR），配了才查。
#
# 失败必须显式报警（静默失败 = 系统已死），绝不悄悄退出。
import subprocess, os, re, json, time, html

# 归档根目录（必配，无默认值——避免误写到任何人的默认路径）
ARCHIVE = os.environ.get("SENTINEL_ARCHIVE", "")
# 可选：共享登记表（多 agent 共用去重账本）
REG = os.environ.get("SENTINEL_REG", "")
# 可选：飞书租户域名（拼妙记链接用）
FEISHU_HOST = os.environ.get("FEISHU_HOST", "")
# owner 过滤：默认 me（服务端过滤，只扫自己的妙记）；传 open_id 会报 99992361
OWNER = os.environ.get("SENTINEL_OWNER", "me")

WINDOW_HOURS = 24


def fail(msg):
    """扫描失败 → 输出报警文本。宁可吵，不可哑。"""
    print("🚨 妙记扫描失败")
    print(f"原因：{msg}")
    print("影响：本轮新妙记可能漏处理。")
    print("自查：lark-cli auth status --as user（看 scope 是否失效）")
    raise SystemExit(1)


if not ARCHIVE:
    fail("未配置 SENTINEL_ARCHIVE（归档根目录），先按 SETUP.md Step 3 配置")

STATE = os.path.join(ARCHIVE, ".state", "state.json")


def sh(*args):
    env = {**os.environ, "LARK_CLI_NO_PROXY": "1"}
    try:
        p = subprocess.run(args, capture_output=True, text=True, env=env, timeout=120)
    except subprocess.TimeoutExpired:
        return "", "命令超时"
    return p.stdout, p.stderr


# ---------- 1. 搜索窗口内的妙记（翻页拉全；单窗 ≥50 条即截断信号） ----------
st = int(time.time()) - WINDOW_HOURS * 3600
et = int(time.time())
items, page, guard = [], None, 0
while True:
    guard += 1
    if guard > 40:
        fail("pagination_guard")
    args = ["lark-cli", "minutes", "+search", "--as", "user",
            "--start", str(st), "--end", str(et), "--format", "json"]
    if OWNER:
        args += ["--owner-ids", OWNER]
    if page:
        args += ["--page-token", page]
    out, err = sh(*args)
    try:
        data = json.loads(out)
    except Exception:
        fail(f"搜索接口返回非 JSON（stderr: {(err or '空')[:300]}）")
    if not data.get("ok", False):
        fail(f"搜索接口报错：{json.dumps(data.get('error', {}), ensure_ascii=False)[:300]}")
    chunk = data.get("data") or {}
    items += chunk.get("items") or []
    if not chunk.get("has_more"):
        break
    page = chunk.get("page_token")
    if not page:
        break

if len(items) >= 50:
    print("⚠️ 窗口内拉到 %d 条（≥50 = 疑似 API 硬截断，可能漏稿）→ 用 wide_scan.py 分段复查" % len(items))
if not items:
    print("✅ 窗口内无妙记")
    raise SystemExit(0)

# display_info 形如 "标题\n<b>关键词:</b> ...\n所有者: x 开始时间: ... 时长: N 分 M 秒"
parsed = []
for it in items:
    tok = it.get("token") or ""
    info = html.unescape(it.get("display_info") or "")
    desc = html.unescape((it.get("meta_data") or {}).get("description") or "")
    lines = [ln.strip() for ln in info.split("\n") if ln.strip()]
    title = lines[0] if lines else "(无标题)"
    m = re.search(r"开始时间:\s*([\d.]+)\s+(\d+:\d+:\d+)", desc)
    date_s, time_s = (m.group(1), m.group(2)) if m else ("", "")
    d = re.search(r"时长:\s*(\d+)\s*分\s*(\d+)\s*秒", desc)
    dur = f"{d.group(1)}分{d.group(2)}秒" if d else ""
    parsed.append({"token": tok, "title": title, "date": date_s, "time": time_s,
                   "dur": dur, "link": it.get("link") or ""})

# ---------- 2. 去重：两道必查 + 可选第三道 ----------
registered = set()
if REG and os.path.exists(REG):
    with open(REG, encoding="utf-8") as f:
        registered = set(re.findall(r"minute_token:\s*(\S+)", f.read()))

processed = set()
if os.path.exists(STATE):
    try:
        with open(STATE, encoding="utf-8") as f:
            processed = set(
                x if isinstance(x, str) else x.get("minute_token", "")
                for x in json.load(f).get("processed", [])
                if isinstance(x, str) or isinstance(x, dict)
            )
    except Exception as exc:
        fail(f"state.json 读取失败：{exc}")

# 档案 frontmatter 里已登记的 token（防 state 漏写时重复归档）
archived = set()
if os.path.isdir(ARCHIVE):
    for root, _dirs, files in os.walk(ARCHIVE):
        for fn in files:
            if not fn.endswith(".md"):
                continue
            try:
                with open(os.path.join(root, fn), encoding="utf-8", errors="ignore") as f:
                    head = f.read(4000)
            except Exception:
                continue
            archived |= set(re.findall(r"^minute_token:\s*(\S+)", head, re.M))


def _scan_dir(root):
    """宽松匹配：任意行同时含 "token" 与 "obcn" 即收（字段名变体很多，严匹配会漏一半）。"""
    out = set()
    for r, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d != ".git"]
        for fn in files:
            if not fn.endswith(".md"):
                continue
            try:
                with open(os.path.join(r, fn), encoding="utf-8", errors="ignore") as f:
                    for line in f:
                        ll = line.lower()
                        if "token" in ll and "obcn" in ll:
                            out |= set(re.findall(r"obcn[a-z0-9]+", line))
            except Exception:
                continue
    return out


def extra_known():
    """可选第三道：其他工具已处理的目录（SENTINEL_EXTRA_PROCESSED_DIR，os.pathsep 分隔多个）。"""
    extra = os.environ.get("SENTINEL_EXTRA_PROCESSED_DIR", "")
    out = set()
    for root in (r for r in extra.split(os.pathsep) if r.strip()):
        if os.path.isdir(root):
            out |= _scan_dir(root)
    return out


known = registered | processed | archived | extra_known()
fresh = [p for p in parsed if p["token"] and p["token"] not in known]

if not fresh:
    print("✅ 窗口内无未归档新稿")
    raise SystemExit(0)

# ---------- 3. 批量拿关键词/摘要，只为未归档的新稿（+detail 一次最多 50 个 token → ≤40 一批） ----------
mins = []
for i in range(0, len(fresh), 40):
    batch = ",".join(p["token"] for p in fresh[i:i + 40])
    det, err = sh("lark-cli", "minutes", "+detail", "--as", "user",
                  "--minute-tokens", batch,
                  "--keyword", "--summary", "--format", "json")
    try:
        d = json.loads(det)
    except Exception:
        fail(f"详情接口返回非 JSON（stderr: {(err or '空')[:300]}）")
    if not d.get("ok", False):
        fail(f"详情接口报错：{json.dumps(d.get('error', {}), ensure_ascii=False)[:300]}")
    mins += d.get("data", {}).get("minutes", []) or []

def clean_summary(raw):
    """去掉 markdown 粗体/列表符，压成一段干净摘要，取首句完整意思。"""
    s = raw or ""
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)          # **粗体** → 粗体
    s = re.sub(r"^\s*[-•]\s*", "", s, flags=re.M)     # 列表符去掉
    s = re.sub(r"^#+\s*", "", s, flags=re.M)
    s = re.sub(r"\s+", " ", s).strip()
    # 摘要常以「内容如下：」开头，后面接 bullet 列表 → 只取到冒号为止的那句导语
    s = re.split(r"内容如下[:：]|content as follows", s)[0].strip()
    s = s.rstrip("：:，,。 ").strip()
    return s


info_by_token = {}
for m in mins:
    art = m.get("artifacts", {}) or {}
    kws = [k for k in (art.get("keywords") or []) if k]
    summ = clean_summary(art.get("summary"))
    info_by_token[m.get("minute_token")] = {"kws": kws, "summ": summ}

# ---------- 4. 输出到终端 ----------
rows = []
for p in fresh:
    info = info_by_token.get(p["token"], {"kws": [], "summ": ""})
    if not info["kws"] and not info["summ"]:
        continue  # 还没出稿，本轮不管（下轮再试）
    when = " ".join(x for x in (p["date"], p["time"]) if x)
    meta = " · ".join(x for x in (when, p["dur"]) if x)
    rows.append((p, info, meta))

if not rows:
    print("✅ 有新录音但都还没出稿（无关键词/摘要）→ 等下一轮")
    raise SystemExit(0)

print(f"🎙 **妙记扫描 · {len(rows)} 条未归档新稿**（仅本地输出，不发送）")
print()
for idx, (p, info, meta) in enumerate(rows, 1):
    print(f"**{idx}. {p['title'] or '(无标题)'}**" + (f"　`{meta}`" if meta else ""))
    if info["summ"]:
        summ = info["summ"]
        if len(summ) > 120:
            summ = summ[:120].rstrip() + "…"
        print(f"　{summ}")
    if info["kws"]:
        print(f"　🏷 {'、'.join(info['kws'][:6])}")
    _link = p.get("link") or ""
    if not _link and FEISHU_HOST:
        _link = f"https://{FEISHU_HOST}/minutes/{p['token']}"
    print(f"　🔗 {_link or p['token']}")
    print()
print("—— 已归档的稿不会再列出；还没出稿的等下一轮。")
