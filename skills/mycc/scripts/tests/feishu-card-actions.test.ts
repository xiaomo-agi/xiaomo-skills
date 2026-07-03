/**
 * 飞书卡片交互按钮测试（Phase 5 步骤 1）
 *
 * 覆盖：
 * - parseCardCommandValue 白名单校验（未识别 value 绝不能流向 Claude skill 转发）
 * - 卡片构建器：按钮 value 携带 {cmd, arg}，格式符合 1.0 action 模块
 * - FeishuCommands.processCardAction：点击 → 命令主路径（复用并发锁/处理器）
 * - /model /agent /sessions 无参时发按钮卡片，通道不支持时回退纯文本
 * - FeishuChannel.handleCardActionEvent：scope 解析（群/私聊/话题群反查 thread_id）
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import {
  parseCardCommandValue,
  modelPickerCard,
  agentPickerCard,
  sessionPickerCard,
  confirmActionCard,
} from "../src/channels/card-actions.js";
import { FeishuCommands, type FeishuCommandsDeps } from "../src/channels/feishu-commands.js";
import { FeishuChannel, type FeishuMessageContext } from "../src/channels/feishu.js";

const DATA_DIR = process.env.MYCC_DATA_DIR || path.resolve(import.meta.dirname, "../src/data");

function cleanPersistedState() {
  for (const f of ["channel-sessions.json", "channel-models.json", "channel-agents.json"]) {
    try { fs.rmSync(path.join(DATA_DIR, f)); } catch { /* absent */ }
  }
}

/** 从 1.0 卡片里抽出所有按钮（展开 action 模块） */
function extractButtons(card: Record<string, unknown>): any[] {
  const elements = (card as any).elements as any[];
  return elements.filter((e) => e.tag === "action").flatMap((e) => e.actions);
}

describe("parseCardCommandValue", () => {
  it("解析白名单内的 cmd + arg", () => {
    expect(parseCardCommandValue({ cmd: "/model", arg: "opus" })).toEqual({ cmd: "/model", arg: "opus" });
    expect(parseCardCommandValue({ cmd: "/switch", arg: "3" })).toEqual({ cmd: "/switch", arg: "3" });
  });

  it("arg 缺失/空串时省略", () => {
    expect(parseCardCommandValue({ cmd: "/sessions" })).toEqual({ cmd: "/sessions", arg: undefined });
    expect(parseCardCommandValue({ cmd: "/model", arg: "" })).toEqual({ cmd: "/model", arg: undefined });
  });

  it("cmd 大小写不敏感", () => {
    expect(parseCardCommandValue({ cmd: "/Model", arg: "opus" })).toEqual({ cmd: "/model", arg: "opus" });
  });

  it("拒绝白名单外的命令（防止旧卡片/伪造 value 被转发给 Claude）", () => {
    expect(parseCardCommandValue({ cmd: "/rm-rf" })).toBeNull();
    expect(parseCardCommandValue({ cmd: "帮我删库" })).toBeNull();
  });

  it("拒绝非对象 / 无 cmd 的载荷", () => {
    expect(parseCardCommandValue(null)).toBeNull();
    expect(parseCardCommandValue("cmd=/model")).toBeNull();
    expect(parseCardCommandValue({ arg: "opus" })).toBeNull();
    expect(parseCardCommandValue({ cmd: 42 })).toBeNull();
  });
});

describe("卡片构建器", () => {
  it("modelPickerCard：4 个模型按钮，value 走 /model", () => {
    const card = modelPickerCard("claude-fable-5");
    const buttons = extractButtons(card);
    expect(buttons).toHaveLength(4);
    for (const b of buttons) {
      expect(b.tag).toBe("button");
      expect(b.value.cmd).toBe("/model");
      expect(parseCardCommandValue(b.value)).not.toBeNull();
    }
    expect(buttons.map((b) => b.value.arg)).toEqual(["fable5", "opus", "sonnet", "haiku"]);
    expect(JSON.stringify(card)).toContain("claude-fable-5");
  });

  it("agentPickerCard：只给已接入且非当前的供应商出按钮", () => {
    const card = agentPickerCard("claude", [
      { name: "claude", registered: true },
      { name: "codex", registered: true },
    ]);
    const buttons = extractButtons(card);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].value).toEqual({ cmd: "/agent", arg: "codex" });
  });

  it("agentPickerCard：未接入的供应商不出按钮，只在文案里说明", () => {
    const card = agentPickerCard("claude", [
      { name: "claude", registered: true },
      { name: "codex", registered: false },
    ]);
    expect(extractButtons(card)).toHaveLength(0);
    expect(JSON.stringify(card)).toContain("尚未接入");
  });

  it("sessionPickerCard：每条会话一个 /switch 按钮，当前会话置灰", () => {
    const card = sessionPickerCard(
      [
        { index: 1, title: "会话甲", timeAgo: "3分钟前", current: true },
        { index: 2, title: "会话乙", timeAgo: "1小时前", current: false },
      ],
      5
    );
    const buttons = extractButtons(card);
    expect(buttons).toHaveLength(2);
    expect(buttons[0].value).toEqual({ cmd: "/switch", arg: "1" });
    expect(buttons[0].type).toBe("default");
    expect(buttons[1].value).toEqual({ cmd: "/switch", arg: "2" });
    expect(buttons[1].type).toBe("primary");
  });

  it("confirmActionCard：危险按钮 + /noop 取消按钮", () => {
    const card = confirmActionCard("确定要杀掉进程吗？", "确认杀掉", { cmd: "/status" });
    const buttons = extractButtons(card);
    expect(buttons).toHaveLength(2);
    expect(buttons[0].type).toBe("danger");
    expect(buttons[1].value).toEqual({ cmd: "/noop" });
  });
});

describe("FeishuCommands.processCardAction", () => {
  let broadcasts: string[];
  let cardReplies: Array<Record<string, unknown>>;

  function createDeps(overrides?: Partial<FeishuCommandsDeps>): FeishuCommandsDeps {
    return {
      adapter: {
        chat: vi.fn(async function* () {
          yield { type: "system", session_id: "sess-1" };
        }),
        listHistory: vi.fn(async () => ({ conversations: [], total: 0, hasMore: false })),
        getHistory: vi.fn(async () => null),
        closeSession: vi.fn(),
        closeAllSessions: vi.fn(),
      } as any,
      channelManager: {
        broadcast: vi.fn(async (event: any) => {
          broadcasts.push(event?.message?.content?.[0]?.text ?? "");
        }),
      } as any,
      cwd: "/test/cwd",
      feishuChannel: { clearTypingIndicator: vi.fn(async () => {}) },
      loadConfig: vi.fn(() => null),
      ...overrides,
    };
  }

  /** 带卡片能力的 mock 通道：sendCardReply 捕获卡片，sendMarkdownReply 捕获文本 */
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

  const ctx: FeishuMessageContext = {
    scope: "oc_chat1",
    chatId: "oc_chat1",
    chatType: "group",
    messageId: "om_card_msg",
  };

  beforeEach(() => {
    broadcasts = [];
    cardReplies = [];
    cleanPersistedState();
  });

  it("白名单外/无效 value → 提示按钮失效，不触发任何命令", async () => {
    const deps = createDeps();
    const commands = new FeishuCommands(deps);
    await commands.processCardAction({ cmd: "/evil", arg: "x" }, ctx);
    expect(broadcasts.join("\n")).toContain("已失效");
    expect(deps.adapter.chat).not.toHaveBeenCalled();
  });

  it("/noop（确认卡片的取消按钮）→ 只回一句已取消", async () => {
    const commands = new FeishuCommands(createDeps());
    await commands.processCardAction({ cmd: "/noop" }, ctx);
    expect(broadcasts.join("\n")).toContain("已取消");
  });

  it("点击 /model opus → 实际切换模型并回复", async () => {
    const commands = new FeishuCommands(createDeps());
    await commands.processCardAction({ cmd: "/model", arg: "opus" }, ctx);
    expect(commands.currentModel).toBe("opus");
    expect(broadcasts.join("\n")).toContain("已切换模型");
  });

  it("点击 /switch 2 → 绑定对应会话", async () => {
    const conversations = [
      { sessionId: "sess-a", firstPrompt: "会话A", lastTime: Date.now() },
      { sessionId: "sess-b", firstPrompt: "会话B", lastTime: Date.now() },
    ];
    const deps = createDeps({
      adapter: {
        chat: vi.fn(async function* () {}),
        listHistory: vi.fn(async () => ({ conversations, total: 2, hasMore: false })),
        getHistory: vi.fn(async () => null),
        closeSession: vi.fn(),
        closeAllSessions: vi.fn(),
      } as any,
    });
    const commands = new FeishuCommands(deps);
    await commands.processCardAction({ cmd: "/switch", arg: "2" }, ctx);
    expect(commands.getSession("oc_chat1")).toBe("sess-b");
    expect(broadcasts.join("\n")).toContain("已切换到会话");
  });

  it("/model 无参 + 通道支持卡片 → 回复带按钮的模型卡片", async () => {
    const channel = cardCapableChannel();
    const commands = new FeishuCommands(createDeps({ feishuChannel: channel }));
    await commands.processMessage("/model", undefined, undefined, "om_1", ctx);
    expect(cardReplies).toHaveLength(1);
    const buttons = extractButtons(cardReplies[0]);
    expect(buttons.some((b) => b.value.cmd === "/model" && b.value.arg === "opus")).toBe(true);
  });

  it("/model 无参 + 通道不支持卡片 → 回退纯文本", async () => {
    const commands = new FeishuCommands(createDeps());
    await commands.processMessage("/model", undefined, undefined, "om_1", ctx);
    expect(cardReplies).toHaveLength(0);
    expect(broadcasts.join("\n")).toContain("当前模型");
  });

  it("/agent 无参 + 通道支持卡片 → 回复带切换按钮的卡片", async () => {
    const channel = cardCapableChannel();
    const commands = new FeishuCommands(createDeps({ feishuChannel: channel }));
    await commands.processMessage("/agent", undefined, undefined, "om_1", ctx);
    expect(cardReplies).toHaveLength(1);
    // codex 已随 adapters/index.ts 出厂注册，claude 是当前 → 只有 codex 按钮
    const buttons = extractButtons(cardReplies[0]);
    expect(buttons.some((b) => b.value.cmd === "/agent" && b.value.arg === "codex")).toBe(true);
  });

  it("/sessions + 通道支持卡片 → 每条会话带 /switch 按钮", async () => {
    const conversations = [
      { sessionId: "sess-a", firstPrompt: "会话A", lastTime: Date.now() },
      { sessionId: "sess-b", firstPrompt: "会话B", lastTime: Date.now() },
    ];
    const channel = cardCapableChannel();
    const commands = new FeishuCommands(createDeps({
      feishuChannel: channel,
      adapter: {
        chat: vi.fn(async function* () {}),
        listHistory: vi.fn(async () => ({ conversations, total: 2, hasMore: false })),
        getHistory: vi.fn(async () => null),
        closeSession: vi.fn(),
        closeAllSessions: vi.fn(),
      } as any,
    }));
    await commands.processMessage("/sessions", undefined, undefined, "om_1", ctx);
    expect(cardReplies).toHaveLength(1);
    const buttons = extractButtons(cardReplies[0]);
    expect(buttons.map((b) => b.value)).toEqual([
      { cmd: "/switch", arg: "1" },
      { cmd: "/switch", arg: "2" },
    ]);
  });
});

describe("FeishuChannel.handleCardActionEvent", () => {
  function createChannel() {
    return new FeishuChannel({
      appId: "app-id",
      appSecret: "app-secret",
      connectionMode: "websocket",
      streamingCards: false,
    });
  }

  function cardEvent(overrides?: Record<string, unknown>) {
    return {
      operator: { open_id: "ou_clicker" },
      context: { open_chat_id: "oc_chat1", open_message_id: "om_card" },
      action: { tag: "button", value: { cmd: "/model", arg: "opus" } },
      ...overrides,
    };
  }

  /** 回调是 fire-and-forget，flush 微任务队列后再断言 */
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("普通群：scope = chatId，回调收到 value + ctx，返回 toast", async () => {
    const channel = createChannel();
    (channel as any).chatModes.set("oc_chat1", "group");
    const cb = vi.fn();
    channel.onCardAction(cb);

    const resp = await channel.handleCardActionEvent(cardEvent());
    await flush();

    expect(cb).toHaveBeenCalledTimes(1);
    const [value, ctx] = cb.mock.calls[0];
    expect(value).toEqual({ cmd: "/model", arg: "opus" });
    expect(ctx.scope).toBe("oc_chat1");
    expect(ctx.chatId).toBe("oc_chat1");
    expect(ctx.messageId).toBe("om_card");
    expect(ctx.senderId).toBe("ou_clicker");
    expect(resp).toHaveProperty("toast");
  });

  it("话题群：反查 thread_id，scope = chatId:threadId", async () => {
    const channel = createChannel();
    (channel as any).chatModes.set("oc_chat1", "topic");
    (channel as any).lookupMessageThreadId = vi.fn(async () => "omt_thread9");
    const cb = vi.fn();
    channel.onCardAction(cb);

    await channel.handleCardActionEvent(cardEvent());
    await flush();

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][1].scope).toBe("oc_chat1:omt_thread9");
    expect(cb.mock.calls[0][1].threadId).toBe("omt_thread9");
  });

  it("话题群反查失败：回退 chatId scope，点击不静默失败", async () => {
    const channel = createChannel();
    (channel as any).chatModes.set("oc_chat1", "topic");
    (channel as any).lookupMessageThreadId = vi.fn(async () => undefined);
    const cb = vi.fn();
    channel.onCardAction(cb);

    await channel.handleCardActionEvent(cardEvent());
    await flush();

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][1].scope).toBe("oc_chat1");
  });

  it("无 value / 未注册回调 → 返回空对象且不抛错", async () => {
    const channel = createChannel();
    (channel as any).chatModes.set("oc_chat1", "group");

    // 未注册回调
    expect(await channel.handleCardActionEvent(cardEvent())).toEqual({});

    // 注册了回调但事件无 value
    const cb = vi.fn();
    channel.onCardAction(cb);
    expect(await channel.handleCardActionEvent(cardEvent({ action: { tag: "button" } }))).toEqual({});
    await flush();
    expect(cb).not.toHaveBeenCalled();
  });

  it("回调抛错不影响事件响应（错误被捕获，不冒泡到 WS 层）", async () => {
    const channel = createChannel();
    (channel as any).chatModes.set("oc_chat1", "group");
    channel.onCardAction(() => { throw new Error("boom"); });

    const resp = await channel.handleCardActionEvent(cardEvent());
    await flush();
    expect(resp).toHaveProperty("toast");
  });
});
