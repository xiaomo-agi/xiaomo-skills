/**
 * 官方 Claude Code SDK 实现（v2 Session API）
 */

import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  type SDKSession,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { CCAdapter, SSEEvent, SessionParams } from "./interface.js";
import type { ChatParams, ConversationSummary, ConversationHistory } from "../types.js";
import { getConversationList, getConversation } from "../history.js";
import { detectClaudeCliPath } from "../platform.js";
import { buildMessageContent, type MessageContent } from "../image-utils.js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { ensurePatchedCli } from "../cli-patch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============ CLI lP Patch（Agent Teams 死锁修复）============
// CLI 2.1.63 的 lP 函数不检查 isIdle，导致 do-while 主循环死锁
// idle 的 teammate 被当成活跃 → 循环不退出 → inbox 轮询不执行 → 消息投递断裂
// 具体实现见 src/cli-patch.ts

// 检测 Claude CLI 路径（跨平台）+ 自动 patch
const { executable: CLAUDE_EXECUTABLE, cliPath: _systemCliPath } = detectClaudeCliPath();
const _patchedPath = resolve(__dirname, "..", "..", "cli-patched.js");
const CLAUDE_CLI_PATH = ensurePatchedCli(_systemCliPath, _patchedPath);

/** v2 SDKSessionOptions 必须提供 model，没有 /model 持久化选择时落到这个默认值（用户 2026-07-02 要求默认用 fable5） */
const DEFAULT_MODEL = "claude-fable-5";

/** Session 超时时间：15 分钟无活动自动关闭 */
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

/** 总安全阀超时：防止异常时 SSE 永远不关闭（60 分钟） */
const MAX_DURATION_MS = 60 * 60 * 1000;

/** 轮间超时：两轮之间等待的最长时间（15 分钟，Teams 队员干活需要时间） */
const BETWEEN_TURN_TIMEOUT_MS = 15 * 60 * 1000;

/** 超时清理间隔：每 2 分钟检查一次 */
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000;

/**
 * 构造 v2 SDKSessionOptions
 */
function buildSessionOptions(model?: string, cwd?: string) {
  // 清除 CLAUDECODE 环境变量，避免子进程被误判为嵌套会话 (#16)
  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;

  // root 用户不能用 --dangerously-skip-permissions（CLI 安全限制）
  const isRoot = process.getuid?.() === 0;

  const options: Parameters<typeof unstable_v2_createSession>[0] = {
    model: model || DEFAULT_MODEL,
    pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
    permissionMode: "bypassPermissions",
    ...(!isRoot && { allowDangerouslySkipPermissions: true }),
    // SDKSessionOptions.cwd 直接传给子进程 spawn，不依赖 process.cwd()（已验证：
    // unstable_v2_createSession 内部同步 spawn 子进程，cwd 选项原样传入 child_process.spawn，
    // 完全不读 process.cwd()）。用这个字段代替 process.chdir()，从根上消除并发竞态。
    ...(cwd && { cwd }),
    env: {
      ...cleanEnv,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
      // CLI 2.1.39+ InboxPoller 新增 enabled 守卫，依赖 GrowthBook feature flag (tengu_amber_flint)
      // 在 SDK 模式下 GrowthBook 可能返回 false，导致 InboxPoller 被禁用、Agent Teams 消息无法投递
      // 此 env 让 CLI 跳过 GrowthBook 检查，使用默认值 true，确保 InboxPoller 始终启用
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  };

  // 如果检测到需要用 node 执行（npm 全局安装），设置 executable
  if (CLAUDE_EXECUTABLE === "node") {
    options.executable = "node" as const;
  }

  return options;
}

/**
 * 官方 Claude Code SDK Adapter（v2 Session 模式）
 */
export class OfficialAdapter implements CCAdapter {
  /** Session 池 */
  private sessions = new Map<string, SDKSession>();

  /** 每个 session 最后活跃时间 */
  private lastActivity = new Map<string, number>();

  /** 正在处理消息的 session 计数（>0 表示回合进行中，清理器必须跳过，防止长任务被中途杀死） */
  private inFlight = new Map<string, number>();

  /** 超时清理定时器 */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** Session 生命周期回调 */
  private lifecycleCallbacks?: {
    onSessionCreate?: (sessionId: string) => void;
    onSessionClose?: (sessionId: string) => void;
  };

  constructor() {
    // 启动定时清理
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredSessions();
    }, CLEANUP_INTERVAL_MS);

    // 不阻止进程退出
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * 获取或创建 v2 Session
   * 注意：新建的 session 不立即存池（sessionId 要收到第一条消息后才可用）
   * 由 chat() 在 stream 中拿到 sessionId 后调 registerSession 存入池
   */
  getOrCreateSession(params: SessionParams): SDKSession {
    const { sessionId, model, cwd } = params;

    // 池中有 → 复用
    if (sessionId && this.sessions.has(sessionId)) {
      this.lastActivity.set(sessionId, Date.now());
      return this.sessions.get(sessionId)!;
    }

    // 通过 SDKSessionOptions.cwd 直接告诉 SDK 子进程该用哪个工作目录（见 buildSessionOptions
    // 注释）。相比之前 process.chdir(cwd) → create → process.chdir(originalCwd) 的写法，
    // 这里完全不touch进程级全局状态 process.cwd()，因此两个并发的 getOrCreateSession()
    // 调用（不同 cwd）永远不会互相踩踏，也不存在"子进程晚于 chdir 恢复才真正 spawn"的窗口。
    const options = buildSessionOptions(model, cwd);

    let session: SDKSession;
    if (sessionId) {
      // 有 sessionId 但不在池中 → resumeSession（sessionId 立即可用）
      session = unstable_v2_resumeSession(sessionId, options);
      this.sessions.set(sessionId, session);
      this.lastActivity.set(sessionId, Date.now());
    } else {
      // 全新对话 → createSession（sessionId 要等第一条消息后才可用）
      session = unstable_v2_createSession(options);
      // 不存池，等 chat() 中从 stream 拿到 sessionId 后再存
    }

    return session;
  }

  /**
   * 将 session 注册到池中（新 session 收到 sessionId 后调用）
   */
  registerSession(sessionId: string, session: SDKSession): void {
    this.sessions.set(sessionId, session);
    this.lastActivity.set(sessionId, Date.now());
    this.lifecycleCallbacks?.onSessionCreate?.(sessionId);
  }

  /**
   * 打断指定 session 的当前回合（等价终端 Esc）。
   * 只停当前回合不关会话——session 留在池里，后续消息继续复用。
   *
   * SDKSession 类型没有暴露 interrupt；打断能力在 v2 session 内部的 query
   * 字段上（Query.interrupt 控制请求，实测 sdk.mjs 里该字段是公开类属性）。
   * SDK 升级可能挪走这个内部结构，所以运行时判空，拿不到就返回 false
   * （命令层会提示"没找到正在运行的任务"），绝不让 /stop 抛 TypeError。
   */
  async interruptSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const query = (session as unknown as { query?: { interrupt?: () => Promise<void> } }).query;
    if (typeof query?.interrupt !== "function") {
      console.warn(`[OfficialAdapter] session.query.interrupt 不可用（SDK 内部结构变化？），无法打断 ${sessionId}`);
      return false;
    }
    await query.interrupt();
    this.lastActivity.set(sessionId, Date.now());
    return true;
  }

  /**
   * 关闭指定 session
   */
  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      try {
        session.close();
      } catch {
        // 静默处理
      }
      this.sessions.delete(sessionId);
      this.lastActivity.delete(sessionId);
      this.lifecycleCallbacks?.onSessionClose?.(sessionId);
    }
  }

  /**
   * 关闭所有 session
   */
  closeAllSessions(): void {
    for (const session of this.sessions.values()) {
      try {
        session.close();
      } catch {
        // 静默处理，继续关闭其他 session
      }
    }
    this.sessions.clear();
    this.lastActivity.clear();

    // 停止清理定时器
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * 设置 session 生命周期回调
   */
  setLifecycleCallbacks(callbacks: {
    onSessionCreate?: (sessionId: string) => void;
    onSessionClose?: (sessionId: string) => void;
  }): void {
    this.lifecycleCallbacks = callbacks;
  }

  /**
   * 发送消息，返回 SSE 事件流（v2 Session 模式）
   *
   * 支持多轮推送（Agent Teams + 后台 Task subagent）：
   * - 普通对话：一轮 result 后直接结束 SSE
   * - Teams 对话：检测到 TeamCreate → 持续等待 → TeamDelete 后结束
   * - 后台 Task：检测到 Task(run_in_background) → 持续等待 → 所有任务完成后结束
   *
   * stream() 遇到 result 就 return，但底层 queryIterator 是共享的，
   * 每次调 stream() 从断点继续消费。后续消息由 CLI 内部注入触发新一轮处理。
   *
   * 退出条件（按优先级）：
   * 1. 非多轮模式 → 第一轮结束即退出
   * 2. Teams + TeamDelete → 退出
   * 3. 后台 Task + 全部完成（pending 计数归零）→ 退出
   * 4. 轮间超时（15 分钟无新消息）→ 退出
   * 5. 总安全阀（60 分钟）→ 强制退出
   */
  async *chat(params: ChatParams): AsyncIterable<SSEEvent> {
    const { message, sessionId, images, model, cwd } = params;

    // 获取或创建 session
    const session = this.getOrCreateSession({ sessionId, model, cwd });
    const isNewSession = !sessionId;

    // 构造消息内容（纯文本或图文混合）
    const content = buildMessageContent(message, images);


    // === 多轮循环核心 ===
    let resolvedSessionId = sessionId;
    let isTeamsMode = false;
    let teamsFinished = false;
    let pendingBgTasks = 0;       // 后台 Task 计数
    let isMultiTurnMode = false;  // 是否进入多轮模式
    const startTime = Date.now();
    let isFirstTurn = true;

    // 标记回合进行中：清理器不能杀正在干活的会话（无论回合跑多久）
    let inFlightId: string | null = sessionId || null;
    if (inFlightId) this.markInFlight(inFlightId, +1);
    const noteResolved = (id: string) => {
      resolvedSessionId = id;
      if (!inFlightId) {
        inFlightId = id;
        this.markInFlight(id, +1);
      }
    };

    try {
      // Send must be inside the try block so a dead pooled session is closed.
      if (typeof content === "string") {
        await session.send(content);
      } else {
        const userMessage: SDKUserMessage = {
          type: "user",
          session_id: sessionId || "",
          message: {
            role: "user",
            content: content as any,
          },
          parent_tool_use_id: null,
        };
        await session.send(userMessage);
      }

      while (true) {
        // 总安全阀
        if (Date.now() - startTime > MAX_DURATION_MS) {
          console.log("[CC] 总安全阀触发，强制结束 SSE");
          break;
        }

        if (isFirstTurn) {
          // 第一轮：直接消费 stream
          for await (const sdkMessage of session.stream()) {
            this.extractSessionId(sdkMessage, resolvedSessionId, session, noteResolved);
            // 回合进行中也要刷新活跃时间，否则长回合会被 cleanupExpiredSessions 误杀
            if (resolvedSessionId) this.lastActivity.set(resolvedSessionId, Date.now());
            const signals = detectMultiTurnSignals(sdkMessage);
            if (signals.teamsStarted) { isTeamsMode = true; isMultiTurnMode = true; }
            if (signals.teamsFinished) teamsFinished = true;
            if (signals.bgTaskLaunched) { pendingBgTasks++; isMultiTurnMode = true; }
            if (signals.bgTaskCompleted) pendingBgTasks--;
            yield sdkMessage as SSEEvent;
          }
          isFirstTurn = false;
        } else {
          // 后续轮：用心跳循环等待，防止前端 SSE 连接看起来"死了"
          const streamGen = session.stream();
          const HEARTBEAT_INTERVAL_MS = 15_000; // 每 15 秒发一次心跳
          // Teams 模式下不用轮间超时，队员干活时 SDK 不产生 turn，只靠总安全阀兜底
          const timeoutMs = isTeamsMode
            ? Math.max(0, MAX_DURATION_MS - (Date.now() - startTime))
            : BETWEEN_TURN_TIMEOUT_MS;
          const deadline = Date.now() + timeoutMs;
          let gotData = false;
          let firstIterResult: IteratorResult<unknown> | null = null;
          // 跨心跳复用同一个 next() promise：async generator 的 next() 调用会排队消费，
          // 每次心跳超时都重新调 next() 会把上一次"没人听"的 promise 永久遗弃在队列里，
          // 下一条真实消息被那个弃单消费掉，表现为消息丢失
          let pendingNext: Promise<IteratorResult<unknown>> | null = null;

          while (Date.now() < deadline) {
            const remaining = deadline - Date.now();
            const waitMs = Math.min(HEARTBEAT_INTERVAL_MS, remaining);

            if (!pendingNext) pendingNext = streamGen.next();

            const raceResult = await Promise.race([
              pendingNext,
              sleep(waitMs).then(() => TIMEOUT_SENTINEL),
            ]);

            if (raceResult !== TIMEOUT_SENTINEL) {
              firstIterResult = raceResult as IteratorResult<unknown>;
              gotData = true;
              pendingNext = null;
              break;
            }

            // 超时片段到了但总超时未到 → 发心跳，继续等（pendingNext 保留，不重新拉取）
            // 等待后台任务/Teams 期间同样刷新活跃时间，防止被清理器误杀
            if (resolvedSessionId) this.lastActivity.set(resolvedSessionId, Date.now());
            yield { type: "heartbeat", ts: Date.now() } as SSEEvent;
          }

          if (!gotData) {
            console.log(`[CC] 轮间超时（${isTeamsMode ? '安全阀' : Math.round(BETWEEN_TURN_TIMEOUT_MS/60000)+'分钟'}无新消息），结束 SSE`);
            break;
          }

          const { done, value } = firstIterResult!;
          if (done) break;

          // 处理首条消息
          this.extractSessionId(value, resolvedSessionId, session, noteResolved);
          if (resolvedSessionId) this.lastActivity.set(resolvedSessionId, Date.now());
          const firstSignals = detectMultiTurnSignals(value);
          if (firstSignals.teamsStarted) { isTeamsMode = true; isMultiTurnMode = true; }
          if (firstSignals.teamsFinished) teamsFinished = true;
          if (firstSignals.bgTaskLaunched) { pendingBgTasks++; isMultiTurnMode = true; }
          if (firstSignals.bgTaskCompleted) pendingBgTasks--;
          yield value as SSEEvent;

          // 消费本轮剩余消息
          for await (const sdkMessage of streamGen) {
            this.extractSessionId(sdkMessage, resolvedSessionId, session, noteResolved);
            if (resolvedSessionId) this.lastActivity.set(resolvedSessionId, Date.now());
            const signals = detectMultiTurnSignals(sdkMessage);
            if (signals.teamsStarted) { isTeamsMode = true; isMultiTurnMode = true; }
            if (signals.teamsFinished) teamsFinished = true;
            if (signals.bgTaskLaunched) { pendingBgTasks++; isMultiTurnMode = true; }
            if (signals.bgTaskCompleted) pendingBgTasks--;
            yield sdkMessage as SSEEvent;
          }
        }

        // 通知前端一轮结束
        yield { type: "turn_complete" } as SSEEvent;

        // 更新活跃时间
        if (resolvedSessionId) {
          this.lastActivity.set(resolvedSessionId, Date.now());
        }

        // === 退出判断 ===
        if (!isMultiTurnMode) break;                           // 普通对话
        if (isTeamsMode && teamsFinished) break;                // Teams 已结束
        if (!isTeamsMode && pendingBgTasks <= 0) break;         // 后台 Task 全部完成

        console.log(`[CC] 多轮模式：等待下一轮（teams=${isTeamsMode}, pending=${pendingBgTasks}）`);
      }
    } catch (err) {
      // SDK 子进程崩溃（ProcessTransport is not ready for writing 等）
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[CC] stream 异常，清理 session: ${errMsg}`);

      // 主动关闭死 session，防止污染池
      if (resolvedSessionId) {
        this.closeSession(resolvedSessionId);
      }

      // 继续向上抛，让 HTTP handler 发送 SSE error 帧
      throw err;
    } finally {
      // 回合结束（无论正常/异常），释放"进行中"标记
      if (inFlightId) this.markInFlight(inFlightId, -1);
    }

    // 最终更新活跃时间
    if (resolvedSessionId) {
      this.lastActivity.set(resolvedSessionId, Date.now());
    }
  }

  /** 增减 session 的"回合进行中"计数 */
  private markInFlight(sessionId: string, delta: number): void {
    const next = (this.inFlight.get(sessionId) || 0) + delta;
    if (next <= 0) {
      this.inFlight.delete(sessionId);
    } else {
      this.inFlight.set(sessionId, next);
    }
  }

  /**
   * 从 system 消息中提取 sessionId
   */
  private extractSessionId(
    msg: unknown,
    current: string | undefined,
    session: SDKSession,
    setter: (id: string) => void,
  ): void {
    if (current) return;
    if (!msg || typeof msg !== "object" || !("type" in msg)) return;
    const m = msg as Record<string, unknown>;
    if (m.type === "system" && "session_id" in m && typeof m.session_id === "string") {
      setter(m.session_id);
      this.registerSession(m.session_id, session);
    }
  }

  /**
   * 获取历史记录列表
   */
  async listHistory(cwd: string, limit?: number): Promise<{
    conversations: ConversationSummary[];
    total: number;
    hasMore: boolean;
  }> {
    let conversations = getConversationList(cwd);
    const total = conversations.length;

    // 如果 limit > 0，只返回前 limit 条
    if (limit && limit > 0) {
      conversations = conversations.slice(0, limit);
    }

    return {
      conversations,
      total,
      hasMore: conversations.length < total,
    };
  }

  /**
   * 获取单个对话详情
   */
  async getHistory(cwd: string, sessionId: string): Promise<ConversationHistory | null> {
    return getConversation(cwd, sessionId);
  }

  /**
   * 清理超时 session
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [id, lastTime] of this.lastActivity.entries()) {
      if (now - lastTime > SESSION_TIMEOUT_MS) {
        // 回合进行中的会话不能杀：长任务跑几十分钟也不刷新 lastActivity，
        // 之前这里会把干活中的会话 abort 掉，用户端表现为回复凭空消失
        if ((this.inFlight.get(id) || 0) > 0) {
          this.lastActivity.set(id, now);
          continue;
        }
        console.log(`[Session] 清理超时 session: ${id}`);
        this.closeSession(id);
      }
    }
  }
}

/** sleep 辅助 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 超时哨兵值 */
const TIMEOUT_SENTINEL = Symbol("TIMEOUT");

/**
 * 检测多轮信号
 * - TeamCreate/TeamDelete：Agent Teams 生命周期
 * - Task + run_in_background：后台 subagent 启动
 * - task_notification + completed：后台 subagent 完成
 *
 * 只解析消息结构（tool_use block 的 name/input，system 消息的 subtype/status），
 * 不对整条消息做字符串搜索——之前用 JSON.stringify(msg).includes(...) 会被正文里
 * 讨论/引用这些字符串（比如贴 Workflow 脚本、讨论 mycc 自己代码）误触发
 */
export function detectMultiTurnSignals(msg: unknown): {
  teamsStarted: boolean;
  teamsFinished: boolean;
  bgTaskLaunched: boolean;
  bgTaskCompleted: boolean;
} {
  const none = { teamsStarted: false, teamsFinished: false, bgTaskLaunched: false, bgTaskCompleted: false };
  if (!msg || typeof msg !== "object") return none;
  const m = msg as Record<string, unknown>;

  if (m.type === "assistant") {
    const content = (m.message as Record<string, unknown> | undefined)?.content;
    if (Array.isArray(content)) {
      let teamsStarted = false;
      let teamsFinished = false;
      let bgTaskLaunched = false;
      for (const block of content) {
        if (!block || typeof block !== "object" || (block as Record<string, unknown>).type !== "tool_use") continue;
        const b = block as Record<string, unknown>;
        if (b.name === "TeamCreate") teamsStarted = true;
        if (b.name === "TeamDelete") teamsFinished = true;
        if (b.name === "Task" && (b.input as Record<string, unknown> | undefined)?.run_in_background === true) {
          bgTaskLaunched = true;
        }
      }
      return { teamsStarted, teamsFinished, bgTaskLaunched, bgTaskCompleted: false };
    }
  }

  if (m.type === "system" && m.subtype === "task_notification" && m.status === "completed") {
    return { ...none, bgTaskCompleted: true };
  }

  return none;
}
