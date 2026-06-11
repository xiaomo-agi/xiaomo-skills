# 轻量哨兵 — Prompt 模板

> `{SENTINEL_NAME}` 每个步骤的执行指令模板。CC 和 Codex 共用。
> 名称变量定义在 `rules.md` 顶部"配置"区域，修改该处即可全局生效。

---

## 1. 搜索新录音

```
搜索飞书妙记中新录音。参数：
- 开始时间：{last_checked}
- 结束时间：{now} + 1 天 buffer
- 用户身份：--as user

命令：
1. lark-cli minutes +search --start {last_checked_date} --end {today_date+1} --as user --format json
   → 记录 items 数量和 page_token
2. 如有 has_more=true，继续用 --page-token 遍历所有页
   → 直到 has_more=false

验证：
- 返回的 items 数组非空则继续
- 为空则静默结束
- 记录总发现数（所有页累加）
```

---

## 2. 分类判断

```
根据以下妙记列表，按规则分类：

| token | 标题 | 时长 | 日期 |
{items_table}

分类规则（简化版，只分两类）：
- 时长 < 5 分钟 → 短录音
- 时长 ≥ 5 分钟 → 长录音

⚠️ 标题含 "soundcore Work" 是耳机自动录音的默认标题，**不是**低价值判断依据。必须按时长正常分类处理。

输出格式：
- 短录音：<token> | <标题> | <时长> → 短录音处理
- 长录音：<token> | <标题> | <时长> → 长录音处理
```

---

## 3. 获取转录（逐字稿优先）

```
获取妙记 {token}（标题：{title}）的转录内容。

⚠️ 逐字稿是主数据源，智能纪要只作辅助。

步骤：

【主路径：逐字稿】
1. lark-cli vc +notes --minute-tokens "{token}" --as user --format pretty --overwrite
   → 下载逐字稿到 minutes/{token}/transcript.txt
2. cat minutes/{token}/transcript.txt
   → 读取完整逐字稿内容

【辅助路径：智能纪要】（同时执行，用于了解结构）
3. lark-cli docs +search --query "{title_keywords}" --as user --format pretty
   → 模糊搜索，不要加前缀
   → 获取 doc_token 后读取

【备选路径：文字记录】（逐字稿下载失败时）
5. lark-cli docs +search --query "{title关键词}" --as user --format pretty
   → 模糊搜索
   → 获取 doc_token 后读取

验证：
- 逐字稿内容 > 50 字符 → ✅
- 逐字稿为空/失败，但文字记录 > 50 字符 → ⚠️ 降级处理
- 全部失败 → 标记 fetch_failed，入失败队列

注意：禁止将录音标记为"已删除"——逐字稿始终可获取。
```

---

## 4. 短录音提取（待办、素材、金句）

```
阅读以下逐字稿内容，提取三类信息：

【逐字稿内容】
{transcript}

【智能纪要参考】
{smart_notes} （仅用于了解结构，提取必须以逐字稿为准）

提取要求：

1. 待办/行动项：
   - 识别明确的 action items
   - 标注优先级（高/中/低）和 deadline（如有）

2. 内容素材（可直接用于社媒）：
   - 金句（可发朋友圈/短视频文案）
   - 观点/案例（可写成公众号/社媒帖子）
   - 标注：[来源:原话] + 适合渠道

3. 金句存档：
   - 格式：> "原话" — 上下文说明
   - **必须从逐字稿提取**，标注说话人身份
   - 没有就明确说"无金句"

输出格式：
## 待办
- [ ] 待办项 | 优先级：高/中/低 | deadline：xxx | 理由：xxx

## 内容素材
### 金句
> "原话" [来源:原话] → 适合：朋友圈/视频号

### 观点/案例
- 观点摘要 [来源:原话] → 适合：公众号/推特

## 金句存档
> "原话" — 上下文

步骤：
1. `mkdir -p {WORKSPACE_DIR}`（目录不存在则自动创建）
2. 写入文件：`{WORKSPACE_DIR}/YYYYMMDD_[{SENTINEL_NAME}]_<标题关键词>.md`
3. 如有金句，额外写入：`{WORKSPACE_DIR}/YYYYMMDD_[{SENTINEL_NAME}]_金句.md`

（无金句则不创建金句文件）
```

---

## 5. 长录音处理（核心摘要 + 待办 + 金句）

```
妙记 {token}（标题：{title}，时长：{duration}）为长录音。

⚠️ 必须逐字稿精读，不是扫读。

【数据源】
1. 逐字稿：minutes/{token}/transcript.txt（主数据源）
2. 智能纪要：辅助了解章节结构（可选）

【精读要求】
逐段阅读逐字稿，提取以下维度：

### 1. 核心主题
- 一句话概括这条录音讨论的核心

### 2. 关键要点（3-5条）
- 提取最重要的信息点

### 3. 具体可执行的方案/路径
- 工具名称、使用方法、操作步骤
- 成本数据、报价信息（如有）

### 4. 待办/行动项
- 识别明确的 action items
- 标注优先级和 deadline

### 5. 金句/原话
- 从逐字稿提取原话，标注说话人
- 禁止只从智能纪要提取

【输出格式】
## 核心主题
一句话概括

## 关键要点
1. xxx
2. xxx
3. xxx

## 可执行方案
- 方案1：xxx（工具/步骤/成本）
- 方案2：xxx

## 待办/行动项
- [ ] xxx | 优先级 | deadline

## 金句
> "原话" — 说话人X，上下文

步骤：
1. `mkdir -p {WORKSPACE_DIR}`（目录不存在则自动创建）
2. 写入文件：`{WORKSPACE_DIR}/YYYYMMDD_[{SENTINEL_NAME}]_<标题关键词>.md`
3. 如有金句，额外写入：`{WORKSPACE_DIR}/YYYYMMDD_[{SENTINEL_NAME}]_金句.md`
```

---

## 6. 更新状态文件

```
更新 {WORKSPACE_DIR}/sentinel-status.md：

1. last_checked 改为当前时间 {now}
2. 已处理 token 追加到列表，格式：
   - <token> — <标题> (<日期时间>) ✅ (<备注>)

3. 检查裁剪：超过 14 天的 token 移到 {WORKSPACE_DIR}/archive.md
4. 检查失败队列：已成功的移除，失败的更新重试次数
```

---

## 7. 自检（扫描结束前）

```
{SENTINEL_NAME} 扫描自检：

1. last_checked 已更新为当前时间？ → 是
2. 所有新录音 token 已加入已处理列表？ → 是（{count} 条）
3. 逐字稿已获取？ → 是（所有 token 都已下载逐字稿或标记原因）
4. 失败队列为空？ → {是/否，如有列出}
5. 结果已存档？ → {已存档数量 / 无新内容}

禁止项检查：
- ❌ 没有 token 被错误标记为"已删除"
- ❌ 没有 token 被跳过不处理（除非用户明确排除）

如有未通过项，记录原因并加入失败队列。
```
