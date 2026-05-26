---
name: sentinel
description: 妙记哨兵。自动扫描飞书妙记新录音，提取待办、内容素材、金句，飞书通知用户。也支持手动粘贴文本处理。触发词："哨兵"、"扫妙记"、"新录音"、"sentinel"、"处理这段文本"
---

# 妙记哨兵

每 60 分钟自动扫描飞书妙记新录音，分类处理：

- **短录音（< 5分钟）**：提取待办、内容素材、金句 → 飞书通知
- **长录音（≥ 5分钟）**：触发 sk-info-assets 完整 8 节分析
- **流水账类**：触发 flomo-journal 流程
- **低价值**：静默归档

---

## 核心规则

详见 [rules.md](./rules.md)。执行流程见 [prompts.md](./prompts.md)。

## 安装

详见 [SETUP.md](./SETUP.md)。

## 依赖

| 依赖 | 用途 | 必装 |
|---|---|---|
| lark-cli | 读取妙记 | 是 |
| tell-me skill | 飞书通知 | 是 |
| sk-info-assets skill | 长录音 8 节分析 | 可选（无则长录音降级为短录音处理） |
| flomo-journal skill | 流水账自动入 flomo | 可选（无则流水账按短录音处理） |

## 定时触发

三种方案任选（详见 SETUP.md）：

| 方案 | 适合 | 配置 |
|---|---|---|
| mycc scheduler | 有 mycc 的用户 | 编辑 tasks.md 加一行 |
| 系统 cron | 无 mycc 的用户 | crontab 定时调 CC CLI |
| GitHub Actions | 公开仓库 | `.github/workflows/sentinel.yml` |

## 手动模式（无飞书也能用）

没有飞书妙记？直接把文本贴给 AI 一样处理：

1. 粘贴录音转录稿、会议纪要、或任何长文本
2. 说"哨兵处理一下"或"sentinel"
3. AI 自动分类并按规则处理：
   - 短内容（等效 < 5 分钟）→ 提取待办、素材、金句
   - 长内容（等效 ≥ 5 分钟）→ 信息资产 8 节分析
   - 流水账风格 → 整理成结构化笔记

输出格式和自动模式完全一致，只是输入从"飞书妙记"变成"你粘贴的文本"。

## 自定义名称

默认叫**哨兵**。你可以在 `rules.md` 里把 `SENTINEL_NAME` 改成"管家"、"助手"或其他名字，所有输出里的称呼会同步替换。

**装完后 AI 会问你**："要不要给哨兵改个名字？"

---

## 注意

- 禁止用 CronCreate 做定时触发（7 天自动过期）
- 状态文件在项目 `memory/minutes-sentinel-status.md`
- 金句存档在 `3-Thinking/daily-quotes/`
