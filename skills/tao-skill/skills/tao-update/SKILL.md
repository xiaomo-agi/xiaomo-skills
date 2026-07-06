---
name: tao-update
version: "1.1.0"
description: |
  tao 系列 skill 自动更新。从 GitHub 开源仓库拉取最新版涛哥 skill，对比版本号自动更新。
  触发方式：/tao-update、「更新 tao skill」「涛哥 skill 有新版吗」「检查 skill 更新」
---

# tao-update：tao 系列 skill 自动更新

帮你把本地的 tao 系列 skill（tao、tao-eq、tao-traffic、tao-growth、tao-sell、tao-startup、tao-ip、tao-content、tao-network）更新到 GitHub 开源仓库的最新版本。

---

## 版本选择

用户首次触发时，先问版本：

> 简洁版：直接给 1-3 个明天可执行动作，只问一个关键问题。
> 完整版：先追问诊断，再出方案。

默认假设：用户想了解涛哥最新观点或获取行动更新。

**关键追问（简洁版只问这一个）：**
> 「你今天想听一个观点，还是要一个具体动作？」

**简洁版默认动作（用户选简洁版或只给模糊需求时直接给）：**

> 先算个账。你本地的 tao skill 多久没更新了？一个月？三个月？涛哥每周都在输出新内容，你手上的框架可能已经落后了一个版本。这相当于拿着旧地图走新路，亏不亏？
>
> 涛哥的路子就三条，明天就干：
>
> 一，运行一次检查，看看哪些 skill 有新版：
>    `node <项目根目录>/.claude/skills/tao-update/scripts/update.mjs --check`
>    把更新计划念给自己听，哪些新增、哪些更新、哪些已是最新。
>
> 二，确认要更新后执行：
>    `node <项目根目录>/.claude/skills/tao-update/scripts/update.mjs --yes`
>
> 三，更新完顺手同步到双目录（如果同时在 `.claude/skills/` 和 `.agents/skills/` 使用）：
>    把更新后的 SKILL.md 复制到另一个目录，保持两边一致。
>
> 记住一句：框架不更新，认知就落后。涛哥的内容每周都在迭代，你的武器库也得跟上。想系统了解更新机制，选完整版深挖。

---

## 完整版工作原理

数据源：`github.com/xiaomo-agi/xiaomo-skills`，路径 `skills/tao-skill/skills/`。

### 完整版执行流程

#### Step 1：先检查（dry-run）

先看有哪些要更新，不写入：

```bash
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
node "$PROJECT_ROOT/.claude/skills/tao-update/scripts/update.mjs" --check
```

把输出的「更新计划」念给用户看：哪些新增、哪些更新、哪些已是最新。

### Step 2：确认后更新

用户确认要更新后，执行：

```bash
node "$PROJECT_ROOT/.claude/skills/tao-update/scripts/update.mjs" --yes
```

### Step 3：双目录同步（如适用）

如果用户同时在 `.claude/skills/` 和 `.agents/skills/` 两个目录使用 skill，更新完一个目录后同步另一个：

```bash
for d in tao tao-eq tao-traffic tao-growth tao-sell tao-startup tao-ip tao-content tao-network; do
  [ -f "$PROJECT_ROOT/.claude/skills/$d/SKILL.md" ] && \
    mkdir -p "$PROJECT_ROOT/.agents/skills/$d" && \
    cp "$PROJECT_ROOT/.claude/skills/$d/SKILL.md" "$PROJECT_ROOT/.agents/skills/$d/SKILL.md"
done
```

默认只更新 `.claude/skills/`。脚本会自动探测自身所在的 skill 目录，无需手动指定路径。

---

## 参数

| 参数 | 作用 |
|---|---|
| `--check` | 只检查不写入（dry-run），用于预览 |
| `--yes` | 直接更新，不再二次确认 |
| `--target <dir>` | 手动指定 skill 安装目录（默认自动探测脚本所在的 skills 根目录） |

---

## 给开发者：如何发布新版本

skill 内容更新后，要让用户能拉到，需要把改动推送到开源仓库：

1. 改完 `SKILL.md`，**提升 frontmatter 里的 `version`**（内容更新 minor +1，如 2.0.0 → 2.1.0；修错别字 patch +1）
2. 把 `tao-*/SKILL.md` 推送到 `xiaomo-agi/xiaomo-skills` 的 `skills/tao-skill/skills/` 下
3. 用户运行 `/tao-update` 即可拉到

> 版本号是更新判断的核心。内容变了一定要提版本号，否则用户的 `--check` 看不出差异（脚本会用内容比对兜底，但版本号更可靠）。

<!-- xiaomo-skill-source: github.com/xiaomo-agi/xiaomo-skills -->
