---
name: sentinel
description: 妙记哨兵。自动扫描飞书妙记新录音，提取待办、内容素材、金句，飞书通知用户。触发词："哨兵"、"扫妙记"、"新录音"、"sentinel"
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

## 注意

- 禁止用 CronCreate 做定时触发（7 天自动过期）
- 状态文件在项目 `memory/minutes-sentinel-status.md`
- 金句存档在 `3-Thinking/daily-quotes/`
