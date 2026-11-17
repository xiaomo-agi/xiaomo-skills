# 哨兵 · Hermes 版安装指南

> 首次安装时，AI 自动执行以下步骤。用户只需确认默认配置。
> 本版本是**静默哨兵**：装好后它定时扫描、自动归档，**不发任何飞书消息**——结果去归档目录看。

---

## Step 0 · 前置检查

```bash
# Hermes 版本
hermes --version

# lark-cli 是否可用
lark-cli --version

# python3（scripts 需要 ≥ 3.9，纯标准库）
python3 --version

# 飞书应用凭据
echo "${LARK_APP_ID:-未设置}" "${LARK_APP_SECRET:-未设置}"
```

**没装 lark-cli** → 官方文档安装后重跑本步。

---

## Step 1 · 安装 skill

把 `skills/sentinel-hermes/` 装进你的 Hermes profile：

```bash
# 方式一：从 git 仓库
hermes skill install <repo-url>/skills/sentinel-hermes --profile <你的profile>

# 方式二：从本地目录
hermes skill install /path/to/xiaomo-skills/skills/sentinel-hermes --profile <你的profile>
```

装完验证：

```bash
hermes --profile <你的profile> skill list
ls ~/.hermes/profiles/<你的profile>/skills/sentinel-hermes/
```

---

## Step 2 · 飞书授权（只需只读权限）

本 skill 只**读**妙记，不写飞书任何东西（不发消息、不建任务）。

在[飞书开放平台](https://open.feishu.cn/app)建应用，开通权限：

| 权限 | 用途 |
|---|---|
| `minutes:minutes:readonly` | 读妙记列表与逐字稿 |
| `drive:drive:readonly` | 降级路：读「文字记录」Docx |
| `docs:document:readonly` | 降级路：读「智能纪要」Docx |

> ⚠️ **不要**多给写权限。本 skill 的设计边界就是「只读飞书、只写本地」。

把 App ID / App Secret 写进 profile 的 `.env`：

```bash
LARK_APP_ID=cli_xxxxxxxxxxxx
LARK_APP_SECRET=xxxxxxxxxxxx
```

用户授权（读用户自己的妙记需要 user token）：

```bash
lark-cli auth login --scope "minutes:minutes:readonly drive:drive:readonly docs:document:readonly"
lark-cli auth status --as user   # 验证授权状态
```

⚠️ **授权链接 10 分钟过期**，过期就重新跑一次。

---

## Step 3 · 配置路径

路径全部走环境变量。首次运行前设好：

```bash
# 归档根目录（必配，唯一必配项）——档案 md、TODO.md、.state/ 都在这
export SENTINEL_ARCHIVE=~/sentinel-archive

# 可选：共享登记表（多个 agent 共用一个去重账本时才配）
# export SENTINEL_REG=~/sentinel-archive/shared/minutes-processed.txt

# 可选：其他工具已归档过的目录（第四道去重，宽松匹配 token）
# export SENTINEL_EXTRA_PROCESSED_DIR=~/other-tool-archive

# 可选：owner 过滤（默认 me，只扫自己的妙记）
# export SENTINEL_OWNER=me

# 可选：脚本暂存目录（wide_scan 进度文件等，默认 ~/.cache/sentinel-hermes）
# export SENTINEL_SCRATCH=~/.cache/sentinel-hermes

# 可选：时区偏移小时数（默认 8=北京时间；海外 Lark 用户可改）
# export SENTINEL_TZ_OFFSET=8

# 可选：state / 闸门审计文件路径覆盖（默认在 $SENTINEL_ARCHIVE/.state/ 下，一般不用动）
# export SENTINEL_STATE=$SENTINEL_ARCHIVE/.state/state.json
# export SENTINEL_SEEN=$SENTINEL_ARCHIVE/.state/monitor_seen.json

# 可选：飞书租户域名（扫描输出里拼妙记链接用，如 xxx.feishu.cn）
# export FEISHU_HOST=xxx.feishu.cn
```

把这些写进 `~/.hermes/profiles/<你的profile>/.env`。

### 目录初始化

```bash
mkdir -p "$SENTINEL_ARCHIVE/.state"
[ -n "$SENTINEL_REG" ] && mkdir -p "$(dirname "$SENTINEL_REG")" && touch "$SENTINEL_REG"
```

⚠️ **必须自己建目录** —— 哨兵只在既有目录里写，不替你创建归档树（避免写错地方）。

建议把归档目录纳入 git（档案是重要资产，覆盖找回全靠它）。

---

## Step 4 · 挂 Hermes cron（定时 + 零 token 闸门）

一个 job 就够：**深度归档扫描**（agent 模式 + monitor 闸门）。

```bash
hermes --profile <你的profile> cron add \
  --id sentinel-deep-scan \
  --name "妙记深度归档扫描" \
  --schedule "5 7-23 * * *" \
  --script check_minutes_monitor.py \
  --prompt "开工先读本 profile 的 skills/sentinel-hermes/SKILL.md、rules.md、prompts.md，以文件为准。按 prompts.md 完整链路执行：时区实测 → 读状态 → 按天分段扫描 → 去重 → 拉逐字稿 → 提炼 → 归档 → fact_check → TODO.md → 更新状态。铁律：归档前必须过 fact_check；提炼里出现转写原文没有的断言 = 致命错误；无新妙记 → 静默收工；扫描失败 → 显式报警且不更新 last_scan。路径从环境变量读：SENTINEL_ARCHIVE / SENTINEL_REG / SENTINEL_SCRATCH。"
```

- **`--script check_minutes_monitor.py` 是零 token 闸门**：脚本输出字节不变（无新稿）→ Hermes 不唤醒 agent，本轮零成本。输出变了（有未处理的新稿）→ 才唤醒 agent 走完整链路。
- **按你的作息改 schedule**：`5 7-23 * * *` = 每天 7 点到 23 点，每小时第 5 分钟跑一次。夜间不扫（录音少且别吵）。
- **不接任何消息下发通道**：agent 收工输出为空（静默）。本 skill 的定位就是只归档、不通知——结果去 `$SENTINEL_ARCHIVE/` 看。

### 验证 cron

```bash
hermes --profile <你的profile> cron list
hermes --profile <你的profile> cron run sentinel-deep-scan   # 手动跑一次看效果
```

---

## Step 5 · 试跑

### 5.1 单次扫描

```bash
cd ~/.hermes/profiles/<你的profile>/skills/sentinel-hermes/scripts
python3 scan_minutes.py          # 打印窗口内未归档的新稿（终端直出，不发消息）
```

**输出为空** = 窗口内没有新妙记（正常）。
**输出报警文本** = 授权或接口有问题，按提示处理。

### 5.2 宽窗复查（怀疑漏扫时）

```bash
python3 wide_scan.py me --hours 720 --seg 12   # 30 天 / 12h 一段分段复查
```

### 5.3 校验一次档案（测机器校验层）

```bash
python3 fact_check.py <某个档案.md> --source <合并源文件>
```

---

## Step 6 · 日常使用

| 想做什么 | 怎么做 |
|---|---|
| 看归档结果 | 打开 `$SENTINEL_ARCHIVE/`，按 `YYYYMMDD_类型_主题.md` 浏览 |
| 看待办 | 打开 `$SENTINEL_ARCHIVE/TODO.md` |
| 查有没有漏 | 跑 `scripts/find_unprocessed_minutes.py --segmented-hours 720` |
| 问某条录音说了什么 | 直接问 agent：查档案 frontmatter 的 `minute_token:` 定位 |
| 手动触发一次 | `hermes --profile <你的profile> cron run sentinel-deep-scan` |

---

## 常见问题

| 现象 | 原因 | 修法 |
|---|---|---|
| 扫描没输出，但确实有录音 | 搜索索引滞后 | 加 `--live-hours 48` 拉线上搜索兜底；或用分段扫 |
| 「too many tokens」 | `+detail` 一次超 50 个 | 分批，每批 ≤40 |
| 单窗口恒返回 50 条 | API 硬截断 | 分段扫，每段实际返回 < 50 |
| 大窗翻页漏整天 | 翻页 bug | 按天分段查 + 按 token 聚合 |
| 99992361 | open_id 跨应用无效 | 用 `--owner-ids me`，别传 open_id |
| 99991400 | 搜索接口限流 | 段间 sleep + 指数退避（wide_scan.py 已内置） |
| 同一稿被归档两次 | 只查了一道去重 | 两道并集：state ∪ 档案 frontmatter |
| 档案里数字被判编造 | `--source` 传了裸 transcript | 传「元信息头 + 逐字稿」合并源文件 |
| cron 一直不触发 agent | 闸门输出没变（无新稿） | 正常——闸门就是干这个的；有新稿会自动唤醒 |

**任何异常** → 直接告诉 AI：「哨兵遇到了问题：[现象]」。AI 会收集错误信息、状态文件内容、相关命令输出和修复建议。

---

## 隐私说明

- skill 文件内**不含任何个人数据**（无硬编码路径、无真实 token、无个人 ID）
- 逐字稿与档案只落在你配置的 `SENTINEL_ARCHIVE` 本地目录，**不外发**
- skill 对飞书**只读**；对本地只写归档目录
- 删除一律走回收站（`trash`），不用 `rm`
