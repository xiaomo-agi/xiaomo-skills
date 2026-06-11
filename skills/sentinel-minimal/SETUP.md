# 轻量哨兵 — 安装配置指南

> 极简版本。只需要 lark-cli 一个外部工具。

---

## 前置条件

只需要安装一个工具：

```bash
# 安装 lark-cli（飞书命令行工具）
npm install -g @larksuiteoapi/lark-cli

# 登录飞书授权
lark-cli auth login
```

**权限要求**：飞书自建应用需开通 `minutes:app` 权限（读取妙记）。

---

## 安装检查流程

### Step 1: 检测环境

```
检测以下文件/目录是否存在：
□ output/sentinel-status.md（状态文件）
□ output/（工作目录）
```

### Step 2: 自动创建缺失项

如果检测到缺失，**不问用户，直接创建**：

**状态文件不存在** → 创建 `output/sentinel-status.md`，内容：

```markdown
---
name: sentinel-minimal-status
description: 轻量哨兵状态跟踪
metadata:
  type: project
---

## 轻量哨兵状态

- **last_checked**: <今天日期> 00:00
- **purpose**: 扫描飞书妙记新录音，提取内容存档到本地
- **workspace**: ./output/

## 已处理 token

## 失败队列（待重试）

（当前为空）

---

## 通用规则

- 只处理 last_checked 之后的新录音
- 已处理 token 不重复 fetch
- 没有新内容就静默结束

## 状态文件维护

- **裁剪规则**：已处理 token 保留最近 14 天，超过的归档到 `output/archive.md`
- **失败队列**：重试上限 3 次，超过标记为 abandoned
- **去重**：保留最早条目，删除重复 token
```

**output 目录不存在** → 创建 `output/` 目录

### Step 3: 配置变量（可选）

编辑 `rules.md` 顶部的配置区域：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SENTINEL_NAME` | 轻量哨兵 | 显示名称，可自定义 |
| `WORKSPACE_DIR` | `./output/` | 输出目录，可改 |

一般不需要改，用默认即可。

---

## 定时触发

轻量哨兵不内置定时功能，需外部触发：

| 方案 | 适合 | 配置 |
|---|---|---|
| mycc scheduler | 有 mycc 的用户 | 在 scheduler tasks.md 中加一行 |
| 系统定时任务 | Windows / macOS / Linux | 系统自带的定时任务工具 |
| 手动执行 | 偶尔用 | 直接对 AI 说"轻量哨兵扫描一下" |

**推荐**：手动执行最省心，需要时喊一声就行。

---

## 安装完成提示

创建完成后，给用户一条简短提示：

```
轻量哨兵已就绪！

已自动创建：
- output/（工作目录）
- output/sentinel-status.md（状态跟踪）

配置：
- 扫描范围：飞书妙记
- 输出位置：output/ 目录
- 分类：短录音（<5分钟）/ 长录音（≥5分钟）
- 不发送通知，结果存本地

使用方式：
- 手动：说"轻量哨兵扫描一下"
- 自动：配置定时任务（可选）

需要调整配置，随时跟我说。
```
