# xiaomo-skills

小mo 的 Claude Code 自定义 Skills 合集。

---

大家好，我是小mo。海外社媒运营，非程序员，用 AI 写 App 的那种。

这个仓库放我自己写的 Claude Code Skill。每个都是我在实际使用中碰到问题、解决问题的产物。不是玩具，是真的天天在用的东西。

「学 AI 没有任何技巧，就是大量的用。用的足够多，就会发现哪个流程有问题，就会想优化、想迭代。」

这里面的 Skill 就是这么来的。

---

## Skills

| Skill | 说明 |
|---|---|
| [tao-traffic](./skills/tao-traffic/) | 流量思维框架。13 个模型（占位/Match/下拉词/流量结构/超级客户/千川...），帮你诊断流量问题 |
| [sentinel](./skills/sentinel/) | 飞书妙记哨兵。定时扫描新录音，自动提取待办、素材、金句，飞书通知你 |
| [mycc](./skills/mycc/) | Claude Code 小程序后端。手机/网页远程操控 CC，飞书双向通信，支持文件收发、流式卡片、Agent Teams |

> 持续更新中。有新 Skill 会加进来，Star 一下不会错过。

---

## 安装

把对应的 skill 文件夹复制到你的 Claude Code skills 目录：

```bash
# 克隆仓库
git clone https://github.com/xiaomo-agi/xiaomo-skills.git

# 复制你想用的 skill 到你的项目
cp -r xiaomo-skills/skills/tao-traffic /你的项目路径/.claude/skills/
cp -r xiaomo-skills/skills/sentinel /你的项目路径/.claude/skills/
cp -r xiaomo-skills/skills/mycc /你的项目路径/.claude/skills/
```

每个 skill 文件夹里的 SKILL.md 是主文件，打开就知道怎么用。

---

## 各 Skill 详情

### tao-traffic

涛哥流量思维框架。帮你诊断流量问题，给出可执行的下一步。

- 11 条核心信念（不可谈判的流量认知）
- 13 个思维模型（占位思维、Match 法则、种子-钩子-筛子、下拉词三阶段、流量结构健康度、超级客户与路径设计、本地生活关键词公式、千川投放决策逻辑...）
- 6 类信号诊断
- 27 条决策启发式
- 12 条反模式
- 12 个真实案例

**使用**：`/tao-traffic`，描述你的流量问题，自动诊断。

### sentinel

飞书妙记自动扫描工具。每 60 分钟扫一次新录音，分类处理：

- 短录音（< 5 分钟）→ 提取待办、素材、金句
- 长录音（>= 5 分钟）→ 完整信息资产分析
- 流水账 → 自动入 flomo
- 低价值 → 静默归档

**依赖**：需要 [lark-cli](https://github.com/webernfe/lark-cli) 和飞书授权。

### mycc

Claude Code 小程序后端服务。让你的手机/网页可以远程操控本地的 Claude Code。

- **多通道输出**：Web（网页/小程序）+ 飞书，可同时启用
- **飞书双向通信**：发消息到飞书 + 接收飞书消息回复，支持文本/图片/文件
- **流式卡片**：AI 回复实时更新到单张卡片，替代逐条消息轰炸
- **Agent Teams**：多 Agent 协作，一个后端管理多个项目
- **文件收发**：支持在飞书收发 PDF/Word/Excel 等文件
- **完整 API**：配对、聊天、历史记录、Skills 列表、SSE 实时广播

**使用**：安装到 `.claude/skills/mycc/`，配置 `.env` 后 `/mycc` 启动后端。

**依赖**：Node.js 18+，cloudflared（外网穿透）

---

## 反馈 & Issue

发现 bug、有功能建议、或者某个 Skill 不好用？直接开 Issue：

1. 点仓库上方的 **Issues** → **New issue**
2. 选对应模板（Bug report / Feature request）
3. 尽量描述清楚：
   - 你用的 Claude Code 版本
   - 触发方式（怎么复现）
   - 实际输出 vs 期望输出

也可以直接在公众号后台留言，看到会回。

---

## 关注我

- **公众号**：小mo的AI日记（全网同名）
- **GitHub**：[xiaomo-agi](https://github.com/xiaomo-agi)
- **Twitter**：蓝V开通后补链接

有问题？加好友备注"来自 GitHub"。

---

## 鸣谢

本项目在开发过程中受益于以下优秀的开源工具和创作者：

- **[sk-info-assets](https://github.com/situker/sk-info-assets)** by 金鑫 — 长文本信息资产分析框架，哨兵系统的长录音精读能力基于此实现

---

## 开发支持

本项目开发过程中使用了以下国产大模型：

**GLM 5.1** · **Deepseek V4 pro** · **Kimi 2.6**

---

## License

MIT — 随便用，注明出处就行。
