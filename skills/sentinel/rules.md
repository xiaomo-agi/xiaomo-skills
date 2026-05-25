# 妙记哨兵 — 核心规则

> 平台无关的哨兵逻辑。CC 和 Codex 各自用适配层读取本文件执行。
> 状态文件：`memory/minutes-sentinel-status.md`

---

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SENTINEL_NAME` | 哨兵 | 本 skill 的显示名称。可自定义为"管家"、"助手"等。修改此处即可全局生效，无需改其他位置。 |

> **使用方式**：所有下文中的 `{SENTINEL_NAME}` 均引用上表的值。
> CC / Codex 执行时读取此变量，替换到输出文本、文件名标记、通知消息中。

---

## 文件命名规则

**所有 `{SENTINEL_NAME}` 生成的文件，文件名必须包含 `[{SENTINEL_NAME}]` 标记。**

- 金句存档：`3-Thinking/daily-quotes/YYYYMMDD_[{SENTINEL_NAME}]_金句.md`
- 长录音分析：`1-Inbox/YYYYMMDD_[{SENTINEL_NAME}]_<主题>.md`
- 其他任何 `{SENTINEL_NAME}` 产生的文件：`<目录>/YYYYMMDD_[{SENTINEL_NAME}]_<描述>.<ext>`

目的：用户让 AI 搜索 `[{SENTINEL_NAME}]` 即可一键定位所有 `{SENTINEL_NAME}` 相关文档。

---

## 目标声明

**所有新妙记录音在 60 分钟内被处理。有价值内容已通知用户。金句已归档。**

每次扫描开始时声明此目标，扫描结束前必须通过自检：

| 检查项 | 通过条件 |
|---|---|
| last_checked 已更新 | 当前时间与 last_checked 差距 < 5 分钟 |
| 新录音全部处理 | 所有本次发现的 token 都在已处理列表中 |
| 失败队列可控 | 无新增失败项，或失败项已记录原因 |
| 金句已归档 | 有金句 → 文件已写入；无金句 → 明确标记"无" |
| 通知已发送 | 有高价值内容 → tell-me 已发出；无 → 静默通过 |

未通过项必须记录原因并加入失败队列，不能静默跳过。

---

## 扫描规则

### 搜索范围
- 起始时间：`last_checked` 时间（不含当天已处理的）
- 结束时间：当前时间
- 命令：`lark-cli minutes +search --start <last_checked日期> --end <今天日期> --as user`

### 排除规则
1. 已在"已处理 token"列表中的 → 跳过
2. 已清除标题的录音 → 跳过
3. 标题含"流水账/复盘/日常工作/日常" → 归 flomo-journal 处理，不在此流程

---

## 分类规则

| 类别 | 判断条件 | 处理方式 |
|---|---|---|
| 流水账 | 标题含"流水账/复盘/日常工作/日常" | flomo-journal skill（原话 + Bitable → 飞书确认 → flomo） |
| 短录音 | 时长 < 5 分钟，非流水账 | 读智能纪要 → 提取待办/素材/金句 |
| 长录音 | 时长 ≥ 5 分钟，课程/访谈/播客类 | sk-info-assets skill（8 节信息资产分析） |
| 低价值 | 时长 < 30 秒，环境音/测试/重复道歉 | 标记为"低价值"，存档不通知 |

---

## 提取规则（短录音）

从智能纪要中提取三类信息：

### 1. 待办/行动项
价值决策树：
- 「下周会让我做/改某事吗？」→ 否 → 降级，不单独通知
- 「能多次复用吗？」→ 是 → 高价值，重点通知
- 「有明确截止时间吗？」→ 是 → 高价值，标注 deadline

### 2. 内容素材
识别可直接用于社媒运营的内容：
- **金句**：可发朋友圈/短视频文案，标注 [来源:原话]
- **观点/案例**：可写成公众号/社媒帖子，标注适合渠道
- **适用渠道**：朋友圈 / 视频号 / 公众号 / 推特 / 小红书

### 3. 金句存档
- 候选金句 → `3-Thinking/daily-quotes/YYYYMMDD_[{SENTINEL_NAME}]_金句.md`
- 格式：`> "原话" — 上下文说明`
- 从 transcription（说话人原话）提取，不是从 AI 摘要提取

---

## 长录音处理规则

触发 `sk-info-assets` skill，走完整 8 节分析：
1. 核心主题
2. 关键观点
3. 论证逻辑
4. 案例/数据
5. 方法与工具
6. 金句/原话
7. 行动启发
8. 关联知识

---

## 获取转录的正确路径

```
1. lark-cli minutes minutes get --params '{"minute_token":"xxx"}' --as user
   → 获取 note_id

2. lark-cli docs +search --query "文字记录：<标题关键词>" --as user --format pretty
   → 搜索转录文档，获取 doc_token

3. lark-cli docs +fetch --doc <doc_token> --as user --format pretty
   → 读取转录全文
```

**禁止**：`lark-cli minutes +get`（不存在）、`lark-cli vc +notes`（缺 scope）、web reader（额度少）

---

## 验证规则

| 步骤 | 验收标准 | 失败处理 |
|---|---|---|
| 搜索妙记 | 返回结果含 `items` 数组 | 重试 1 次，仍失败 → 记入失败队列 |
| 获取 note_id | note_id 非空 | 标记 token 为 `fetch_failed`，入失败队列 |
| 读转录内容 | 内容长度 > 50 字符，非错误信息 | 尝试备选路径，仍失败 → 入失败队列 |
| 发飞书通知 | tell-me 返回成功 | 重试 1 次，仍失败 → 入失败队列，下次补发 |
| 金句归档 | 文件写入无报错 | 重试，仍失败 → 暂存到失败队列 |

---

## 通知规则

- 没有新内容 → 静默，不通知
- 短录音有高价值待办/优质素材 → `tell-me` 飞书通知
- 长录音处理完成 → 通知分析结果摘要
- 流水账 → 确认后再发 flomo
- 所有低价值录音 → 静默归档

---

## 状态文件维护

### 写入规则
- 每条处理完的 token 立即写入，格式：`- <token> — <标题> (<日期时间>) ✅ (<备注>)`
- 更新 `last_checked` 为当前时间

### 裁剪规则
- 已处理 token 保留最近 **7 天**
- 每次扫描后检查：超过 7 天的条目 → 移到 `5-Archive/sentinel-history.md`
- 归档格式：`<原条目> — 归档于 <日期>`

### 失败队列
- 失败条目保留在队列中，每次扫描先处理
- 成功 → 移除；仍失败 → 递增重试次数
- 最多重试 **3 次**，超过 → 标记 `abandoned` → 移到归档

### 去重
- 写入前检查 token 是否已存在
- 发现重复 → 保留最早条目，删除重复的

---

## 24 小时汇总报告

每天一次（建议 22:00），汇总过去 24 小时 `{SENTINEL_NAME}` 的工作：

```
📊 {SENTINEL_NAME}日报 {date}

今日扫描：{scan_count} 次
处理录音：{processed_count} 条
  - 短录音：{short_count} 条
  - 长录音：{long_count} 条
  - 流水账：{journal_count} 条
  - 低价值：{low_value_count} 条

提取成果：
  - 待办项：{todo_count} 条（高价值 {high_count}）
  - 内容素材：{material_count} 条
  - 金句归档：{quote_count} 条

失败队列：{failed_count} 条待重试
```

触发方式：在 22:00 那一轮扫描时自动附带日报。
当天无任何处理记录 → 不发日报。
