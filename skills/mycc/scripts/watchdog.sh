#!/bin/bash
# mycc watchdog (Linux) — 对应 watchdog.ps1 的 Linux 版
# 流程：health 检查失败 → 杀残留进程 → 自愈依赖 → 重启后端 → 复查
#       重启成功 → 飞书通知一句；重启失败 → 飞书告警等人工
# 由 crontab 驱动：每 2 分钟一次 + @reboot 开机拉起
set -u
PATH=/usr/local/bin:/usr/bin:/bin

PROJECT_ROOT="/home/xiaomo/mycc-chloe-only"
SKILL_DIR="$PROJECT_ROOT/.claude/skills/mycc"
SCRIPTS_DIR="$SKILL_DIR/scripts"
TSX="$SCRIPTS_DIR/node_modules/.bin/tsx"
HEALTH_URL="http://localhost:18080/health"
LOG="$SKILL_DIR/watchdog.log"
MYCC_LOG="$SKILL_DIR/mycc.log"
LOCK="/tmp/mycc-watchdog-$(id -u).lock"

log() { echo "$(date '+%F %T') [watchdog] $*" >> "$LOG"; }

# 直接用 .env 里 mycc 机器人的凭证走飞书开放平台 API 发消息
# （不依赖 lark-cli，也不依赖 mycc 后端本身——后端挂了也能告警）
feishu_notify() {
    local msg="$1" app_id app_secret chat_id token
    app_id=$(grep -E '^FEISHU_APP_ID=' "$PROJECT_ROOT/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' | tr -d "'")
    app_secret=$(grep -E '^FEISHU_APP_SECRET=' "$PROJECT_ROOT/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' | tr -d "'")
    chat_id=$(grep -E '^FEISHU_RECEIVE_USER_ID=' "$PROJECT_ROOT/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' | tr -d "'")
    if [ -z "$app_id" ] || [ -z "$app_secret" ] || [ -z "$chat_id" ]; then
        log "feishu notify skipped: .env 缺少 FEISHU_APP_ID/APP_SECRET/RECEIVE_USER_ID"
        return 1
    fi
    token=$(curl -sf -m 10 -X POST \
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" \
        -H "Content-Type: application/json" \
        -d "{\"app_id\":\"$app_id\",\"app_secret\":\"$app_secret\"}" \
        | sed -n 's/.*"tenant_access_token":"\([^"]*\)".*/\1/p')
    [ -z "$token" ] && { log "feishu notify failed: 拿不到 tenant_access_token"; return 1; }
    # 注意：msg 里不要包含双引号，JSON 是手工拼的
    curl -sf -m 10 -X POST \
        "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id" \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        -d "{\"receive_id\":\"$chat_id\",\"msg_type\":\"text\",\"content\":\"{\\\"text\\\":\\\"$msg\\\"}\"}" \
        >> "$LOG" 2>&1 || log "feishu notify failed: 发送请求失败"
    echo >> "$LOG"
}

# 单实例锁，防止 cron 重叠执行
exec 9>"$LOCK"
flock -n 9 || exit 0

# 健康 → 静默退出
curl -sf -m 10 "$HEALTH_URL" >/dev/null 2>&1 && exit 0

# 机器负载高时后端可能只是短暂卡顿（3核小机常见），杀掉会丢正在进行的对话。
# 等 30 秒放宽超时复查一次，连续两次失败才认定真挂。
sleep 30
curl -sf -m 30 "$HEALTH_URL" >/dev/null 2>&1 && exit 0

log "health 连续两次检查失败，开始重启"

# 杀掉 18080 残留进程
PIDS=$(lsof -i :18080 -t -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$PIDS" ]; then
    log "杀掉残留进程: $PIDS"
    kill $PIDS 2>/dev/null
    sleep 2
fi

# 自愈：tsx 不可用（如 node_modules 变坏软链）→ 重装依赖
if [ ! -x "$TSX" ]; then
    log "tsx 不可用，自愈重装 node_modules"
    if [ -L "$SCRIPTS_DIR/node_modules" ] && [ ! -e "$SCRIPTS_DIR/node_modules" ]; then
        rm "$SCRIPTS_DIR/node_modules"
        log "已移除坏软链 node_modules"
    fi
    (cd "$SCRIPTS_DIR" && npm install --silent) >> "$LOG" 2>&1
fi

if [ ! -x "$TSX" ]; then
    log "自愈失败：tsx 仍不可用，发飞书告警"
    feishu_notify "⚠️ mycc watchdog：后端挂了，依赖自愈失败（tsx 不可用），需要人工处理。日志：$LOG"
    exit 1
fi

# 重启后端（脱离 watchdog 进程树）
cd "$PROJECT_ROOT" || exit 1
echo "=== $(date) [watchdog.sh] 自动重启 ===" >> "$MYCC_LOG"
nohup "$TSX" "$SCRIPTS_DIR/src/index.ts" start >> "$MYCC_LOG" 2>&1 &
disown

# 复查
sleep 15
if curl -sf -m 10 "$HEALTH_URL" >/dev/null 2>&1; then
    log "重启成功"
    feishu_notify "🔄 mycc watchdog：后端刚才挂了，已自动拉起，服务恢复正常。"
else
    log "重启后 health 仍失败，发飞书告警"
    feishu_notify "⚠️ mycc watchdog：后端挂了且自动重启失败，需要人工处理。日志：$MYCC_LOG"
    exit 1
fi
