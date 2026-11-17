# 哨兵 · 执行流程模板

> 每个步骤的执行指令模板。规则定义在 `rules.md`，路径配置在 `SETUP.md`。
> 占位符：`{ARCHIVE}` `{STATE}` `{REG}` `{SCRATCH}` `{SENTINEL_NAME}`
> 本版本只做扫描 + 归档：不发通知、不建外部任务卡，待办只记本地 TODO.md。

---

## 1. 搜索新录音

```
扫描飞书妙记中的新录音。

配置（从环境变量或 state.json 的 paths 字段读）：
- 归档根目录：{ARCHIVE}
- 状态文件：{STATE}
- owner 过滤：me

步骤：
1. 实测时区：date +%z。妙记时间是北京时间，机器时区漂移时换算后再查。
2. 读 {STATE} 拿 last_scan。**若 last_scan > 当前时间，钳制到 now-5min**（否则 API 报 --start is after --end，增量窗整段作废）。
3. 增量搜索：
   lark-cli minutes +search --start <last_scan epoch> --end <now epoch> --as user --format json --page-size 30
4. **不要传 --owner-ids <open_id>**（跨应用报 99992361）。用 --owner-ids me 或不传。
5. **必须翻页到 has_more=false**，且**按天分段查**（每天一窗 + 段内翻页），按 token 聚合去重 —— 大窗翻页会漏整段。
6. 宽窗复查：回扩 3-5 天起，同样按天分段。
7. 解析每条的 token / 标题 / 开始时间 / 时长（**时长优先从 meta_data.description 取**，格式「所有者: x 开始时间: YYYY.M.DD HH:MM:SS 时长: N 分 M 秒」）。

输出：token 列表。空 → 静默结束（不要输出任何「无新录音」）。
```

---

## 2. 去重

```
对每个 token 判断是否已处理。**两道必查并集，任一命中即已处理**：

1. {STATE} 的 processed 数组
2. 档案 frontmatter 的 minute_token（扫 {ARCHIVE}/*.md 的头部）

可选第三道（配了才查）：
- {REG}：共享登记表（SENTINEL_REG），多 agent 共用时
- SENTINEL_EXTRA_PROCESSED_DIR：其他工具已处理的目录
—— 外部目录用宽松匹配：任意行同时含 "token" 与 "obcn" 即收（字段名变体很多，
   严匹配 `minute_token[_0-9]*:` 会漏掉一半）。

命中的 → 补进 processed（若不在），不归档。
未命中的 → 进入第 3 步。
```

---

## 3. 获取逐字稿

```
获取妙记 {token}（标题：{title}）的逐字稿。

路 1c（首选，万能兜底）：
  cd {SCRATCH} && lark-cli minutes +detail --as user --minute-tokens {token} \
    --transcript --output-dir ./td --overwrite --format json
  产物在 ./td/artifact-<标题>_<token>/transcript.txt

⚠️ --output-dir 有白名单（cwd / /tmp / ~/files）——先 cd 再用相对路径。
⚠️ 产物目录名带标题原文（含空格），不要用 shell for f in $(find ...)，
   用 Python os.walk 读。
⚠️ 批量拉时一次最多 50 个 token，超了报 too many tokens → 按 ≤40 一批分批拉。

路 1b：note +transcript 报 "is not a unified note (note_display_type=normal,
      verbatim_doc_token=XXX)" 时，错误信息里的 verbatim_doc_token 直接喂
      docs +fetch --doc <token>。

路 2：docs +search --query "文字记录：{标题关键词}" --as user → docs +fetch
路 3：drive +search --query "智能纪要 {标题关键词}" --as user → 读底部文字记录区块

验证：内容 > 50 字符且非报错文本。
⚠️「成功取到」≠「有内容」：可能只有一行乱码或空壳。
   此时不要跳过 token（跳过=静默失败），也不要推测补写（保真红线）——
   按实存内容如实建档，写明「转写不可辨识」。
三路全败 → 记入 {STATE} 的 failed 数组。
```

---

## 4. 提炼（按时长分流）

```
{transcript}

⚠️ 提炼里出现转写原文没有的断言 = 致命错误。数字、日期、人名、归属一个都不能编。
⚠️ 他人分享 ≠ 用户原创 —— 转述的方法论/案例要标明「他人分享，用户收藏」。

【时长 < 5 分钟】→ 待办 / 内容素材 / 金句
- 待办：说话人明确要做的事，带原文引证。**不确定是不是待办 → 归素材并标待确认**。
- 素材：有复用价值的信息点、观点、数据。
- 金句：最亮的原话 1-3 条，保留原始措辞。

【时长 ≥ 5 分钟】→ 八节信息资产
Recap / Business / Content / Tools / Actions / Dashboard / Closing / Relationship
- 记录带稳定 ID，引用带时间戳 [00:23:45]（秒级，不带小数）
- 超长（>1h）分块处理，逐块提炼后汇总
- 会议/面试类重点在 Recap + Actions；课程类重点在 Content + Tools

【归属标注】
- 长录音里若主说话人是对方（老师/商家/朋友），Business/Actions 记的是**对方的**，
  不是用户的待办 → 不进 TODO.md，档案里注明「对方的事」。
- 说话人身份不猜 → 标「未识别说话人」或注明推断依据。
```

---

## 5. 归档

```
写档案到 {ARCHIVE}/YYYYMMDD_<类型>_<主题slug>.md

类型 ∈ {面试, 会议, 灵感, 课程, 其他}；slug ≤15 字；同日同主题冲突加 -2。

⚠️ 写前先 ls 目标名 —— 已存在且 frontmatter 的 minute_token 与本次不同
   → 改名加后缀，不要覆盖。批量写完校验全库 minute_token 无重复。

结构（缺一不可）：
---
date: YYYY-MM-DD
duration: Nmin Ns
type: <类型>
source: 飞书妙记 <token>
minute_token: <token>
keywords: [3-6 个干净关键词]
---

# <主题slug>          ← 一级标题，缺这行机器校验判 P0

## 三句话摘要
1. …（这一节是检索层，给未来的查询用，必须无错别字）

---

## 提炼

### 待办
### 内容素材
### 金句

---

## 转写全文
（逐字稿零删改）

⚠️ 元数据头（frontmatter + 三句摘要）是**检索层**，转写全文是**证据层**，两层不合并。
⚠️ 超长稿（>2万字符）：存开头 500 字符样例 + 取回命令，不必全量粘。
```

---

## 6. 机器校验（强制）

```
逐个跑（批量写成循环跑完全部，全绿再动状态）：

python3 <skill目录>/scripts/fact_check.py <档案路径> --source <合并源文件>

--source 传「妙记元信息头 + 逐字稿原文」的合并源文件，**不要传裸 transcript**
（frontmatter 里的长 token 数字会被判编造 → P0）。

exit=0 才许写 {STATE}。
exit=1 → 按输出逐条修后重跑：
- 编造数字 → 删或标「待确认」
- 残留标记 → 转写原文自带的不改原文，人工确认后重跑加 `--allow-residue`
- 引用修复 → 见 rules.md §五 的四条常见 P0
```

---

## 7. TODO 账本（待办的唯一去向）

```
第 4 步提炼出的待办 → 记入 {ARCHIVE}/TODO.md：

- [ ] <待办内容> | 来源：YYYYMMDD_档案.md | 录音时间 HH:MM

⚠️ 只记本地 TODO.md，**不建任何外部任务卡、不派活**。
⚠️ 归属是别人的待办 → 不记，档案里注明「对方的事」。
⚠️ 不确定是不是待办 → 不记，档案素材区标「待确认」。
⚠️ TODO.md 与档案互相索引，销待办两边一起销。
```

---

## 8. 更新状态与登记

```
⚠️ 登记放最后一步（提前登记会让扫描器以为已处理而漏报）。

{STATE}：
- processed 追加纯 token 字符串（**不放 dict**，脚本用 set() 去重会崩）
- last_scan = 本次窗口终点
- failed 追加失败的 token
- 用 json.load + append + json.dump 写，不要手写整个 JSON
- 配了共享登记表（SENTINEL_REG）→ 末尾追加一行：
  minute_token: <token> | YYYY-MM-DD | {SENTINEL_NAME} | 一句话说明
  （只追加，不改别人的行）
- 批次整理的总览文档也要登记：写「（总览）」行 + 各 token 行
```

---

## 9. 收工自检

```
1. last_scan 已更新？
2. 所有新录音 token 已进 processed？（去重并集比对后未处理为 0？）
3. 失败队列为空？如有 → 列出（失败≠事故，静默失败才是事故）
4. 档案 / TODO.md 已落盘？
5. ⚠️ 收工前二次复查：再拉一次不同时间窗，确认未处理为 0
   （索引收录发生在扫描过程当中，一次复查不够）
6. ⚠️ 除档案目录外没写任何文件？没留下 tmp/中间 JSON？
7. 用了 git 的话：只 add 归档目录的文件，精确到路径，禁止 git add .
```

---

## 10. 批次统一整理（多条同主题）

```
一次录了 N 条同主题录音时：

1. 逐条档案照常出（每条一个 md）
2. 再出一份总览 YYYYMMDD_灵感_<主题>总览.md：
   - 按层次/模块串起来
   - 指出这是**一个大工程**而非 N 个孤立待办
   - 标出**前置闸门**（哪一步没完成后面不能动）
   - 标出**贯穿的动机/目标线**
   - 末尾给**建议的执行顺序**（先做不依赖闸门的那件）
   - 方法论详见 references/batch-unified-review.md
3. 总览也要登记 state.json（「（总览）」行 + 各 token 行）
```
