/**
 * CCAdapter 接口定义
 *
 * 不同的 Claude Code 版本可以实现这个接口
 * - official.ts: 官方 Claude Code SDK 实现
 * - custom.ts: 用户自定义实现
 */

import type { ChatParams, ConversationSummary, ConversationHistory } from "../types.js";
import type { SDKSession } from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalCardHandle } from "../permissions/approval.js";

/** SSE 事件 */
export type SSEEvent = Record<string, unknown>;

/** Session 参数 */
export interface SessionParams {
  sessionId?: string;
  model?: string;
  cwd?: string;
  /** 本会话的飞书审批句柄：会话创建时闭包进 canUseTool，审批卡只发本会话的聊天（09-06 串卡修复） */
  approvalHandle?: ApprovalCardHandle;
}

/** Adapter 接口 */
export interface CCAdapter {
  /**
   * 发送消息，返回 SSE 事件流
   */
  chat(params: ChatParams): AsyncIterable<SSEEvent>;

  /**
   * 获取历史记录列表
   */
  listHistory(cwd: string, limit?: number): Promise<{
    conversations: ConversationSummary[];
    total: number;
    hasMore: boolean;
  }>;

  /**
   * 获取单个对话详情
   */
  getHistory(cwd: string, sessionId: string): Promise<ConversationHistory | null>;

  /**
   * 获取或创建 v2 Session
   * - 池中有 → 复用
   * - 有 sessionId 但不在池中 → resumeSession
   * - 无 sessionId → createSession
   */
  getOrCreateSession(params: SessionParams): SDKSession;

  /**
   * 打断指定 session 的当前回合（等价终端 Esc）：只停正在跑的任务，
   * 会话本身保留，后续消息可以继续。返回是否找到了活跃目标并发出打断。
   */
  interruptSession(sessionId: string): Promise<boolean>;

  /**
   * 往正在进行的回合注入补充信息（官方 Session.send 的 steering 路径）：
   * CLI 在当前步骤完成后吸收这条消息继续跑，任务连续完成后回合才结束。
   * 仅当该 session 当前真的在回合中（result 未出）才有效；回合已收线、
   * session 不在池或供应商不支持时返回 false，调用方应降级排队。
   */
  steerSession(sessionId: string, text: string): Promise<boolean>;

  /**
   * 关闭指定 session
   */
  closeSession(sessionId: string): void;

  /**
   * 关闭所有 session（退出时调用）
   */
  closeAllSessions(): void;

  /**
   * 设置 session 生命周期回调
   */
  setLifecycleCallbacks(callbacks: {
    onSessionCreate?: (sessionId: string) => void;
    onSessionClose?: (sessionId: string) => void;
  }): void;
}
