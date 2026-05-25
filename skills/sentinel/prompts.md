# 妙记哨兵 — Prompt 模板

> `{SENTINEL_NAME}` 每个步骤的执行指令模板。CC 和 Codex 共用。
> 名称变量定义在 `rules.md` 顶部"配置"区域，修改该处即可全局生效。

---

## 1. 搜索新录音

```
搜索飞书妙记中新录音。参数：
- 开始时间：{last_checked}
- 结束时间：{now}
- 用户身份：--as user

命令：lark-cli minutes +search --start {last_checked_date} --end {today_date} --as user

验证：返回的 items 数组非空则继续，为空则静默结束。
```

---

## 2. 分类判断

```
根据以下妙记列表，按规则分类：

| token | 标题 | 时长 | 日期 |
{items_table}

分类规则：
- 标题含"流水账/复盘/日常工作/日常" → 流水账
- 时长 < 5 分钟 → 短录音
- 时长 ≥ 5 分钟 → 长录音
- 时长 < 30 秒且标题含"soundcore Work" → 工作群短录音，低价值

输出格式：
- 流水账：<token> | <标题> → flomo-journal
- 短录音：<token> | <标题> | <时长> → 短录音处理
- 长录音：<token> | <标题> | <时长> → sk-info-assets
- 低价值：<token> | <标题> | <时长> → 静默归档
```

---

## 3. 获取转录

```
获取妙记 {token}（标题：{title}）的转录内容。

步骤：
1. lark-cli minutes minutes get --params '{"minute_token":"{token}"}' --as user
2. 从结果中提取 note_id
3. lark-cli docs +search --query "文字记录：{title_keywords}" --as user --format pretty
4. 从结果中提取 doc_token
5. lark-cli docs +fetch --doc <doc_token> --as user --format pretty

验证：返回内容 > 50 字符且不含错误信息。
失败：标记为 fetch_failed，入失败队列。
```

---

## 4. 短录音提取（待办、素材、金句）

```
阅读以下妙记转录内容，提取三类信息：

【转录内容】
{transcript}

提取要求：

1. 待办/行动项（用决策树筛选）：
   - "下周会让我做/改某事吗？" → 否 → 降级，不提
   - "能多次复用吗？" → 是 → 高价值，重点标注
   - "有明确截止时间吗？" → 是 → 标注 deadline

2. 内容素材（可直接用于社媒）：
   - 金句（可发朋友圈/短视频文案）
   - 观点/案例（可写成公众号/社媒帖子）
   - 标注：[来源:原话/引申] + 适合渠道（朋友圈/视频号/公众号/推特/小红书）

3. 金句存档：
   - 格式：> "原话" — 上下文说明
   - 只从说话人原话提取，不从 AI 摘要提取
   - 没有就明确说"无金句"

输出格式：
## 待办
- [ ] 待办项 | 优先级：高/中/低 | deadline：xxx | 理由：xxx

## 内容素材
### 金句
> "原话" [来源:原话] → 适合：朋友圈/视频号

### 观点/案例
- 观点摘要 [来源:原话/引申] → 适合：公众号/推特

## 金句存档
> "原话" — 上下文
写入文件：`3-Thinking/daily-quotes/YYYYMMDD_[{SENTINEL_NAME}]_金句.md`
（无金句则写"无"，不创建文件）
```

---

## 5. 长录音处理

```
妙记 {token}（标题：{title}，时长：{duration}）为长录音。
触发 sk-info-assets skill 进行完整的 8 节信息资产分析。

先获取转录内容，然后按 sk-info-assets 流程处理。
处理完成后，摘要发飞书通知。
```

---

## 6. 流水账处理

```
妙记 {token}（标题：{title}）为流水账类录音。

执行 flomo-journal 完整流程：
1. 获取转录原话
2. 查询 Bitable 当日工作记录
3. 整合原话 + 工作记录
4. 生成摘要，发飞书给用户确认
5. 用户确认后发 flomo
6. 更新 diary-sync-status.md
```

---

## 7. 发送飞书通知

```
用 tell-me skill 发飞书卡片通知用户：

格式：
📡 {SENTINEL_NAME}扫描 {scan_time}

【待办】
- [ ] xxx | 优先级 | deadline

【内容素材】
> "金句" → 朋友圈

【长录音处理】
《标题》— 8节分析完成，摘要：xxx

无值得通知的内容则不发送。
```

---

## 8. 更新状态文件

```
更新 memory/minutes-sentinel-status.md：

1. last_checked 改为当前时间 {now}
2. 已处理 token 追加到列表，格式：
   - <token> — <标题> (<日期时间>) ✅ (<备注>)

3. 检查裁剪：超过 7 天的 token 移到 5-Archive/sentinel-history.md
4. 检查失败队列：已成功的移除，失败的更新重试次数
```

---

## 9. 自检（扫描结束前）

```
哨兵扫描自检（即 `{SENTINEL_NAME}` 自检）：

1. last_checked 已更新为当前时间？ → 是
2. 所有新录音 token 已加入已处理列表？ → 是（{count} 条）
3. 失败队列为空？ → {是/否，如有列出}
4. 金句已归档？ → {已归档数量 / 无新金句}
5. 通知已发送？ → {已发送 / 无值得通知的内容}

如有未通过项，记录原因并加入失败队列。
```
