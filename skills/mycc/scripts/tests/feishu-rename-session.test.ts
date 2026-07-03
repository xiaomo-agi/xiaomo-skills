/**
 * 重命名会话（/rename + 输入卡片）测试
 *
 * 覆盖：
 * - 白名单放行 /rename（parseCardCommandValue）
 * - renameInputCard：卡片 2.0 表单结构（输入框 + form_submit 按钮带 callback value）
 * - helpMenuCard 会话组包含重命名按钮
 * - FeishuChannel.handleCardActionEvent：form_value 挂到 value.form 转发
 * - FeishuCommands：/rename 有参直接改（写入真实 .jsonl）、无参出输入卡/回退用法、
 *   无会话提示、codex 供应商拒绝、表单提交经 processCardAction 拼回命令
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseCardCommandValue,
  renameInputCard,
  helpMenuCard,
  RENAME_INPUT_NAME,
} from "../src/channels/card-actions.js";
import { FeishuCommands, type FeishuCommandsDeps } from "../src/channels/feishu-commands.js";
import { FeishuChannel, type FeishuMessageContext } from "../src/channels/feishu.js";
import { encodeProjectPath, getConversation } from "../src/history.js";

const DATA_DIR = process.env.MYCC_DATA_DIR || path.resolve(import.meta.dirname, "../src/data");

function cleanPersistedState() {
  for (const f of ["channel-sessions.json", "channel-models.json", "channel-agents.json"]) {
    try { fs.rmSync(path.join(DATA_DIR, f)); } catch { /* absent */ }
  }
}

// ==================== 卡片构建 ====================

describe("renameInputCard / 白名单", () => {
  it("parseCardCommandValue 放行 /rename", () => {
    expect(parseCardCommandValue({ cmd: "/rename" })).toEqual({ cmd: "/rename", arg: undefined });
    expect(parseCardCommandValue({ cmd: "/rename", arg: "新标题" })).toEqual({ cmd: "/rename", arg: "新标题" });
  });

  it("卡片 2.0 表单：输入框 name + form_submit 按钮带 callback value", () => {
    const card = renameInputCard() as any;
    expect(card.schema).toBe("2.0");
    const form = card.body.elements.find((e: any) => e.tag === "form");
    expect(form).toBeTruthy();
    const input = form.elements.find((e: any) => e.tag === "input");
    expect(input.name).toBe(RENAME_INPUT_NAME);
    const button = form.elements.find((e: any) => e.tag === "button");
    expect(button.form_action_type).toBe("submit");
    // 提交按钮的 callback value 必须过白名单，否则点击会被当成失效按钮
    const cbValue = button.behaviors[0].value;
    expect(parseCardCommandValue(cbValue)).toEqual({ cmd: "/rename", arg: undefined });
  });

  it("带当前标题时在文案里展示（markdown 特殊字符转义）", () => {
    const card = JSON.stringify(renameInputCard("旧*标题*"));
    expect(card).toContain("旧\\\\*标题\\\\*");
  });

  it("helpMenuCard 会话组包含 /rename 按钮", () => {
    const card = helpMenuCard() as any;
    const buttons = (card.elements as any[])
      .filter((e) => e.tag === "action")
      .flatMap((e) => e.actions);
    expect(buttons.some((b: any) => b.value.cmd === "/rename")).toBe(true);
  });
});

// ==================== 通道层：form_value 转发 ====================

describe("handleCardActionEvent 转发 form_value", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("表单提交：form_value 挂到 value.form", async () => {
    const channel = new FeishuChannel({
      appId: "app-id",
      appSecret: "app-secret",
      connectionMode: "websocket",
      streamingCards: false,
    });
    (channel as any).chatModes.set("oc_chat1", "group");
    const cb = vi.fn();
    channel.onCardAction(cb);

    await channel.handleCardActionEvent({
      operator: { open_id: "ou_clicker" },
      context: { open_chat_id: "oc_chat1", open_message_id: "om_card" },
      action: {
        tag: "button",
        value: { cmd: "/rename" },
        form_value: { [RENAME_INPUT_NAME]: "新标题" },
      },
    });
    await flush();

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toEqual({
      cmd: "/rename",
      form: { [RENAME_INPUT_NAME]: "新标题" },
    });
  });
});

// ==================== 命令层 ====================

describe("FeishuCommands /rename", () => {
  // renameSession 写 ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl，
  // 用临时 cwd 隔离出独立的历史目录
  const TEST_CWD = join(tmpdir(), `test-rename-${process.pid}`);
  const SESSION_ID = "sess-rename-1";
  const historyDir = join(process.env.HOME || tmpdir(), ".claude", "projects", encodeProjectPath(TEST_CWD));

  let broadcasts: string[];
  let cardReplies: Array<Record<string, unknown>>;

  const ctx: FeishuMessageContext = {
    scope: "oc_chat1",
    chatId: "oc_chat1",
    chatType: "group",
    messageId: "om_card_msg",
  };

  function createSessionFile() {
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(
      join(historyDir, `${SESSION_ID}.jsonl`),
      JSON.stringify({ type: "user", message: { content: "第一条消息" }, timestamp: "2026-07-03T00:00:00Z", uuid: "u1" }) + "\n",
      "utf-8"
    );
  }

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
        closeSession: vi.fn(),
        closeAllSessions: vi.fn(),
      } as any,
      channelManager: {
        broadcast: vi.fn(async (event: any) => {
          broadcasts.push(event?.message?.content?.[0]?.text ?? "");
        }),
      } as any,
      cwd: TEST_CWD,
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

  beforeEach(() => {
    broadcasts = [];
    cardReplies = [];
    cleanPersistedState();
    fs.rmSync(historyDir, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(historyDir, { recursive: true, force: true });
  });

  it("/rename <标题> → 追加 custom-title，getConversation 能读到新标题", async () => {
    createSessionFile();
    const commands = new FeishuCommands(createDeps());
    await bindSession(commands);

    await commands.processMessage("/rename 部署排查", undefined, undefined, "om_1", ctx);

    expect(broadcasts.join("\n")).toContain("已重命名为：部署排查");
    const conv = getConversation(TEST_CWD, SESSION_ID);
    expect(conv?.messages.some((m: any) => m.type === "custom-title" && m.customTitle === "部署排查")).toBe(true);
  });

  it("标题带空格时完整保留（args 重新 join）", async () => {
    createSessionFile();
    const commands = new FeishuCommands(createDeps());
    await bindSession(commands);

    await commands.processMessage("/rename 部署 排查 记录", undefined, undefined, "om_1", ctx);
    const conv = getConversation(TEST_CWD, SESSION_ID);
    expect(conv?.messages.some((m: any) => m.customTitle === "部署 排查 记录")).toBe(true);
  });

  it("会话文件不存在 → 明确报失败，不静默", async () => {
    // 不创建文件
    const commands = new FeishuCommands(createDeps());
    await bindSession(commands);

    await commands.processMessage("/rename 新标题", undefined, undefined, "om_1", ctx);
    expect(broadcasts.join("\n")).toContain("重命名失败");
  });

  it("无活跃会话 → 提示先创建", async () => {
    const commands = new FeishuCommands(createDeps());
    await commands.processMessage("/rename 新标题", undefined, undefined, "om_1", ctx);
    expect(broadcasts.join("\n")).toContain("没有活跃的会话");
  });

  it("codex 供应商 → 拒绝并说明", async () => {
    createSessionFile();
    const commands = new FeishuCommands(createDeps());
    await bindSession(commands);
    await commands.processMessage("/agent codex", undefined, undefined, "om_1", ctx);
    broadcasts.length = 0;

    await commands.processMessage("/rename 新标题", undefined, undefined, "om_1", ctx);
    expect(broadcasts.join("\n")).toContain("暂不支持重命名");
  });

  it("/rename 无参 + 通道支持卡片 → 发输入卡片（2.0 表单，文案含当前标题）", async () => {
    createSessionFile();
    const channel = cardCapableChannel();
    const commands = new FeishuCommands(createDeps({ feishuChannel: channel }));
    await bindSession(commands);

    await commands.processMessage("/rename", undefined, undefined, "om_1", ctx);
    expect(cardReplies).toHaveLength(1);
    const card = cardReplies[0] as any;
    expect(card.schema).toBe("2.0");
    expect(JSON.stringify(card)).toContain(RENAME_INPUT_NAME);
    expect(JSON.stringify(card)).toContain("第一条消息");
  });

  it("/rename 无参 + 通道不支持卡片 → 回退用法说明", async () => {
    createSessionFile();
    const commands = new FeishuCommands(createDeps());
    await bindSession(commands);

    await commands.processMessage("/rename", undefined, undefined, "om_1", ctx);
    expect(cardReplies).toHaveLength(0);
    expect(broadcasts.join("\n")).toContain("/rename <新标题>");
  });

  it("表单提交（value.form 带新标题）→ processCardAction 拼回 /rename <标题>", async () => {
    createSessionFile();
    const commands = new FeishuCommands(createDeps());
    await bindSession(commands);

    await commands.processCardAction(
      { cmd: "/rename", form: { [RENAME_INPUT_NAME]: "  表单标题  " } },
      ctx
    );
    expect(broadcasts.join("\n")).toContain("已重命名为：表单标题");
    const conv = getConversation(TEST_CWD, SESSION_ID);
    expect(conv?.messages.some((m: any) => m.customTitle === "表单标题")).toBe(true);
  });

  it("表单提交但输入为空 → 走无参路径（不误改标题）", async () => {
    createSessionFile();
    const commands = new FeishuCommands(createDeps());
    await bindSession(commands);

    await commands.processCardAction({ cmd: "/rename", form: { [RENAME_INPUT_NAME]: "   " } }, ctx);
    const conv = getConversation(TEST_CWD, SESSION_ID);
    expect(conv?.messages.some((m: any) => m.type === "custom-title")).toBe(false);
  });
});
