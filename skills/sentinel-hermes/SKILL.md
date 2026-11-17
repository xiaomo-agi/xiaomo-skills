---
name: sentinel-hermes
description: 飞书妙记哨兵（Hermes Agent 版）。自动扫描飞书妙记新录音 → 拉逐字稿 → 归档全文 + 提炼待办/素材/金句，全部落在本地归档目录，静默不打扰、不外发任何数据。需要 Hermes Agent + lark-cli。触发词："哨兵"、"扫妙记"、"新录音"、"sentinel-hermes"
version: 1.0.0
---

# 妙记哨兵 · Hermes 版（扫描 + 归档）

把飞书妙记变成**可检索的本地档案库**，而不是一堆躺在云端的录音。

本版本只做一件事：**自动扫描 + 自动归档**。不发通知、不建外部任务卡、不写任何第三方系统——所有产出都落在你自己的归档目录里，逐字稿不出你的机器。

```
扫描 → 两道去重 → 拉逐字稿 → 提炼 → fact_check → 归档 + TODO 账本 → 更新状态
```

## 适合谁

- 有 **Hermes Agent**（或其他常驻 agent），想让它在后台定时值守妙记
- 只想要「录音 → 本地档案」的闭环，不要机器人反复发消息打扰
- 在意隐私：skill 内不含任何个人数据，配置全部走你自己的环境变量

## 三个版本怎么选

| 功能 | sentinel | sentinel-minimal | sentinel-hermes（本 skill） |
|---|---|---|---|
| 扫描妙记 | 有 | 有 | 有（带零 token 闸门，无新稿不唤醒 agent） |
| 实战坑位 rules | 基础 | 基础 | 完整（搜索/去重/拉稿/校验全链路踩坑记录） |
| 归档全文 + 提炼 | 有 | 摘要级 | 有（全文 + 三句摘要 + 待办/素材/金句） |
| 机器校验 fact_check | 无 | 无 | 有（归档前强制，防编造） |
| Hermes 定时 + 闸门 | 无 | 无 | 有 |
| 飞书通知 | 有 | 无 | **无（静默）** |
| 依赖 skill | tell-me 等 | 无 | 无，仅需 lark-cli |

## 什么时候用

- 定时触发（Hermes cron）→ 按 [prompts.md](./prompts.md) 走完整链路；闸门判定无新稿时 agent 不被唤醒
- 用户说「扫妙记」「读一下妙记」「新录音」→ 走 prompts.md §1-§9
- 用户问「我还有啥没归档」→ 跑 `scripts/find_unprocessed_minutes.py`
- 用户问某条录音里说了什么 → 查档案 frontmatter 的 `minute_token:` 定位，再读全文
- 怀疑漏扫 → 跑 `scripts/wide_scan.py` 宽窗分段复查
- 批量同主题录音 → 见 [references/batch-unified-review.md](./references/batch-unified-review.md)

## 目录布局（唯一正本）

```
<归档根目录>/                      ← 用户自选，见 SETUP.md
├── YYYYMMDD_<类型>_<主题>.md      ← 妙记档案 md（唯一可写目录）
├── TODO.md                        ← 待办账本（只记本地）
└── .state/
    ├── state.json                 ← processed / failed / last_scan
    └── monitor_seen.json          ← 闸门审计（历史上报过哪些）
```

**写档案前先 `ls` 目标目录确认路径**——同名目录会让新旧两份并存，闸门读新的、旧的那份永远不更新还被 git 当成删除。

## 核心规则速查（完整版见 rules.md）

### 扫描

```bash
lark-cli minutes +search --start <epoch> --end <epoch> --as user --format json
```

- **不要传 `--owner-ids <open_id>`**——open_id 是应用维度的，传用户自己的也会报 `99992361`。用 `--owner-ids me` 或干脆不传。
- **`+search` 在 50 条处硬截断，`has_more=false` 是假的**。按天分段查（每天一窗 + 段内翻页），按 token 聚合去重。
- **`+detail` 一次最多 50 个 token**，超了报 `too many tokens` → 按 ≤40 一批分批拉。

### 去重（两道必查 + 可选第三道，任一命中即已处理）

1. `state.json` 的 `processed` 数组
2. 档案 frontmatter 的 `minute_token:`
3. （可选）`SENTINEL_REG` 共享登记表 / `SENTINEL_EXTRA_PROCESSED_DIR` 外部已处理目录——多 agent 或多工具共用时才配

### 逐字稿（多路降级）

```bash
# 路 1c（万能兜底）
cd <scratch> && lark-cli minutes +detail --as user --minute-tokens <token> \
   --transcript --output-dir ./td --overwrite
```

- `--output-dir` 有白名单（当前工作目录 / /tmp / ~/files）。**先 cd 到目标目录再用相对路径**。
- 产物目录名带标题原文（含空格），**不要用 shell `for f in $(find ...)`**——用 Python `os.walk` 或 `find -print0`。
- **「成功取到」≠「有内容可提炼」**。可能只有一行乱码或空壳。不要跳过 token（跳过=静默失败），也不要推测补写（保真红线）——按实存内容如实建档，写明「转写不可辨识」。

### 归档格式

```markdown
---
date: YYYY-MM-DD
duration: Nmin Ns
type: 灵感
source: 飞书妙记 <token>
minute_token: <token>
keywords: [关键词1, 关键词2]
---

# 主题slug

## 三句话摘要
1. …

---

## 提炼

### 待办
### 内容素材
### 金句

---

## 转写全文
（零删改）
```

- **命名**：`YYYYMMDD_类型_主题slug.md`，类型 ∈ {面试, 会议, 灵感, 课程, 其他}
- **撞名**：写前先 `ls`——已存在且 token 不同 → 加后缀，不要覆盖
- **时长分流**：< 5min 走待办/素材/金句；≥ 5min 走八节信息资产（Recap/Business/Content/Tools/Actions/Dashboard/Closing/Relationship）
- **超长稿**（> 2 万字符）：存开头 500 字符样例 + 取回命令，不必全量粘
- **待办去向**：只记 `<归档根目录>/TODO.md`，不建任何外部任务卡

### fact_check（强制，不通过不许登记）

```bash
python3 <scripts>/fact_check.py <档案路径> --source <合并源文件>
```

- `--source` 传「妙记元信息头 + 逐字稿原文」的**合并源文件**，不要传裸 transcript（frontmatter 里的长 token 数字会被判编造）
- 退出码 0 才许写 state.json / 登记表
- 转写原文自带 `XXX` / `【待】` 等标记触发残留误判 → **不改原文**，人工确认后用 `--allow-residue` 显式豁免
- 批量写完把 fact_check 写成循环跑完全部文件，全绿再动状态

### 状态文件

```json
{
  "version": 2,
  "last_scan": "YYYY-MM-DDTHH:MM:SS+08:00",
  "processed": ["<token>", "..."],
  "failed": [],
  "note": ""
}
```

- **`processed` 只放纯 token 字符串，不放 dict**——脚本用 `set()` 去重，dict 不可 hash 会让闸门班次崩掉
- 写 state.json 用 `json.load` + append 纯字符串 + `json.dump`，不要手写整个 JSON
- **`last_scan` 可能是未来时间**（上一场 session 写的）→ 扫之前先比 now，last_scan > now 就钳制到 now-5min

### 静默与显式失败

- 本 skill **不发任何通知**。扫完即归档，无新稿静默收工；结果去归档目录看。
- 但**失败必须出声**：接口报错 / 授权失效 / 拉稿失败 → 写进 state 或当场报错，**严禁静默跳过**。漏扫不报告 = 系统已死。

### 删除

一律 `trash <路径>`（可从回收站找回），**禁止 rm / rm -rf**。删档案必须留墓碑：state.note 记「用户要求删除，勿再补档」，否则下次会被拉起来重新补档。

## 安装

见 [SETUP.md](./SETUP.md)。核心三步：飞书应用授权（只需只读权限）→ 配环境变量 → 挂 Hermes cron（带零 token 闸门）。

## 依赖

| 依赖 | 用途 | 必装 |
|---|---|---|
| lark-cli | 读取妙记与逐字稿 | 是 |
| python3 ≥ 3.9 | 跑 scripts/ | 是 |
| Hermes cron | 定时触发 + 闸门 | Hermes 用户必配；无 Hermes 可手动跑脚本 |
| fact_check.py（随 skill 附带） | 档案机器校验 | 是 |

## 遇到问题

直接告诉 AI：「哨兵遇到了问题：[现象]」。AI 会收集错误信息、状态文件内容、相关命令输出和修复建议。

---

## 附：路径适配

本 skill 里的路径都是**相对本 skill 目录**的（`scripts/`、`references/`）。安装后：

| 变量 | 默认 | 说明 |
|---|---|---|
| 归档根目录 | 环境变量 `SENTINEL_ARCHIVE`（必配） | 档案 md + TODO.md + .state/ |
| 共享登记表 | `SENTINEL_REG`（可选） | 多 agent 共用去重才配 |
| 外部已处理目录 | `SENTINEL_EXTRA_PROCESSED_DIR`（可选） | 其他工具已归档的目录 |
| owner 过滤 | `SENTINEL_OWNER`（默认 `me`） | 只扫自己的妙记 |
| 脚本暂存目录 | `SENTINEL_SCRATCH`（默认 `~/.cache/sentinel-hermes`） | wide_scan 进度文件等 |

**不要把绝对路径写死在 skill 里**——每个人的目录结构不同。首次运行时让用户指定归档根目录，写进 `state.json` 的 `paths` 字段。
