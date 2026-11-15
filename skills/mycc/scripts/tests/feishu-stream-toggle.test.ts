/**
 * /stream 流式输出开关 + 回合收尾状态行测试（Phase 5 步骤 6）
 *
 * 覆盖：
 * - 白名单放行 /stream、streamToggleCard 只出"切到另一侧"按钮、/help 菜单收录
 * - /stream on|off 切换 + 持久化（重建实例后仍生效）、无参出卡片/纯文本回退、
 *   非法参数提示、重复切换提示、卡片按钮路径与手敲一致
 * - 批量模式：关闭流式后处理期间零消息，结束后一次性发送完整回复；
 *   不创建流式卡片；工具调用不出现在最终消息里（仅记录供 /status）；
 *   出错时部分回复 + 错误提示 + ❌ 状态行一起带出
 * - 回合收尾状态行（流式卡片）：正常 ✅ / 出错 ❌ / 被 /stop 终止 🛑
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import {
  parseCardCommandValue,
  streamToggleCard,
  helpMenuCard,
  detectSuggestedCommands,
} from "../src/channels/card-actions.js";
import { FeishuCommands, type FeishuCommandsDeps } from "../src/channels/feishu-commands.js";
import type { FeishuMessageContext } from "../src/channels/feishu.js";

const DATA_DIR = process.env.MYCC_DATA_DIR || path.resolve(import.meta.dirname, "../src/data");

function cleanPersistedState() {
  for (const f of [
    "channel-sessions.json",
    "channel-models.json",
    "channel-agents.json",
    "channel-stream.json",
  ]) {
    try { fs.rmSync(path.join(DATA_DIR, f)); } catch { /* absent */ }
  }
}

function cardButtons(card: Record<string, unknown>): any[] {
  const out: any[] = [];
  const strip = (s: string) => String(s).replace(/<[^>]+>/g, "").replace(/\*\*/g, "");
  const walk = (els: any[]) =>
    els.forEach((e: any) => {
      if (e.tag === "interactive_container" && Array.isArray(e.behaviors)) {
        out.push({ text: { content: strip(e.elements?.[0]?.content ?? "") }, value: e.behaviors[0].value });
      }
      if (Array.isArray(e.elements)) walk(e.elements);
      if (Array.isArray(e.columns)) e.columns.forEach((c: any) => walk(c.elements ?? []));
    });
  walk(card.body?.elements ?? card.elements ?? []);
  return out;
}

// ==================== 卡片构建 ====================

describe("streamToggleCard / 白名单", () => {
  it("parseCardCommandValue 放行 /stream（带参数）", () => {
    expect(parseCardCommandValue({ cmd: "/stream", arg: "off" })).toEqual({ cmd: "/stream", arg: "off" });
  });

  it("当前开启 → 只出'关闭'按钮（arg=off）", () => {
    const buttons = cardButtons(streamToggleCard(true));
    expect(buttons).toHaveLength(1);
    expect(buttons[0].value).toEqual({ cmd: "/stream", arg: "off" });
  });

  it("当前关闭 → 只出'开启'按钮（arg=on）", () => {
    const buttons = cardButtons(streamToggleCard(false));
    expect(buttons).toHaveLength(1);
    expect(buttons[0].value).toEqual({ cmd: "/stream", arg: "on" });
  });

  it("helpMenuCard 包含 /stream 按钮", () => {
    expect(cardButtons(helpMenuCard()).some((b) => b.value.cmd === "/stream")).toBe(true);
  });

  it("语境快捷按钮能识别 /stream", () => {
    expect(detectSuggestedCommands("可以发 /stream 关闭流式输出")).toEqual(["/stream"]);
  });
});

// ==================== 命令层 + 批量模式 ====================

describe("FeishuCommands /stream", () => {
  let broadcasts: string[];
  let cardReplies: Array<Record<string, unknown>>;

  const ctx: FeishuMessageContext = {
    scope: "oc_chat1",
    chatId: "oc_chat1",
    chatType: "group",
    messageId: "om_stream_msg",
  };

  /** 默认 chat 流：一段文本 + 一次工具调用 + 收尾文本 */
  function defaultChatGen() {
    return async function* () {
      yield { type: "system", session_id: "sess-stream-1" };
      yield {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "我先查一下。" },
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
            { type: "text", text: "查完了。" },
          ],
        },
      };
    };
  }

  function createDeps(overrides?: Partial<FeishuCommandsDeps>): FeishuCommandsDeps {
    return {
      adapter: {
        chat: vi.fn(defaultChatGen()),
        listHistory: vi.fn(async () => ({ conversations: [], total: 0, hasMore: false })),
        getHistory: vi.fn(async () => null),
        interruptSession: vi.fn(async () => true),
        closeSession: vi.fn(),
        closeAllSessions: vi.fn(),
      } as any,
      channelManager: {
        broadcast: vi.fn(async (event: any) => {
          broadcasts.push(event?.message?.content?.[0]?.text ?? "");
        }),
      } as any,
      cwd: "/tmp",
      feishuChannel: basicChannel(),
      loadConfig: vi.fn(() => null),
      ...overrides,
    };
  }

  /** 不支持卡片/流式的最简通道：sendMarkdownReply 记录到 broadcasts */
  function basicChannel() {
    return {
      id: "feishu-stream-test",
      clearTypingIndicator: vi.fn(async () => {}),
      sendMarkdownReply: vi.fn(async (_messageId: string, text: string) => {
        broadcasts.push(text);
        return true;
      }),
    };
  }

  /** 支持卡片和流式卡片的通道：卡片进 cardReplies，流式更新/收尾进 updates/closes */
  function streamingChannel() {
    const updates: string[] = [];
    const closes: string[] = [];
    const channel = {
      id: "feishu-stream-test",
      clearTypingIndicator: vi.fn(async () => {}),
      sendMarkdownReply: vi.fn(async (_messageId: string, text: string) => {
        broadcasts.push(text);
        return true;
      }),
      sendCardReply: vi.fn(async (_messageId: string, card: Record<string, unknown>) => {
        cardReplies.push(card);
        return true;
      }),
      getConfig: vi.fn(() => ({ appId: "a", appSecret: "s" })),
      getReplyTarget: vi.fn(() => ({ receiveId: "oc_chat1", receiveIdType: "chat_id" as const })),
      createStreamingSession: vi.fn(() => ({
        start: vi.fn(async () => {}),
        update: vi.fn(async (text: string) => { updates.push(text); }),
        close: vi.fn(async (text?: string) => { closes.push(text ?? ""); }),
        addToolCall: vi.fn(() => {}),
        isActive: () => true,
      })),
    };
    return { channel, updates, closes };
  }

  beforeEach(() => {
    broadcasts = [];
    cardReplies = [];
    cleanPersistedState();
  });

  it("/stream 无参 + 卡片通道 → 发状态卡片（当前开启，按钮是关闭）", async () => {
    const { channel } = streamingChannel();
    const commands = new FeishuCommands(createDeps({ feishuChannel: channel }));

    await commands.processMessage("/stream", undefined, undefined, "om_1", ctx);
    expect(cardReplies).toHaveLength(1);
    const buttons = cardButtons(cardReplies[0]);
    expect(buttons[0].value).toEqual({ cmd: "/stream", arg: "off" });
  });

  it("/stream 无参 + 通道不支持卡片 → 纯文本显示当前状态", async () => {
    const commands = new FeishuCommands(createDeps());

    await commands.processMessage("/stream", undefined, undefined, "om_1", ctx);
    expect(broadcasts.join("\n")).toContain("当前流式输出: 开启");
  });

  it("/stream off → 确认关闭，且持久化到新实例", async () => {
    const commands = new FeishuCommands(createDeps());
    await commands.processMessage("/stream off", undefined, undefined, "om_1", ctx);
    expect(broadcasts.join("\n")).toContain("已关闭流式输出");

    // 重建实例（模拟重启）：关闭项应从盘上恢复
    broadcasts.length = 0;
    const revived = new FeishuCommands(createDeps());
    await revived.processMessage("/stream", undefined, undefined, "om_2", ctx);
    expect(broadcasts.join("\n")).toContain("当前流式输出: 关闭");
  });

  it("/stream off 重复执行 → 提示无需切换", async () => {
    const commands = new FeishuCommands(createDeps());
    await commands.processMessage("/stream off", undefined, undefined, "om_1", ctx);
    broadcasts.length = 0;

    await commands.processMessage("/stream off", undefined, undefined, "om_2", ctx);
    expect(broadcasts.join("\n")).toContain("已经是关闭状态");
  });

  it("/stream 非法参数 → 用法提示", async () => {
    const commands = new FeishuCommands(createDeps());
    await commands.processMessage("/stream fast", undefined, undefined, "om_1", ctx);
    expect(broadcasts.join("\n")).toContain("无效参数");
  });

  it("卡片按钮 {cmd:'/stream', arg:'on'} → 与手敲一致", async () => {
    const commands = new FeishuCommands(createDeps());
    await commands.processMessage("/stream off", undefined, undefined, "om_1", ctx);
    broadcasts.length = 0;

    await commands.processCardAction({ cmd: "/stream", arg: "on" }, ctx);
    expect(broadcasts.join("\n")).toContain("已开启流式输出");
  });

  it("开关按 scope 隔离：关掉 oc_chat1 不影响其他群", async () => {
    const commands = new FeishuCommands(createDeps());
    await commands.processMessage("/stream off", undefined, undefined, "om_1", ctx);
    broadcasts.length = 0;

    const ctx2: FeishuMessageContext = { ...ctx, scope: "oc_chat2", chatId: "oc_chat2", messageId: "om_x" };
    await commands.processMessage("/stream", undefined, undefined, "om_2", ctx2);
    expect(broadcasts.join("\n")).toContain("当前流式输出: 开启");
  });

  // ============ 批量模式 ============

  it("关闭流式后：不建流式卡片，处理期间零消息，结束后一次性发送完整回复（无工具行）", async () => {
    const { channel } = streamingChannel();
    const commands = new FeishuCommands(createDeps({ feishuChannel: channel }));
    await commands.processMessage("/stream off", undefined, undefined, "om_0", ctx);
    broadcasts.length = 0;

    await commands.processMessage("帮我看看", undefined, undefined, "om_1", ctx);
    expect(channel.createStreamingSession).not.toHaveBeenCalled();
    // 一次性发送：完整正文在一条消息里
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toContain("我先查一下。");
    expect(broadcasts[0]).toContain("查完了。");
    // 工具调用不出现在最终消息里（只记录状态供 /status）
    expect(broadcasts[0]).not.toContain("Bash");
  });

  it("默认（开启流式）+ 通道无流式能力 → 仍是降级逐条发送，行为不变", async () => {
    const commands = new FeishuCommands(createDeps());

    await commands.processMessage("帮我看看", undefined, undefined, "om_1", ctx);
    // 逐条：文本块和工具行分开发（2 条文本 + 1 条工具）
    expect(broadcasts.length).toBeGreaterThan(1);
    expect(broadcasts.join("\n")).toContain("使用工具: Bash");
  });

  it("批量模式中途出错 → 部分回复 + 错误提示 + ❌ 状态行一起带出", async () => {
    const deps = createDeps({
      adapter: {
        ...createDeps().adapter,
        chat: vi.fn(async function* () {
          yield { type: "system", session_id: "sess-stream-1" };
          yield { type: "text", text: "已经写了一半" };
          throw new Error("adapter boom");
        }),
      } as any,
    });
    const commands = new FeishuCommands(deps);
    await commands.processMessage("/stream off", undefined, undefined, "om_0", ctx);
    broadcasts.length = 0;

    await commands.processMessage("帮我看看", undefined, undefined, "om_1", ctx);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toContain("已经写了一半");
    expect(broadcasts[0]).toContain("处理消息时出错");
    expect(broadcasts[0]).toContain("❌ 出错中断");
  });

  // ============ 回合收尾状态行（流式卡片） ============

  it("流式卡片正常收尾 → 正文不带状态行（完成状态在抬头条/KPI）", async () => {
    const { channel, closes } = streamingChannel();
    const commands = new FeishuCommands(createDeps({ feishuChannel: channel }));

    await commands.processMessage("帮我看看", undefined, undefined, "om_1", ctx);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toContain("查完了。");
    // 2026-10-31 owner：KPI 行已有耗时，正文不再追"✅ 已完成·耗时"
    expect(closes[0]).not.toContain("✅ 已完成 · 耗时");
  });

  it("流式卡片出错收尾 → 部分正文 + 错误提示 + ❌ 状态行", async () => {
    const { channel, closes } = streamingChannel();
    const deps = createDeps({
      feishuChannel: channel,
      adapter: {
        ...createDeps().adapter,
        chat: vi.fn(async function* () {
          yield { type: "system", session_id: "sess-stream-1" };
          yield { type: "text", text: "写了一部分" };
          throw new Error("stream boom");
        }),
      } as any,
    });
    const commands = new FeishuCommands(deps);

    await commands.processMessage("帮我看看", undefined, undefined, "om_1", ctx);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toContain("写了一部分");
    expect(closes[0]).toContain("处理消息时出错");
    expect(closes[0]).toContain("❌ 出错中断 · 已运行");
  });

  it("回合中被 /stop 终止 → 正文不带状态行（🛑 语义在抬头条）", async () => {
    const { channel, closes } = streamingChannel();
    let commands: FeishuCommands;
    const deps = createDeps({
      feishuChannel: channel,
      adapter: {
        ...createDeps().adapter,
        interruptSession: vi.fn(async () => true),
        chat: vi.fn(async function* () {
          yield { type: "system", session_id: "sess-stream-1" };
          yield { type: "text", text: "跑到一半" };
          // 模拟用户在回合进行中发 /stop（锁前拦截路径，处理中也会响应）
          await commands.processMessage("/stop", undefined, undefined, "om_stop", ctx);
          // interrupt 生效：流到此结束
        }),
      } as any,
    });
    commands = new FeishuCommands(deps);

    await commands.processMessage("帮我看看", undefined, undefined, "om_1", ctx);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toContain("跑到一半");
    expect(closes[0]).toBe("跑到一半");
    expect(closes[0]).not.toContain("✅");
  });
});
