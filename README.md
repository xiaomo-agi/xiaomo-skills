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
| [tao](./skills/tao/) | 创业助手中台，分析问题涉及维度，自动调度子 skill 并行诊断，综合输出 |
| [tao-traffic](./skills/tao-traffic/) | 流量思维框架。13 个模型（占位/Match/下拉词/流量结构/超级客户/千川...），帮你诊断流量问题 |
| [tao-content](./skills/tao-content/) | 内容思维框架。9 个模型（有趣vs有用/洗稿/下拉词决策旅程...），帮你诊断内容问题 |
| [sentinel](./skills/sentinel/) | 飞书妙记哨兵。定时扫描新录音，自动提取待办、素材、金句，飞书通知你 |

> 持续更新中。有新 Skill 会加进来，Star 一下不会错过。

---

## 安装

把对应的 skill 文件夹复制到你的 Claude Code skills 目录：

```bash
# 克隆仓库
git clone https://github.com/xiaomo-agi/xiaomo-skills.git

# 复制你想用的 skill 到你的项目
cp -r xiaomo-skills/skills/tao /你的项目路径/.claude/skills/
cp -r xiaomo-skills/skills/sentinel /你的项目路径/.claude/skills/
```

每个 skill 文件夹里的 SKILL.md 是主文件，打开就知道怎么用。

---

## 各 Skill 详情

### tao（中台）+ tao-traffic + tao-content

涛哥创业思维框架合集。中台 `/tao` 自动分析问题涉及哪些维度，并行调度子 skill 综合诊断。

**tao-traffic（流量）**：
- 11 条核心信念（不可谈判的流量认知）
- 13 个思维模型（占位思维、Match 法则、种子-钩子-筛子、下拉词三阶段、流量结构健康度、超级客户与路径设计、本地生活关键词公式、千川投放决策逻辑...）
- 6 类信号诊断
- 27 条决策启发式
- 12 条反模式
- 12 个真实案例

**tao-content（内容）**：
- 8 条核心信念
- 9 个思维模型（有趣vs有用、传播感知力+表达力、洗稿大法、对标-拆解-复刻、下拉词=用户决策旅程...）
- 6 类信号诊断
- 24 条决策启发式
- 12 条反模式
- 9 个真实案例

**使用**：`/tao` 进入中台，说你的问题，自动分析维度并调度对应的子 skill。

### sentinel

飞书妙记自动扫描工具。每 60 分钟扫一次新录音，分类处理：

- 短录音（< 5 分钟）→ 提取待办、素材、金句
- 长录音（>= 5 分钟）→ 完整信息资产分析
- 流水账 → 自动入 flomo
- 低价值 → 静默归档

**依赖**：需要 [lark-cli](https://github.com/webernfe/lark-cli) 和飞书授权。

---

## 关注我

- **公众号**：小mo的AI日记（全网同名）
- **GitHub**：[xiaomo-agi](https://github.com/xiaomo-agi)
- **Twitter**：蓝V开通后补链接

有问题？加好友备注"来自 GitHub"。

---

## License

MIT — 随便用，注明出处就行。
