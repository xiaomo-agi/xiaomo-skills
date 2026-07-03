# mycc 更新日志

## 1.0.0 (2026-07-03)

### 新增

- **一个 bot 多会话隔离**：私聊/普通群按群隔离，话题群按话题隔离；A 群跑长任务不阻塞 B 群；新群/新话题首条消息自动建会话
- **多 bot 支持**：最多 5 个飞书机器人通道（A–E），各通道会话独立
- **文件收发**：飞书里可直接发送/接收文件和图片
- **会话命令**：`/new` `/switch` `/current` `/status` 按群/话题粒度生效；新增 `/model`（模型切换并持久化）、`/skills`、`/agents`
- **系统服务守护**：`service start` 一键注册 OS 托管服务——macOS launchd / Linux systemd / Windows 计划任务 + watchdog，开机自启 + 崩溃自动重启
- **会话持久化**：每 bot 每会话的 sessionId 持久化，后端重启后自动恢复

### 稳定性

- WebSocket 看门狗 + 断线自动重连
- 会话可恢复错误自动重试（chatWithSessionRecovery）
- 消息缓冲合并（快速连发多条自动合并处理）
- 并发处理锁按会话粒度，互不阻塞
- 清理器不再误杀活跃会话

### 变更

- **移除网页端**（mycc.dev / cloudflared tunnel / 配对码流程）：项目聚焦飞书通道，websocket 长连接模式无需公网穿透、无需 cloudflared
- 移除只适用于特定机器的启动脚本（`start_backend.bat` / `start_hidden.vbs`）
- Windows 平台完整支持

## 0.5.2 及更早

见仓库提交历史。
