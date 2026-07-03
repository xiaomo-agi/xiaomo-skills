/**
 * Codex CLI Adapter（Phase 3）
 *
 * 每回合 spawn 一次 `codex exec --json ... -`（prompt 走 stdin），流式读 stdout
 * JSONL，用有状态的 CodexJsonlTranslator 翻译成本仓库既有消费方
 * （feishu-commands.streamChatToFeishu、web 通道）能吃的 SSE 事件形状：
 * - { type: "system", session_id }                      → 会话绑定
 * - { type: "assistant", message: { content: [...] } }  → 文本 / tool_use 卡片渲染
 * - { type: "tool_result", ... }                        → web 端工具状态广播
 * - { type: "result", subtype, result, usage }          → 回合收尾
 * - { type: "turn_complete" }                           → 与 OfficialAdapter 对齐
 *
 * Codex 没有常驻 session：resume 语义用 `codex exec resume <thread_id>` 实现，
 * thread_id 直接充当 mycc 的 sessionId。历史由 CodexHistoryStore 自己落盘
 * （见 codex-history.ts），因为 codex 的 rollout 格式不对外承诺。
 *
 * 参考实现：Tmp/lark-coding-agent-bridge-ref/src/agent/codex/（argv 构造、
 * JSONL 事件语义、protocol drift 计数思路），已适配本仓库 CCAdapter 接口。
 *
 * 模块加载零副作用：不 spawn、不起定时器。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SDKSession } from "@anthropic-ai/claude-agent-sdk";
import type { CCAdapter, SSEEvent, SessionParams } from "./interface.js";
import type { ChatParams, ConversationSummary, ConversationHistory, RawHistoryLine } from "../types.js";
import { CodexHistoryStore } from "./codex-history.js";

// ============ argv 构造 ============

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexArgvInput {
  cwd: string;
  sandbox?: CodexSandboxMode;
  /** 有值 → codex exec resume <id>，多轮对话连续 */
  resumeSessionId?: string;
  /** 已落盘的图片文件路径 */
  images?: readonly string[];
}

const SAFE_SANDBOX_MODES: readonly string[] = ["read-only", "workspace-write", "danger-full-access"];

/**
 * 构造 codex exec 的 argv（prompt 用 "-" 从 stdin 读，避免命令行长度/转义问题）。
 * 旗标顺序与参考项目对齐（对真实 codex 验证过的顺序）：
 * - 新会话：exec --json <全局旗标> [--image ...] [--] -
 * - 续会话：exec <全局旗标> resume --json [--image ...] <thread_id> -
 */
export function buildCodexArgs(input: CodexArgvInput): string[] {
  const sandbox = input.sandbox ?? "workspace-write";
  if (!SAFE_SANDBOX_MODES.includes(sandbox)) {
    throw new Error(`不安全的 codex sandbox 模式: ${sandbox}`);
  }

  const globalFlags = [
    "--sandbox",
    sandbox,
    "-c",
    'approval_policy="never"',
    "-c",
    'shell_environment_policy.inherit="all"',
    "--skip-git-repo-check",
    "-C",
    input.cwd,
  ];

  const imageFlags = (input.images ?? []).flatMap((p) => ["--image", p]);

  if (input.resumeSessionId) {
    return ["exec", ...globalFlags, "resume", "--json", ...imageFlags, input.resumeSessionId, "-"];
  }

  return [
    "exec",
    "--json",
    ...globalFlags,
    ...imageFlags,
    ...(imageFlags.length > 0 ? ["--"] : []),
    "-",
  ];
}

// ============ JSONL translator ============

/** protocol drift 计数：codex 升级引入新事件时不崩，只累计并告警 */
export interface CodexDriftState {
  unknownEvents: number;
  anomalies: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorMessageOf(raw: Record<string, unknown>, fallback: string): string {
  const nested = recordValue(raw.error);
  return stringValue(raw.message) ?? stringValue(nested?.message) ?? stringValue(raw.error) ?? fallback;
}

/**
 * 有状态的 Codex JSONL → mycc SSE 事件翻译器（单回合生命周期）。
 *
 * codex exec --json 的事件流（experimental JSON 输出）：
 *   thread.started / turn.started / item.started / item.completed /
 *   turn.completed / turn.failed / error / agent_message(旧版)
 */
export class CodexJsonlTranslator {
  /** codex thread_id，直接作为 mycc sessionId */
  private _sessionId: string | undefined;
  private terminal = false;
  private _failureMessage: string | undefined;
  private lastNonTerminalError: string | undefined;
  private readonly startedItems = new Set<string>();
  private readonly textParts: string[] = [];
  private drift: CodexDriftState = { unknownEvents: 0, anomalies: 0 };

  constructor(opts: { resumeSessionId?: string } = {}) {
    this._sessionId = opts.resumeSessionId;
  }

  sessionId(): string | undefined {
    return this._sessionId;
  }

  /** 是否已收到终态事件（turn.completed / turn.failed） */
  terminalEmitted(): boolean {
    return this.terminal;
  }

  /** turn.failed 的错误信息（无失败时 undefined） */
  failureMessage(): string | undefined {
    return this._failureMessage;
  }

  /** 流中断（未到终态）时的补充错误细节 */
  lastErrorDetail(): string | undefined {
    return this.lastNonTerminalError;
  }

  /** 本回合已累计的最终文本（result 事件用） */
  finalText(): string {
    return this.textParts.join("");
  }

  protocolDrift(): CodexDriftState {
    return { ...this.drift };
  }

  translate(raw: unknown): SSEEvent[] {
    if (this.terminal) return [];
    if (!isRecord(raw) || typeof raw.type !== "string") {
      this.drift.anomalies++;
      return [];
    }

    switch (raw.type) {
      case "thread.started":
        return this.onThreadStarted(raw);
      case "turn.started":
        return [];
      case "item.started":
        return this.onItemStarted(raw);
      case "item.completed":
        return this.onItemCompleted(raw);
      case "agent_message":
        // 旧版 codex 把助手消息作为顶层事件吐出
        return this.textEvent(stringValue(raw.message ?? raw.text));
      case "turn.completed":
        return this.onTurnCompleted(raw);
      case "turn.failed": {
        this.terminal = true;
        this._failureMessage = errorMessageOf(raw, "codex 回合失败（turn.failed）");
        return [];
      }
      case "error": {
        // 非终态错误（如内部重连提示）：记录细节但不打断流
        this.lastNonTerminalError = errorMessageOf(raw, "codex error");
        console.warn(`[Codex] 非终态 error 事件: ${this.lastNonTerminalError.slice(0, 200)}`);
        return [];
      }
      default:
        this.drift.unknownEvents++;
        console.warn(`[Codex] 未知事件类型（protocol drift）: ${raw.type}（累计 ${this.drift.unknownEvents}）`);
        return [];
    }
  }

  private onThreadStarted(raw: Record<string, unknown>): SSEEvent[] {
    const threadId = stringValue(raw.thread_id ?? raw.threadId);
    if (!threadId) {
      this.drift.anomalies++;
      return [];
    }
    this._sessionId = threadId;
    // 形状对齐官方 SDK 的 system/init：消费方靠 type=system + session_id 绑定会话
    return [{ type: "system", subtype: "init", session_id: threadId, provider: "codex" }];
  }

  private onItemStarted(raw: Record<string, unknown>): SSEEvent[] {
    const item = recordValue(raw.item);
    if (!item || item.type !== "command_execution") return [];
    const id = stringValue(item.id);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    this.startedItems.add(id);
    // 包成 assistant 消息里的 tool_use block：feishu 卡片按这个形状渲染 🔧 行
    return [
      {
        type: "assistant",
        session_id: this._sessionId,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id,
              name: "Bash",
              input: { command: stringValue(item.command) ?? "" },
            },
          ],
        },
      },
    ];
  }

  private onItemCompleted(raw: Record<string, unknown>): SSEEvent[] {
    const item = recordValue(raw.item);
    if (!item) return [];

    if (item.type === "agent_message") {
      return this.textEvent(stringValue(item.text ?? item.message));
    }

    if (item.type !== "command_execution") return [];

    const id = stringValue(item.id);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    if (!this.startedItems.has(id)) {
      this.drift.anomalies++;
    }
    this.startedItems.delete(id);
    const exitCode = numberValue(item.exit_code);
    return [
      {
        type: "tool_result",
        id,
        name: "Bash",
        output: stringValue(item.output ?? item.aggregated_output ?? item.stdout) ?? "",
        is_error: exitCode !== undefined && exitCode !== 0,
        session_id: this._sessionId,
      },
    ];
  }

  private onTurnCompleted(raw: Record<string, unknown>): SSEEvent[] {
    this.terminal = true;
    const usage = recordValue(raw.usage);
    return [
      {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: this._sessionId,
        result: this.finalText(),
        ...(usage && {
          usage: {
            input_tokens: numberValue(usage.input_tokens ?? usage.inputTokens),
            output_tokens: numberValue(usage.output_tokens ?? usage.outputTokens),
            cached_input_tokens: numberValue(usage.cached_input_tokens ?? usage.cachedInputTokens),
          },
        }),
      },
    ];
  }

  private textEvent(text: string | undefined): SSEEvent[] {
    if (!text) return [];
    this.textParts.push(text);
    return [
      {
        type: "assistant",
        session_id: this._sessionId,
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
        },
      },
    ];
  }
}

// ============ Adapter ============

/** 单回合安全阀：codex 子进程最长运行时间（防挂死进程泄漏） */
const MAX_TURN_MS = 60 * 60 * 1000;

export interface CodexAdapterOptions {
  /** codex 可执行文件；默认取 MYCC_CODEX_BIN 环境变量，再默认 "codex"（PATH 查找） */
  binary?: string;
  sandbox?: CodexSandboxMode;
}

export class CodexAdapter implements CCAdapter {
  private readonly binaryOverride: string | undefined;
  private readonly sandbox: CodexSandboxMode;
  private readonly history = new CodexHistoryStore();

  /** sessionId → 正在运行的子进程（closeSession 时终止） */
  private readonly activeChildren = new Map<string, Set<ChildProcess>>();
  /** 尚未拿到 sessionId 的子进程 */
  private readonly anonymousChildren = new Set<ChildProcess>();

  private lifecycleCallbacks?: {
    onSessionCreate?: (sessionId: string) => void;
    onSessionClose?: (sessionId: string) => void;
  };

  constructor(opts: CodexAdapterOptions = {}) {
    this.binaryOverride = opts.binary;
    this.sandbox = opts.sandbox ?? "workspace-write";
  }

  /** 每次调用时解析二进制路径，测试可运行期注入 MYCC_CODEX_BIN 指向 fake 脚本 */
  private resolveBinary(): string {
    return this.binaryOverride || process.env.MYCC_CODEX_BIN || "codex";
  }

  /**
   * 发送消息：spawn 一次 codex exec，流式翻译 stdout JSONL 为 SSE 事件。
   * 有 sessionId 时走 resume，多轮对话连续。
   */
  async *chat(params: ChatParams): AsyncIterable<SSEEvent> {
    const { message, sessionId, cwd, images } = params;
    const binary = this.resolveBinary();

    // 图片：base64 → 临时文件 → --image 旗标（codex 只吃文件路径）
    const imagePaths: string[] = [];
    if (images && images.length > 0) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mycc-codex-img-"));
      images.forEach((img, i) => {
        const ext = img.mediaType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png";
        const file = path.join(tmpDir, `image-${i}.${ext}`);
        fs.writeFileSync(file, Buffer.from(img.data, "base64"));
        imagePaths.push(file);
      });
    }

    const args = buildCodexArgs({
      cwd,
      sandbox: this.sandbox,
      resumeSessionId: sessionId,
      images: imagePaths,
    });

    const child = spawn(binary, args, {
      cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.trackChild(sessionId, child);

    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });

    let spawnError: Error | null = null;
    let exitCode: number | null = null;
    let exited = false;
    child.once("error", (err) => {
      // spawn 失败（如 ENOENT）不会触发 exit 事件，stdout 也永远不结束——
      // 关掉 readline 让 for-await 循环退出，否则 chat() 挂死（已验证 destroy stdout 不够）
      spawnError = err;
      rl.close();
    });
    child.once("exit", (code) => {
      exited = true;
      exitCode = code;
    });

    const stderrChunks: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrChunks.length < 64) stderrChunks.push(chunk); // 防失控进程撑爆内存
    });
    child.stdout?.on("error", () => {});
    child.stdin?.on("error", () => {}); // spawn 失败时避免 EPIPE 未捕获
    child.stdin?.end(message, "utf8");

    // 安全阀：超时强杀，防子进程挂死泄漏
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* 忽略 */ }
    }, MAX_TURN_MS);
    if (killTimer.unref) killTimer.unref();

    const translator = new CodexJsonlTranslator({ resumeSessionId: sessionId });
    let resolvedSessionId = sessionId;
    const now = () => new Date().toISOString();
    const historyLines: RawHistoryLine[] = [
      { type: "user", message: { role: "user", content: message }, sessionId, timestamp: now(), cwd },
    ];

    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue; // 非 JSON 行（banner 等）直接跳过
        }
        for (const event of translator.translate(parsed)) {
          // 新会话：从 system 事件里拿 thread_id 当 sessionId
          if (!resolvedSessionId && event.type === "system" && typeof event.session_id === "string") {
            resolvedSessionId = event.session_id;
            this.trackChild(resolvedSessionId, child);
            this.lifecycleCallbacks?.onSessionCreate?.(resolvedSessionId);
          }
          if (event.type === "assistant") {
            historyLines.push({
              type: "assistant",
              message: (event as { message?: RawHistoryLine["message"] }).message,
              sessionId: resolvedSessionId,
              timestamp: now(),
            });
          }
          yield event;
        }
      }

      // stdout 读完，等子进程退出拿 exit code（spawn 失败时 exit 不会来，别等）
      if (!exited && !spawnError) {
        await new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          child.once("error", () => resolve());
        });
      }

      if (timedOut) {
        throw new Error(`codex 回合超时（${Math.round(MAX_TURN_MS / 60000)} 分钟），已强制终止`);
      }
      if (spawnError) {
        throw new Error(`无法启动 codex（${binary}）: ${(spawnError as Error).message}`);
      }
      if (translator.failureMessage()) {
        throw new Error(`codex 回合失败: ${translator.failureMessage()}`);
      }
      if (!translator.terminalEmitted()) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        const detail =
          (exitCode !== 0 && exitCode !== null ? `退出码 ${exitCode}` : "输出流在回合结束前中断") +
          (translator.lastErrorDetail() ? `: ${translator.lastErrorDetail()}` : "") +
          (stderr ? `: ${stderr.slice(0, 500)}` : "");
        throw new Error(`codex 异常结束（${detail}）`);
      }

      const drift = translator.protocolDrift();
      if (drift.unknownEvents > 0 || drift.anomalies > 0) {
        console.warn(
          `[Codex] protocol drift 汇总: 未知事件 ${drift.unknownEvents} 个、结构异常 ${drift.anomalies} 个（codex 版本可能已更新）`
        );
      }

      yield { type: "turn_complete" };
    } finally {
      clearTimeout(killTimer);
      rl.close();
      this.untrackChild(sessionId, child);
      if (resolvedSessionId && resolvedSessionId !== sessionId) {
        this.untrackChild(resolvedSessionId, child);
      }
      // 消费方提前 break / 异常退出时确保子进程被回收
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGTERM"); } catch { /* 忽略 */ }
      }
      // 历史落盘：只要拿到了 sessionId 就记录（失败回合也保留用户消息+已产出内容）
      if (resolvedSessionId) {
        try {
          historyLines[0].sessionId = resolvedSessionId;
          this.history.appendTurn(resolvedSessionId, cwd, historyLines);
        } catch (err) {
          console.warn(`[Codex] 历史落盘失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // 临时图片清理
      for (const p of imagePaths) {
        try { fs.unlinkSync(p); } catch { /* 忽略 */ }
      }
    }
  }

  async listHistory(cwd: string, limit?: number): Promise<{
    conversations: ConversationSummary[];
    total: number;
    hasMore: boolean;
  }> {
    let conversations = this.history.list(cwd);
    const total = conversations.length;
    if (limit && limit > 0) {
      conversations = conversations.slice(0, limit);
    }
    return { conversations, total, hasMore: conversations.length < total };
  }

  async getHistory(_cwd: string, sessionId: string): Promise<ConversationHistory | null> {
    return this.history.get(sessionId);
  }

  /**
   * Codex 每回合独立 spawn 子进程，没有常驻 SDKSession 可返回。
   * 该方法只被 OfficialAdapter 内部使用（外部消费者只用 chat/history/close 系列），
   * 这里按契约保留签名但明确不支持。
   */
  getOrCreateSession(_params: SessionParams): SDKSession {
    throw new Error("CodexAdapter 不支持 getOrCreateSession：Codex 无常驻 session，请直接使用 chat()");
  }

  /**
   * 打断当前回合：Codex 无 SDK 级 interrupt，直接终止该会话的活跃子进程。
   * 历史是自维护的（不依赖进程退出方式落盘），后续消息重新 spawn 即可继续。
   */
  async interruptSession(sessionId: string): Promise<boolean> {
    const children = this.activeChildren.get(sessionId);
    if (!children || children.size === 0) return false;
    for (const child of children) {
      try { child.kill("SIGTERM"); } catch { /* 忽略 */ }
    }
    this.activeChildren.delete(sessionId);
    return true;
  }

  closeSession(sessionId: string): void {
    const children = this.activeChildren.get(sessionId);
    if (children) {
      for (const child of children) {
        try { child.kill("SIGTERM"); } catch { /* 忽略 */ }
      }
      this.activeChildren.delete(sessionId);
    }
    this.lifecycleCallbacks?.onSessionClose?.(sessionId);
  }

  closeAllSessions(): void {
    for (const children of this.activeChildren.values()) {
      for (const child of children) {
        try { child.kill("SIGTERM"); } catch { /* 忽略 */ }
      }
    }
    this.activeChildren.clear();
    for (const child of this.anonymousChildren) {
      try { child.kill("SIGTERM"); } catch { /* 忽略 */ }
    }
    this.anonymousChildren.clear();
  }

  setLifecycleCallbacks(callbacks: {
    onSessionCreate?: (sessionId: string) => void;
    onSessionClose?: (sessionId: string) => void;
  }): void {
    this.lifecycleCallbacks = callbacks;
  }

  private trackChild(sessionId: string | undefined, child: ChildProcess): void {
    if (!sessionId) {
      this.anonymousChildren.add(child);
      return;
    }
    this.anonymousChildren.delete(child);
    let set = this.activeChildren.get(sessionId);
    if (!set) {
      set = new Set();
      this.activeChildren.set(sessionId, set);
    }
    set.add(child);
  }

  private untrackChild(sessionId: string | undefined, child: ChildProcess): void {
    this.anonymousChildren.delete(child);
    if (!sessionId) return;
    const set = this.activeChildren.get(sessionId);
    if (!set) return;
    set.delete(child);
    if (set.size === 0) this.activeChildren.delete(sessionId);
  }
}
