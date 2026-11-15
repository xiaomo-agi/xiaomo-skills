---
name: mycc
description: 启动 mycc 后端服务（后台运行），通过飞书机器人远程操控 Claude Code。触发词："/mycc"、"启动 mycc"、"启动 mycc 后端"、"检查 mycc 状态"
---

# mycc

> 启动和管理 mycc 本地后端。不是 mycc 的开发。

启动 mycc 本地后端，通过飞书机器人（websocket 长连接）远程操控本地 Claude Code。

## 环境要求

| 要求 | 说明 |
|------|------|
| Claude Code | **必须是官方原版**，fork 版本可能不兼容 |
| Node.js | 18+ |
| 飞书 | 一个自建应用（机器人），App ID + App Secret 填入 `.env` |
| 系统 | ✅ macOS、✅ Linux、✅ Windows |

> 💡 **关于第三方 Claude Code**：目前仅测试了官方原版，第三方 fork 版本的兼容性支持在规划中。

## 触发词

- "/mycc"
- "启动 mycc"
- "启动 mycc 后端"
- "检查 mycc 状态"

## 执行步骤

### 1. 安装依赖（首次）

```bash
cd .claude/skills/mycc/scripts && npm install && cd -
```

### 2. 启动后端

```bash
.claude/skills/mycc/scripts/node_modules/.bin/tsx .claude/skills/mycc/scripts/src/index.ts start -d
```

`start -d`（守护模式）会自动脱离 CC 进程树并把日志追加到 `.claude/skills/mycc/mycc.log`，关掉 CC 窗口也不会挂。**不要用 `run_in_background: true`，不要手拼 nohup**。

其他命令（同一个入口，换子命令即可）：

| 命令 | 作用 |
|------|------|
| `status` | 探测 /health，显示运行/配对状态（未运行时退出码 1） |
| `ps` | 列出注册的后端进程（短 id / pid / 端口 / 启动时间） |
| `stop` | 停止所有后端进程（先 SIGTERM 优雅退出，超时 SIGKILL 兜底） |
| `restart` | stop + start -d |
| `kill <id\|pid\|序号>` | 干掉指定进程（id 用 `ps` 查看） |
| `service start` | 注册为系统服务并启动（**推荐长期使用**：开机自启 + 崩溃自动重启） |
| `service status` / `stop` / `uninstall` | 服务状态 / 停止 / 移除，详见 `service help` |

> 代码会自动检测项目根目录（向上查找 `.claude/` 或 `claude.md`），无需手动指定 cwd。

**守护模式（推荐）**：`service start` 会把后端注册成 OS 托管服务——macOS 用 launchd（KeepAlive）、Linux 用 systemd 用户级 unit（Restart=always）、Windows 用计划任务 + watchdog 巡检。进程崩溃自动拉起，开机自动启动，无需额外脚本。

### 3. 读取连接信息

等待几秒后读取：
```bash
sleep 5 && cat .claude/skills/mycc/current.json
```

### 4. 告知用户

展示：
- 飞书通道状态（配置 `FEISHU_APP_ID` 等环境变量后自动启动，websocket 模式无需公网地址）
- 不展示 Web URL，不打开浏览器（网页端已移除）

## 关键说明

- **后台运行**：后端会在后台持续运行，不阻塞当前会话
- **自动检测 cwd**：会向上查找项目根目录，确保 hooks 能正确加载
- **连接信息**：保存在 `.claude/skills/mycc/current.json`
- **停止服务**：`.claude/skills/mycc/scripts/node_modules/.bin/tsx .claude/skills/mycc/scripts/src/index.ts stop`
- **Agent Teams 支持**：后端已完整支持 Agent Teams（建队、派成员、通信、关队），CLI 2.1.63+ 原生支持，settingSources patch 仍需保留
- **改代码后必须重启**：tsx 不热更新，修改 `scripts/src/` 下的代码后必须用 `restart` 子命令重启后端，否则跑的还是旧代码。若 AI 自己跑在这个后端里，要用延迟脚本（macOS 没有 setsid，用 `nohup bash -c 'sleep 5 && <restart 命令>' >> mycc.log 2>&1 & disown`），先把回复发完；**不要吞错误输出**，布置完用 `ps`/日志确认真的执行了

## 遇到问题？

**让 AI 自己解决。** 代码都在 `scripts/src/` 目录下，AI 可以：
1. 读取错误日志
2. 检查代码逻辑
3. 修复问题并重试

常见问题：
- **端口被占用**：跑一次 `stop` 子命令（注册表为空时会按端口兜底清理）
- **飞书连不上**：检查 `.env` 里 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 是否正确、文件是否为 Unix 换行符（CRLF 会导致 secret 带 `\r` 报 invalid param）

---

## 连接信息格式

启动后保存在 `.claude/skills/mycc/current.json`：
```json
{
  "routeToken": "XXXXXX",
  "pairCode": "XXXXXX",
  "cwd": "/path/to/project",
  "startedAt": "2026-01-27T06:00:00.000Z"
}
```

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/{token}/health` | GET | 健康检查 |
| `/{token}/pair` | POST | 配对验证 |
| `/{token}/chat` | POST | 发送消息 |
| `/{token}/history/list` | GET | 历史记录列表 |
| `/{token}/history/{sessionId}` | GET | 对话详情 |
| `/{token}/chat/rename` | POST | 会话重命名 |
| `/{token}/skills/list` | GET | Skills 列表 |
| `/{token}/events` | GET | SSE 实时广播 |
| `/{token}/status` | GET | 运行状态快照 |

## 边界

- 资源预算：启动时间 ≤ 10 秒（含 npm install 首次除外）
- 产出格式：`[mycc] 后端已启动，飞书通道 {N} 个在线`

## 不做的事

- 不修改 mycc 后端代码
- 不推送代码到 GitHub（需用户确认）
