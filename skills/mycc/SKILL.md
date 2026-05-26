---
name: mycc
description: 启动 mycc 小程序后端服务（后台运行）。触发词："/mycc"、"启动 mycc"、"启动小程序后端"、"检查 mycc 状态"
layer: 基础层
authorization: A区（自动执行，无需人类介入）
output_levels: L1（结论）
status: active
created: 2026-01-20
origin: P08-cc小程序，mycc 后端服务管理需求
---

# mycc

> 启动和管理 mycc 小程序本地后端。不是 mycc 的开发，不是小程序前端。

启动 mycc 小程序本地后端，连接网页版/小程序与本地 Claude Code。

## 环境要求

| 要求 | 说明 |
|------|------|
| Claude Code | **必须是官方原版**，fork 版本可能不兼容 |
| 网络 | 内网模式需要 VPN/代理（cloudflared 需访问外网）；公网模式（有 PUBLIC_URL）无需 |
| 系统 | ✅ macOS、✅ Linux、❌ Windows、⚠️ WSL（不稳定） |

> ⚠️ **Windows/WSL 用户注意**：目前 Windows 原生和 WSL 环境都存在兼容性问题，建议使用 macOS 或 Linux。
>
> 💡 **关于第三方 Claude Code**：目前仅测试了官方原版，第三方 fork 版本的兼容性支持在规划中。

## 依赖

- **cloudflared**：`brew install cloudflare/cloudflare/cloudflared`（macOS）或参考 [官方文档](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)

## 触发词

- "/mycc"
- "启动 mycc"
- "启动小程序后端"
- "检查 mycc 状态"

## 执行步骤

### 1. 安装依赖（首次）

```bash
cd .claude/skills/mycc/scripts && npm install && cd -
```

### 2. 启动后端

```bash
echo "=== $(date) ===" >> .claude/skills/mycc/mycc.log && nohup .claude/skills/mycc/scripts/node_modules/.bin/tsx .claude/skills/mycc/scripts/src/index.ts start >> .claude/skills/mycc/mycc.log 2>&1 & disown
```

用 `nohup ... & disown` 让后端完全脱离 CC 进程树，关掉 CC 窗口也不会挂。**不要用 `run_in_background: true`**。日志实时写入 `.claude/skills/mycc/mycc.log`。

> 代码会自动检测项目根目录（向上查找 `.claude/` 或 `claude.md`），无需手动指定 cwd。

### 3. 读取连接信息

等待几秒后读取：
```bash
sleep 5 && cat .claude/skills/mycc/current.json
```

### 3.5 检查通道开关

读取 `.env` 中的 `CHANNEL_WEB` 值（默认为 `true`）：
```bash
grep CHANNEL_WEB .env 2>/dev/null || echo "CHANNEL_WEB=true"
```

### 4. 告知用户

**通道状态**（根据 `.env` 实际配置显示）：
- Web 通道：`CHANNEL_WEB=false` 时已禁用，**不要展示 Web URL，不要打开浏览器**
- 飞书通道：配置 `FEISHU_APP_ID` 等环境变量后自动启动

**如果 Web 通道已启用（`CHANNEL_WEB` 不为 `false`）**，展示：
- 连接码（routeToken）
- 配对码（pairCode）
- 访问 https://mycc.dev 输入配对

**如果 Web 通道已禁用（`CHANNEL_WEB=false`）**，只展示：
- 飞书通道状态
- tunnel URL（供飞书事件订阅用）
- 不展示 mpUrl，不提及 mycc.dev

## 关键说明

- **后台运行**：后端会在后台持续运行，不阻塞当前会话
- **自动检测 cwd**：会向上查找项目根目录，确保 hooks 能正确加载
- **连接信息**：保存在 `.claude/skills/mycc/current.json`
- **停止服务**：`lsof -i :18080 -t -sTCP:LISTEN | xargs kill`
- **Agent Teams 支持**：后端已完整支持 Agent Teams（建队、派成员、通信、关队），CLI 2.1.63+ 原生支持，settingSources patch 仍需保留
- **改代码后必须重启**：tsx 不热更新，修改 `scripts/src/` 下的代码后必须 kill + 重新启动后端，否则跑的还是旧代码

## 遇到问题？

**让 AI 自己解决。** 代码都在 `scripts/src/` 目录下，AI 可以：
1. 读取错误日志
2. 检查代码逻辑
3. 修复问题并重试

常见问题：
- **端口被占用**：`lsof -i :18080 -t -sTCP:LISTEN | xargs kill`
- **cloudflared 未安装**：按上面的依赖说明安装
- **tunnel 启动失败**：检查网络，重试即可

---

## 连接信息格式

启动后保存在 `.claude/skills/mycc/current.json`：
```json
{
  "routeToken": "XXXXXX",
  "pairCode": "XXXXXX",
  "tunnelUrl": "https://xxx.trycloudflare.com",
  "mpUrl": "https://api.mycc.dev/XXXXXX",
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
- 产出格式：`[mycc] 后端已启动，连接码：{routeToken}`

## 不做的事

- 不修改 mycc 后端代码
- 不管理 cloudflared tunnel 全局配置
- 不推送代码到 GitHub（那是 aster 的事）
- 不直接操作小程序前端
