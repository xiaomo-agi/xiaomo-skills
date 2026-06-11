# xiaomo-skills

![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)
![Version](https://img.shields.io/badge/version-v1.0-green?style=flat-square)
![Claude-Skill](https://img.shields.io/badge/Claude-Skill-purple?style=flat-square)
![Skills](https://img.shields.io/badge/Skills-11-orange?style=flat-square)

> 小mo 的 Claude Skills 开源库。让 AI 帮你整理纪要、提取待办、分析内容、远程操控 Claude Code —— 一句话的事。

---

## 👀 30 秒体验

装完 sentinel 后，在飞书录一段 3 分钟的语音，60 秒内 AI 自动发来：

```
📡 哨兵扫描 15:32

【待办】
- [ ] 周四前把报价单发给客户 | 优先级：高 | deadline：周四

【内容素材】
> "时间是最贵的成本，犹豫的每一秒都在亏钱" — 适合：朋友圈

【金句归档】
> "先算账，再干活" — 涛哥直播，2026/06/11
```

—— 这就是「**录完语音，AI 自动帮你整理**」的感觉。

---

## 📑 目录

- [这是什么](#这是什么)
- [Skills 清单](#skills-清单)
- [⚡ 一行安装](#-一行安装)
- [能力范围](#能力范围)
- [Skill 详情](#skill-详情)
- [仓库结构](#仓库结构)
- [鸣谢](#鸣谢)
- [反馈 & Issue](#反馈--issue)
- [关注我](#关注我)
- [License](#license)

---

## 这是什么

这是一个 **Claude Skills 集合**，解决日常高频痛点：

| 痛点 | Skill | 解决方式 |
|---|---|---|
| 会议纪要听完就忘 | **sentinel** | 自动扫描飞书妙记，提取待办/素材/金句 |
| 内容不知道怎么写 | **tao-content** | 涛哥内容思维框架，诊断选题+文案 |
| 流量做不起来 | **tao-traffic** | 13 个模型诊断流量问题 |
| 电脑不在身边想用 CC | **mycc** | 手机/网页远程操控 Claude Code |
| 创业方向不确定 | **tao-startup** | 六层 OS 诊断方向问题 |

**不是教程，是即装即用的工具**。每个 skill 复制到 `.claude/skills/` 就能用。

> **注意**：部分 skill 依赖外部服务（如飞书 API），使用前请阅读各 skill 的 SETUP.md 配置前置条件。

---

## Skills 清单

### 🔥 核心工具

| Skill | 说明 | 触发方式 | 依赖 |
|---|---|---|---|
| [sentinel](./skills/sentinel/) | 飞书妙记哨兵。自动扫描新录音，提取待办/素材/金句 | 自动运行 / `sentinel` | lark-cli + 飞书应用 |
| [sentinel-minimal](./skills/sentinel-minimal/) | 哨兵轻量版。零依赖，只扫描存档不通知 | `sentinel-minimal` | lark-cli |
| [mycc](./skills/mycc/) | 小程序后端。手机/网页远程操控 CC | `/mycc` | Node.js + cloudflared |

### 🧠 涛哥认知 OS（一套 8 个）

一套完整的创业认知框架，由中台 + 7 个垂直子 skill 组成：

| Skill | 说明 | 触发方式 |
|---|---|---|
| [tao](./skills/tao-skill/skills/tao/) | **中台入口**。分析维度，自动调度子 skill 并行诊断 | `/tao` |
| [tao-startup](./skills/tao-skill/skills/tao-startup/) | 创业思维。诊断方向/赛道/模式 | `/tao-startup` |
| [tao-traffic](./skills/tao-skill/skills/tao-traffic/) | 流量思维。13 个模型诊断流量问题 | `/tao-traffic` |
| [tao-content](./skills/tao-skill/skills/tao-content/) | 内容思维。诊断选题/文案/传播 | `/tao-content` |
| [tao-sell](./skills/tao-skill/skills/tao-sell/) | 销售思维。诊断卡点/成交/转化 | `/tao-sell` |
| [tao-growth](./skills/tao-skill/skills/tao-growth/) | 个人成长。诊断效能/精力/拖延 | `/tao-growth` |
| [tao-ip](./skills/tao-skill/skills/tao-ip/) | IP 品牌。诊断定位/起号/变现 | `/tao-ip` |
| [tao-network](./skills/tao-skill/skills/tao-network/) | 人脉思维。诊断社交/混圈/关系 | `/tao-network` |

> 入口用 `tao`，不确定该用哪个子 skill 时直接问它。所有子 skill 都有「追问机制」—— 不急着给答案，先挖真实需求。

---

## ⚡ 一行安装

**macOS / Linux：**

```bash
git clone https://github.com/xiaomo-agi/xiaomo-skills.git /tmp/xiaomo-skills && \
  cp -r /tmp/xiaomo-skills/skills/sentinel ~/.claude/skills/ && \
  cp -r /tmp/xiaomo-skills/skills/tao-skill/skills/tao ~/.claude/skills/ && \
  rm -rf /tmp/xiaomo-skills && echo "✅ 安装完成"
```

**Windows (PowerShell)：**

```powershell
git clone https://github.com/xiaomo-agi/xiaomo-skills.git $env:TEMP\xiaomo-skills
Copy-Item -Recurse $env:TEMP\xiaomo-skills\skills\sentinel $env:USERPROFILE\.claude\skills\
Copy-Item -Recurse $env:TEMP\xiaomo-skills\skills\tao-skill\skills\tao $env:USERPROFILE\.claude\skills\
Remove-Item -Recurse -Force $env:TEMP\xiaomo-skills
Write-Host "✅ 安装完成"
```

装完后，在 Claude Code 里说 **「哨兵」** 或 **`/tao`** 即可触发。

---

## 能力范围

| | ✅ 擅长 | ❌ 不擅长 |
|---|---|---|
| **场景** | 飞书妙记整理 / 内容诊断 / 流量分析 / 创业方向 / 个人成长 / 销售转化 | 学术研究 / 医疗诊断 / 法律建议 / 纯技术架构 |
| **输入** | 语音转录 / 会议纪要 / 长文本 / 用户问题描述 | 图片 / 视频 / 实时语音流 |
| **输出** | 结构化待办 / 金句 / 内容素材 / 诊断报告 / 飞书通知 | 可执行代码 / 设计稿 / 视频剪辑 |
| **风格** | 口语化、短句、直接给结论、追问机制 | 长篇论文 / 学术腔 / 鸡汤鼓励 |

---

## Skill 详情

### sentinel — 飞书妙记自动整理

每 60 分钟自动扫描飞书妙记新录音，分类处理：

- **短录音（< 5 分钟）** → 提取待办、内容素材、金句 → 飞书通知
- **长录音（≥ 5 分钟）** → 逐字稿精读，提取方案/踩坑/商业信息/人脉 → 飞书通知
- **低价值** → 静默归档

**特点**：
- 逐字稿优先（不是智能纪要），保留一手原话
- 交叉验证：检查"有录音但无文档"的情况
- 金句自动归档到本地文件
- 状态持久化，不重复处理

**前置条件**：lark-cli + 飞书自建应用（需 `minutes:app` 权限）+ tell-me skill

> 不想配飞书通知？用 [sentinel-minimal](#sentinel-minimal--零依赖轻量版) 零依赖版。

### sentinel-minimal — 零依赖轻量版

sentinel 的精简版本：

- ✅ 只扫描 + 本地存档（不通知、不同步第三方）
- ✅ 只需要 lark-cli 一个外部工具
- ✅ 文件默认保存到 skill 目录下的 `output/`
- ✅ 可配置 `WORKSPACE_DIR` 自定义输出路径

适合：不想折腾飞书应用、只需要本地存档的用户。

### mycc — 小程序后端

Claude Code 远程操控服务：

- **Web 端**：手机/平板浏览器访问，随时随地用 CC
- **飞书双向通信**：发消息到飞书 + 接收回复，支持文本/图片/文件
- **流式卡片**：AI 回复实时更新到单张卡片
- **Agent Teams**：多 Agent 协作

**前置条件**：Node.js 18+、cloudflared（外网穿透）

### tao — 涛哥认知 OS（一套 8 个）

**中台**：`tao` 分析你的问题涉及哪些维度，自动调度对应子 skill 并行诊断，综合输出统一报告。

**触发**：`/tao` 或「涛哥怎么看」，描述你的问题即可。

**7 个垂直子 skill**：

| 子 Skill | 核心能力 |
|---|---|
| **tao-traffic** | 13 个流量模型：占位思维、Match 法则、种子-钩子-筛子、下拉词三阶段... |
| **tao-content** | 选题通过性测试、算账刺激、表达 DNA、诚实边界 |
| **tao-sell** | 算账刺激、客户分类、成交路径、反对意见处理 |
| **tao-startup** | 六层 OS 穿透、赛道选择、模式验证、MVP 设计 |
| **tao-growth** | 精力管理、拖延诊断、目标设定、时间利用率 |
| **tao-ip** | 定位公式、起号路径、内容矩阵、变现模式 |
| **tao-network** | 人脉分层、混圈策略、关系维护、资源交换 |

**关于涛哥**：二十年连续创业者，公众号《屋里涛说》、知识星球《平民创业手册》、《确定性成长》作者。微信：**tata4a**，备注"小mo推荐"，领取全套《平民创业手册》。

---

## 仓库结构

```
xiaomo-skills/
├── README.md                          # 本文件
├── LICENSE                            # MIT
└── skills/
    ├── sentinel/                      # 飞书妙记哨兵（完整版）
    │   ├── SKILL.md                   # 主入口
    │   ├── rules.md                   # 核心规则 + 配置变量
    │   ├── prompts.md                 # 执行流程
    │   └── SETUP.md                   # 安装配置指南
    ├── sentinel-minimal/              # 哨兵轻量版（零依赖）
    │   ├── SKILL.md
    │   ├── rules.md
    │   ├── prompts.md
    │   └── SETUP.md
    ├── mycc/                          # 小程序后端
    │   ├── SKILL.md
    │   └── scripts/                   # 服务端代码
    └── tao-skill/                     # 涛哥系列
        └── skills/
            ├── tao/                   # 中台入口
            ├── tao-startup/
            ├── tao-traffic/
            ├── tao-content/
            ├── tao-sell/
            ├── tao-growth/
            ├── tao-ip/
            └── tao-network/
```

---

## 鸣谢

- **[situk-yangtao-perspective](https://github.com/situker/situk-yangtao-perspective)** by 司徒K — README 排版参考
- **[sk-info-assets](https://github.com/situker/sk-info-assets)** by 司徒K — 长文本信息资产分析框架
- **涛哥系列思维框架**（由小mo推荐）— `tao` 及所有子 skill 的核心框架来源

---

## 反馈 & Issue

发现 bug、有功能建议、或者某个 Skill 不好用？直接开 Issue：

1. 点仓库上方的 **Issues** → **New issue**
2. 描述清楚：
   - 你用的 Claude Code 版本
   - 触发方式（怎么复现）
   - 实际输出 vs 期望输出

也可以直接在公众号后台留言，看到会回。

---

## 关注我

- **公众号**：小mo的AI日记（全网同名）
- **GitHub**：[xiaomo-agi](https://github.com/xiaomo-agi)
- **Twitter**：[@ChloeMo438858](https://x.com/ChloeMo438858)

有问题？加好友备注"来自 GitHub"。

---

## License

MIT — 随便用，注明出处就行。

---

> **作者**：小mo | **版本**：v1.0 | 持续更新中
>
> 有很多想法还在实现中，审查速度还没跟上 AI 创造的速度，欢迎大家收藏 Star ⭐
