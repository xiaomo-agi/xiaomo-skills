/**
 * 一个 bot 多会话隔离测试
 *
 * 会话按 scope 隔离：私聊/普通群 = chatId，话题群 = chatId:threadId。
 * 验证：不同群独立会话不串、A 群忙不阻塞 B 群、新群自动建会话、
 * 持久化 v1→v2 格式迁移、/new 只作用于当前 scope。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import type { FeishuCommandsDeps } from "../src/channels/feishu-commands.js";
import { FeishuCommands } from "../src/channels/feishu-commands.js";
import type { FeishuMessageContext } from "../src/channels/feishu.js";

/** 必须跟 src 侧一致地读 MYCC_DATA_DIR（tests/setup.ts 已重定向到临时目录），
 *  否则清理逻辑会绕过重定向、直接删生产环境的 src/data/ 文件 */
const DATA_DIR = process.env.MYCC_DATA_DIR || path.resolve(import.meta.dirname, "../src/data");
const SESSION_FILE = path.join(DATA_DIR, "channel-sessions.json");

function cleanPersistedState() {
  for (const f of ["channel-sessions.json", "channel-models.json"]) {
    try { fs.rmSync(path.join(DATA_DIR, f)); } catch { /* absent */ }
  }
}

function ctxFor(chatId: string, threadId?: string): FeishuMessageContext {
  return {
    scope: threadId ? `${chatId}:${threadId}` : chatId,
    chatId,
    threadId,
    messageId: `msg-${chatId}-${threadId || "main"}`,
  };
}

/** 每次调用 chat 生成一个新的唯一 session id（模拟 adapter 新建会话） */
function createDeps(): FeishuCommandsDeps & { chatCalls: any[] } {
  const chatCalls: any[] = [];
  let sessionCounter = 0;
  const deps: any = {
    adapter: {
      chat: vi.fn(async function* (params: any) {
        chatCalls.push(params);
        // 有 sessionId 就复用，否则分配新的
        const sid = params.sessionId || `new-sess-${++sessionCounter}`;
        yield { type: "system", session_id: sid };
        yield {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: `回复(${sid})` }] },
        };
      }),
      listHistory: vi.fn(async () => ({ conversations: [], total: 0, hasMore: false })),
      getHistory: vi.fn(async () => null),
      closeSession: vi.fn(),
      closeAllSessions: vi.fn(),
      getOrCreateSession: vi.fn(),
      setLifecycleCallbacks: vi.fn(),
    },
    channelManager: { broadcast: vi.fn(async () => {}) },
    cwd: "/test/cwd",
    feishuChannel: {
      id: "feishu-test",
      send: vi.fn(async () => {}),
      sendMarkdownReply: vi.fn(async () => true),
      clearTypingIndicator: vi.fn(async () => {}),
      getConfig: () => ({ appId: "a", appSecret: "s", showToolUse: true }),
      getReplyTarget: () => ({ receiveId: "u1", receiveIdType: "open_id" }),
      createStreamingSession: () => ({
        start: vi.fn(async () => {}),
        update: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        isActive: () => true,
      }),
    },
    loadConfig: vi.fn(() => null),
    chatCalls,
  };
  return deps;
}

describe("多会话隔离", () => {
  beforeEach(cleanPersistedState);

  it("两个群各自获得独立会话，互不串扰", async () => {
    const deps = createDeps();
    const fc = new FeishuCommands(deps);

    await fc.processMessage("群1的消息", undefined, undefined, "m1", ctxFor("chat-1"));
    await fc.processMessage("群2的消息", undefined, undefined, "m2", ctxFor("chat-2"));

    const s1 = fc.getSession("chat-1");
    const s2 = fc.getSession("chat-2");
    expect(s1).toBeTruthy();
    expect(s2).toBeTruthy();
    expect(s1).not.toBe(s2);

    // 群1 再发消息：复用群1 的会话
    await fc.processMessage("群1第二条", undefined, undefined, "m3", ctxFor("chat-1"));
    const lastCall = deps.chatCalls[deps.chatCalls.length - 1];
    expect(lastCall.sessionId).toBe(s1);
  });

  it("话题群里不同话题各自独立会话", async () => {
    const deps = createDeps();
    const fc = new FeishuCommands(deps);

    await fc.processMessage("话题A", undefined, undefined, "m1", ctxFor("chat-t", "thread-A"));
    await fc.processMessage("话题B", undefined, undefined, "m2", ctxFor("chat-t", "thread-B"));

    expect(fc.getSession("chat-t:thread-A")).not.toBe(fc.getSession("chat-t:thread-B"));
  });

  it("新群第一条消息自动创建会话（不需要先 /new）", async () => {
    const deps = createDeps();
    const fc = new FeishuCommands(deps);

    await fc.processMessage("新群第一条", undefined, undefined, "m1", ctxFor("chat-new"));

    // adapter.chat 被调用且 sessionId 为空（新建）
    expect(deps.chatCalls[0].sessionId).toBeUndefined();
    // 新会话被绑定到该 scope
    expect(fc.getSession("chat-new")).toBeTruthy();
    // 不应该出现"还没有会话记录"的打断提示
    const replyTexts = (deps.feishuChannel.sendMarkdownReply as any).mock.calls.map((c: any) => c[1]);
    expect(replyTexts.join("\n")).not.toContain("还没有会话记录");
  });

  it("A 群正在处理时，B 群消息不被阻塞", async () => {
    const deps = createDeps();
    const fc = new FeishuCommands(deps) as any;

    // A 群摆出处理中状态
    fc.processingScopes.set("chat-A", { startedAt: Date.now(), unlockTimer: setTimeout(() => {}, 0) });

    // B 群消息正常处理（没有被拒绝）
    await fc.processMessage("B群消息", undefined, undefined, "m1", ctxFor("chat-B"));
    expect(fc.getSession("chat-B")).toBeTruthy();

    // A 群消息被拒绝并附带进度
    await fc.processMessage("A群消息", undefined, undefined, "m2", ctxFor("chat-A"));
    const replyTexts = (deps.feishuChannel.sendMarkdownReply as any).mock.calls.map((c: any) => c[1]);
    expect(replyTexts.some((t: string) => t.includes("还在处理中"))).toBe(true);
  });

  it("/new 只重置当前群的会话，不影响其他群", async () => {
    const deps = createDeps();
    const fc = new FeishuCommands(deps);

    await fc.processMessage("群1", undefined, undefined, "m1", ctxFor("chat-1"));
    await fc.processMessage("群2", undefined, undefined, "m2", ctxFor("chat-2"));
    const s2Before = fc.getSession("chat-2");

    await fc.processMessage("/new", undefined, undefined, "m3", ctxFor("chat-1"));

    expect(fc.getSession("chat-2")).toBe(s2Before);
  });

  it("持久化 v1 旧格式（字符串）自动迁移到 __default", () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ "feishu-test": "legacy-sess-1" }));

    const deps = createDeps();
    const fc = new FeishuCommands(deps);

    expect(fc.currentSessionId).toBe("legacy-sess-1");
    expect(fc.getSession("__default")).toBe("legacy-sess-1");
  });

  it("多会话绑定持久化为 v2 格式并可恢复", async () => {
    const deps = createDeps();
    const fc = new FeishuCommands(deps);

    await fc.processMessage("群1", undefined, undefined, "m1", ctxFor("chat-1"));
    await fc.processMessage("群2", undefined, undefined, "m2", ctxFor("chat-2"));

    // 新实例（模拟重启）恢复全部绑定
    const fc2 = new FeishuCommands(createDeps());
    expect(fc2.getSession("chat-1")).toBe(fc.getSession("chat-1"));
    expect(fc2.getSession("chat-2")).toBe(fc.getSession("chat-2"));
  });

  it("无 ctx 的旧调用走 __default scope（web 同步兼容）", async () => {
    const deps = createDeps();
    const fc = new FeishuCommands(deps);
    fc.currentSessionId = "web-sess-1";

    await fc.processMessage("无 ctx 消息");

    const lastCall = deps.chatCalls[deps.chatCalls.length - 1];
    expect(lastCall.sessionId).toBe("web-sess-1");
  });
});
