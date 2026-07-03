/**
 * /agent 命令测试（Phase 3：多供应商切换）
 *
 * 覆盖：
 * - 无参查询（显示当前供应商 + 可用列表）
 * - 非法输入报错并列出支持项
 * - 合法切换后消息主路径走对应供应商 adapter
 * - scope 隔离（A 群切 codex 不影响 B 群）
 * - 持久化到 channel-agents.json + 重启恢复
 * - 切换语义：会话按 (scope, provider) 各自绑定，切走解绑/驱逐，切回恢复
 *
 * 注意：src/adapters/codex.ts 落地后，真实 CodexAdapter 在 adapters/index.ts
 * 模块加载时即注册——"codex 尚未接入"的过渡态不复存在，第一部分用例
 * 改为断言出厂即接入的行为。第二部分用 registerAdapter 覆盖为 fake codex
 * （模块级单例，覆盖后不可还原），验证切换主路径。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import type { FeishuCommandsDeps } from "../src/channels/feishu-commands.js";
import { FeishuCommands } from "../src/channels/feishu-commands.js";
import type { FeishuMessageContext } from "../src/channels/feishu.js";
import { registerAdapter, type CCAdapter } from "../src/adapters/index.js";

/** 必须跟 src 侧一致地读 MYCC_DATA_DIR（tests/setup.ts 已重定向到临时目录） */
const DATA_DIR = process.env.MYCC_DATA_DIR || path.resolve(import.meta.dirname, "../src/data");
const AGENT_FILE = path.join(DATA_DIR, "channel-agents.json");

function cleanPersistedState() {
  for (const f of ["channel-sessions.json", "channel-models.json", "channel-agents.json"]) {
    try { fs.rmSync(path.join(DATA_DIR, f)); } catch { /* absent */ }
  }
}

function ctxFor(chatId: string, threadId?: string): FeishuMessageContext {
  return {
    scope: threadId ? `${chatId}:${threadId}` : chatId,
    chatId,
    threadId,
  };
}

/** claude 侧 mock adapter（走 deps.adapter 注入） */
function createMockDeps(overrides?: Partial<FeishuCommandsDeps>): FeishuCommandsDeps {
  return {
    adapter: {
      chat: vi.fn(async function* () {
        yield { type: "system", session_id: "claude-sess-1" };
        yield {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Hello from Claude" }] },
        };
      }),
      listHistory: vi.fn(async () => ({ conversations: [], total: 0, hasMore: false })),
      getHistory: vi.fn(async () => null),
      closeSession: vi.fn(),
      closeAllSessions: vi.fn(),
    } as any,
    channelManager: { broadcast: vi.fn(async () => {}) } as any,
    cwd: "/test/cwd",
    feishuChannel: { clearTypingIndicator: vi.fn(async () => {}) },
    loadConfig: vi.fn(() => null),
    ...overrides,
  };
}

/** codex 侧 fake adapter（走注册表注入，本机没装 codex CLI） */
function createFakeCodexAdapter() {
  return {
    chat: vi.fn(async function* () {
      yield { type: "system", session_id: "codex-sess-1" };
      yield {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Hello from Codex" }] },
      };
    }),
    listHistory: vi.fn(async () => ({ conversations: [], total: 0, hasMore: false })),
    getHistory: vi.fn(async () => null),
    closeSession: vi.fn(),
    closeAllSessions: vi.fn(),
  } as unknown as CCAdapter & { chat: any; closeSession: any };
}

function getLastBroadcastText(deps: FeishuCommandsDeps): string {
  const calls = (deps.channelManager.broadcast as any).mock.calls;
  if (calls.length === 0) return "";
  const lastCall = calls[calls.length - 1][0];
  return lastCall?.message?.content?.[0]?.text || "";
}

// ============ 第一部分：出厂状态（真实 CodexAdapter 已在模块加载时注册） ============

describe("/agent 命令 - 出厂即注册真实 CodexAdapter", () => {
  let deps: FeishuCommandsDeps;
  let fc: FeishuCommands;

  beforeEach(() => {
    cleanPersistedState();
    deps = createMockDeps();
    fc = new FeishuCommands(deps);
  });

  it("无参数显示当前供应商（默认 claude）和可用列表，codex 已接入不再标注", async () => {
    await fc.processMessage("/agent", undefined, undefined, undefined, ctxFor("chat-q"));

    const text = getLastBroadcastText(deps);
    expect(text).toContain("当前 agent: claude");
    expect(text).toContain("默认");
    expect(text).toContain("codex");
    expect(text).not.toContain("尚未接入");
  });

  it("切换到 codex 成功并写入持久化（导入 adapters/index 即完成注册）", async () => {
    await fc.processMessage("/agent codex", undefined, undefined, undefined, ctxFor("chat-q"));

    const text = getLastBroadcastText(deps);
    expect(text).toContain("已切换 agent: claude → codex");
    expect(text).not.toContain("尚未接入");

    // 切换记录已持久化（不发后续消息：真实 CodexAdapter 会 spawn codex 二进制）
    const data = JSON.parse(fs.readFileSync(AGENT_FILE, "utf-8"));
    expect(data.default["chat-q"]).toBe("codex");
  });

  it("非法输入报错并列出支持项", async () => {
    await fc.processMessage("/agent gpt5", undefined, undefined, undefined, ctxFor("chat-q"));

    const text = getLastBroadcastText(deps);
    expect(text).toContain("无效的 agent 供应商: gpt5");
    expect(text).toContain("claude");
    expect(text).toContain("codex");
  });

  it("切换到当前已在用的 claude 时提示无需切换", async () => {
    await fc.processMessage("/agent claude", undefined, undefined, undefined, ctxFor("chat-q"));

    const text = getLastBroadcastText(deps);
    expect(text).toContain("已经在使用 claude");
  });
});

// ============ 第二部分：注册 fake codex 后的切换行为 ============

describe("/agent 命令 - codex 已注册后", () => {
  let deps: FeishuCommandsDeps;
  let fc: FeishuCommands;
  let codex: ReturnType<typeof createFakeCodexAdapter>;

  beforeEach(() => {
    cleanPersistedState();
    deps = createMockDeps();
    fc = new FeishuCommands(deps);
    codex = createFakeCodexAdapter();
    registerAdapter("codex", codex as unknown as CCAdapter);
  });

  it("无参数时列表不再标注尚未接入", async () => {
    await fc.processMessage("/agent", undefined, undefined, undefined, ctxFor("chat-q"));

    const text = getLastBroadcastText(deps);
    expect(text).toContain("• codex");
    expect(text).not.toContain("尚未接入");
  });

  it("合法切换：/agent codex 后该 scope 的消息走 codex adapter", async () => {
    const ctx = ctxFor("chat-A");
    await fc.processMessage("/agent codex", undefined, undefined, undefined, ctx);

    const text = getLastBroadcastText(deps);
    expect(text).toContain("已切换 agent: claude → codex");

    await fc.processMessage("你好", undefined, undefined, undefined, ctx);
    expect(codex.chat).toHaveBeenCalledTimes(1);
    expect(deps.adapter.chat).not.toHaveBeenCalled();

    // codex 的回复正常送达
    const calls = (deps.channelManager.broadcast as any).mock.calls;
    const texts = calls.map((c: any) => c[0]?.message?.content?.[0]?.text || "");
    expect(texts.some((t: string) => t === "Hello from Codex")).toBe(true);
  });

  it("无参数查询显示切换后的供应商", async () => {
    const ctx = ctxFor("chat-A");
    await fc.processMessage("/agent codex", undefined, undefined, undefined, ctx);
    await fc.processMessage("/agent", undefined, undefined, undefined, ctx);

    const text = getLastBroadcastText(deps);
    expect(text).toContain("当前 agent: codex");
    expect(text).not.toContain("（默认）");
  });

  it("scope 隔离：A 群切 codex 不影响 B 群", async () => {
    await fc.processMessage("/agent codex", undefined, undefined, undefined, ctxFor("chat-A"));

    // B 群消息仍走 claude
    await fc.processMessage("B群消息", undefined, undefined, undefined, ctxFor("chat-B"));
    expect(deps.adapter.chat).toHaveBeenCalledTimes(1);
    expect(codex.chat).not.toHaveBeenCalled();

    // A 群消息走 codex
    await fc.processMessage("A群消息", undefined, undefined, undefined, ctxFor("chat-A"));
    expect(codex.chat).toHaveBeenCalledTimes(1);
    expect(deps.adapter.chat).toHaveBeenCalledTimes(1);

    // B 群查询显示默认 claude
    await fc.processMessage("/agent", undefined, undefined, undefined, ctxFor("chat-B"));
    expect(getLastBroadcastText(deps)).toContain("当前 agent: claude");
  });

  it("持久化写入 channel-agents.json（scope 粒度），重启后恢复", async () => {
    await fc.processMessage("/agent codex", undefined, undefined, undefined, ctxFor("chat-A"));

    // 文件格式：{channelId: {scope: provider}}
    const data = JSON.parse(fs.readFileSync(AGENT_FILE, "utf-8"));
    expect(data.default["chat-A"]).toBe("codex");

    // 模拟重启：新实例从磁盘恢复
    const deps2 = createMockDeps();
    const fc2 = new FeishuCommands(deps2);

    await fc2.processMessage("重启后的消息", undefined, undefined, undefined, ctxFor("chat-A"));
    expect(codex.chat).toHaveBeenCalledTimes(1);
    expect(deps2.adapter.chat).not.toHaveBeenCalled();

    // 未切换过的 scope 不受影响
    await fc2.processMessage("其他群消息", undefined, undefined, undefined, ctxFor("chat-B"));
    expect(deps2.adapter.chat).toHaveBeenCalledTimes(1);
  });

  it("切回 claude 后记录清除，消息回到默认 adapter", async () => {
    const ctx = ctxFor("chat-A");
    await fc.processMessage("/agent codex", undefined, undefined, undefined, ctx);
    await fc.processMessage("/agent claude", undefined, undefined, undefined, ctx);

    expect(getLastBroadcastText(deps)).toContain("已切换 agent: codex → claude");

    await fc.processMessage("你好", undefined, undefined, undefined, ctx);
    expect(deps.adapter.chat).toHaveBeenCalledTimes(1);
    expect(codex.chat).not.toHaveBeenCalled();

    // 持久化里不再有该 scope 的记录（claude=默认不落盘）
    const data = fs.existsSync(AGENT_FILE) ? JSON.parse(fs.readFileSync(AGENT_FILE, "utf-8")) : {};
    expect(data.default?.["chat-A"]).toBeUndefined();
  });

  it("切换语义：会话按 (scope, provider) 各自绑定，切走驱逐+解绑，切回恢复", async () => {
    const ctx = ctxFor("chat-A");

    // 先在 claude 下建立会话绑定
    await fc.processMessage("你好", undefined, undefined, undefined, ctx);
    expect(fc.getSession("chat-A")).toBe("claude-sess-1");

    // 切到 codex：claude 会话被暂存并从 claude adapter 池驱逐，scope 解绑
    await fc.processMessage("/agent codex", undefined, undefined, undefined, ctx);
    expect(deps.adapter.closeSession).toHaveBeenCalledWith("claude-sess-1");
    expect(fc.getSession("chat-A")).toBeNull();
    expect(getLastBroadcastText(deps)).toContain("新会话将在下一条消息时自动创建");

    // codex 下发消息：不带 claude 的 sessionId，新建 codex 会话
    await fc.processMessage("codex你好", undefined, undefined, undefined, ctx);
    const codexCall = codex.chat.mock.calls[0][0];
    expect(codexCall.sessionId).toBeUndefined();
    expect(fc.getSession("chat-A")).toBe("codex-sess-1");

    // 切回 claude：codex 会话被暂存+驱逐，claude 旧会话恢复
    await fc.processMessage("/agent claude", undefined, undefined, undefined, ctx);
    expect(codex.closeSession).toHaveBeenCalledWith("codex-sess-1");
    expect(fc.getSession("chat-A")).toBe("claude-sess-1");
    expect(getLastBroadcastText(deps)).toContain("已恢复此前在 claude 下的会话");

    // 恢复后的消息带旧 sessionId 走 claude adapter
    await fc.processMessage("继续聊", undefined, undefined, undefined, ctx);
    const claudeCalls = (deps.adapter.chat as any).mock.calls;
    const lastClaudeCall = claudeCalls[claudeCalls.length - 1][0];
    expect(lastClaudeCall.sessionId).toBe("claude-sess-1");
  });

  it("codex scope 不透传 /model 选择的 claude 模型 ID", async () => {
    const ctx = ctxFor("chat-A");
    await fc.processMessage("/model fable5", undefined, undefined, undefined, ctx);
    await fc.processMessage("/agent codex", undefined, undefined, undefined, ctx);

    await fc.processMessage("你好", undefined, undefined, undefined, ctx);
    const codexCall = codex.chat.mock.calls[0][0];
    expect(codexCall.model).toBeUndefined();

    // claude scope 照常透传
    await fc.processMessage("B群你好", undefined, undefined, undefined, ctxFor("chat-B"));
    const claudeCall = (deps.adapter.chat as any).mock.calls[0][0];
    expect(claudeCall.model).toBe("claude-fable-5");
  });

  it("话题群 scope（chatId:threadId）也按 scope 粒度隔离", async () => {
    await fc.processMessage("/agent codex", undefined, undefined, undefined, ctxFor("chat-t", "thread-A"));

    await fc.processMessage("话题A消息", undefined, undefined, undefined, ctxFor("chat-t", "thread-A"));
    expect(codex.chat).toHaveBeenCalledTimes(1);

    await fc.processMessage("话题B消息", undefined, undefined, undefined, ctxFor("chat-t", "thread-B"));
    expect(deps.adapter.chat).toHaveBeenCalledTimes(1);
  });

  it("/help 包含 /agent 命令说明", async () => {
    await fc.processMessage("/help");
    const text = getLastBroadcastText(deps);
    expect(text).toContain("/agent");
    expect(text).toContain("Agent 供应商");
  });
});
