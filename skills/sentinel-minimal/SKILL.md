---
name: sentinel-minimal
description: 轻量哨兵。零依赖版本，只扫描飞书妙记新录音，提取待办和金句，结果存档到本地。不通知、不同步第三方。触发词："轻量哨兵"、"简单扫描"、"sentinel-minimal"
---

# 轻量哨兵

sentinel 的零依赖版本。只干一件事：扫描飞书妙记新录音，提取有价值内容，存档到本地。

---

## 和完整版 sentinel 的区别

| 功能 | sentinel（完整版） | sentinel-minimal（本 skill） |
|---|---|---|
| 扫描妙记 | 有 | 有 |
| 提取待办/金句 | 有 | 有 |
| 飞书通知 | 有（tell-me） | 无 |
| 长录音 8 节分析 | 有（sk-info-assets） | 无，降级为摘要 |
| 流水账处理 | 有（flomo-journal） | 无，按短录音处理 |
| 金句归档到 daily-quotes | 有 | 有（存到本地 output/） |
| 状态跟踪 | 有（memory/ 下） | 有（output/ 下） |
| 依赖 skill | tell-me、sk-info-assets、flomo-journal | 无 |
| 外部工具 | lark-cli | 仅 lark-cli |

**适合场景**：
- 不想装一堆 skill，只想简单扫描存档
- 不需要飞书通知，自己手动来看结果
- 测试环境或临时使用

---

## 核心规则

详见 [rules.md](./rules.md)。执行流程见 [prompts.md](./prompts.md)。

## 安装

详见 [SETUP.md](./SETUP.md)。

## 依赖

| 依赖 | 用途 | 必装 |
|---|---|---|
| lark-cli | 读取妙记 | 是 |

就这一个。

## 手动模式（无飞书也能用）

直接把文本贴给 AI 一样处理：

1. 粘贴录音转录稿、会议纪要、或任何长文本
2. 说"轻量哨兵处理一下"或"sentinel-minimal"
3. AI 自动分类并按规则处理：
   - 短内容（等效 < 5 分钟）→ 提取待办、素材、金句
   - 长内容（等效 ≥ 5 分钟）→ 提取核心摘要 + 待办 + 金句

输出格式和自动模式完全一致，只是输入从"飞书妙记"变成"你粘贴的文本"。

## 自定义名称

默认叫**轻量哨兵**。你可以在 `rules.md` 里把 `SENTINEL_NAME` 改成其他名字，所有输出里的称呼会同步替换。

---

## 注意

- 结果文件默认存放在 skill 目录下的 `output/` 文件夹
- 不发送任何通知，处理完静默结束
- 如需通知功能，请使用完整版 sentinel skill
