# 妨记哨兵 — 新用户 Onboarding

> 首次安装哨兵时，AI 自动执行以下步骤。用户只需确认默认配置即可开始使用。

---

## 安装检查流程

### Step 1: 检测环境

```
检测以下文件/目录是否存在：
□ memory/minutes-sentinel-status.md（哨兵状态文件）
□ 3-Thinking/daily-quotes/（金句归档目录）
□ 5-Archive/sentinel-history.md（历史归档文件）
```

### Step 2: 自动创建缺失项

如果检测到缺失，**不问用户，直接创建**：

1. **状态文件不存在** → 创建 `memory/minutes-sentinel-status.md`，内容：

```markdown
---
name: minutes-sentinel-status
description: 妙记哨兵状态跟踪
metadata:
  type: project
---

## 妙记哨兵状态

- **last_checked**: <今天日期> 00:00
- **purpose**: 每 60 分钟自动扫描飞书妙记新录音
- **exclude**: 标题含"流水账/复盘/日常工作/日常"的录音归 flomo-journal 处理

## 已处理 token

## 失败队列（待重试）

（当前为空）

---

## 通用规则

- 只处理 last_checked 之后的新录音
- 已处理 token 不重复 fetch
- 没有新内容就静默，不发通知

## 状态文件维护

- **裁剪规则**：已处理 token 保留最近 7 天，超过的归档到 `5-Archive/sentinel-history.md`
- **失败队列**：重试上限 3 次，超过标记为 abandoned
- **去重**：保留最早条目，删除重复 token

## 获取转录的正确路径

1. `lark-cli minutes minutes get --params '{"minute_token":"xxx"}' --as user` → 拿 note_id
2. `lark-cli docs +search --query "文字记录：标题关键词" --as user --format pretty` → 拿 doc token
3. `lark-cli docs +fetch --doc <token> --as user --format pretty` → 读内容
```

2. **daily-quotes 目录不存在** → 创建 `3-Thinking/daily-quotes/` 目录

3. **归档文件不存在** → 创建 `5-Archive/sentinel-history.md`：
```markdown
# 哨兵历史归档

> 存放超过 7 天的已处理 token 和超过重试上限的失败条目
```

### Step 3: 配置定时触发

**禁止使用 CronCreate**（7 天自动过期）。

根据用户环境选择定时方案：

**方案A：mycc scheduler（推荐，有 mycc 的用户）**

在 `.claude/skills/scheduler/tasks.md` 的「间隔任务」中添加：

```
| 每60分钟 | 妙记哨兵扫描 | - | 执行妙记哨兵完整流程（9步）... |
```

**方案B：系统 cron / Task Scheduler（无 mycc 的用户）**

用系统定时器调用 Claude Code CLI 执行哨兵 prompt。

**方案C：GitHub Actions（公开仓库）**

`cron: "0 * * * *"` 每小时触发 Claude Code 执行哨兵扫描。

---

AI 安装时自动检测：
1. 检查是否存在 `.claude/skills/scheduler/tasks.md` → 选方案A
2. 不存在 → 提示用户选方案B或C，并给出配置示例

### Step 4: 通知用户

创建完成后，给用户一条简短提示：

```
✅ 妨记哨兵已就绪！

已自动创建：
- 📁 3-Thinking/daily-quotes/（金句归档）
- 📄 memory/minutes-sentinel-status.md（状态跟踪）
- ⏰ 每 60 分钟自动扫描新录音（通过 scheduler / cron / GitHub Actions）

默认配置：
- 扫描频率：每 60 分钟
- 流水账录音 → 自动走 flomo-journal 流程
- 短录音 → 提取待办/素材/金句
- 长录音（≥5分钟）→ 完整信息资产分析

需要调整频率或规则，随时跟我说。
```

---

## 前置条件

用户需要已安装：
- `lark-cli`（飞书命令行工具）
- 已配置飞书授权（`lark-cli auth login`）
- `tell-me` skill（飞书通知）

如果缺少前置条件，提示用户安装，不要静默跳过。
