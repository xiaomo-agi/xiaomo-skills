/**
 * Agent 工作状态反馈机制测试
 *
 * 1. 流式卡片实时显示工具调用（用户能看到 AI 正在干什么）
 * 2. /status 命令：空闲/处理中都能查询，且处理中不被并发锁挡住
 * 3. "处理中"拒绝提示附带已运行时长
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import type { FeishuCommandsDeps } from "../src/channels/feishu-commands.js";
import { FeishuCommands } from "../src/channels/feishu-commands.js";

/** 必须跟 src 侧一致地读 MYCC_DATA_DIR（tests/setup.ts 已重定向到临时目录），
 *  否则清理逻辑会绕过重定向、直接删生产环境的 src/data/ 文件 */
const DATA_DIR = process.env.MYCC_DATA_DIR || path.resolve(import.meta.dirname, "../src/data");
function cleanPersistedState() {
  for (const f of ["channel-sessions.json", "channel-models.json"]) {
    try { fs.rmSync(path.join(DATA_DIR, f)); } catch { /* absent */ }
  }
}

/** 带流式卡片能力的 mock 通道 */
function createStreamingChannelMock() {
  const updates: string[] = [];
  const sent: string[] = [];
  return {
    updates,
    sent,
    channel: {
      id: "feishu-test",
      send: vi.fn(async (event: any) => {
        sent.push(event?.message?.content?.[0]?.text || "");
      }),
      clearTypingIndicator: vi.fn(async () => {}),
      getConfig: () => ({ appId: "a", appSecret: "s", showToolUse: true }),
      getReplyTarget: () => ({ receiveId: "u1", receiveIdType: "open_id" }),
      createStreamingSession: () => ({
        start: vi.fn(async () => {}),
        update: vi.fn(async (text: string) => { updates.push(text); }),
        close: vi.fn(async () => {}),
        isActive: () => true,
      }),
    },
  };
}

function createDeps(channel: any, chatGen?: () => AsyncGenerator<any>): FeishuCommandsDeps {
  return {
    adapter: {
      chat: vi.fn(chatGen || (async function* () {
        yield { type: "system", session_id: "sess-1" };
        yield {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "我先查一下。" },
              { type: "tool_use", name: "Bash", input: { command: "ls", description: "列出文件" } },
              { type: "text", text: "查完了。" },
            ],
          },
        };
      })),
      listHistory: vi.fn(async () => ({ conversations: [], total: 0, hasMore: false })),
      getHistory: vi.fn(async () => null),
      closeSession: vi.fn(),
      closeAllSessions: vi.fn(),
      getOrCreateSession: vi.fn(),
      setLifecycleCallbacks: vi.fn(),
    } as any,
    channelManager: { broadcast: vi.fn(async () => {}) } as any,
    cwd: "/test/cwd",
    feishuChannel: channel,
    loadConfig: vi.fn(() => null) as any,
  };
}

describe("流式卡片显示工具调用", () => {
  beforeEach(cleanPersistedState);

  it("tool_use block 出现在卡片累积文本里（名字 + 摘要）", async () => {
    const mock = createStreamingChannelMock();
    const deps = createDeps(mock.channel);
    const fc = new FeishuCommands(deps);
    fc.currentSessionId = "sess-1";

    await fc.processMessage("帮我看看", undefined, undefined, "msg-1");

    const finalText = mock.updates[mock.updates.length - 1] || "";
    expect(finalText).toContain("🔧 Bash");
    // Bash 的摘要按工具类型选字段，显示实际命令而不是 description
    expect(finalText).toContain("ls");
    expect(finalText).toContain("我先查一下。");
    expect(finalText).toContain("查完了。");
  });

  it("showToolUse=false 时卡片不显示工具调用", async () => {
    const mock = createStreamingChannelMock();
    mock.channel.getConfig = () => ({ appId: "a", appSecret: "s", showToolUse: false });
    const deps = createDeps(mock.channel);
    const fc = new FeishuCommands(deps);
    fc.currentSessionId = "sess-1";

    await fc.processMessage("帮我看看", undefined, undefined, "msg-1");

    const finalText = mock.updates[mock.updates.length - 1] || "";
    expect(finalText).not.toContain("🔧");
    expect(finalText).toContain("我先查一下。");
  });
});

describe("心跳提示（长时间无输出）", () => {
  beforeEach(cleanPersistedState);

  it("heartbeat 事件追加'仍在运行'提示到卡片", async () => {
    const mock = createStreamingChannelMock();
    const deps = createDeps(mock.channel, async function* () {
      yield { type: "system", session_id: "sess-1" };
      yield {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "查一下先。" }] },
      };
      yield { type: "heartbeat", ts: Date.now() };
      yield {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "查完了。" }] },
      };
    });
    const fc = new FeishuCommands(deps);
    fc.currentSessionId = "sess-1";

    await fc.processMessage("帮我看看", undefined, undefined, "msg-1");

    const heartbeatUpdate = mock.updates.find((t) => t.includes("⏳"));
    expect(heartbeatUpdate).toBeDefined();
    expect(heartbeatUpdate).toContain("仍在处理中");

    const finalText = mock.updates[mock.updates.length - 1] || "";
    expect(finalText).toContain("查一下先。");
    expect(finalText).toContain("查完了。");
  });

  it("同一 scope 短时间内第二次 heartbeat 被节流，不重复展示", async () => {
    const mock = createStreamingChannelMock();
    const deps = createDeps(mock.channel, async function* () {
      yield { type: "system", session_id: "sess-1" };
      yield { type: "heartbeat", ts: Date.now() };
      yield { type: "heartbeat", ts: Date.now() };
      yield {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "完成。" }] },
      };
    });
    const fc = new FeishuCommands(deps);
    fc.currentSessionId = "sess-1";

    await fc.processMessage("帮我看看", undefined, undefined, "msg-1");

    // accumulatedText 是累积的，一旦插入 ⏳ 提示会保留到后续所有 update() 里，
    // 所以要看最终文本里 ⏳ 出现了几次，而不是数多少次 update() 调用包含它
    const finalText = mock.updates[mock.updates.length - 1] || "";
    const heartbeatOccurrences = (finalText.match(/⏳/g) || []).length;
    expect(heartbeatOccurrences).toBe(1);
  });

  it("heartbeat 展示最近工具名（若有）", async () => {
    const mock = createStreamingChannelMock();
    const deps = createDeps(mock.channel, async function* () {
      yield { type: "system", session_id: "sess-1" };
      yield {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
        },
      };
      yield { type: "heartbeat", ts: Date.now() };
    });
    const fc = new FeishuCommands(deps);
    fc.currentSessionId = "sess-1";

    await fc.processMessage("帮我看看", undefined, undefined, "msg-1");

    const heartbeatUpdate = mock.updates.find((t) => t.includes("⏳"));
    expect(heartbeatUpdate).toContain("正在执行 Bash");
  });
});

describe("/status 命令", () => {
  beforeEach(cleanPersistedState);

  it("空闲时报告空闲 + 会话/模型信息", async () => {
    const mock = createStreamingChannelMock();
    const deps = createDeps(mock.channel);
    const fc = new FeishuCommands(deps);
    fc.currentSessionId = "sess-abcdefgh-123";
    fc.currentModel = "claude-fable-5";

    await fc.processMessage("/status");

    const text = mock.sent[mock.sent.length - 1] || "";
    expect(text).toContain("空闲");
    expect(text).toContain("sess-abc");
    expect(text).toContain("claude-fable-5");
  });

  it("处理中不被并发锁挡住，报告已运行时长和最近工具", async () => {
    const mock = createStreamingChannelMock();
    const deps = createDeps(mock.channel);
    const fc = new FeishuCommands(deps) as any;
    // 模拟正在处理：直接摆出锁定状态（多会话后按 scope 记录）
    fc.processingScopes.set("__default", {
      startedAt: Date.now() - 90_000,
      lastToolName: "Bash",
      lastToolAt: Date.now() - 5_000,
      unlockTimer: setTimeout(() => {}, 0),
    });

    await fc.processMessage("/status");

    const text = mock.sent[mock.sent.length - 1] || "";
    expect(text).toContain("正在处理");
    expect(text).toContain("1 分30 秒");
    expect(text).toContain("Bash");
  });

  it("处理中收到普通消息：拒绝提示附带进度", async () => {
    const mock = createStreamingChannelMock();
    const deps = createDeps(mock.channel);
    const fc = new FeishuCommands(deps) as any;
    fc.processingScopes.set("__default", {
      startedAt: Date.now() - 30_000,
      unlockTimer: setTimeout(() => {}, 0),
    });

    await fc.processMessage("新消息");

    const text = mock.sent[mock.sent.length - 1] || "";
    expect(text).toContain("还在处理中");
    expect(text).toContain("已运行 30 秒");
    expect(text).toContain("/status");
  });
});
