/**
 * /stop 紧急终止测试
 *
 * 覆盖：
 * - 白名单放行 /stop（parseCardCommandValue）
 * - processingNoticeCard：终止按钮（danger）+ 查看进度按钮
 * - helpMenuCard 会话组包含终止按钮
 * - FeishuCommands：空闲时提示无任务、处理中调 adapter.interruptSession、
 *   无会话 ID 时优雅提示、adapter 返回 false / 抛错的差异化提示、
 *   卡片按钮路径与手敲一致（锁前拦截，处理中也能触发）、
 *   处理中收到普通消息时忙碌提示卡片带终止按钮
 * - OfficialAdapter.interruptSession：池中有 → session.interrupt()；池中无 → false
 * - CodexAdapter.interruptSession：有活跃子进程 → SIGTERM；无 → false
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import {
  parseCardCommandValue,
  processingNoticeCard,
  helpMenuCard,
} from "../src/channels/card-actions.js";
import { FeishuCommands, type FeishuCommandsDeps } from "../src/channels/feishu-commands.js";
import type { FeishuMessageContext } from "../src/channels/feishu.js";
import { OfficialAdapter } from "../src/adapters/official.js";
import { CodexAdapter } from "../src/adapters/codex.js";

const DATA_DIR = process.env.MYCC_DATA_DIR || path.resolve(import.meta.dirname, "../src/data");
const SESSION_ID = "sess-stop-1";

function cleanPersistedState() {
  for (const f of ["channel-sessions.json", "channel-models.json", "channel-agents.json"]) {
    try { fs.rmSync(path.join(DATA_DIR, f)); } catch { /* absent */ }
  }
}

// ==================== 卡片构建 ====================

describe("processingNoticeCard / 白名单", () => {
  it("parseCardCommandValue 放行 /stop", () => {
    expect(parseCardCommandValue({ cmd: "/stop" })).toEqual({ cmd: "/stop", arg: undefined });
  });

  it("卡片含终止（danger）和查看进度按钮，文案原样带入", () => {
    const card = processingNoticeCard("正在处理消息（已进行 30 秒）。") as any;
    expect(JSON.stringify(card)).toContain("已进行 30 秒");
    const buttons = (card.elements as any[])
      .filter((e) => e.tag === "action")
      .flatMap((e) => e.actions);
    const stopBtn = buttons.find((b: any) => b.value.cmd === "/stop");
    expect(stopBtn).toBeTruthy();
    expect(stopBtn.type).toBe("danger");
    expect(buttons.some((b: any) => b.value.cmd === "/status")).toBe(true);
  });

  it("helpMenuCard 会话组包含 /stop 按钮", () => {
    const card = helpMenuCard() as any;
    const buttons = (card.elements as any[])
      .filter((e) => e.tag === "action")
      .flatMap((e) => e.actions);
    expect(buttons.some((b: any) => b.value.cmd === "/stop")).toBe(true);
  });
});

// ==================== 命令层 ====================

describe("FeishuCommands /stop", () => {
  let broadcasts: string[];
  let cardReplies: Array<Record<string, unknown>>;
  let interruptSession: ReturnType<typeof vi.fn>;

  const ctx: FeishuMessageContext = {
    scope: "oc_chat1",
    chatId: "oc_chat1",
    chatType: "group",
    messageId: "om_stop_msg",
  };

  function createDeps(overrides?: Partial<FeishuCommandsDeps>): FeishuCommandsDeps {
    return {
      adapter: {
        chat: vi.fn(async function* () {}),
        listHistory: vi.fn(async () => ({
          conversations: [{ sessionId: SESSION_ID, firstPrompt: "第一条消息", lastTime: Date.now() }],
          total: 1,
          hasMore: false,
        })),
        getHistory: vi.fn(async () => null),
        interruptSession,
        closeSession: vi.fn(),
        closeAllSessions: vi.fn(),
      } as any,
      channelManager: {
        broadcast: vi.fn(async (event: any) => {
          broadcasts.push(event?.message?.content?.[0]?.text ?? "");
        }),
      } as any,
      cwd: "/tmp",
      feishuChannel: { clearTypingIndicator: vi.fn(async () => {}) },
      loadConfig: vi.fn(() => null),
      ...overrides,
    };
  }

  function cardCapableChannel() {
    return {
      clearTypingIndicator: vi.fn(async () => {}),
      sendCardReply: vi.fn(async (_messageId: string, card: Record<string, unknown>) => {
        cardReplies.push(card);
        return true;
      }),
      sendMarkdownReply: vi.fn(async (_messageId: string, text: string) => {
        broadcasts.push(text);
        return true;
      }),
      getConfig: () => ({ appId: "", appSecret: "" }),
    };
  }

  /** 绑定当前会话：走 /switch 1 主路径（与真实点击一致） */
  async function bindSession(commands: FeishuCommands) {
    await commands.processCardAction({ cmd: "/switch", arg: "1" }, ctx);
    expect(commands.getSession("oc_chat1")).toBe(SESSION_ID);
    broadcasts.length = 0;
  }

  /** 模拟"正在处理中"：直接占住处理锁（真实场景由 processMessage 主路径写入） */
  function markProcessing(commands: FeishuCommands, scope = "oc_chat1") {
    const timer = setTimeout(() => {}, 60_000);
    timer.unref?.();
    (commands as any).processingScopes.set(scope, { startedAt: Date.now() - 30_000, unlockTimer: timer });
  }

  beforeEach(() => {
    broadcasts = [];
    cardReplies = [];
    interruptSession = vi.fn(async () => true);
    cleanPersistedState();
  });

  it("空闲时 /stop → 提示无任务，不调 adapter", async () => {
    const commands = new FeishuCommands(createDeps());
    await bindSession(commands);

    await commands.processMessage("/stop", undefined, undefined, "om_1", ctx);
    expect(broadcasts.join("\n")).toContain("没有正在处理的任务");
    expect(interruptSession).not.toHaveBeenCalled();
  });

  it("处理中 /stop → 调 interruptSession(当前会话) 并确认终止", async () => {
    const commands = new FeishuCommands(createDeps());
    await bindSession(commands);
    markProcessing(commands);

    await commands.processMessage("/stop", undefined, undefined, "om_1", ctx);
    expect(interruptSession).toHaveBeenCalledWith(SESSION_ID);
    expect(broadcasts.join("\n")).toContain("已发送终止指令");
  });

  it("处理中但会话 ID 还没绑定 → 优雅提示，不调 adapter", async () => {
    const commands = new FeishuCommands(createDeps());
    markProcessing(commands);

    await commands.processMessage("/stop", undefined, undefined, "om_1", ctx);
    expect(interruptSession).not.toHaveBeenCalled();
    expect(broadcasts.join("\n")).toContain("还没拿到会话 ID");
  });

  it("adapter 返回 false（任务刚好结束）→ 提示确认状态", async () => {
    interruptSession = vi.fn(async () => false);
    const commands = new FeishuCommands(createDeps());
    await bindSession(commands);
    markProcessing(commands);

    await commands.processMessage("/stop", undefined, undefined, "om_1", ctx);
    expect(broadcasts.join("\n")).toContain("可能刚好已经结束");
  });

  it("adapter 抛错 → 报终止失败，不静默", async () => {
    interruptSession = vi.fn(async () => { throw new Error("interrupt 超时"); });
    const commands = new FeishuCommands(createDeps());
    await bindSession(commands);
    markProcessing(commands);

    await commands.processMessage("/stop", undefined, undefined, "om_1", ctx);
    expect(broadcasts.join("\n")).toContain("终止失败");
    expect(broadcasts.join("\n")).toContain("interrupt 超时");
  });

  it("卡片按钮 {cmd:'/stop'} 在处理中点击 → 锁前拦截，与手敲一致", async () => {
    const commands = new FeishuCommands(createDeps());
    await bindSession(commands);
    markProcessing(commands);

    await commands.processCardAction({ cmd: "/stop" }, ctx);
    expect(interruptSession).toHaveBeenCalledWith(SESSION_ID);
    expect(broadcasts.join("\n")).toContain("已发送终止指令");
  });

  it("处理中收到普通消息 → 忙碌提示卡片带终止按钮", async () => {
    const commands = new FeishuCommands(createDeps({ feishuChannel: cardCapableChannel() }));
    await bindSession(commands);
    markProcessing(commands);

    await commands.processMessage("再帮我看看", undefined, undefined, "om_1", ctx);
    expect(cardReplies).toHaveLength(1);
    expect(JSON.stringify(cardReplies[0])).toContain('"cmd":"/stop"');
  });

  it("处理中收到普通消息 + 通道不支持卡片 → 纯文本提示含 /stop", async () => {
    const commands = new FeishuCommands(createDeps());
    await bindSession(commands);
    markProcessing(commands);

    await commands.processMessage("再帮我看看", undefined, undefined, "om_1", ctx);
    expect(broadcasts.join("\n")).toContain("/stop");
  });
});

// ==================== Adapter 层 ====================

describe("OfficialAdapter.interruptSession", () => {
  it("池中有 session → 调内部 query.interrupt() 并返回 true", async () => {
    // SDKSession 运行时没有 interrupt 方法（sdk.d.ts 和 sdk.mjs 源码均已核实），
    // 打断能力在内部 query 字段上——mock 必须贴运行时结构，不能想当然
    const adapter = new OfficialAdapter();
    const interrupt = vi.fn(async () => {});
    (adapter as any).sessions.set("s1", { query: { interrupt } });

    await expect(adapter.interruptSession("s1")).resolves.toBe(true);
    expect(interrupt).toHaveBeenCalledTimes(1);
    adapter.closeAllSessions();
  });

  it("session 上没有可用的 query.interrupt（SDK 结构变化）→ false，不抛 TypeError", async () => {
    const adapter = new OfficialAdapter();
    (adapter as any).sessions.set("s1", {});

    await expect(adapter.interruptSession("s1")).resolves.toBe(false);
    adapter.closeAllSessions();
  });

  it("池中无 session → false，不抛错", async () => {
    const adapter = new OfficialAdapter();
    await expect(adapter.interruptSession("missing")).resolves.toBe(false);
    adapter.closeAllSessions();
  });
});

describe("CodexAdapter.interruptSession", () => {
  it("有活跃子进程 → 全部 SIGTERM 并返回 true", async () => {
    const adapter = new CodexAdapter();
    const kill = vi.fn();
    (adapter as any).activeChildren.set("s1", new Set([{ kill }]));

    await expect(adapter.interruptSession("s1")).resolves.toBe(true);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect((adapter as any).activeChildren.has("s1")).toBe(false);
  });

  it("无活跃子进程 → false", async () => {
    const adapter = new CodexAdapter();
    await expect(adapter.interruptSession("s1")).resolves.toBe(false);
  });
});
