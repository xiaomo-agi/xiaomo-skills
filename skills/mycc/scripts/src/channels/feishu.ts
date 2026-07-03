/**
 * 飞书通道
 *
 * 支持双向通信：
 * - 发送：将 Claude Code 回复发送到飞书
 * - 接收：通过 WebSocket 接收飞书消息并转发给 Claude Code
 */

import type { MessageChannel } from "./interface.js";
import type { SSEEvent } from "../adapters/interface.js";
import Lark from "@larksuiteoapi/node-sdk";
import fs from "fs";
import path from "path";
import os from "os";
import {
  FeishuStreamingSession,
  buildMarkdownCard,
  normalizeFeishuMarkdownLinks,
} from "./feishu-streaming.js";
import { summarizeToolInput } from "./tool-summary.js";

/**
 * 逐事件调试日志开关（MYCC_DEBUG=1 或 true 时开启）。
 * 这些日志每条消息/事件都会打一批，默认关闭以免 mycc.log 刷屏。
 */
const DEBUG = process.env.MYCC_DEBUG === "1" || process.env.MYCC_DEBUG === "true";
const debugLog = (...args: unknown[]) => { if (DEBUG) console.log(...args); };

/**
 * 飞书通道配置
 */
export interface FeishuChannelConfig {
  /** 飞书应用 ID */
  appId: string;
  /** 飞书应用密钥 */
  appSecret: string;
  /** 接收消息的用户/群组 Open ID */
  receiveUserId?: string;
  /** 接收 ID 类型：open_id（用户）或 chat_id（群聊） */
  receiveIdType?: "open_id" | "chat_id";
  /** 连接模式：websocket（长连接）或 poll（轮询） */
  connectionMode?: "websocket" | "poll";
  /** Encrypt Key（用于验证事件推送） */
  encryptKey?: string;
  /** Verification Token（用于验证事件推送） */
  verificationToken?: string;
  /** 是否显示工具调用：true（显示）或 false（不显示），默认 true */
  showToolUse?: boolean;
  /** 通道标识（用于日志区分，如 A/B/C） */
  label?: string;
  /** 是否使用流式卡片（CardKit API），默认 true。设为 false 降级为静态卡片 */
  streamingCards?: boolean;
}

/**
 * 图片上传响应
 */
interface FeishuUploadResponse {
  code: number;
  msg: string;
  data: {
    image_key: string;
  };
}

interface FeishuReplyTarget {
  receiveId: string;
  receiveIdType: "open_id" | "chat_id";
}

/**
 * 单条消息的会话上下文（多会话隔离的核心）
 *
 * scope 规则（参考 lark-coding-agent-bridge 的设计）：
 * - 私聊 / 普通群：scope = chatId（整个聊天共享一个会话）
 * - 话题群：scope = `${chatId}:${threadId}`（每个话题独立会话）
 * - 群模式查询失败时保守回退 chatId，宁可不拆分也不能把会话搞串
 */
export interface FeishuMessageContext {
  scope: string;
  chatId?: string;
  chatType?: string;
  threadId?: string;
  messageId?: string;
  senderId?: string;
  mentions?: Array<{ id: any; id_type?: string; name?: string; key?: string }>;
}

export type FeishuMessageHandler = (
  message: string,
  images?: Array<{ data: string; mediaType: string }>,
  files?: Array<{ filePath: string; fileName: string }>,
  messageId?: string,
  ctx?: FeishuMessageContext,
) => void;

/** 卡片按钮点击回调：value 是按钮上带的载荷，ctx 已解析好 scope（含话题群反查） */
export type FeishuCardActionHandler = (
  value: Record<string, unknown>,
  ctx: FeishuMessageContext,
) => void | Promise<void>;

/**
 * 飞书消息通道
 *
 * 实现消息过滤、发送和接收功能
 * 支持双向通信：发送 Claude 回复到飞书，接收飞书消息并转发给 Claude
 */
export class FeishuChannel implements MessageChannel {
  readonly id = "feishu";

  private config: FeishuChannelConfig;
  private label: string;
  private accessToken: string | null = null;
  private tokenExpireTime: number = 0;
  private pendingImages = new Map<string, string>(); // sessionId → image_key

  // WebSocket 相关
  private wsClient: Lark.WSClient | null = null;
  private eventDispatcher: Lark.EventDispatcher | null = null;
  private messageCallback: FeishuMessageHandler | null = null;
  private cardActionCallback: FeishuCardActionHandler | null = null;
  private wsWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  private wsRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private isWebSocketStopped = false;
  private isWebSocketStarting = false;
  private readonly WS_RESTART_DELAY_MS = 30_000;
  private readonly WS_WATCHDOG_INTERVAL_MS = 60_000;
  private readonly WS_RECONNECT_STALE_MS = 3 * 60_000;

  // 消息合并缓冲（解决同时发图+文字时图片被并发锁丢弃的问题）
  // 按 scope+发送者 分桶，不同群/话题的消息互不干扰
  private messageBuffers = new Map<string, {
    items: Array<{ text: string; images?: Array<{ data: string; mediaType: string }>; files?: Array<{ filePath: string; fileName: string }>; messageId?: string }>;
    timer: ReturnType<typeof setTimeout> | null;
    ctx: FeishuMessageContext;
  }>();
  private readonly BUFFER_DELAY = 300; // ms，等待后续消息到达

  // 表态相关（"正在输入" emoji），按 messageId 记录，多会话并发时互不覆盖
  private typingReactions = new Map<string, string>(); // messageId → reactionId

  /** 群模式缓存：chatId → chat_mode（topic/group/p2p），查一次终身缓存 */
  private chatModes = new Map<string, string>();

  /** 最近一次消息的上下文（用于群路由判断） */
  private lastMessageContext: { chatId?: string; mentions?: Array<{ id: string; id_type?: string; name?: string }> } = {};

  /** 本 bot 的 open_id（用于群聊@路由判断） */
  private botOpenId: string | null = null;

  // 流式卡片（CardKit API）
  private streamingSession: FeishuStreamingSession | null = null;
  private useStreamingCards: boolean;
  private streamingTextAcc: string = "";

  /** 上一次成功发送卡片消息的时间（发送节流用） */
  private lastCardSentAt = 0;

  /** 日志前缀 */
  private get lp(): string {
    return this.label ? `[Feishu-${this.label}]` : "[Feishu]";
  }

  constructor(config?: FeishuChannelConfig) {
    this.label = config?.label || "";
    // 从环境变量读取配置
    this.config = config || {
      appId: process.env.FEISHU_APP_ID || "",
      appSecret: process.env.FEISHU_APP_SECRET || "",
      receiveUserId: process.env.FEISHU_RECEIVE_USER_ID,
      receiveIdType: (process.env.FEISHU_RECEIVE_ID_TYPE as "open_id" | "chat_id") || "open_id",
      connectionMode: (process.env.FEISHU_CONNECTION_MODE as "websocket" | "poll") || "poll",
      encryptKey: process.env.FEISHU_ENCRYPT_KEY,
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
      showToolUse: process.env.FEISHU_SHOW_TOOL_USE === "false" ? false : true, // 默认 true
    };

    // 流式卡片：默认启用，可通过 config 或环境变量关闭
    this.useStreamingCards = config?.streamingCards !== false
      && process.env.FEISHU_STREAMING_CARDS !== "false";

    // 如果有凭证，预创建流式会话实例
    if (this.config.appId && this.config.appSecret && this.useStreamingCards) {
      this.streamingSession = new FeishuStreamingSession(
        { appId: this.config.appId, appSecret: this.config.appSecret },
        (msg: string) => console.log(`${this.lp} ${msg}`)
      );
    }
  }

  /**
   * 消息过滤器 - 支持 v1 和 v2 SDK 的事件类型
   * v1: text, content_block_delta, system, tool_use
   * v2: assistant (包含消息内容), system
   */
  filter(event: SSEEvent): boolean {
    const eventType = event.type as string;
    // 调试：记录所有事件类型（包括被过滤的）
    debugLog(`${this.lp} [FILTER] 收到事件类型: ${eventType}`);

    const textOnlyTypes = ["text", "content_block_delta", "system", "assistant", "turn_complete"];
    const allTypes = ["text", "content_block_delta", "system", "assistant", "turn_complete", "tool_use"];

    // 根据配置决定是否显示工具调用
    if (this.config.showToolUse) {
      return allTypes.includes(eventType);
    } else {
      return textOnlyTypes.includes(eventType);
    }
  }

  /**
   * 发送消息到飞书
   * @param event - SSE 事件
   */
  async send(event: SSEEvent): Promise<void> {
    // 如果没有配置飞书凭证，静默跳过
    if (!this.config.appId || !this.config.appSecret) {
      return;
    }

    // 没有配置接收用户，跳过
    if (!this.getReplyTarget()) {
      return;
    }

    // turn_complete → 关闭当前流式卡片
    if (event.type === "turn_complete") {
      await this.closeStreamingCard();
      return;
    }

    // 处理 system 事件（提取图片信息）
    if (event.type === "system") {
      const systemEvent = event as Record<string, unknown>;
      if ("images" in systemEvent && Array.isArray(systemEvent.images)) {
        const sessionId = String(systemEvent.session_id || "default");
        await this.handleImages(sessionId, systemEvent.images as Array<{ data: string; mediaType: string }>);
      }
      return;
    }

    // 提取文本内容
    let text = "";
    if (event.type === "assistant") {
      text = this.extractAssistantText(event);
      if (text) {
        console.log(`${this.lp} [assistant] 提取 ${text.length} 字符`);
      }
    } else if (event.type === "text") {
      text = String(event.text ?? "");
    } else if (event.type === "content_block_delta") {
      const delta = event.delta as { text?: string } | undefined;
      text = delta?.text ?? "";
    } else if (event.type === "tool_use") {
      if (!this.config.showToolUse) return;
      const toolContent = this.formatToolUse(event);
      if (toolContent) text = toolContent;
    }

    if (!text) return;

    // 流式卡片路径
    if (this.useStreamingCards && this.streamingSession) {
      await this.streamUpdate(text);
    } else {
      // 降级：静态卡片
      const sessionId = this.extractSessionId(event);
      await this.sendMessageToFeishu(text, sessionId);
    }
  }

  /**
   * 设置消息接收回调
   * @param callback - 收到飞书消息时的回调函数
   */
  onMessage(callback: FeishuMessageHandler): void {
    this.messageCallback = callback;
  }

  /**
   * 设置卡片按钮点击回调
   * @param callback - 收到 card.action.trigger 事件时的回调函数
   */
  onCardAction(callback: FeishuCardActionHandler): void {
    this.cardActionCallback = callback;
  }

  /**
   * 刷新指定分桶的消息缓冲：合并缓冲的多条消息并一次性回调
   * 解决用户同时发图+文字时，图片被并发锁丢弃的问题
   */
  private flushMessageBuffer(bufferKey: string): void {
    const buffer = this.messageBuffers.get(bufferKey);
    if (!buffer || buffer.items.length === 0 || !this.messageCallback) {
      this.messageBuffers.delete(bufferKey);
      return;
    }
    if (buffer.timer) clearTimeout(buffer.timer);
    this.messageBuffers.delete(bufferKey);

    // 合并所有缓冲的消息
    let mergedText = "";
    const mergedImages: Array<{ data: string; mediaType: string }> = [];
    const mergedFiles: Array<{ filePath: string; fileName: string }> = [];
    let firstMessageId: string | undefined;

    for (const msg of buffer.items) {
      if (msg.text && msg.text.trim()) {
        mergedText += (mergedText ? "\n" : "") + msg.text.trim();
      }
      if (msg.images) mergedImages.push(...msg.images);
      if (msg.files) mergedFiles.push(...msg.files);
      if (!firstMessageId && msg.messageId) firstMessageId = msg.messageId;
    }

    console.log(`${this.lp} ✓ 合并 ${buffer.items.length} 条消息 [scope=${buffer.ctx.scope}]: ${mergedText ? mergedText.substring(0, 50) : "[图片/文件]"}... [${mergedImages.length} 图, ${mergedFiles.length} 文件]`);

    this.messageCallback(
      mergedText,
      mergedImages.length > 0 ? mergedImages : undefined,
      mergedFiles.length > 0 ? mergedFiles : undefined,
      firstMessageId,
      { ...buffer.ctx, messageId: firstMessageId ?? buffer.ctx.messageId },
    );
  }

  /**
   * 计算消息的会话 scope：
   * 话题群按 `${chatId}:${threadId}` 拆（每话题独立会话），其余按 chatId
   */
  private async resolveScope(chatId: string | undefined, chatType: string | undefined, threadId: string | undefined): Promise<string> {
    if (!chatId) return "__default";
    if (!threadId || chatType === "p2p") return chatId;
    const mode = await this.resolveChatMode(chatId);
    return mode === "topic" ? `${chatId}:${threadId}` : chatId;
  }

  /** 查询群模式（topic/group/p2p），失败回退 group（保守：不拆分会话） */
  private async resolveChatMode(chatId: string): Promise<string> {
    const cached = this.chatModes.get(chatId);
    if (cached) return cached;
    try {
      if (!this.accessToken || Date.now() > this.tokenExpireTime) {
        this.accessToken = await this.getAccessToken();
        if (!this.accessToken) return "group";
      }
      const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/chats/${chatId}`, {
        headers: { "Authorization": `Bearer ${this.accessToken}` },
      });
      const data = await res.json() as any;
      const mode = data?.data?.chat_mode || "group";
      this.chatModes.set(chatId, mode);
      console.log(`${this.lp} chat_mode 缓存: ${chatId} → ${mode}`);
      return mode;
    } catch {
      return "group";
    }
  }

  /**
   * 启动飞书通道（验证凭证 + 启动 WebSocket）
   */
  async start(): Promise<void> {
    if (!this.config.appId || !this.config.appSecret) {
      console.log("[FeishuChannel] Not configured, skipping");
      return;
    }

    // 验证凭证
    const token = await this.getAccessToken();
    if (!token) {
      console.error("[FeishuChannel] ✗ Invalid credentials");
      return;
    }

    this.accessToken = token;

    console.log("[FeishuChannel] ✓ Credentials validated");
    console.log(`[FeishuChannel] Will send to: ${this.config.receiveUserId || "未配置接收用户"}`);

    // 获取本 bot 的 open_id（用于群聊@路由判断）
    await this.fetchBotOpenId();

    // 启动 WebSocket 连接（如果配置了）
    if (this.config.connectionMode === "websocket") {
      this.isWebSocketStopped = false;
      await this.startWebSocket();
    } else {
      console.log("[FeishuChannel] WebSocket disabled (polling mode)");
    }
  }

  /**
   * 启动 WebSocket 连接
   */
  private async startWebSocket(): Promise<void> {
    if (this.isWebSocketStopped || this.isWebSocketStarting) {
      return;
    }

    this.isWebSocketStarting = true;

    try {
      // 创建 Event Dispatcher（只在配置了加密密钥时传入）
      const dispatcherOptions: {
        encryptKey?: string;
        verificationToken?: string;
      } = {};
      if (this.config.encryptKey) {
        dispatcherOptions.encryptKey = this.config.encryptKey;
      }
      if (this.config.verificationToken) {
        dispatcherOptions.verificationToken = this.config.verificationToken;
      }

      this.eventDispatcher = new Lark.EventDispatcher(dispatcherOptions);

      // 注册多个事件类型（参考 monitor.ts）
      this.eventDispatcher.register({
        // 消息接收事件
        "im.message.receive_v1": async (data) => {
          try {
            debugLog("[FeishuChannel] [DEBUG] 收到 im.message.receive_v1 事件");
            const event = data as any;
            const messageId = event?.message?.message_id;

            // 打印发送者 open_id，方便配置 RECEIVE_USER_ID
            const senderId = event?.sender?.sender_id?.open_id || event?.sender?.id?.open_id;
            if (senderId) {
              debugLog(`[FeishuChannel] [DEBUG] 发送者 open_id: ${senderId}`);
            }

            // 添加"正在输入"表态（敲键盘 emoji）
            if (messageId) {
              this.addTypingIndicator(messageId).catch(() => {
                // 静默失败，不影响主流程
              });
            }

            // await 解析结果（图片/文件下载是异步的）
            const parsed = await this.parseFeishuMessage(event, messageId);
            if (!parsed || !this.messageCallback) {
              debugLog("[FeishuChannel] [DEBUG] 解析消息内容为空或无回调");
              return;
            }

            const { text, images, files } = parsed;
            if (!text && !images && !files) {
              debugLog("[FeishuChannel] [DEBUG] 解析消息内容为空");
              return;
            }

            // 构造会话上下文（多会话隔离核心：不同群/话题各自独立）
            const chatId = event?.message?.chat_id as string | undefined;
            const chatType = event?.message?.chat_type as string | undefined;
            const threadId = event?.message?.thread_id as string | undefined;
            const scope = await this.resolveScope(chatId, chatType, threadId);
            const ctx: FeishuMessageContext = {
              scope,
              chatId,
              chatType,
              threadId,
              messageId,
              senderId,
              mentions: event?.message?.mentions || [],
            };

            // 消息合并缓冲：同 scope+同发送者 短时间内多条消息合并（文字+图片）
            const bufferKey = `${scope}|${senderId || ""}`;
            let buffer = this.messageBuffers.get(bufferKey);
            if (!buffer) {
              buffer = { items: [], timer: null, ctx };
              this.messageBuffers.set(bufferKey, buffer);
            }
            if (buffer.timer) clearTimeout(buffer.timer);
            buffer.items.push({ text: text || "", images, files, messageId });

            console.log(`${this.lp} ✓ 收到消息（缓冲中, scope=${scope}）: ${text ? text.substring(0, 50) : images ? "[图片]" : "[文件]"}...`);

            buffer.timer = setTimeout(() => {
              this.flushMessageBuffer(bufferKey);
            }, this.BUFFER_DELAY);
          } catch (err) {
            console.error("[FeishuChannel] 消息处理错误:", err);
          }
        },
        // 消息已读事件（忽略）
        "im.message.message_read_v1": async () => {
          debugLog("[FeishuChannel] [DEBUG] 收到 im.message.message_read_v1 事件（忽略）");
        },
        // 机器人被添加到群聊事件
        "im.chat.member.bot.added_v1": async (data) => {
          try {
            const event = data as any;
            console.log(`[FeishuChannel] ✓ 机器人被添加到群聊: ${event?.chat_id || "unknown"}`);
          } catch (err) {
            console.error("[FeishuChannel] 处理机器人添加事件错误:", err);
          }
        },
        // 机器人被移出群聊事件
        "im.chat.member.bot.deleted_v1": async (data) => {
          try {
            const event = data as any;
            console.log(`[FeishuChannel] ✓ 机器人被移出群聊: ${event?.chat_id || "unknown"}`);
          } catch (err) {
            console.error("[FeishuChannel] 处理机器人移除事件错误:", err);
          }
        },
        // 卡片按钮点击事件（WS 长连接推送，无需公网回调 URL）。
        // SDK 的 IHandles 类型表里没有这个键，但 register 的 handles Map 按事件
        // 名字符串分发，运行时完全支持——参考项目同款机制，这里 as any 绕过类型。
        "card.action.trigger": async (data: any) => this.handleCardActionEvent(data),
      } as any);

      // 创建 WebSocket 客户端
      this.wsClient = new Lark.WSClient({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        domain: Lark.Domain.Feishu,
        loggerLevel: Lark.LoggerLevel.info,
        autoReconnect: true,
      });

      // 启动连接
      await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
      this.startWebSocketWatchdog();
      console.log("[FeishuChannel] ✓ WebSocket 已启动");
      console.log("[FeishuChannel] [INFO] 已注册事件: im.message.receive_v1, im.message.message_read_v1, im.chat.member.bot.added_v1, im.chat.member.bot.deleted_v1, card.action.trigger");
    } catch (err) {
      console.error("[FeishuChannel] WebSocket start failed:", err);
      this.scheduleWebSocketRestart("start_failed");
    } finally {
      this.isWebSocketStarting = false;
    }
  }


  private startWebSocketWatchdog(): void {
    if (this.wsWatchdogTimer) {
      clearInterval(this.wsWatchdogTimer);
    }

    this.wsWatchdogTimer = setInterval(() => {
      if (this.isWebSocketStopped || !this.wsClient) {
        return;
      }

      const reconnectInfo = (this.wsClient as any).getReconnectInfo?.();
      const nextConnectTime = reconnectInfo?.nextConnectTime
        ? new Date(reconnectInfo.nextConnectTime).getTime()
        : 0;

      if (nextConnectTime > 0 && nextConnectTime < Date.now() - this.WS_RECONNECT_STALE_MS) {
        console.warn("[FeishuChannel] WebSocket reconnect stale, scheduling restart:", reconnectInfo);
        this.scheduleWebSocketRestart("reconnect_stale");
      }
    }, this.WS_WATCHDOG_INTERVAL_MS);

    (this.wsWatchdogTimer as any).unref?.();
  }

  private scheduleWebSocketRestart(reason: string): void {
    if (this.isWebSocketStopped || this.wsRestartTimer) {
      return;
    }

    console.warn("[FeishuChannel] WebSocket restart scheduled: " + reason);
    this.wsRestartTimer = setTimeout(async () => {
      this.wsRestartTimer = null;
      if (this.isWebSocketStopped) {
        return;
      }

      const oldClient = this.wsClient;
      this.wsClient = null;
      this.eventDispatcher = null;

      if (oldClient) {
        try {
          await oldClient.close({ force: true } as any);
        } catch {
          // Ignore close errors from already-dead sockets.
        }
      }

      await this.startWebSocket();
    }, this.WS_RESTART_DELAY_MS);

    (this.wsRestartTimer as any).unref?.();
  }

  /**
   * 解析飞书消息（异步，支持图片下载）
   */
  private async parseFeishuMessage(event: any, messageId?: string): Promise<{ text: string; images?: Array<{ data: string; mediaType: string }>; files?: Array<{ filePath: string; fileName: string }> } | null> {
    try {
      // 保存消息上下文（用于群路由判断 @all）
      const message = event?.message;
      this.lastMessageContext = {
        chatId: message?.chat_id,
        mentions: message?.mentions || [],
      };

      // [DEBUG] 打印 mention 原始结构，用于排查群@路由问题
      if (message?.mentions && message.mentions.length > 0) {
        debugLog(`${this.lp} [DEBUG-MENTION] chatId=${message.chat_id} mentions=${JSON.stringify(message.mentions)}`);
        debugLog(`${this.lp} [DEBUG-MENTION] this.botOpenId=${this.botOpenId}`);
      }

      // 事件结构: event.sender + event.message（不是 event.event.message）
      if (!message) return null;

      const messageType = message.message_type;
      const content = message.content;

      if (messageType === "text") {
        // 文本消息 - content 是 JSON 字符串
        if (typeof content === "string") {
          const parsed = JSON.parse(content);
          return { text: parsed.text || "" };
        }
        // 兜底：content 可能已经是对象
        return { text: content?.text || "" };
      }

      if (messageType === "image") {
        // 图片消息 - content 是 JSON 字符串
        console.log(`[FeishuChannel] 收到图片消息`);
        if (typeof content === "string") {
          const parsed = JSON.parse(content);
          const imageKey = parsed.image_key;
          if (imageKey) {
            // 需要通过飞书 API 获取图片数据
            return this.downloadImageFromFeishu(imageKey, messageId).then(data => ({
              text: "",
              images: data ? [{ data, mediaType: "image/png" }] : undefined
            }));
          }
        }
        console.log(`[FeishuChannel] 图片消息没有 image_key`);
        return { text: "" };
      }

      if (messageType === "file") {
        // 文件消息 - content 是 JSON 字符串
        console.log(`[FeishuChannel] 收到文件消息`);
        if (typeof content === "string") {
          const parsed = JSON.parse(content);
          const fileKey = parsed.file_key;
          const fileName = parsed.file_name;
          if (fileKey && messageId) {
            const filePath = await this.downloadFileFromFeishu(fileKey, fileName, messageId);
            if (filePath) {
              return { text: "", files: [{ filePath, fileName }] };
            }
          }
        }
        console.log(`[FeishuChannel] 文件消息解析失败`);
        return { text: "" };
      }

      // 其他类型消息暂不支持
      console.log(`[FeishuChannel] 暂不支持的消息类型: ${messageType}`);
      return null;
    } catch (err) {
      console.error("[FeishuChannel] 解析消息失败:", err);
      return null;
    }
  }

  /**
   * 处理卡片按钮点击事件（card.action.trigger）。
   *
   * 事件里不带 thread_id：话题群需要用 open_message_id 反查卡片所在消息，
   * 才能把点击路由到正确话题的会话（参考项目 resolveScope 踩过的坑）。
   * 返回值会作为事件响应回传给飞书，可携带 toast 立即提示点击者。
   * 业务处理不 await：先让事件快速返回（toast 立刻弹出），处理结果由
   * 回调自己发消息反馈。
   */
  async handleCardActionEvent(data: any): Promise<Record<string, unknown>> {
    try {
      const chatId = data?.context?.open_chat_id as string | undefined;
      const messageId = data?.context?.open_message_id as string | undefined;
      const senderId = data?.operator?.open_id as string | undefined;
      let value = data?.action?.value;
      // 表单提交（如重命名输入卡）：输入框内容在 action.form_value 里，
      // 挂到 value.form 一起转发，命令层按输入框 name 取值
      const formValue = data?.action?.form_value;
      if (formValue && typeof formValue === "object" && value && typeof value === "object") {
        value = { ...value, form: formValue };
      }

      if (!value || typeof value !== "object") {
        debugLog(`${this.lp} [DEBUG] 卡片点击无 value，忽略`);
        return {};
      }
      if (!this.cardActionCallback) {
        console.warn(`${this.lp} ⚠ 收到卡片点击但未注册回调，忽略`);
        return {};
      }

      const mode = chatId ? await this.resolveChatMode(chatId) : "group";
      let threadId: string | undefined;
      if (mode === "topic" && messageId) {
        threadId = await this.lookupMessageThreadId(messageId);
      }
      const chatType = mode === "p2p" ? "p2p" : "group";
      const scope = await this.resolveScope(chatId, chatType, threadId);
      const ctx: FeishuMessageContext = { scope, chatId, chatType, threadId, messageId, senderId };

      console.log(`${this.lp} ✓ 卡片按钮点击: ${JSON.stringify(value).substring(0, 100)} (scope=${scope})`);
      // then() 里再调回调：同步抛错也进 catch，不影响 toast 响应
      Promise.resolve()
        .then(() => this.cardActionCallback!(value as Record<string, unknown>, ctx))
        .catch((err) => {
          console.error(`${this.lp} 卡片按钮处理错误:`, err);
        });
      return { toast: { type: "info", content: "已收到" } };
    } catch (err) {
      console.error(`${this.lp} 卡片按钮事件解析错误:`, err);
      return {};
    }
  }

  /**
   * 反查消息所在话题的 thread_id（卡片点击事件不带 thread_id，话题群定位 scope 用）。
   * 查不到时返回 undefined，调用方回退 chatId scope——宁可落到群默认会话，
   * 也不能让点击静默失败。
   */
  private async lookupMessageThreadId(messageId: string): Promise<string | undefined> {
    try {
      if (!this.accessToken || Date.now() > this.tokenExpireTime) {
        this.accessToken = await this.getAccessToken();
        if (!this.accessToken) return undefined;
      }
      const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`, {
        headers: { "Authorization": `Bearer ${this.accessToken}` },
      });
      const data = await res.json() as any;
      const threadId = data?.data?.items?.[0]?.thread_id;
      return typeof threadId === "string" && threadId ? threadId : undefined;
    } catch (err) {
      console.warn(`${this.lp} ⚠ 反查消息 thread_id 失败: ${err}`);
      return undefined;
    }
  }

  /**
   * 停止飞书通道
   */
  stop() {
    this.isWebSocketStopped = true;
    if (this.wsWatchdogTimer) {
      clearInterval(this.wsWatchdogTimer);
      this.wsWatchdogTimer = null;
    }
    if (this.wsRestartTimer) {
      clearTimeout(this.wsRestartTimer);
      this.wsRestartTimer = null;
    }

    this.accessToken = null;
    this.pendingImages.clear();

    // 关闭流式卡片
    this.closeStreamingCard().catch(() => {});

    // 停止 WebSocket
    if (this.wsClient) {
      try {
        this.wsClient.close();
        console.log("[FeishuChannel] WebSocket 已停止");
      } catch {
        // 静默处理
      }
      this.wsClient = null;
    }
    this.eventDispatcher = null;
    this.messageCallback = null;
    this.cardActionCallback = null;
  }

  /**
   * 从 SSE 事件中提取文本内容
   */
  private extractText(event: SSEEvent): string {
    if (event.type === "text") {
      return String(event.text ?? "");
    }

    if (event.type === "content_block_delta") {
      const delta = event.delta as { text?: string } | undefined;
      return delta?.text ?? "";
    }

    return "";
  }

  /**
   * 从 SSE 事件中提取 session_id
   */
  private extractSessionId(event: SSEEvent): string | undefined {
    if (event && typeof event === "object" && "session_id" in event) {
      return String(event.session_id);
    }
    return undefined;
  }

  /**
   * 格式化 tool_use 事件为可读文本
   */
  private formatToolUse(event: Record<string, unknown>): string {
    try {
      const name = (event.name as string) || "unknown";
      // 按工具类型选字段的摘要，替代之前无上限的 JSON 全量 dump
      // （Write 带整个文件内容时能直接把卡片撑爆）
      const summary = summarizeToolInput(name, event.input, 200);
      return `🔧 使用工具: **${name}**${summary ? `\n\`${summary}\`` : ""}\n`;
    } catch (err) {
      console.error("[FeishuChannel] 格式化工具调用失败:", err);
      return "🔧 使用工具（详情解析失败）";
    }
  }

  /**
   * 格式化 assistant 事件中的 tool_use block
   */
  private formatToolUseBlock(block: Record<string, unknown>): string | null {
    try {
      const name = (block.name as string) || "unknown";
      // 按工具类型选字段的单行摘要，替代之前裸 JSON.stringify 截 100 字符
      const summary = summarizeToolInput(name, block.input);
      return `🔧 **${name}**${summary ? ` ${summary}` : ""}`;
    } catch (err) {
      console.error("[FeishuChannel] 格式化工具调用失败:", err);
      return "🔧 工具调用（详情解析失败）";
    }
  }

  /**
   * 从 assistant 事件提取所有 text + tool_use，拼接为完整文本
   */
  private extractAssistantText(event: Record<string, unknown>): string {
    const parts: string[] = [];
    if ("message" in event && typeof event.message === "object") {
      const message = event.message as any;
      if (message.content && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === "text") {
            parts.push(String(block.text));
          } else if (block.type === "tool_use" && this.config.showToolUse) {
            const formatted = this.formatToolUseBlock(block as Record<string, unknown>);
            if (formatted) parts.push(`\n${formatted}\n`);
          }
        }
      }
    }
    return parts.join("\n");
  }

  /**
   * 流式更新卡片（累积文本 + 调 CardKit API）
   * CardKit 不可用时自动降级为静态卡片
   */
  private async streamUpdate(text: string): Promise<void> {
    if (!this.streamingSession) return;

    const target = this.getReplyTarget();
    if (!target) return;

    try {
      // 如果有待发送的图片，先发图片再创建流式卡片
      const imagesToSend: string[] = [];
      for (const [sid, imageKey] of this.pendingImages.entries()) {
        imagesToSend.push(imageKey);
        this.pendingImages.delete(sid);
      }
      for (const imageKey of imagesToSend) {
        await this.sendImageMessage(target.receiveId, imageKey, target.receiveIdType);
      }

      // 如果当前没有活跃的流式卡片，创建新的
      if (!this.streamingSession.isActive()) {
        console.log(`${this.lp} [Streaming] 创建流式卡片...`);
        await this.streamingSession.start(
          target.receiveId,
          target.receiveIdType
        );
        this.streamingTextAcc = "";
      }

      // 按事件累积：send() 按事件类型提取出的是"本事件的文本片段"，
      // 在这里追加成全量快照再交给流式会话（update 是快照语义，后写覆盖）。
      // 以前是覆盖赋值 + 会话内 includes() 启发式拼接，AI 输出重复内容时会被误判为旧文本丢掉
      this.streamingTextAcc += text;

      // 发送到飞书（内部有节流，100ms 内多次调用自动合并）
      await this.streamingSession.update(this.streamingTextAcc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`${this.lp} [Streaming] 流式卡片不可用，降级为静态卡片: ${msg}`);
      this.useStreamingCards = false;

      // 用当前累积文本发一张静态卡片（不丢内容）
      try {
        await this.sendMessageToFeishu(this.streamingTextAcc || text, undefined);
      } catch {
        // 静默
      }
    }
  }

  /**
   * 关闭当前流式卡片（公开方法，外部可调用）
   */
  async closeStreamingCard(): Promise<void> {
    if (!this.streamingSession || !this.streamingSession.isActive()) return;
    try {
      // 确保最后一段文本已发送
      if (this.streamingTextAcc) {
        await this.streamingSession.update(this.streamingTextAcc);
      }
      await this.streamingSession.close();
      this.streamingTextAcc = "";
      console.log(`${this.lp} [Streaming] 卡片已关闭`);
    } catch (err) {
      console.warn(`${this.lp} [Streaming] 关闭失败:`, err);
    }
  }

  /**
   * 处理图片（上传到飞书并保存 image_key）
   */
  private async handleImages(sessionId: string, images: Array<{ data: string; mediaType: string }>): Promise<void> {
    if (!images || images.length === 0) {
      return;
    }

    // 只支持单张图片
    const image = images[0];

    try {
      // 上传图片到飞书
      const imageKey = await this.uploadImageToFeishu(image.data, image.mediaType);
      if (imageKey) {
        // 保存 image_key
        this.pendingImages.set(sessionId, imageKey);
        console.log(`[FeishuChannel] ✓ Image uploaded: ${imageKey}`);
      }
    } catch (error) {
      console.error("[FeishuChannel] ✗ Upload image error:", error);
    }
  }

  /**
   * 上传图片到飞书
   */
  private async uploadImageToFeishu(base64Data: string, mediaType: string): Promise<string | null> {
    try {
      // 获取访问令牌（如果需要）
      if (!this.accessToken || Date.now() > this.tokenExpireTime) {
        this.accessToken = await this.getAccessToken();
        if (!this.accessToken) {
          return null;
        }
      }

      // 将 base64 转换为 Buffer
      const buffer = Buffer.from(base64Data, "base64");

      // 上传图片
      const response = await fetch("https://open.feishu.cn/open-apis/im/v1/images", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.accessToken}`,
          "Content-Type": mediaType,
        },
        body: buffer,
      });

      const result = await response.json() as FeishuUploadResponse;
      if (result.code === 0 && result.data?.image_key) {
        return result.data.image_key;
      }

      console.error("[FeishuChannel] ✗ Upload failed:", result.msg);
      return null;
    } catch (error) {
      console.error("[FeishuChannel] ✗ Upload error:", error);
      return null;
    }
  }

  /**
   * 从飞书下载图片（通过 message_id 获取 base64 数据）
   *
   * 对于用户发送的图片：
   * 使用 messageResource API，直接将 image_key 作为 file_key 使用
   *
   * 参考 openclaw 实现：
   * "For message media, always use messageResource API
   *  The image.get API is only for images uploaded via im/v1/images, not for message attachments"
   */
  private async downloadImageFromFeishu(imageKey: string, messageId?: string): Promise<string | null> {
    try {
      // 获取访问令牌（如果需要）
      if (!this.accessToken || Date.now() > this.tokenExpireTime) {
        this.accessToken = await this.getAccessToken();
        if (!this.accessToken) {
          return null;
        }
      }

      // 如果有 messageId，使用 messageResource API 下载
      // 对于用户发送的图片，image_key 可以直接作为 file_key 使用
      if (messageId) {
        debugLog(`[FeishuChannel] [DEBUG] Using messageResource API with image_key as file_key`);

        const resourceResponse = await fetch(
          `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`,
          {
            method: "GET",
            headers: {
              "Authorization": `Bearer ${this.accessToken}`,
            },
          }
        );

        if (resourceResponse.ok) {
          const buffer = await resourceResponse.arrayBuffer();
          const base64 = Buffer.from(buffer).toString("base64");
          console.log(`[FeishuChannel] ✓ Downloaded image: ${base64.length} bytes (base64)`);
          return base64;
        } else {
          const errorText = await resourceResponse.text();
          console.error(`[FeishuChannel] ✗ Resource download failed: ${resourceResponse.status}`, errorText.substring(0, 200));
          return null;
        }
      }

      // 没有 messageId 的情况：尝试直接下载
      // 注意：这只对机器人自己上传的图片有效（通过 im/v1/images 上传）
      debugLog(`[FeishuChannel] [DEBUG] No messageId, trying direct image download (only works for bot-uploaded images)`);
      const directResponse = await fetch(`https://open.feishu.cn/open-apis/im/v1/images/${imageKey}`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${this.accessToken}`,
        },
      });

      if (directResponse.ok) {
        const buffer = await directResponse.arrayBuffer();
        const base64 = Buffer.from(buffer).toString("base64");
        console.log(`[FeishuChannel] ✓ Downloaded image via direct API: ${base64.length} bytes (base64)`);
        return base64;
      } else {
        const errorText = await directResponse.text();
        console.error(`[FeishuChannel] ✗ Direct image download failed: ${directResponse.status}`, errorText.substring(0, 200));
        return null;
      }
    } catch (error) {
      console.error("[FeishuChannel] ✗ Download error:", error);
      return null;
    }
  }

  /**
   * 发送消息到飞书
   */
  private async sendMessageToFeishu(text: string, sessionId?: string): Promise<boolean> {
    try {
      if (!this.accessToken || Date.now() > this.tokenExpireTime) {
        this.accessToken = await this.getAccessToken();
        if (!this.accessToken) {
          return false;
        }
      }

      const target = this.getReplyTarget();
      if (!target) {
        return false;
      }
      const userId = target.receiveId;

      if (sessionId && this.pendingImages.has(sessionId)) {
        const imageKey = this.pendingImages.get(sessionId)!;
        const imageSent = await this.sendImageMessage(userId, imageKey, target.receiveIdType);
        if (imageSent) {
          this.pendingImages.delete(sessionId);
        }
      }

      const normalizedText = normalizeFeishuMarkdownLinks(text);
      return await this.sendMarkdownCardMessage(userId, normalizedText, target.receiveIdType);
    } catch (error) {
      console.error("[FeishuChannel] Send error:", error);
      return false;
    }
  }

  /**
   * 发送节流：飞书 im 消息接口有 QPS 限制，连续发送时保持 1 秒最小间隔。
   * 之前是每次发送成功后无条件 sleep(1000)——降级模式逐条发消息时每条都
   * 白等 1 秒，单条消息也要多挂 1 秒才返回；改成只在间隔不足时补齐等待。
   */
  private async throttleCardSend(): Promise<void> {
    const wait = this.lastCardSentAt + 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastCardSentAt = Date.now();
  }

  /**
   * 发送交互卡片消息（公开：命令层发带按钮的卡片用）
   */
  async sendInteractiveCard(userId: string, card: any, idType?: "open_id" | "chat_id"): Promise<boolean> {
    try {
      if (!this.accessToken || Date.now() > this.tokenExpireTime) {
        this.accessToken = await this.getAccessToken();
        if (!this.accessToken) return false;
      }
      const receiveIdType = idType || this.config.receiveIdType || "open_id";
      await this.throttleCardSend();

      const responseBody = {
        receive_id: userId,
        msg_type: "interactive",
        content: JSON.stringify(card)
      };

      const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.accessToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(responseBody),
      });

      const result = await response.json();
      if (result.code === 0) {
        console.log(`[FeishuChannel] ✓ Sent interactive card`);
        return true;
      } else {
        console.error("[FeishuChannel] ✗ Send failed:", result.msg);
        return false;
      }
    } catch (error) {
      console.error("[FeishuChannel] ✗ Send interactive card error:", error);
      return false;
    }
  }

  /**
   * 发送 schema 2.0 markdown 卡片消息
   * 完整支持代码块、表格、链接、加粗等 markdown 语法
   */
  private async sendMarkdownCardMessage(userId: string, text: string, idType?: "open_id" | "chat_id"): Promise<boolean> {
    try {
      const receiveIdType = idType || this.config.receiveIdType || "open_id";
      await this.throttleCardSend();
      const card = buildMarkdownCard(text);

      const responseBody = {
        receive_id: userId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      };

      const response = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(responseBody),
        }
      );

      const result = await response.json();
      if (result.code === 0) {
        console.log(
          `[FeishuChannel] ✓ Sent card: ${text.substring(0, 30)}${text.length > 30 ? "..." : ""}`
        );
        return true;
      } else {
        console.error("[FeishuChannel] ✗ Send card failed:", result.msg);
        return false;
      }
    } catch (error) {
      console.error("[FeishuChannel] ✗ Send card error:", error);
      return false;
    }
  }

  /**
   * 发送图片消息到飞书
   */
  private async sendImageMessage(userId: string, imageKey: string, idType?: "open_id" | "chat_id"): Promise<boolean> {
    try {
      const receiveIdType = idType || this.config.receiveIdType || "open_id";
      const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.accessToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          receive_id: userId,
          msg_type: "image",
          content: JSON.stringify({ image_key: imageKey }),
        }),
      });

      const result = await response.json();
      if (result.code === 0) {
        console.log(`[FeishuChannel] ✓ Image sent: ${imageKey}`);
        return true;
      } else {
        console.error("[FeishuChannel] ✗ Image send failed:", result.msg);
        return false;
      }
    } catch (error) {
      console.error("[FeishuChannel] ✗ Image send error:", error);
      return false;
    }
  }

  /**
   * 发送文件消息到飞书
   */
  async sendFileMessage(userId: string, filePath: string): Promise<boolean> {
    try {
      const fileKey = await this.uploadFileToFeishu(filePath);
      if (!fileKey) return false;

      const receiveIdType = this.config.receiveIdType || "open_id";
      const fileName = path.basename(filePath);
      const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.accessToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          receive_id: userId,
          msg_type: "file",
          content: JSON.stringify({ file_key: fileKey, file_name: fileName }),
        }),
      });

      const result = await response.json();
      if (result.code === 0) {
        console.log(`[FeishuChannel] ✓ File sent: ${fileName}`);
        return true;
      } else {
        console.error("[FeishuChannel] ✗ File send failed:", result.msg);
        return false;
      }
    } catch (error) {
      console.error("[FeishuChannel] ✗ File send error:", error);
      return false;
    }
  }

  /**
   * 上传文件到飞书（/im/v1/files）
   */
  private async uploadFileToFeishu(filePath: string): Promise<string | null> {
    try {
      if (!this.accessToken || Date.now() > this.tokenExpireTime) {
        this.accessToken = await this.getAccessToken();
        if (!this.accessToken) return null;
      }

      const buffer = fs.readFileSync(filePath);
      const filename = path.basename(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const fileTypeMap: Record<string, string> = {
        ".mp4": "mp4", ".mp3": "opus", ".pdf": "pdf",
        ".doc": "doc", ".docx": "doc", ".xls": "xls",
        ".xlsx": "xls", ".ppt": "ppt", ".pptx": "ppt",
      };
      const fileType = fileTypeMap[ext] || "stream";

      const boundary = "----FormBoundary" + Math.random().toString(36).substring(2);
      let body = "--" + boundary + "\r\n";
      body += `Content-Disposition: form-data; name="file_name"\r\n\r\n${filename}\r\n`;
      body += "--" + boundary + "\r\n";
      body += `Content-Disposition: form-data; name="file_type"\r\n\r\n${fileType}\r\n`;
      body += "--" + boundary + "\r\n";
      body += `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`;
      body += "Content-Type: application/octet-stream\r\n\r\n";

      const headerBuffer = Buffer.from(body, "utf8");
      const tailBuffer = Buffer.from("\r\n--" + boundary + "--\r\n", "utf8");
      const fullBody = Buffer.concat([headerBuffer, buffer, tailBuffer]);

      const response = await fetch("https://open.feishu.cn/open-apis/im/v1/files", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.accessToken}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(fullBody.length),
        },
        body: fullBody,
      });

      const result = await response.json() as any;
      if (result.code === 0 && result.data?.file_key) {
        console.log(`[FeishuChannel] ✓ File uploaded: ${result.data.file_key}`);
        return result.data.file_key;
      }
      console.error("[FeishuChannel] ✗ File upload failed:", result.msg);
      return null;
    } catch (error) {
      console.error("[FeishuChannel] ✗ File upload error:", error);
      return null;
    }
  }

  /**
   * 从飞书下载文件（通过 message_id + file_key）
   */
  private async downloadFileFromFeishu(fileKey: string, fileName: string, messageId: string): Promise<string | null> {
    try {
      if (!this.accessToken || Date.now() > this.tokenExpireTime) {
        this.accessToken = await this.getAccessToken();
        if (!this.accessToken) return null;
      }

      const response = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`,
        {
          method: "GET",
          headers: { "Authorization": `Bearer ${this.accessToken}` },
        }
      );

      if (!response.ok) {
        console.error(`[FeishuChannel] ✗ File download failed: ${response.status}`);
        return null;
      }

      const buffer = await response.arrayBuffer();
      const tmpDir = path.join(os.tmpdir(), "mycc-feishu");
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
      const safeName = `${Date.now()}_${fileName.replace(/[\\\\/:*?"<>|]/g, "_")}`;
      const filePath = path.join(tmpDir, safeName);
      fs.writeFileSync(filePath, Buffer.from(buffer));

      console.log(`[FeishuChannel] ✓ File downloaded: ${filePath} (${buffer.byteLength} bytes)`);
      return filePath;
    } catch (error) {
      console.error("[FeishuChannel] ✗ File download error:", error);
      return null;
    }
  }

  /**
   * 获取飞书访问令牌
   */
  private async getAccessToken(): Promise<string | null> {
    try {
      const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      });

      const data = await response.json();
      if (data.code === 0) {
        // 提前 5 分钟刷新令牌
        this.tokenExpireTime = Date.now() + (data.expire - 300) * 1000;
        return data.tenant_access_token;
      }

      console.error("[FeishuChannel] Get token failed:", data);
      return null;
    } catch (error) {
      console.error("[FeishuChannel] Get token error:", error);
      return null;
    }
  }

  /**
   * 添加"正在输入"表态（敲键盘 emoji）
   * 参照 openclaw 飞书扩展的 typing.ts 实现
   * @returns reactionId - 表态 ID，用于后续删除
   */
  private async addTypingIndicator(messageId: string): Promise<string | null> {
    try {
      // 获取访问令牌
      if (!this.accessToken || Date.now() > this.tokenExpireTime) {
        this.accessToken = await this.getAccessToken();
        if (!this.accessToken) {
          return null;
        }
      }

      // 使用飞书 API 添加表态（reaction）
      // emoji_type: "Typing" 是飞书内置的"正在输入"表情
      const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.accessToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          reaction_type: {
            emoji_type: "Typing",
          },
        }),
      });

      const result = await response.json();
      if (result.code === 0 && result.data?.reaction_id) {
        // 按 messageId 记录，多会话并发时互不覆盖
        this.typingReactions.set(messageId, result.data.reaction_id);
        console.log(`[FeishuChannel] ✓ 已添加正在输入表态 (${result.data.reaction_id})`);
        return result.data.reaction_id;
      }
      // 静默失败 - 表态不是关键功能
      return null;
    } catch (error) {
      // 静默失败 - 表态不是关键功能
      console.log(`[FeishuChannel] 添加表态失败（非关键）: ${error}`);
      return null;
    }
  }

  /**
   * 移除表态（可选功能）
   */
  private async removeTypingIndicator(messageId: string, reactionId: string): Promise<void> {
    try {
      if (!this.accessToken || Date.now() > this.tokenExpireTime) {
        this.accessToken = await this.getAccessToken();
        if (!this.accessToken) {
          return;
        }
      }

      await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`, {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${this.accessToken}`,
        },
      });
    } catch (error) {
      // 静默失败 - 清理不是关键功能
    }
  }

  /**
   * 移除"正在输入"表态（公共方法）
   * @param messageId - 指定则只清该消息的表态；不传则清全部（兼容旧调用）
   */
  async clearTypingIndicator(messageId?: string): Promise<void> {
    const targets = messageId
      ? (this.typingReactions.has(messageId) ? [[messageId, this.typingReactions.get(messageId)!] as const] : [])
      : [...this.typingReactions.entries()];
    for (const [mid, rid] of targets) {
      await this.removeTypingIndicator(mid, rid);
      this.typingReactions.delete(mid);
    }
    if (targets.length > 0) {
      console.log("[FeishuChannel] ✓ 已移除正在输入表态");
    }
  }

  /**
   * 回复指定消息（markdown 卡片）：回复会自动落在正确的群和话题里
   * 多会话模式下优先用这个而不是全局 getReplyTarget()
   */
  async sendMarkdownReply(messageId: string, text: string): Promise<boolean> {
    try {
      if (!this.accessToken || Date.now() > this.tokenExpireTime) {
        this.accessToken = await this.getAccessToken();
        if (!this.accessToken) return false;
      }
      const card = buildMarkdownCard(normalizeFeishuMarkdownLinks(text));
      const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.accessToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ msg_type: "interactive", content: JSON.stringify(card) }),
      });
      const result = await response.json();
      if (result.code === 0) {
        console.log(`${this.lp} ✓ 已回复消息 ${messageId}: ${text.substring(0, 30)}...`);
        return true;
      }
      console.error(`${this.lp} ✗ 回复失败:`, result.msg);
      return false;
    } catch (error) {
      console.error(`${this.lp} ✗ 回复出错:`, error);
      return false;
    }
  }

  /**
   * 回复指定消息（预构建的交互卡片，可带按钮）：回复自动落在正确的群和话题里。
   * 和 sendMarkdownReply 的区别：这里不做 markdown 包装，卡片由调用方构建
   * （card-actions.ts 的按钮卡片）。
   */
  async sendCardReply(messageId: string, card: Record<string, unknown>): Promise<boolean> {
    try {
      if (!this.accessToken || Date.now() > this.tokenExpireTime) {
        this.accessToken = await this.getAccessToken();
        if (!this.accessToken) return false;
      }
      const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.accessToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ msg_type: "interactive", content: JSON.stringify(card) }),
      });
      const result = await response.json();
      if (result.code === 0) {
        console.log(`${this.lp} ✓ 已回复按钮卡片 ${messageId}`);
        return true;
      }
      console.error(`${this.lp} ✗ 按钮卡片回复失败:`, result.msg);
      return false;
    } catch (error) {
      console.error(`${this.lp} ✗ 按钮卡片回复出错:`, error);
      return false;
    }
  }

  /**
   * 创建飞书流式卡片会话
   * 用于 AI 回复实时更新到单个卡片，替代逐条发送消息
   */
  createStreamingSession(): FeishuStreamingSession {
    return new FeishuStreamingSession(
      { appId: this.config.appId, appSecret: this.config.appSecret },
      (msg) => console.log(msg)
    );
  }

  /**
   * Get the best reply target for the latest inbound message.
   */
  getReplyTarget(): FeishuReplyTarget | null {
    if (this.lastMessageContext.chatId) {
      return {
        receiveId: this.lastMessageContext.chatId,
        receiveIdType: "chat_id",
      };
    }

    if (!this.config.receiveUserId) {
      return null;
    }

    return {
      receiveId: this.config.receiveUserId,
      receiveIdType: this.config.receiveIdType || "open_id",
    };
  }

  /**
   * 暴露配置（供流式会话使用）
   */
  getConfig(): FeishuChannelConfig {
    return this.config;
  }

  /**
   * 获取本 bot 的 open_id（群聊@路由判断用）
   */
  getBotOpenId(): string | null {
    return this.botOpenId;
  }

  /**
   * 获取最近一次消息的上下文（群路由判断用）
   */
  getLastMessageContext(): { chatId?: string; mentions?: Array<{ id: string; id_type?: string; name?: string }> } {
    return this.lastMessageContext;
  }

  /**
   * 从飞书 API 获取本 bot 的 open_id
   */
  private async fetchBotOpenId(): Promise<void> {
    try {
      if (!this.accessToken || Date.now() > this.tokenExpireTime) {
        this.accessToken = await this.getAccessToken();
        if (!this.accessToken) return;
      }

      const response = await fetch("https://open.feishu.cn/open-apis/bot/v3/info", {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${this.accessToken}`,
        },
      });

      const result = await response.json() as any;
      if (result.code === 0 && result.bot?.open_id) {
        this.botOpenId = result.bot.open_id;
        console.log(`${this.lp} ✓ Bot open_id: ${this.botOpenId}`);
      } else {
        console.warn(`${this.lp} ⚠ 无法获取 bot open_id:`, result.msg || "未知错误");
      }
    } catch (error) {
      console.warn(`${this.lp} ⚠ 获取 bot open_id 失败:`, error);
    }
  }

}

/** sleep 辅助函数 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
