# Changelog

## v1.1.0 — 2026-11-14

仓库重建（fresh history），同步 2026-07 基线以来全部迭代（测试环境：macOS + Claude Code + SDK 0.2.63，2026-11；详见 README「测试环境记录」）：

- **卡片系统抹茶化（Card 2.0）**：容器按钮可点+回调、原生 table 组件（点开横屏查看）、审批卡/选项卡/按钮卡/会话卡全套构件统一 #6BA36A 视觉、KPI 行与绿头样式
- **工具调用折叠压缩**：流式卡折叠面板 + 静态卡折叠面板方案统一（复用 buildToolPanel），长任务不再刷屏
- **/ask 旁路询问**：观察员读实时轨迹答进度，不插话不进主任务；跟随默认模型
- **权限三代（意图级审批）**：红线直接拒 → 硬闸意图弹审批卡（说人话不说命令）→ 其余放行 + 轮末执行摘要卡事后验收；审批解释 AI 现场翻译；`setPrivatePushRemotes()` 可配置私有备份仓豁免
- **回收站删除**：删除类操作走 trash 免审，天然可逆
- **稳定性**：飞书断网凭证重试自愈、出站发送退避重试（网络异常/5xx/429）、消息合并窗口（350ms + 1s 硬封顶）、session 可恢复错误自动重试、WebSocket 看门狗
- **富媒体**：post 富文本图文混排整条解析（丢图修复）、多图聚合缓冲、文件收发
- **多通道**：`FEISHU{suffix}_*` 环境变量驱动多飞书应用通道（A/B/C/…），会话/模型/配对互相独立
- **可观测**：日志统一 HH:MM:SS 时间戳、/events SSE、health 接口、session 统计

## v1.0.0 — 2026-07-02

首次开源基线（cc-miniprogram → mycc）：飞书 WebSocket 长连接、多 bot 会话配对、/skills /model /agents 命令、schedule-api / wishlist-api / agent-router、Windows watchdog。
