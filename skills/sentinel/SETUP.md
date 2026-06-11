# 妙记哨兵 — 安装配置指南

> 首次安装时，AI 自动执行以下步骤。用户只需确认默认配置即可开始使用。

---

## 前置条件（必须）

安装前请确保以下工具已就绪：

| 工具 | 用途 | 安装命令 |
|---|---|---|
| lark-cli | 读取飞书妙记、文档 | `npm install -g @larksuiteoapi/lark-cli` |
| tell-me skill | 飞书通知 | 见下方配置 |

### 1. 配置 lark-cli

```bash
# 登录飞书
lark-cli auth login

# 验证登录状态
lark-cli auth whoami
```

### 2. 创建飞书自建应用（获取 API 权限）

飞书妙记需要自建应用才能访问，步骤如下：

**Step 1: 创建应用**
1. 打开 [飞书开发者平台](https://open.feishu.cn/app)
2. 点击「创建企业自建应用」
3. 填写应用名称（如"妙记哨兵"），选择「企业自建应用」
4. 记录 **App ID** 和 **App Secret**

**Step 2: 添加权限**
在「权限管理」中添加以下权限：
- `minutes:app` — 访问妙记
- `im:chat:readonly` — 读取群信息
- `im:message:send_as_bot` — 以机器人身份发消息
- `docs:document:readonly` — 读取文档

**Step 3: 发布应用**
1. 「版本管理与发布」→「创建版本」
2. 填写版本号（如 1.0.0）和更新说明
3. 点击「申请发布」→「确认发布」
4. **必须发布后才能调用 API**

**Step 4: 配置 lark-cli 使用自建应用**

```bash
lark-cli auth login --app-id <你的AppID> --app-secret <你的AppSecret>
```

### 3. 配置 tell-me skill（飞书通知）

sentinel 扫描到有价值的录音后，通过 tell-me 发飞书通知。

tell-me 配置步骤：
1. 在飞书群里添加你的自建应用机器人
2. 记录群聊的 `chat_id`
3. 配置 tell-me skill 的 `config.json`：

```json
{
  "default_channel": "feishu",
  "feishu": {
    "chat_id": "你的群chat_id"
  }
}
```

获取 chat_id 的方法：
```bash
lark-cli im chat +list --as user --format json
```

---

## 安装步骤

### Step 1: 配置 WORKSPACE_DIR

打开 `rules.md`，修改 `WORKSPACE_DIR`：

```yaml
WORKSPACE_DIR: ./output/   # 默认，相对 skill 目录
# 或
WORKSPACE_DIR: /Users/xxx/Documents/sentinel-output/  # 绝对路径
```

所有生成文件（金句、分析、状态）都会存到这个目录下。

### Step 2: 初始化目录结构

AI 自动创建以下目录：

```
{WORKSPACE_DIR}/
├── daily-quotes/          # 金句存档
├── inbox/                 # 长录音分析
├── archive/               # 历史归档
└── status.md              # 哨兵状态文件
```

**status.md 初始内容**：

```markdown
---
name: sentinel-status
description: 妙记哨兵状态跟踪
metadata:
  type: project
---

## 妙记哨兵状态

- **last_checked**: <今天日期> 00:00
- **purpose**: 每 60 分钟自动扫描飞书妙记新录音

## 已处理 token

## 失败队列（待重试）

（当前为空）

---

## 通用规则

- 只处理 last_checked 之后的新录音
- 已处理 token 不重复 fetch
- 没有新内容就静默，不发通知

## 状态文件维护

- **裁剪规则**：已处理 token 保留最近 14 天，超过的归档到 `{WORKSPACE_DIR}/archive/sentinel-history.md`
- **失败队列**：重试上限 3 次，超过标记为 abandoned
- **去重**：保留最早条目，删除重复 token
```

### Step 3: 配置定时触发

**禁止使用 CronCreate**（7 天自动过期）。

根据用户环境选择定时方案：

**方案A：mycc scheduler（推荐，有 mycc 的用户）**

在 `.claude/skills/scheduler/tasks.md` 的「间隔任务」中添加：

```
| 每60分钟 | 妙记哨兵扫描 | - | 执行妙记哨兵完整流程（8步）... |
```

**方案B：系统 cron / Task Scheduler（无 mycc 的用户）**

用系统定时器调用 Claude Code CLI 执行哨兵 prompt。

**方案C：GitHub Actions（公开仓库）**

`cron: "0 * * * *"` 每小时触发 Claude Code 执行哨兵扫描。

---

## 安装完成确认

创建完成后，检查清单：

```
✅ 妙记哨兵已就绪！

已配置：
- 📁 {WORKSPACE_DIR}/daily-quotes/（金句归档）
- 📁 {WORKSPACE_DIR}/inbox/（长录音分析）
- 📄 {WORKSPACE_DIR}/status.md（状态跟踪）
- ⏰ 每 60 分钟自动扫描新录音

默认配置：
- 扫描频率：每 60 分钟
- 短录音 → 提取待办/素材/金句 → 飞书通知
- 长录音（≥5分钟）→ 逐字稿精读 → 飞书通知
- 低价值 → 静默归档

可选增强：
- sk-info-assets skill → 长录音 8 节信息资产深度分析

需要调整频率或规则，随时跟我说。
```

---

## 故障排查

| 问题 | 原因 | 解决 |
|---|---|---|
| `lark-cli auth login` 失败 | 网络或账号问题 | 检查梯子，确认飞书账号有开发者权限 |
| 搜索妙记返回空 | 权限未开通 | 确认自建应用已发布，且有 `minutes:app` 权限 |
| tell-me 通知发不出去 | chat_id 错误或 bot 不在群里 | 检查 chat_id，确认 bot 已加入目标群 |
| 逐字稿下载失败 | 录音无逐字稿 | 改用「文字记录」文档路径 |
| 状态文件丢失 | WORKSPACE_DIR 被修改 | 检查 `rules.md` 中的 WORKSPACE_DIR 配置 |

---

## 可选：sk-info-assets 增强

如需长录音深度分析，可额外安装 sk-info-assets skill：

1. 将 sk-info-assets skill 放入 `.claude/skills/` 目录
2. sentinel 长录音处理时会自动调用
3. 不安装也不影响基础功能
