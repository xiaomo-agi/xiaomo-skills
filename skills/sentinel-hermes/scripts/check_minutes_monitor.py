# -*- coding: utf-8 -*-
# 妙记扫描闸门（Hermes cron 的 monitor_script）。
#
# 作用：hermes 语义 = 输出字节不变 → 不唤醒 agent（零 token 闸门）。
#       静默哨兵每小时跑一次深度归档，多数时段无新妙记 → 不该每次都叫醒大模型白跑。
#
# 设计修订记录（实测踩坑，修过两次）：
#   v1 旧版把登记表【整行】塞进 done 集合、再用【裸 token】去查 → 永远查不中 →
#      已归档的妙记照样算"未归档"，输出其实是"24h 窗口内的妙记条数"，
#      窗口随时间滑动 → 每班都变 → 闸门常开白唤醒。
#      现改为：token 提取 + 去重并集 + owner=me 限定 + 分页拉全 + 稳定输出。
#   v2 旧版闸门量是「已报过总数」（seen 只增不减的累计数）有个死锁：agent 若某班
#      归档失败，token 已进 seen，下班 pending 为空 → 累计数不变 → 闸门
#      不再唤醒 → 该稿永久漏处理。
#   v3（当前）闸门量 = 未处理 token 集合的哈希 —— 只要还有没归档的，输出每班
#      都变（重试被唤醒）；全部归档完 → 哈希变回基线 → 静默零 token。
#
# 输出格式（字节级稳定）：
#   pending_total=<N>    N = 窗口内「尚未真正归档」的妙记数
#   pending_sig=<hash>   未处理 token 集合的哈希（集合不变 → 字节不变 → 不唤醒 agent）
#   failed=<token,token> state.failed 里仍未归档的（新增失败/失败被清掉时才变）
# 失败必须显式报警（输出变化即唤醒 agent 自查），绝不静默退出。
import subprocess, os, re, json, time, datetime, hashlib

# 归档根目录（必配，无默认值——避免误读到任何人的默认路径）
ARCHIVE = os.environ.get("SENTINEL_ARCHIVE", "")
# 可选：共享登记表（多 agent 共用去重账本）
REG = os.environ.get("SENTINEL_REG", "")
STATE = os.environ.get("SENTINEL_STATE", os.path.join(ARCHIVE, ".state", "state.json") if ARCHIVE else "")
SEEN = os.environ.get("SENTINEL_SEEN", os.path.join(ARCHIVE, ".state", "monitor_seen.json") if ARCHIVE else "")
OWNER = os.environ.get("SENTINEL_OWNER", "me")


def fail(msg):
    print(f"pending_total=monitor_error {msg}"[:80])  # 输出异常变化也会唤醒 agent 来自查
    raise SystemExit(0)


if not ARCHIVE:
    fail("SENTINEL_ARCHIVE not set")

def sh(*args):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=120,
                           env={**os.environ, "LARK_CLI_NO_PROXY": "1"})
    except subprocess.TimeoutExpired:
        return "", "timeout after 120s"
    return p.stdout, p.stderr


def _extra_known():
    """可选第三道：外部已处理目录（SENTINEL_EXTRA_PROCESSED_DIR，宽松匹配 token）。"""
    extra = os.environ.get("SENTINEL_EXTRA_PROCESSED_DIR", "")
    out = set()
    for root in (r for r in extra.split(os.pathsep) if r.strip()):
        if not os.path.isdir(root):
            continue
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


def load_seen():
    try:
        with open(SEEN, encoding="utf-8") as f:
            return {x if isinstance(x, str) else x.get("token", "")
                    for x in json.load(f).get("tokens", []) if isinstance(x, (str, dict))}
    except Exception:
        return set()


# ---------- 1. 已处理并集（state.json + 档案 frontmatter + 可选登记表） ----------
known = set()
failed = set()
st = {}
try:
    with open(STATE, encoding="utf-8") as f:
        st = json.load(f)
    known |= {x if isinstance(x, str) else x.get("minute_token", "")
              for x in st.get("processed", []) if isinstance(x, (str, dict))}
    failed = {x if isinstance(x, str) else x.get("minute_token", "")
              for x in st.get("failed", []) if isinstance(x, (str, dict))}
except Exception:
    pass
if REG:
    try:
        with open(REG, encoding="utf-8") as f:
            known |= set(re.findall(r"minute_token:\s*(\S+)", f.read()))
    except OSError:
        pass
for root, _dirs, files in os.walk(ARCHIVE):
    for fn in files:
        if not fn.endswith(".md"):
            continue
        try:
            with open(os.path.join(root, fn), encoding="utf-8", errors="ignore") as f:
                head = f.read(4000)
        except Exception:
            continue
        known |= set(re.findall(r"minute_token[_0-9]*:\s*(\S+)", head))
known |= _extra_known()

# ---------- 2. 窗口：下限取 min(近24h, last_scan) ----------
# 近 24h 覆盖索引滞后（妙记可能隔天才被搜索收录）；last_scan 更早时以它为准，
# 保证 agent 当班要扫的区间始终在闸门视野里。
now = int(time.time())
start = now - 24 * 3600
lc = st.get("last_scan")
if lc:
    try:
        start = min(start, int(datetime.datetime.fromisoformat(lc).timestamp()))
    except Exception:
        pass

# ---------- 3. 按天分段 + 段内翻页拉全量 ----------
# +search 默认只回第一页，且在 50 条处硬截断、has_more=false 不可信（rules.md #2/#55）。
# 单窗翻页不够 —— 闸门必须按天分段：每段独立翻页，段满 50 条输出警告（输出变化即唤醒自查）。
def pull_range(seg_start, seg_end):
    """拉一个时间窗的所有页。返回 (items, 是否疑似截断)。"""
    its, page, guard = [], None, 0
    while True:
        guard += 1
        if guard > 40:
            fail("pagination_guard")
        args = ["lark-cli", "minutes", "+search", "--as", "user",
                "--start", str(int(seg_start)), "--end", str(int(seg_end)), "--format", "json"]
        if OWNER:
            args += ["--owner-ids", OWNER]
        if page:
            args += ["--page-token", page]
        out, err = sh(*args)
        try:
            data = json.loads(out)
        except Exception as e:
            fail(f"parse:{e} stderr={(err or '')[:100]}")
        if not data.get("ok"):
            fail(str(data.get("error"))[:60])
        chunk = data.get("data") or {}
        its += chunk.get("items") or []
        if not chunk.get("has_more"):
            return its, False
        page = chunk.get("page_token")
        if not page:
            return its, True

items = []
truncated = False
cursor = start
DAY = 24 * 3600
while cursor < now:
    seg_end = min(cursor + DAY, now)
    got, trunc = pull_range(cursor, seg_end)
    if len(got) >= 50:
        truncated = True
    items += got
    cursor = seg_end
if truncated:
    print("WARNING: segment hit 50-cap; run scripts/wide_scan.py to recheck")

# ---------- 4. 闸门量：未处理集合的稳定哈希 ----------
# seen 只收「已真正处理完」的 token；未处理的留在 pending，
# 闸门输出 = 未处理 token 列表的哈希——只要还有没处理完的，输出就会变，
# 每班都会唤醒 agent 重试；全部处理完 → 输出变回基线 → 静默。
# 这样「未处理集合」本身就是单调可逆的闸门量，agent 失败可自动重试。
toks = {it.get("token") for it in items if it.get("token")}
pending_now = toks - known                       # 窗口内、还没被任何一道去重命中过的

# failed（state.failed 里仍未归档的）也算未处理，必须一起纳入闸门量
failed_pending = sorted(failed - known)
pending_all = sorted(pending_now | set(failed_pending))

# 输出 = 未处理集合的稳定哈希 + 计数。集合不变则字节不变 → 不唤醒；变了就唤醒。
pending_sig = hashlib.sha1("|".join(pending_all).encode("utf-8")).hexdigest()[:12]

# 仍写 seen（审计用：历史上报过哪些），但不参与闸门判定
seen = load_seen()
before = set(seen)
seen |= pending_now
if seen != before:                               # 集合没变就不重写（避免每班都把 git 弄脏）
    try:
        os.makedirs(os.path.dirname(SEEN), exist_ok=True)
        with open(SEEN, "w", encoding="utf-8") as f:
            json.dump({"tokens": sorted(seen), "updated": time.strftime("%Y-%m-%d %H:%M:%S")},
                      f, ensure_ascii=False, indent=1)
    except Exception as exc:
        print(f"⚠️ 闸门已报集合写入失败（可能重复唤醒）：{exc}")

# 闸门量：pending_sig 未变 → 字节完全一致 → monitor 判定 no_change → 不唤醒 agent
print(f"pending_total={len(pending_all)}")
print(f"pending_sig={pending_sig}")
print("failed=" + ",".join(failed_pending))
