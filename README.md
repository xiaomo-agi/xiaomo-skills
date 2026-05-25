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
| [tao](./skills/tao/) | 创业助手入口路由，根据问题自动分发到对应思维框架 |
| [tao-traffic](./skills/tao-traffic/) | 流量思维框架。占位思维、Match 法则、不可能三角，帮你诊断流量问题找到突破口 |
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

### tao + tao-traffic

流量思维诊断工具。不是搜索「涛哥说过什么」，而是用涛哥看流量的方式帮你分析问题。

**包含**：
- 11 条核心信念（不可谈判的流量认知）
- 8 个思维模型（占位思维、Match 法则、种子-钩子-筛子...）
- 6 类信号诊断（流量虚无主义、追量不追质、平台依赖症...）
- 22 条决策启发式
- 10 条反模式（绝对不要做的事）
- 10 个真实案例

**使用**：`/tao` 进入路由，选流量相关会自动跳到 `/tao-traffic`。

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
