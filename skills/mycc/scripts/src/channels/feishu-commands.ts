/**
 * 飞书命令处理模块
 *
 * 从 HttpServer 提取的飞书消息处理和命令系统
 *
 * 多会话模型（2026-07-02）：
 * 会话按 scope 隔离——私聊/普通群一个 scope（chatId），话题群每个话题一个
 * scope（chatId:threadId）。一个 bot 可以同时服务多个独立会话，互不干扰；
 * 并发锁、工作状态、会话绑定全部按 scope 粒度管理。
 * 无 ctx 的旧调用（web 同步、旧测试）落在 "__default" scope，行为不变。
 */

import type { CCAdapter } from "../adapters/interface.js";
import { getAdapter, isValidProvider, listRegisteredProviders, type AgentProvider } from "../adapters/index.js";
import type { ChannelManager } from "./manager.js";
import type { DeviceConfig } from "../types.js";
import type { FeishuStreamingSession } from "./feishu-streaming.js";
import type { FeishuMessageContext } from "./feishu.js";
import { listSkills } from "../skills.js";
import fs from "fs";
import path from "path";
import { readJsonFile, writeJsonFileAtomic } from "../json-store.js";
import { toolUseLine, summarizeToolInput } from "./tool-summary.js";
import {
  parseCardCommandValue,
  modelPickerCard,
  agentPickerCard,
  sessionPickerCard,
  optionPickerCard,
  helpMenuCard,
  processingNoticeCard,
  streamToggleCard,
  renameInputCard,
  RENAME_INPUT_NAME,
  detectSuggestedCommands,
  commandSuggestionCard,
  type SessionEntry,
} from "./card-actions.js";
import { renameSession } from "../history.js";
import {
  detectTrailingOptions,
  extractAskUserQuestionOptions,
  extractOptionCallbackToken,
  newOptionGroupId,
  optionCallbackAuth,
  OPTION_FAIL_MESSAGES,
  type DetectedOptions,
} from "./option-buttons.js";

/** 运行时状态目录：默认跟随代码位置，可用 MYCC_DATA_DIR 显式指定（部署解耦） */
const DATA_DIR = process.env.MYCC_DATA_DIR || path.resolve(import.meta.dirname, "../data");

/** 每个 bot 独立记住自己的会话绑定（v2 格式：{channelId: {scope: sessionId}}） */
const SESSION_FILE = path.join(DATA_DIR, "channel-sessions.json");

/** 每个 bot 独立记住自己选择的模型 */
const MODEL_FILE = path.join(DATA_DIR, "channel-models.json");

/** 每个 bot 按 scope 记住选择的 agent 供应商（v2 格式：{channelId: {scope: provider}}，无记录=claude） */
const AGENT_FILE = path.join(DATA_DIR, "channel-agents.json");

/** 每个 bot 按 scope 记住流式输出开关（{channelId: {scope: "off"}}，只存关闭项，无记录=开启） */
const STREAM_FILE = path.join(DATA_DIR, "channel-stream.json");

/** /agent 命令展示用的已知供应商列表（校验以 adapters/index.ts 的 isValidProvider 为准） */
const KNOWN_AGENT_PROVIDERS: AgentProvider[] = ["claude", "codex"];

/** 无 ctx 调用（web 同步、旧入口）使用的兜底 scope */
const DEFAULT_SCOPE = "__default";

/**
 * 流式模式出错时拼接最终展示文本：有已累积的部分回复时，把错误提示追加在后面
 * （用分隔线/⚠️标出，和卡片截断提示 CARD_TRUNCATE_NOTICE 的风格保持一致），
 * 而不是用 `accumulatedText || errorNotice` 把错误信息整个吞掉。
 */
function appendErrorNotice(accumulatedText: string, errorNotice: string): string {
  return accumulatedText ? `${accumulatedText}\n\n---\n⚠️ ${errorNotice}` : errorNotice;
}

/** 在正文末尾追加回合状态行（分隔线隔开）；正文为空时状态行就是全部内容 */
function withStatusLine(text: string, statusLine: string): string {
  return text ? `${text}\n\n---\n${statusLine}` : statusLine;
}

/** 提取事件里的可展示文本块（text 事件 + assistant 消息里的 text block） */
function extractTextBlocks(data: Record<string, any>): string[] {
  if (data.type === "text" && data.text) return [String(data.text)];
  if (data.type === "assistant" && Array.isArray(data.message?.content)) {
    return data.message.content
      .filter((b: any) => b.type === "text" && b.text)
      .map((b: any) => String(b.text));
  }
  return [];
}

/** 模型别名 → SDK/CLI 认识的模型 ID */
const MODEL_ALIASES: Record<string, string> = {
  sonnet: "sonnet",
  opus: "opus",
  haiku: "haiku",
  fable: "claude-fable-5",
  fable5: "claude-fable-5",
  "fable-5": "claude-fable-5",
};

/**
 * 完整模型 ID 的形状校验（如 claude-opus-4-6、claude-sonnet-4-5-20250929）。
 * 不做别名之外的严格白名单，但能挡住明显打错的字符串（如 "gpt5"、"sonet"）。
 */
const MODEL_ID_PATTERN = /^claude-(sonnet|opus|haiku|fable)(-\d+)*$/i;

/** 校验 /model 的目标是否是已知别名或形状合法的完整模型 ID */
function isValidModelTarget(target: string): boolean {
  if (MODEL_ALIASES[target.toLowerCase()]) return true;
  return MODEL_ID_PATTERN.test(target);
}

export interface FeishuCommandsDeps {
  adapter: CCAdapter;
  channelManager: ChannelManager;
  cwd: string;
  feishuChannel: any;
  loadConfig: (cwd: string) => DeviceConfig | null;
}

/** 单个 scope 的处理状态（并发锁 + 工作反馈） */
interface ScopeProcessing {
  startedAt: number;
  lastToolName?: string;
  lastToolAt?: number;
  /** 上次在卡片上显示"仍在工作"心跳提示的时间，用于节流，避免长时间等待时刷屏 */
  lastHeartbeatShownAt?: number;
  /** /stop 已对本回合发出终止指令的时间——收尾状态行据此显示 🛑 而不是 ✅/❌ */
  interruptedAt?: number;
  unlockTimer: ReturnType<typeof setTimeout>;
}

/** 两次心跳提示之间的最短间隔（心跳事件本身约 15s 一次，这里再兜底节流一层） */
const MIN_HEARTBEAT_DISPLAY_GAP_MS = 10_000;

export class FeishuCommands {
  private deps: FeishuCommandsDeps;
  private _currentModel: string | null = null;
  /** scope → sessionId 会话绑定 */
  private convSessions = new Map<string, string>();
  /** scope → agent 供应商（只存非 claude 的选择，无记录=claude，行为零变化） */
  private agentProviders = new Map<string, AgentProvider>();
  /** 关闭了流式输出的 scope 集合（只存关闭项，无记录=开启，行为零变化） */
  private streamOffScopes = new Set<string>();
  /**
   * `${scope}::${provider}` → sessionId 暂存。
   * 切换供应商时把当前会话按旧供应商暂存，切回时恢复——claude 的 sessionId 是
   * SDK 的，codex 的历史是自维护的，两边不互通，绝不能把一边的 sessionId 喂给
   * 另一边的 adapter。仅内存态：重启后活跃绑定走 channel-sessions.json 恢复，
   * 非活跃供应商的暂存丢失（切回时开新会话，claude 旧会话仍可用 /sessions 找回）。
   */
  private providerSessionStash = new Map<string, string>();
  /** scope → 处理状态（存在即表示"正在处理中"） */
  private processingScopes = new Map<string, ScopeProcessing>();
  /** 劫持用的回复通道（群路由时用） */
  private replyChannel: any = null;
  /** 小工身份名称（群聊路由时用于身份标识） */
  agentName: string = "";
  private processingTimeoutMs = 120_000; // 2分钟超时自动解锁

  constructor(deps: FeishuCommandsDeps) {
    this.deps = deps;
    this.loadPersistedSessions();
    if (this.convSessions.size > 0) {
      console.log(`[CC] 恢复 ${this.convSessions.size} 个会话绑定 (channel: ${deps.feishuChannel?.id})`);
    }
    this._currentModel = this.loadPersistedModel();
    if (this._currentModel) {
      console.log(`[CC] 恢复模型选择: ${this._currentModel} (channel: ${deps.feishuChannel?.id})`);
    }
    this.loadPersistedAgents();
    if (this.agentProviders.size > 0) {
      console.log(`[CC] 恢复 ${this.agentProviders.size} 个 agent 供应商选择 (channel: ${deps.feishuChannel?.id})`);
    }
    this.loadPersistedStreamPrefs();
    if (this.streamOffScopes.size > 0) {
      console.log(`[CC] 恢复 ${this.streamOffScopes.size} 个流式输出关闭项 (channel: ${deps.feishuChannel?.id})`);
    }
  }

  /** 查询 scope 的流式输出开关（无记录=开启） */
  private streamEnabledFor(scope: string): boolean {
    return !this.streamOffScopes.has(scope);
  }

  /** 设置 scope 的流式输出开关并持久化（开启=默认，直接删记录） */
  private setStreamEnabled(scope: string, on: boolean): void {
    if (on) {
      this.streamOffScopes.delete(scope);
    } else {
      this.streamOffScopes.add(scope);
    }
    this.persistStreamPrefs();
  }

  /** 查询 scope 当前使用的 agent 供应商（无记录=claude） */
  private currentProvider(scope: string): AgentProvider {
    return this.agentProviders.get(scope) || "claude";
  }

  /**
   * 按 scope 解析实际使用的 adapter。
   * claude（含无记录）→ 注入的 deps.adapter（向后兼容，测试可 mock）；
   * 其他供应商 → 注册表 getAdapter。同一回合内 chat/closeSession/listHistory
   * 必须都走这里，避免 chat 用 codex、closeSession 却调 claude 的鬼故事。
   */
  private adapterFor(scope: string): CCAdapter {
    const provider = this.currentProvider(scope);
    return provider === "claude" ? this.deps.adapter : getAdapter(provider);
  }

  /** /model 选择的模型只对 claude 生效；codex scope 不透传 claude 模型 ID */
  private modelFor(scope: string): string | undefined {
    return this.currentProvider(scope) === "claude" ? this._currentModel || undefined : undefined;
  }

  /** 设置 scope 的 agent 供应商并持久化（claude=默认，直接删记录） */
  private setAgentProvider(scope: string, provider: AgentProvider): void {
    if (provider === "claude") {
      this.agentProviders.delete(scope);
    } else {
      this.agentProviders.set(scope, provider);
    }
    this.persistAgents();
  }

  /** 获取实际使用的飞书通道（支持劫持） */
  private get effectiveChannel(): any {
    return this.replyChannel || this.deps.feishuChannel;
  }

  /** 设置劫持回复通道（AgentRouter 用） */
  setReplyChannel(channel: any): void {
    this.replyChannel = channel;
  }

  /** 清除劫持回复通道 */
  clearReplyChannel(): void {
    this.replyChannel = null;
  }

  /** 兼容旧接口：读写 __default scope 的会话绑定（web 同步、旧测试用） */
  get currentSessionId(): string | null {
    return this.convSessions.get(DEFAULT_SCOPE) || null;
  }

  set currentSessionId(id: string | null) {
    this.bindSession(DEFAULT_SCOPE, id);
  }

  get currentModel(): string | null {
    return this._currentModel;
  }

  set currentModel(model: string | null) {
    this._currentModel = model;
    this.persistModel();
  }

  /** 查询 scope 绑定的会话 */
  getSession(scope: string): string | null {
    return this.convSessions.get(scope) || null;
  }

  /** 绑定/解绑 scope 的会话并持久化；无变化时不写盘不打日志 */
  private bindSession(scope: string, sessionId: string | null): void {
    const prev = this.convSessions.get(scope) || null;
    if (prev === (sessionId || null)) return;
    if (sessionId) {
      // 回合处理中出现会话 ID 漂移 = 疑似 Teams/subagent 的 system 事件
      // 劫持了 scope 绑定，留告警取证（确认后再决定是否过滤 subagent 事件）
      if (prev && this.processingScopes.has(scope)) {
        console.warn(
          `[CC] ⚠ 处理中会话 ID 漂移: ${prev} → ${sessionId} (scope=${scope})，疑似 subagent system 事件劫持`
        );
      }
      this.convSessions.set(scope, sessionId);
      console.log(`[CC] 会话已绑定: ${sessionId} (scope=${scope})`);
    } else {
      this.convSessions.delete(scope);
      console.log(`[CC] 会话已解绑 (scope=${scope})`);
    }
    this.persistSessions();
  }

  /**
   * 处理飞书收到的消息
   * @param message - 消息文本
   * @param images - 图片数组
   * @param files - 文件数组（已下载到本地临时目录）
   * @param messageId - 原始消息 ID，用于回复和流式卡片
   * @param ctx - 消息上下文（scope/chatId/threadId），多会话隔离核心
   */
  async processMessage(
    message: string,
    images?: Array<{ data: string; mediaType: string }>,
    files?: Array<{ filePath: string; fileName: string }>,
    messageId?: string,
    ctx?: FeishuMessageContext,
  ): Promise<void> {
    const scope = ctx?.scope || DEFAULT_SCOPE;

    // /status、/stop 不受处理锁限制：正在干活时也能随时查询进度/紧急终止
    const lockFreeCmd = message.trim().toLowerCase();
    if (lockFreeCmd.startsWith("/status")) {
      await this.handleStatus(scope, ctx);
      return;
    }
    if (lockFreeCmd.startsWith("/stop")) {
      await this.handleStop(scope, ctx);
      return;
    }

    // 并发锁（按 scope）：同一会话串行，不同群/话题互不阻塞
    if (this.processingScopes.has(scope)) {
      console.warn(`[CC] ⚠ scope ${scope} 正在处理中，拒绝新消息: ${message.substring(0, 30)}...`);
      const busyText = `上一条消息还在处理中${this.describeProgress(scope)}，请稍等。`;
      // 优先出带终止按钮的卡片，通道不支持时回退纯文本
      if (!(await this.sendCardToFeishu(processingNoticeCard(busyText), ctx))) {
        await this.sendToFeishu(`${busyText}\n\n随时发 /status 查看进度，发 /stop 紧急终止。`, ctx);
      }
      return;
    }
    const unlockTimer = setTimeout(() => {
      if (this.processingScopes.has(scope)) {
        console.error(`[CC] ⚠ scope ${scope} processMessage 超时自动解锁 (${this.processingTimeoutMs}ms)`);
        this.processingScopes.delete(scope);
      }
    }, this.processingTimeoutMs);
    this.processingScopes.set(scope, { startedAt: Date.now(), unlockTimer });
    console.log(`[CC] 🔒 处理锁已锁定 (scope=${scope})`);

    try {
    console.log(`[CC] 收到飞书消息: ${message.substring(0, 50)}...${images ? ` [${images.length} 张图片]` : ""}${files ? ` [${files.length} 个文件]` : ""}`);

    const trimmedMessage = message.trim();

    // 如果有文件，在消息中附加文件信息
    let userMessage = trimmedMessage;
    if (files && files.length > 0) {
      const fileInfo = files.map(f => `- ${f.fileName}: ${f.filePath}`).join("\n");
      userMessage = `[用户发送了文件]\n${fileInfo}\n\n${trimmedMessage}`;
    }

    // 检查是否是 mycc 飞书专用命令
    // 原生 CC slash 命令（如 /context /usage）需要透传给 Claude，不走 mycc 命令处理
    const nativeCcSlashCommands = ["/context", "/usage", "/compact", "/clear", "/hooks", "/memory", "/debug"];
    const cmd = trimmedMessage.split(/\s+/)[0].toLowerCase();
    const isNativeCcSlash = nativeCcSlashCommands.includes(cmd);

    if (trimmedMessage.startsWith("/") && !isNativeCcSlash) {
      await this.handleFeishuCommand(trimmedMessage, messageId, ctx);
      return;
    }

    // 确定本 scope 使用的会话
    let sessionId = this.getSession(scope);
    if (!sessionId) {
      if (scope === DEFAULT_SCOPE) {
        // 兼容旧行为：默认 scope 自动接上最近的历史会话
        console.log(`[CC] 无活跃会话，尝试自动选择最近的历史会话`);
        try {
          const result = await this.adapterFor(scope).listHistory(this.deps.cwd, 1);
          if (result.conversations.length > 0) {
            const latestSession = result.conversations[0];
            this.bindSession(scope, latestSession.sessionId);
            sessionId = latestSession.sessionId;

            const title = latestSession.customTitle || latestSession.firstPrompt?.substring(0, 30) || "历史会话";
            const timeAgo = this.formatTimeAgo(latestSession.lastTime || latestSession.modified || Date.now());

            console.log(`[CC] 自动选择会话: ${sessionId} (${title})`);
            await this.sendToFeishu(`已自动使用最近的会话：${title}\n${timeAgo}\n\n继续你的对话...`, ctx);
          } else {
            console.log(`[CC] 没有历史会话，显示帮助信息`);
            await this.sendToFeishu("还没有会话记录。\n\n发送任意消息开始新对话\n发送 /help 查看所有命令", ctx);
            return;
          }
        } catch (err) {
          console.error(`[CC] 获取历史会话失败:`, err);
          await this.sendToFeishu("无法加载历史会话，请重试或发送 /new 创建新会话。", ctx);
          return;
        }
      } else {
        // 新群/新话题：不打扰用户，直接开新会话（sessionId 留空，adapter 会创建）
        console.log(`[CC] scope ${scope} 无绑定会话，本条消息将自动创建新会话`);
      }
    }

    if (sessionId) {
      console.log(`[CC] 使用会话: ${sessionId} (scope=${scope})`);
    }

    await this.streamChatToFeishu(
      this.chatWithSessionRecovery({
        scope,
        message: userMessage,
        sessionId: sessionId,
        cwd: this.deps.cwd,
        images: images,
        model: this.modelFor(scope),
      }),
      {
        scope,
        ctx,
        messageId,
        errorLogPrefix: "处理飞书消息错误",
        errorNotice: "处理消息时出错，请重试。",
      }
    );
  } catch (err) {
    console.error(`[CC] processMessage 未捕获错误:`, err);
  } finally {
    clearTimeout(unlockTimer);
    if (this.processingScopes.has(scope)) {
      console.log(`[CC] 🔓 处理锁已解锁 (scope=${scope})`);
      this.processingScopes.delete(scope);
    }
  }
}

  /**
   * 处理卡片按钮点击（Phase 5）：把按钮 value 里的 {cmd, arg} 拼回命令字符串，
   * 走 processMessage 主路径——复用并发锁、/status 拦截和现有命令处理器，
   * 点击和手敲命令行为完全一致。
   *
   * 白名单校验在 parseCardCommandValue 里：未识别命令默认会被转发给 Claude
   * 当 skill 调用，旧卡片/伪造 value 绝不能走到那条路。
   */
  async processCardAction(value: Record<string, unknown>, ctx: FeishuMessageContext): Promise<void> {
    // 选项按钮（{cb: token}）先于命令白名单分发：验票通过后选项文本
    // 被当成用户消息转回当前会话，安全性完全依赖签名（见 option-buttons.ts）
    const cbToken = extractOptionCallbackToken(value);
    if (cbToken) {
      await this.processOptionClick(cbToken, ctx);
      return;
    }
    const parsed = parseCardCommandValue(value);
    if (!parsed) {
      console.warn(`[CC] ⚠ 卡片按钮 value 无效或不在白名单: ${JSON.stringify(value).substring(0, 100)}`);
      await this.sendToFeishu("这个按钮已失效或不被支持。", ctx);
      return;
    }
    if (parsed.cmd === "/noop") {
      await this.sendToFeishu("已取消。", ctx);
      return;
    }
    let command = parsed.arg ? `${parsed.cmd} ${parsed.arg}` : parsed.cmd;
    // 重命名表单提交：新标题在 form_value（feishu.ts 挂到 value.form），不在 arg
    if (parsed.cmd === "/rename" && !parsed.arg) {
      const form = (value as { form?: Record<string, unknown> }).form;
      const title = typeof form?.[RENAME_INPUT_NAME] === "string" ? (form[RENAME_INPUT_NAME] as string).trim() : "";
      if (title) command = `/rename ${title}`;
    }
    console.log(`[CC] 🔘 卡片按钮 → ${command} (scope=${ctx.scope})`);
    await this.processMessage(command, undefined, undefined, ctx.messageId, ctx);
  }

  /**
   * 选项按钮点击（Phase 5 步骤 2）：验票 → 选项文本当用户消息走 processMessage
   * 主路径转回当前会话（复用并发锁，点击=打字回答）。
   * 验票失败按原因给差异化提示（过期/重启/他人点击/会话已切换/已答过），
   * 不静默吞掉——用户点了按钮没反应是最差体验。
   */
  private async processOptionClick(token: string, ctx: FeishuMessageContext): Promise<void> {
    const result = optionCallbackAuth.verify(token, {
      scope: ctx.scope,
      operatorId: ctx.senderId ?? "",
      sessionId: this.getSession(ctx.scope) ?? "",
    });
    if (!result.ok) {
      console.warn(`[CC] ⚠ 选项按钮验票失败: ${result.reason} (scope=${ctx.scope})`);
      await this.sendToFeishu(OPTION_FAIL_MESSAGES[result.reason], ctx);
      return;
    }
    console.log(`[CC] 🔘 选项按钮 → "${result.option.substring(0, 50)}" (scope=${ctx.scope})`);
    await this.processMessage(result.option, undefined, undefined, ctx.messageId, ctx);
  }

  /**
   * 回复结束后检测选择题并追发选项卡片。检测优先级：
   * AskUserQuestion 工具事件（结构化，可靠）> 回复文本尾部选项块（保守启发式）。
   * 出卡失败只记日志不打扰主流程——选项卡片是增强，正文已经送达。
   */
  private async maybeSendOptionCard(
    detected: DetectedOptions | null,
    scope: string,
    ctx?: FeishuMessageContext
  ): Promise<boolean> {
    if (!detected) return false;
    try {
      const sessionId = this.getSession(scope) ?? "";
      const groupId = newOptionGroupId();
      const options = detected.options.map((opt) => ({
        label: opt,
        token: optionCallbackAuth.sign({
          scope,
          senderId: ctx?.senderId ?? "",
          sessionId,
          option: opt,
          groupId,
        }),
      }));
      const ok = await this.sendCardToFeishu(optionPickerCard(detected.question, options), ctx);
      if (ok) {
        console.log(`[CC] 🔘 已出选项卡片：${detected.options.length} 个选项 (scope=${scope})`);
      }
      return ok;
    } catch (err) {
      console.warn(`[CC] ⚠ 选项卡片发送失败（不影响正文）:`, err);
      return false;
    }
  }

  /**
   * 回复里提到白名单命令时追发快捷按钮卡片（Phase 5 步骤 3）：
   * AI 说"可以发 /context 查看" → 用户不用打字，点按钮直接执行。
   * 每回合最多一张追加卡片，选项卡片（选择题）优先级更高。
   */
  private async maybeSendCommandSuggestions(
    replyText: string,
    scope: string,
    ctx?: FeishuMessageContext
  ): Promise<void> {
    const cmds = detectSuggestedCommands(replyText);
    if (!cmds) return;
    try {
      const ok = await this.sendCardToFeishu(commandSuggestionCard(cmds), ctx);
      if (ok) {
        console.log(`[CC] ⚡ 已出快捷命令卡片：${cmds.join(" ")} (scope=${scope})`);
      }
    } catch (err) {
      console.warn(`[CC] ⚠ 快捷命令卡片发送失败（不影响正文）:`, err);
    }
  }

  /**
   * 发送预构建的交互卡片（带按钮）。优先回复原消息（自动落在正确的群和话题），
   * 失败降级普通发送。通道不支持卡片（测试 mock 等）时返回 false，
   * 调用方应回退纯文本版本。
   */
  private async sendCardToFeishu(card: Record<string, unknown>, ctx?: FeishuMessageContext): Promise<boolean> {
    const channel = this.effectiveChannel;
    if (!channel) return false;

    if (ctx?.messageId && typeof channel.sendCardReply === "function") {
      const ok = await channel.sendCardReply(ctx.messageId, card);
      if (ok) return true;
    }

    if (typeof channel.sendInteractiveCard === "function") {
      const target = ctx?.chatId
        ? { receiveId: ctx.chatId, receiveIdType: "chat_id" as const }
        : channel.getReplyTarget?.();
      if (target) {
        return await channel.sendInteractiveCard(target.receiveId, card, target.receiveIdType);
      }
    }
    return false;
  }

  /**
   * 消费一个 chat 事件流并转发到飞书：优先流式卡片（单卡片实时更新），
   * 卡片不可用时降级为逐条消息。统一处理 system 会话绑定、tool_use 展示、
   * 心跳活跃提示、收尾关闭、错误提示和"正在输入"表态清理。
   * processMessage 主路径和未识别命令转发（skill 调用）共用这一份实现。
   */
  private async streamChatToFeishu(
    stream: AsyncIterable<any>,
    opts: {
      scope: string;
      ctx?: FeishuMessageContext;
      /** 原始消息 ID：提供且通道可用时才尝试流式卡片 */
      messageId?: string;
      errorLogPrefix: string;
      errorNotice: string;
    }
  ): Promise<void> {
    const { scope, ctx, messageId } = opts;
    const feishuChannel = this.effectiveChannel;
    const startedAt = Date.now();
    // 用户关闭了流式输出：整轮静默累计，结束后一次性发送完整回复。
    // 与"流式卡片启动失败的降级逐条"是两回事——降级仍然边生成边发。
    const batchMode = !this.streamEnabledFor(scope);

    // 尝试启动流式卡片（单卡片实时更新，替代逐条消息）
    let streamingSession: FeishuStreamingSession | null = null;
    if (!batchMode && feishuChannel && messageId) {
      try {
        const cfg = feishuChannel.getConfig();
        // 优先用消息自带的 chatId（多会话下不能依赖全局回复目标）
        const target = ctx?.chatId
          ? { receiveId: ctx.chatId, receiveIdType: "chat_id" as const }
          : feishuChannel.getReplyTarget?.();
        if (cfg.appId && cfg.appSecret && target) {
          const session = feishuChannel.createStreamingSession();
          await session.start(target.receiveId, target.receiveIdType, messageId);
          streamingSession = session;
          console.log(`[CC] 流式卡片已启动 (scope=${scope})`);
        }
      } catch (err) {
        console.warn(`[CC] 流式卡片启动失败，降级为普通消息: ${err}`);
        streamingSession = null;
      }
    }

    let accumulatedText = "";
    // 纯回复文本（不含工具行/心跳行），流结束后检测尾部选择题用
    let replyText = "";
    // AskUserQuestion 工具事件里的结构化选项，优先于文本启发式
    let askOptions: DetectedOptions | null = null;
    try {
      for await (const data of stream) {
        if (!data || typeof data !== "object") continue;

        if (data.type === "system" && "session_id" in data) {
          this.bindSession(scope, data.session_id as string);
        }

        if (streamingSession) {
          // 流式卡片模式：收集文本并实时更新
          if (data.type === "text" && data.text) {
            accumulatedText += String(data.text);
            replyText += String(data.text);
            await streamingSession.update(accumulatedText);
          } else if (data.type === "assistant") {
            const content = (data as any).message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "text" && block.text) {
                  accumulatedText += String(block.text);
                  replyText += String(block.text);
                } else if (block.type === "tool_use") {
                  if (block.name === "AskUserQuestion") {
                    askOptions = askOptions ?? extractAskUserQuestionOptions(block.input);
                  }
                  if (feishuChannel?.getConfig?.()?.showToolUse !== false) {
                    // 实时展示工具调用，让用户知道 AI 正在干什么
                    accumulatedText += this.noteToolUse(block, scope);
                  }
                }
              }
              await streamingSession.update(accumulatedText);
            }
          } else if (data.type === "heartbeat") {
            // 长时间无新文本/工具输出（如 Teams 多轮等待）→ 显示"仍在运行"提示，让卡片不再死寂
            const line = this.noteHeartbeat(scope);
            if (line) {
              accumulatedText += line;
              await streamingSession.update(accumulatedText);
            }
          }
        } else if (batchMode) {
          // 批量模式：只累计文本和工具状态（供 /status 查询），处理期间不发消息
          for (const text of extractTextBlocks(data)) {
            replyText += text;
          }
          if (data.type === "assistant" && Array.isArray((data as any).message?.content)) {
            for (const block of (data as any).message.content) {
              if (block.type === "tool_use") {
                if (block.name === "AskUserQuestion") {
                  askOptions = askOptions ?? extractAskUserQuestionOptions(block.input);
                }
                this.noteToolUse(block, scope);
              }
            }
          }
        } else {
          // 降级模式：逐条发送
          if (data.type === "text" && data.text) {
            const text = String(data.text);
            replyText += text;
            console.log(`[CC] 发送文本: ${text.substring(0, 30)}...`);
            await this.sendToFeishu(text, ctx);
          } else if (data.type === "assistant") {
            const assistantEvent = data as any;
            if (assistantEvent.message?.content) {
              for (const block of assistantEvent.message.content) {
                if (block.type === "text" && block.text) {
                  const text = String(block.text);
                  replyText += text;
                  console.log(`[CC] 发送文本: ${text.substring(0, 30)}...`);
                  await this.sendToFeishu(text, ctx);
                } else if (block.type === "tool_use") {
                  if (block.name === "AskUserQuestion") {
                    askOptions = askOptions ?? extractAskUserQuestionOptions(block.input);
                  }
                  this.noteToolUse(block, scope); // 记录状态供 /status 查询
                  const name = block.name || "unknown";
                  const summary = summarizeToolInput(name, block.input, 200);
                  const toolCallText = `**使用工具: ${name}**${summary ? `\n\`${summary}\`` : ""}`;
                  console.log(`[CC] 发送工具调用: ${name}`);
                  await this.sendToFeishu(toolCallText, ctx);
                }
              }
            }
          }
        }
      }

      // 收尾：流式卡片末尾追加状态行再定格（用户不用猜"跑完了没"）；
      // 批量模式此刻才一次性发送完整回复（消息到达本身就是完成信号，不加状态行）
      const stoppedByUser = !!this.processingScopes.get(scope)?.interruptedAt;
      const statusLine = this.turnStatusLine(stoppedByUser ? "stopped" : "done", startedAt);
      if (streamingSession) {
        await streamingSession.close(withStatusLine(accumulatedText, statusLine));
      } else if (batchMode && (replyText || stoppedByUser)) {
        await this.sendToFeishu(stoppedByUser ? withStatusLine(replyText, statusLine) : replyText, ctx);
      }

      // 回复正常结束后检测选择题，追发选项按钮卡片（每回合最多一张追加卡片；
      // 出错中断的回合不出题——正文都没送完整，选项没有意义）。
      // 没出选择题时再检测正文提到的命令，追发快捷命令按钮（选择题优先，二者不同发）
      const optionCardSent = await this.maybeSendOptionCard(
        askOptions ?? detectTrailingOptions(replyText),
        scope,
        ctx
      );
      if (!optionCardSent) {
        await this.maybeSendCommandSuggestions(replyText, scope, ctx);
      }
    } catch (err) {
      console.error(`[CC] ${opts.errorLogPrefix}:`, err);
      // /stop 终止可能让流以报错收场（codex 杀子进程必然如此）——这是用户主动
      // 行为，显示 🛑 状态行，不吓唬人说"出错了"
      const stoppedByUser = !!this.processingScopes.get(scope)?.interruptedAt;
      const statusLine = this.turnStatusLine(stoppedByUser ? "stopped" : "error", startedAt);
      if (streamingSession) {
        const finalText = stoppedByUser
          ? withStatusLine(accumulatedText, statusLine)
          : `${appendErrorNotice(accumulatedText, opts.errorNotice)}\n${statusLine}`;
        await streamingSession.close(finalText).catch(() => {});
      } else if (stoppedByUser) {
        await this.sendToFeishu(withStatusLine(batchMode ? replyText : "", statusLine), ctx);
      } else if (batchMode && replyText) {
        // 批量模式出错：把已生成的部分回复带出来，不能只发一句错误提示
        await this.sendToFeishu(`${appendErrorNotice(replyText, opts.errorNotice)}\n${statusLine}`, ctx);
      } else {
        await this.sendToFeishu(opts.errorNotice, ctx);
      }
    } finally {
      if (feishuChannel) {
        await feishuChannel.clearTypingIndicator(ctx?.messageId);
      }
    }
  }

  /**
   * 回合收尾状态行：流式卡片本身没有肉眼可辨的"结束"信号，收尾时在正文
   * 末尾追加一行状态，用户不用猜该不该继续等。
   * done=正常完成 / stopped=被 /stop 终止 / error=出错中断
   */
  private turnStatusLine(outcome: "done" | "stopped" | "error", startedAt: number): string {
    const elapsed = this.formatElapsed(Date.now() - startedAt);
    if (outcome === "stopped") return `🛑 已手动终止 · 已运行 ${elapsed}`;
    if (outcome === "error") return `❌ 出错中断 · 已运行 ${elapsed}`;
    return `✅ 已完成 · 耗时 ${elapsed}`;
  }

  /** 格式化耗时为 "1 分30 秒" / "45 秒"（/status 和心跳提示共用） */
  private formatElapsed(ms: number): string {
    const elapsed = Math.max(0, Math.round(ms / 1000));
    return elapsed >= 60 ? `${Math.floor(elapsed / 60)} 分${elapsed % 60} 秒` : `${elapsed} 秒`;
  }

  /** 描述指定 scope 的处理进度："（已运行 2 分钟，正在执行 Bash）" */
  private describeProgress(scope: string): string {
    const p = this.processingScopes.get(scope);
    if (!p) return "";
    let s = `（已运行 ${this.formatElapsed(Date.now() - p.startedAt)}`;
    if (p.lastToolName && p.lastToolAt) {
      s += `，最近动作：🔧 ${p.lastToolName}（${this.formatElapsed(Date.now() - p.lastToolAt)}前）`;
    }
    return s + "）";
  }

  /**
   * 心跳事件（长时间无新文本/工具输出时的"仍在运行"提示）对应的卡片展示行。
   * 复用 describeProgress 同款耗时/工具信息，格式贴近 /status 的进度描述，
   * 只是换成更适合嵌在卡片正文里的单行提示。
   * 节流：同一 scope 距上次显示不足 MIN_HEARTBEAT_DISPLAY_GAP_MS 时返回空字符串，
   * 避免长时间等待（如 Teams 多轮）时刷屏。
   */
  private noteHeartbeat(scope: string): string {
    const p = this.processingScopes.get(scope);
    const now = Date.now();
    if (p) {
      if (p.lastHeartbeatShownAt && now - p.lastHeartbeatShownAt < MIN_HEARTBEAT_DISPLAY_GAP_MS) {
        return "";
      }
      p.lastHeartbeatShownAt = now;
    }
    const elapsedStr = this.formatElapsed(now - (p?.startedAt ?? now));
    const doing = p?.lastToolName ? `，正在执行 ${p.lastToolName}` : "，仍在处理中";
    return `\n⏳ 已运行 ${elapsedStr}${doing}...\n`;
  }

  /** /status：查询当前 scope 是否在干活（不受处理锁限制） */
  private async handleStatus(scope: string, ctx?: FeishuMessageContext): Promise<void> {
    if (this.processingScopes.has(scope)) {
      const busyText = `正在处理消息${this.describeProgress(scope)}。\n\n处理完会自动回复，请稍等。`;
      if (!(await this.sendCardToFeishu(processingNoticeCard(busyText), ctx))) {
        await this.sendToFeishu(`⏳ ${busyText}\n\n发 /stop 可紧急终止。`, ctx);
      }
    } else {
      const sessionId = this.getSession(scope);
      const session = sessionId ? `\n当前会话: ${sessionId.substring(0, 8)}...` : "\n当前会话: 无（下一条消息自动创建）";
      const model = this._currentModel ? `\n当前模型: ${this._currentModel}` : "";
      const provider = this.currentProvider(scope);
      const agent = provider !== "claude" ? `\n当前 agent: ${provider}` : "";
      const busy = this.processingScopes.size > 0 ? `\n\n（本 bot 其他会话有 ${this.processingScopes.size} 个正在处理，互不影响）` : "";
      await this.sendToFeishu(`✅ 本会话空闲，随时可以发消息。${session}${model}${agent}${busy}`, ctx);
    }
  }

  /**
   * /stop：紧急终止当前 scope 正在跑的回合（不受处理锁限制，等价终端 Esc）。
   * 只打断当前回合，会话保留——终止后直接发下一条消息即可继续。
   * 处理锁由被打断回合的 finally 正常释放，这里不动锁，避免双方竞态。
   */
  private async handleStop(scope: string, ctx?: FeishuMessageContext): Promise<void> {
    if (!this.processingScopes.has(scope)) {
      await this.sendToFeishu("当前没有正在处理的任务，无需终止。", ctx);
      return;
    }
    const sessionId = this.getSession(scope);
    if (!sessionId) {
      await this.sendToFeishu("任务刚启动，还没拿到会话 ID，暂时无法终止——稍等几秒再试，或等它自行结束。", ctx);
      return;
    }
    // 先标记再打断：中断生效的瞬间被打断回合就会收尾，标记晚了状态行会竞态成 ✅/❌
    const processing = this.processingScopes.get(scope);
    if (processing) processing.interruptedAt = Date.now();
    try {
      const interrupted = await this.adapterFor(scope).interruptSession(sessionId);
      if (interrupted) {
        console.log(`[CC] 🛑 已打断会话 ${sessionId} (scope=${scope})`);
        await this.sendToFeishu(`🛑 已发送终止指令${this.describeProgress(scope)}。\n\n任务会在当前步骤停下，会话保留，可以直接发下一条消息。`, ctx);
      } else {
        if (processing) delete processing.interruptedAt;
        await this.sendToFeishu("没找到正在运行的任务进程——可能刚好已经结束了。发 /status 确认一下。", ctx);
      }
    } catch (err) {
      if (processing) delete processing.interruptedAt;
      console.error(`[CC] ✗ 终止失败 (scope=${scope}):`, err);
      await this.sendToFeishu(`终止失败：${err instanceof Error ? err.message : String(err)}\n\n可以再试一次 /stop。`, ctx);
    }
  }

  /**
   * /stream：查看/切换当前群（话题）的流式输出开关。
   * 关闭后整轮静默处理（"正在输入"表态仍在），结束时一次性发送完整回复；
   * 按 scope 持久化，重启后仍生效。对当前正在跑的回合不生效，下一条消息起算。
   */
  private async handleStream(target?: string, ctx?: FeishuMessageContext): Promise<void> {
    const scope = ctx?.scope || DEFAULT_SCOPE;
    const current = this.streamEnabledFor(scope);
    const usage = "用法: /stream on | off（只作用于当前群/话题）";

    if (!target) {
      // 优先发带切换按钮的卡片，通道不支持时回退纯文本
      if (await this.sendCardToFeishu(streamToggleCard(current), ctx)) return;
      await this.sendToFeishu(`当前流式输出: ${current ? "开启" : "关闭"}\n\n${usage}`, ctx);
      return;
    }

    const lower = target.toLowerCase();
    if (lower !== "on" && lower !== "off") {
      await this.sendToFeishu(`无效参数: ${target}\n\n${usage}`, ctx);
      return;
    }

    const on = lower === "on";
    if (on === current) {
      await this.sendToFeishu(`流式输出已经是${on ? "开启" : "关闭"}状态，无需切换。`, ctx);
      return;
    }

    this.setStreamEnabled(scope, on);
    console.log(`[CC] 流式输出已${on ? "开启" : "关闭"} (scope=${scope})`);
    await this.sendToFeishu(
      on
        ? "已开启流式输出：回复会边生成边更新到卡片上。"
        : "已关闭流式输出：处理期间保持安静，完成后一次性发送完整回复。\n\n随时发 /status 查进度、/stop 终止任务。",
      ctx
    );
  }

  /** 记录一次工具调用并生成卡片上的展示行 */
  private noteToolUse(block: any, scope: string): string {
    const name = String(block?.name || "unknown");
    const p = this.processingScopes.get(scope);
    if (p) {
      p.lastToolName = name;
      p.lastToolAt = Date.now();
    }
    return toolUseLine(name, block?.input);
  }

  private async *chatWithSessionRecovery(params: {
    /** 消息所属 scope：决定这一回合用哪个供应商的 adapter（chat/closeSession 必须同源） */
    scope: string;
    message: string;
    sessionId?: string | null;
    cwd: string;
    images?: Array<{ data: string; mediaType: string }>;
    model?: string;
  }): AsyncIterable<any> {
    // 回合开始时解析一次 adapter，整个回合（含重试）固定用它，
    // 避免中途 /agent 切换导致 chat 和 closeSession 打到不同供应商
    const adapter = this.adapterFor(params.scope);
    try {
      for await (const data of adapter.chat({
        message: params.message,
        sessionId: params.sessionId || undefined,
        cwd: params.cwd,
        images: params.images,
        model: params.model,
      })) {
        yield data;
      }
    } catch (err) {
      if (!params.sessionId || !this.isRecoverableSessionError(err)) {
        throw err;
      }

      console.warn("[CC] session error, closing stale session and retrying once: " + params.sessionId);
      adapter.closeSession(params.sessionId);

      for await (const data of adapter.chat({
        message: params.message,
        sessionId: params.sessionId,
        cwd: params.cwd,
        images: params.images,
        model: params.model,
      })) {
        yield data;
      }
    }
  }

  private isRecoverableSessionError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /ProcessTransport|not ready|closed|Connection lost|EPIPE|ECONNRESET|stream|session/i.test(message);
  }

  /**
   * 处理飞书命令
   */
  private async handleFeishuCommand(command: string, messageId?: string, ctx?: FeishuMessageContext): Promise<void> {
    const parts = command.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);
    const scope = ctx?.scope || DEFAULT_SCOPE;

    console.log(`[CC] 📋 处理飞书命令: ${cmd} (scope=${scope})`);
    const startTime = Date.now();

    try {
      switch (cmd) {
        case "/new":
        case "/create":
          await this.handleNewSession(args.join(" "), ctx);
          break;

        case "/sessions":
        case "/list":
        case "/history":
          await this.handleListSessions(ctx);
          break;

        case "/switch":
          await this.handleSwitchSession(args[0], ctx);
          break;

        case "/rename":
          await this.handleRenameSession(args.join(" "), ctx);
          break;

        case "/current":
          await this.handleCurrentSession(ctx);
          break;

        case "/status":
          // 正常情况在 processMessage 锁之前就被拦截了，这里兜底
          await this.handleStatus(scope, ctx);
          break;

        case "/stop":
          // 同 /status：正常在锁前拦截，这里兜底
          await this.handleStop(scope, ctx);
          break;

        case "/stream":
          await this.handleStream(args[0], ctx);
          break;

        case "/model":
          await this.handleModel(args[0], ctx);
          break;

        case "/agent":
          await this.handleAgent(args[0], ctx);
          break;

        case "/device":
        case "/devices":
          await this.handleDevice(ctx);
          break;

        case "/agents":
          await this.handleAgents(ctx);
          break;

        case "/help":
        case "/?":
          await this.handleHelp(ctx);
          break;

        case "/skills":
          await this.handleListSkills(ctx);
          break;

        default: {
          // 未识别的命令可能是 skill 调用，转发给 Claude Code 处理
          console.log(`[CC] 未识别命令 ${cmd}，转发给 Claude Code 作为普通消息`);
          const skillMessage = command;
          // 确定会话（与普通消息一致：默认 scope 自动接最近，其他 scope 自动新建）
          let sessionId = this.getSession(scope);
          if (!sessionId && scope === DEFAULT_SCOPE) {
            try {
              const result = await this.adapterFor(scope).listHistory(this.deps.cwd, 1);
              if (result.conversations.length > 0) {
                this.bindSession(scope, result.conversations[0].sessionId);
                sessionId = result.conversations[0].sessionId;
              }
            } catch { /* ignore */ }
          }

          await this.streamChatToFeishu(
            this.chatWithSessionRecovery({
              scope,
              message: skillMessage,
              sessionId: sessionId,
              cwd: this.deps.cwd,
              model: this.modelFor(scope),
            }),
            {
              scope,
              ctx,
              messageId,
              errorLogPrefix: "Skill 命令处理错误",
              errorNotice: "处理命令时出错，请重试。",
            }
          );
          break;
        }
      }
    } catch (err) {
      console.error(`[CC] 命令处理错误:`, err);
      await this.sendToFeishu(`执行命令时出错: ${err instanceof Error ? err.message : String(err)}`, ctx);
    }
    const elapsed = Date.now() - startTime;
    console.log(`[CC] ✅ 命令处理完成 (${elapsed}ms)`);
  }

  private async handleNewSession(title?: string, ctx?: FeishuMessageContext): Promise<void> {
    const scope = ctx?.scope || DEFAULT_SCOPE;
    console.log(`[CC] 创建新会话${title ? `: ${title}` : ''} (scope=${scope})`);

    try {
      const replyParts: string[] = [];
      let newSessionId: string | undefined;

      for await (const data of this.adapterFor(scope).chat({
        message: title || "开始新对话",
        cwd: this.deps.cwd,
        model: this.modelFor(scope),
      })) {
        if (data && typeof data === "object") {
          if (data.type === "system" && "session_id" in data) {
            this.bindSession(scope, data.session_id as string);
            newSessionId = data.session_id as string;
            console.log(`[CC] 新会话已创建: ${newSessionId} (scope=${scope})`);
          }
          replyParts.push(...extractTextBlocks(data));
        }
      }

      let response = "";
      if (newSessionId) {
        response = `新会话已创建\n\n`;
        response += `会话 ID: ${newSessionId}\n`;
        if (title) {
          response += `标题: ${title}\n`;
        }
        response += `\n`;
      }

      if (replyParts.length > 0) {
        response += replyParts.join("").trim();
      } else if (newSessionId) {
        response += `现在发送的消息将使用此会话。`;
      }

      await this.sendToFeishu(response, ctx);
    } catch (err) {
      console.error(`[CC] 创建会话错误:`, err);
      await this.sendToFeishu("创建会话失败，请重试。", ctx);
    }
  }

  private async handleListSessions(ctx?: FeishuMessageContext): Promise<void> {
    const scope = ctx?.scope || DEFAULT_SCOPE;
    console.log(`[CC] 列出历史会话`);

    try {
      const result = await this.adapterFor(scope).listHistory(this.deps.cwd, 10);
      const conversations = result.conversations;

      if (conversations.length === 0) {
        await this.sendToFeishu("还没有历史会话。\n\n发送 /new 创建第一个会话。", ctx);
        return;
      }

      const currentId = this.getSession(scope);
      const entries: SessionEntry[] = conversations.map((conv, index) => {
        let title = "未命名会话";
        if (conv.customTitle) {
          title = conv.customTitle;
        } else if (conv.firstPrompt) {
          title = conv.firstPrompt.substring(0, 30);
        } else if (conv.lastMessagePreview) {
          title = conv.lastMessagePreview.substring(0, 30);
        }
        return {
          index: index + 1,
          title,
          timeAgo: this.formatTimeAgo(conv.lastTime || conv.modified || Date.now()),
          current: conv.sessionId === currentId,
        };
      });

      // 优先发带按钮的卡片（点按钮=发 /switch <序号>），通道不支持时回退纯文本
      if (await this.sendCardToFeishu(sessionPickerCard(entries, result.total), ctx)) return;

      let output = `历史会话 (共 ${result.total} 个，显示最近 ${entries.length} 个)\n\n`;
      for (const e of entries) {
        output += `${e.index}. ${e.title}${e.current ? " [当前]" : ""}\n`;
        output += `   ${e.timeAgo}\n\n`;
      }
      output += `使用 /switch <序号> 切换到某个会话`;

      await this.sendToFeishu(output, ctx);
    } catch (err) {
      console.error(`[CC] 获取会话列表错误:`, err);
      await this.sendToFeishu("获取会话列表失败，请重试。", ctx);
    }
  }

  private async handleSwitchSession(target: string | undefined, ctx?: FeishuMessageContext): Promise<void> {
    const scope = ctx?.scope || DEFAULT_SCOPE;
    console.log(`[CC] 切换会话: ${target} (scope=${scope})`);

    if (!target) {
      await this.sendToFeishu("请指定要切换的会话序号。\n\n使用 /sessions 查看所有会话。", ctx);
      return;
    }

    try {
      const result = await this.adapterFor(scope).listHistory(this.deps.cwd, 50);
      const conversations = result.conversations;

      const index = parseInt(target, 10) - 1;
      if (isNaN(index) || index < 0 || index >= conversations.length) {
        await this.sendToFeishu(`无效的序号: ${target}\n\n使用 /sessions 查看有效序号。`, ctx);
        return;
      }

      const targetSession = conversations[index];

      if (targetSession.sessionId === this.getSession(scope)) {
        const title = targetSession.customTitle || targetSession.firstPrompt?.substring(0, 30) || "未命名";
        await this.sendToFeishu(`已经在这个会话中了：${title}`, ctx);
        return;
      }

      this.bindSession(scope, targetSession.sessionId);
      const title = targetSession.customTitle || targetSession.firstPrompt?.substring(0, 30) || "未命名";
      const timeAgo = this.formatTimeAgo(targetSession.lastTime || targetSession.modified || Date.now());

      await this.sendToFeishu(
        `已切换到会话：${title}\n\n` +
        `最后更新: ${timeAgo}\n\n` +
        `现在发送的消息将使用这个会话。`,
        ctx
      );
    } catch (err) {
      console.error(`[CC] 切换会话错误:`, err);
      await this.sendToFeishu("切换会话失败，请重试。", ctx);
    }
  }

  /**
   * /rename：重命名当前会话。有参直接改；无参发输入卡片（卡片 2.0 表单），
   * 提交后经 processCardAction 拼回 `/rename <新标题>` 走同一路径。
   * 只支持 claude 会话——renameSession 写的是 claude 的 .jsonl 历史文件。
   */
  private async handleRenameSession(title?: string, ctx?: FeishuMessageContext): Promise<void> {
    const scope = ctx?.scope || DEFAULT_SCOPE;
    if (this.currentProvider(scope) !== "claude") {
      await this.sendToFeishu("当前 agent 供应商的会话暂不支持重命名（仅 claude 会话可用）。", ctx);
      return;
    }
    const currentId = this.getSession(scope);
    if (!currentId) {
      await this.sendToFeishu("当前没有活跃的会话，先发一条消息或用 /new 创建后再重命名。", ctx);
      return;
    }

    const trimmed = (title || "").trim();
    if (!trimmed) {
      // 无参：优先发输入卡片，通道不支持卡片时回退用法说明
      let currentTitle: string | undefined;
      try {
        const result = await this.adapterFor(scope).listHistory(this.deps.cwd, 50);
        const conv = result.conversations.find((c) => c.sessionId === currentId);
        currentTitle = conv?.customTitle || conv?.firstPrompt?.substring(0, 30) || undefined;
      } catch { /* 拿不到标题不影响出卡 */ }
      if (await this.sendCardToFeishu(renameInputCard(currentTitle), ctx)) return;
      await this.sendToFeishu("用法: /rename <新标题>\n\n重命名当前群/话题正在使用的会话。", ctx);
      return;
    }

    console.log(`[CC] 重命名会话 ${currentId} → "${trimmed}" (scope=${scope})`);
    const ok = renameSession(currentId, trimmed, this.deps.cwd);
    if (ok) {
      await this.sendToFeishu(`✅ 会话已重命名为：${trimmed}`, ctx);
    } else {
      await this.sendToFeishu("重命名失败：找不到会话文件或写入失败，请重试。", ctx);
    }
  }

  private async handleCurrentSession(ctx?: FeishuMessageContext): Promise<void> {
    const scope = ctx?.scope || DEFAULT_SCOPE;
    console.log(`[CC] 显示当前会话 (scope=${scope})`);

    const currentId = this.getSession(scope);
    if (!currentId) {
      await this.sendToFeishu("当前没有活跃的会话。\n\n直接发消息会自动创建新会话，也可以用 /new 创建，或 /sessions 选择一个历史会话。", ctx);
      return;
    }

    try {
      const conversation = await this.adapterFor(scope).getHistory(this.deps.cwd, currentId);

      if (!conversation) {
        await this.sendToFeishu("当前会话不存在。\n\n使用 /new 创建新会话。", ctx);
        return;
      }

      let title = "未命名会话";
      let lastMessageTime: string | undefined;

      for (const msg of conversation.messages) {
        if (msg.type === "custom-title" && msg.customTitle) {
          title = msg.customTitle;
        }
        if (msg.timestamp) {
          lastMessageTime = msg.timestamp;
        }
      }

      if (title === "未命名会话") {
        const firstUserMsg = conversation.messages.find(m => m.type === "user" && m.message);
        if (firstUserMsg?.message?.content) {
          const content = firstUserMsg.message.content;
          if (typeof content === "string") {
            title = content.substring(0, 30);
          } else if (Array.isArray(content)) {
            const textBlock = (content as any[]).find((b: any) => b.type === "text" && b.text);
            if (textBlock) {
              title = textBlock.text.substring(0, 30);
            }
          }
        }
      }

      const timeStr = lastMessageTime ? this.formatTimeAgo(lastMessageTime) : "未知";
      const msgCount = conversation.messages.length;

      await this.sendToFeishu(
        `当前会话信息\n\n` +
        `标题: ${title}\n` +
        `ID: ${conversation.sessionId}\n` +
        `消息数: ${msgCount}\n` +
        `最后活动: ${timeStr}`,
        ctx
      );
    } catch (err) {
      console.error(`[CC] 获取会话信息错误:`, err);
      await this.sendToFeishu("获取会话信息失败，请重试。", ctx);
    }
  }

  private async handleModel(target?: string, ctx?: FeishuMessageContext): Promise<void> {
    console.log(`[CC] 切换模型: ${target}`);

    const usage =
      `可选: /model sonnet | opus | haiku | fable5\n` +
      `也可以直接传完整模型 ID，如 /model claude-fable-5`;

    if (!target) {
      // 优先发带按钮的卡片（点按钮=发 /model <别名>），通道不支持时回退纯文本
      if (await this.sendCardToFeishu(modelPickerCard(this._currentModel), ctx)) return;
      const current = this._currentModel || "claude-fable-5（默认）";
      await this.sendToFeishu(`当前模型: ${current}\n\n${usage}`, ctx);
      return;
    }

    if (!isValidModelTarget(target)) {
      await this.sendToFeishu(
        `无效的模型: ${target}\n\n${usage}`,
        ctx
      );
      return;
    }

    const resolved = MODEL_ALIASES[target.toLowerCase()] || target;

    // currentModel 是整个 bot（channel）级别的设置，会影响所有 scope。
    // 已经建立的会话对象在 SDK v2 API 里不支持中途改 model（SDKSession 只有
    // send/stream/close），所以必须把已绑定的 session 从池里驱逐掉——
    // 下一条消息会走 resumeSession(sessionId, {model: 新模型}) 重新创建session对象，
    // 由于 sessionId 不变，CLI 会从持久化的历史记录里恢复对话内容，不丢历史。
    for (const [sessScope, sessionId] of this.convSessions) {
      // 各 scope 可能绑在不同供应商上，驱逐必须用会话所属供应商的 adapter
      this.adapterFor(sessScope).closeSession(sessionId);
    }

    this.currentModel = resolved;
    await this.sendToFeishu(`已切换模型: ${resolved}\n\n下一条消息起生效。`, ctx);
  }

  /**
   * /agent 命令：查看/切换当前群（话题）使用的 agent 供应商（claude/codex）。
   *
   * 切换语义：每个 scope 每个 provider 各自记会话绑定。
   * claude 的 sessionId 是 SDK 的、codex 的历史是自维护的，两边不互通，
   * 切换时把当前会话按旧供应商暂存并从旧 adapter 池驱逐；新供应商此前
   * 有暂存会话就恢复，没有就解绑（下一条消息自动创建新会话）。
   */
  private async handleAgent(target?: string, ctx?: FeishuMessageContext): Promise<void> {
    const scope = ctx?.scope || DEFAULT_SCOPE;
    console.log(`[CC] 切换 agent 供应商: ${target ?? "(查询)"} (scope=${scope})`);

    const registered = listRegisteredProviders() as string[];
    const list = KNOWN_AGENT_PROVIDERS
      .map(p => `• ${p}${registered.includes(p) ? "" : "（尚未接入）"}`)
      .join("\n");
    const usage = `用法: /agent claude | codex（只作用于当前群/话题）\n\n可用供应商:\n${list}`;

    if (!target) {
      const current = this.currentProvider(scope);
      // 优先发带按钮的卡片（点按钮=发 /agent <供应商>），通道不支持时回退纯文本
      const providers = KNOWN_AGENT_PROVIDERS.map(p => ({ name: p, registered: registered.includes(p) }));
      if (await this.sendCardToFeishu(agentPickerCard(current, providers), ctx)) return;
      const suffix = this.agentProviders.has(scope) ? "" : "（默认）";
      await this.sendToFeishu(`当前 agent: ${current}${suffix}\n\n${usage}`, ctx);
      return;
    }

    const lower = target.toLowerCase();
    if (!isValidProvider(lower)) {
      await this.sendToFeishu(`无效的 agent 供应商: ${target}\n\n${usage}`, ctx);
      return;
    }

    const prev = this.currentProvider(scope);
    if (prev === lower) {
      await this.sendToFeishu(`当前已经在使用 ${lower}，无需切换。`, ctx);
      return;
    }

    if (!registered.includes(lower)) {
      await this.sendToFeishu(`agent 供应商 ${lower} 尚未接入，暂时无法切换。\n\n${usage}`, ctx);
      return;
    }

    // 暂存当前会话（按旧供应商），并从旧供应商的池里驱逐 session 对象。
    // 注意 adapterFor 必须在 setAgentProvider 之前调用，才能拿到旧供应商的 adapter。
    const currentSession = this.getSession(scope);
    if (currentSession) {
      this.providerSessionStash.set(`${scope}::${prev}`, currentSession);
      try {
        this.adapterFor(scope).closeSession(currentSession);
      } catch (err) {
        console.warn(`[CC] 切换 agent 时驱逐旧会话失败（忽略）: ${err}`);
      }
    }

    this.setAgentProvider(scope, lower);

    // 新供应商此前有暂存会话就恢复，否则解绑（下一条消息自动创建新会话）
    const restored = this.providerSessionStash.get(`${scope}::${lower}`) || null;
    this.bindSession(scope, restored);

    const sessionNote = restored
      ? `已恢复此前在 ${lower} 下的会话（${restored.substring(0, 8)}...）。`
      : `新会话将在下一条消息时自动创建。`;
    await this.sendToFeishu(`已切换 agent: ${prev} → ${lower}\n\n${sessionNote}`, ctx);
  }

  private async handleDevice(ctx?: FeishuMessageContext): Promise<void> {
    console.log("[CC] 查询设备信息");

    try {
      const config = this.deps.loadConfig(this.deps.cwd) as DeviceConfig;

      if (!config) {
        await this.sendToFeishu("未找到设备配置", ctx);
        return;
      }

      const createdAt = new Date(config.createdAt);
      const createdTimeStr = createdAt.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });

      let output = "当前设备信息\n\n";
      output += `设备 ID: ${config.deviceId}\n`;
      output += `配对码: ${config.pairCode}\n`;

      if (config.routeToken) {
        output += `连接码: ${config.routeToken}\n`;
      }

      if (config.authToken) {
        output += `状态: 已配对\n`;
      } else {
        output += `状态: 未配对\n`;
      }

      output += `\n创建时间: ${createdTimeStr}`;

      await this.sendToFeishu(output, ctx);
    } catch (err) {
      console.error(`[CC] 获取设备信息错误:`, err);
      await this.sendToFeishu("获取设备信息失败，请重试。", ctx);
    }
  }

  private async handleAgents(ctx?: FeishuMessageContext): Promise<void> {
    const agents = [
      { name: "技术助手", desc: "代码、编程、bug排查、部署" },
      { name: "写作助手", desc: "文案、文章、公众号、润色" },
      { name: "数据分析", desc: "数据分析、表格、统计、报表" },
      { name: "社媒运营", desc: "社媒运营、内容策略、涨粉" },
      { name: "通用助手", desc: "兜底：不属于以上分类的问题" },
    ];

    let output = "当前在线小工\n\n";
    agents.forEach((agent, index) => {
      output += `${index + 1}. **${agent.name}** — ${agent.desc}\n`;
    });
    output += "\n使用方式：\n";
    output += "• @all — 智能分配给最适合的小工\n";
    output += "• @具体小工 — 直接点名（如@技术助手）\n";

    await this.sendToFeishu(output, ctx);
  }

  private async handleListSkills(ctx?: FeishuMessageContext): Promise<void> {
    console.log("[CC] 列出可用 skills");

    try {
      const skillsDir = this.deps.cwd + "/.claude/skills";
      const skills = listSkills(skillsDir);

      if (skills.length === 0) {
        await this.sendToFeishu("当前没有可用的 skill。", ctx);
        return;
      }

      let output = `可用 Skill（共 ${skills.length} 个）\n\n`;
      skills.forEach((skill, index) => {
        const desc = skill.description ? ` - ${skill.description}` : "";
        output += `${index + 1}. /${skill.name}${desc}\n`;
      });

      output += `\n输入 /skill名称 调用对应 skill`;

      await this.sendToFeishu(output, ctx);
    } catch (err) {
      console.error("[CC] 获取 skill 列表错误:", err);
      await this.sendToFeishu("获取 skill 列表失败，请重试。", ctx);
    }
  }

  private async handleHelp(ctx?: FeishuMessageContext): Promise<void> {
    // 优先出带按钮的命令菜单卡片（Phase 5 步骤 3），通道不支持卡片时回退纯文本
    if (await this.sendCardToFeishu(helpMenuCard(), ctx)) {
      console.log(`[CC] 📖 已发送命令菜单卡片`);
      return;
    }
    const helpText =
      "飞书命令帮助\n\n" +
      "**多会话说明**\n" +
      "每个私聊/群是独立会话；话题群里每个话题也是独立会话。\n" +
      "新群/新话题直接发消息即可，会自动创建会话。\n\n" +
      "**会话管理**（均只作用于当前群/话题）\n" +
      "/new [标题] - 创建新会话\n" +
      "/sessions - 查看历史会话\n" +
      "/switch <序号> - 把当前群/话题切到某个历史会话\n" +
      "/rename <新标题> - 重命名当前会话\n" +
      "/current - 显示当前会话信息\n" +
      "/status - 查看 AI 是否正在干活（处理中也能查）\n" +
      "/stop - 紧急终止正在跑的任务（处理中也能发，会话保留）\n\n" +
      "**模型 / 输出**\n" +
      "/model - 查看当前模型\n" +
      "/model <sonnet|opus|haiku|fable5> - 切换模型\n" +
      "/stream on|off - 开关流式输出（关闭后完成时一次性发送完整回复）\n\n" +
      "**Agent 供应商**\n" +
      "/agent - 查看当前 agent 供应商\n" +
      "/agent <claude|codex> - 切换供应商（只作用于当前群/话题）\n\n" +
      "**Skill**\n" +
      "/skills - 查看所有可用 skill\n" +
      "/skill名称 - 调用对应 skill\n\n" +
      "**小工管理**\n" +
      "/agents - 查看所有在线小工\n\n" +
      "**设备管理**\n" +
      "/device - 查看当前设备信息\n\n" +
      "**CC 原生命令（透传给 Claude Code）**\n" +
      "/context - 查看当前上下文占用\n" +
      "/usage - 查看 token 用量\n" +
      "/compact [指令] - 压缩对话历史\n" +
      "/clear - 清空当前对话\n" +
      "/hooks - 查看已注册钩子\n" +
      "/memory - 查看加载的记忆\n" +
      "/debug - 切换调试模式\n\n" +
      "**其他**\n" +
      "/help - 显示此帮助信息\n\n" +
      "提示：非命令消息会发送到当前群/话题绑定的会话";

    await this.sendToFeishu(helpText, ctx);
  }

  private channelId(): string {
    return this.deps.feishuChannel?.id || "default";
  }

  /**
   * 加载会话绑定（兼容 v1 旧格式：值为单个 sessionId 字符串 → 迁移到 __default）
   */
  private loadPersistedSessions(): void {
    const data = readJsonFile<Record<string, unknown>>(SESSION_FILE);
    const mine = data?.[this.channelId()];
    if (typeof mine === "string") {
      // v1 旧格式迁移
      this.convSessions.set(DEFAULT_SCOPE, mine);
    } else if (mine && typeof mine === "object") {
      for (const [scope, sessionId] of Object.entries(mine)) {
        if (typeof sessionId === "string") {
          this.convSessions.set(scope, sessionId);
        }
      }
    }
  }

  private persistSessions(): void {
    try {
      const data = readJsonFile<Record<string, unknown>>(SESSION_FILE) ?? {};
      if (this.convSessions.size > 0) {
        data[this.channelId()] = Object.fromEntries(this.convSessions);
      } else {
        delete data[this.channelId()];
      }
      writeJsonFileAtomic(SESSION_FILE, data);
    } catch { /* ignore */ }
  }

  private loadPersistedModel(): string | null {
    const data = readJsonFile<Record<string, string>>(MODEL_FILE);
    return data?.[this.channelId()] || null;
  }

  private persistModel(): void {
    try {
      const data = readJsonFile<Record<string, string>>(MODEL_FILE) ?? {};
      if (this._currentModel) {
        data[this.channelId()] = this._currentModel;
      } else {
        delete data[this.channelId()];
      }
      writeJsonFileAtomic(MODEL_FILE, data);
    } catch (err) {
      // 2026-07-02 事故：这里之前静默吞错误，导致模型切换写盘失败时完全没人知道，
      // 重启后悄悄回落到默认模型。现在至少把错误打到日志里，方便定位。
      console.error(`[CC] 模型持久化写盘失败 (channel=${this.channelId()}):`, err);
    }
  }

  /** 加载 agent 供应商选择（{channelId: {scope: provider}}，只认合法且非默认的值） */
  private loadPersistedAgents(): void {
    const data = readJsonFile<Record<string, unknown>>(AGENT_FILE);
    const mine = data?.[this.channelId()];
    if (mine && typeof mine === "object") {
      for (const [scope, provider] of Object.entries(mine)) {
        if (typeof provider === "string" && isValidProvider(provider) && provider !== "claude") {
          this.agentProviders.set(scope, provider);
        }
      }
    }
  }

  private persistAgents(): void {
    try {
      const data = readJsonFile<Record<string, unknown>>(AGENT_FILE) ?? {};
      if (this.agentProviders.size > 0) {
        data[this.channelId()] = Object.fromEntries(this.agentProviders);
      } else {
        delete data[this.channelId()];
      }
      writeJsonFileAtomic(AGENT_FILE, data);
    } catch (err) {
      // 同 persistModel：绝不静默吞写盘错误（2026-07-02 模型丢失事故的教训）
      console.error(`[CC] agent 供应商持久化写盘失败 (channel=${this.channelId()}):`, err);
    }
  }

  /** 加载流式输出关闭项（{channelId: {scope: "off"}}，只认 "off"，其余值忽略） */
  private loadPersistedStreamPrefs(): void {
    const data = readJsonFile<Record<string, unknown>>(STREAM_FILE);
    const mine = data?.[this.channelId()];
    if (mine && typeof mine === "object") {
      for (const [scope, value] of Object.entries(mine)) {
        if (value === "off") {
          this.streamOffScopes.add(scope);
        }
      }
    }
  }

  private persistStreamPrefs(): void {
    try {
      const data = readJsonFile<Record<string, unknown>>(STREAM_FILE) ?? {};
      if (this.streamOffScopes.size > 0) {
        data[this.channelId()] = Object.fromEntries(
          [...this.streamOffScopes].map((scope) => [scope, "off"])
        );
      } else {
        delete data[this.channelId()];
      }
      writeJsonFileAtomic(STREAM_FILE, data);
    } catch (err) {
      // 同 persistModel：绝不静默吞写盘错误（2026-07-02 模型丢失事故的教训）
      console.error(`[CC] 流式开关持久化写盘失败 (channel=${this.channelId()}):`, err);
    }
  }

  private async sendToFeishu(text: string, ctx?: FeishuMessageContext): Promise<void> {
    // 使用 effectiveChannel（支持劫持）；通道不可用时回退到广播
    const channel = this.effectiveChannel;
    // 劫持模式下（群聊路由）自动加身份前缀
    const finalText = (this.replyChannel && this.agentName)
      ? `【${this.agentName}】\n${text}`
      : text;

    // 多会话：优先回复原消息（自动落在正确的群和话题里）
    if (ctx?.messageId && channel && typeof channel.sendMarkdownReply === "function") {
      const ok = await channel.sendMarkdownReply(ctx.messageId, finalText);
      if (ok) return;
      // 回复失败（消息被删等），降级走普通发送
    }

    if (channel && typeof channel.send === "function") {
      await channel.send({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: finalText }],
        },
      } as any);
    } else {
      await this.deps.channelManager.broadcast({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
        },
      } as any);
    }
  }

  /**
   * 格式化时间显示
   */
  formatTimeAgo(timestamp: string | number): string {
    const now = Date.now();
    const time = typeof timestamp === "string" ? new Date(timestamp).getTime() : timestamp;
    const diff = now - time;

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes}分钟前`;
    if (hours < 24) return `${hours}小时前`;
    if (days < 7) return `${days}天前`;

    const date = new Date(time);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }
}
