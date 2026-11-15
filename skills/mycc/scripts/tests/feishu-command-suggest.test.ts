/**
 * 命令菜单 + 语境快捷按钮测试（Phase 5 步骤 3）
 *
 * 覆盖：
 * - detectSuggestedCommands 保守启发式：只认白名单、排除路径/标识符、去重保序、超量跳过
 * - helpMenuCard / commandSuggestionCard：按钮 value 全部能过白名单校验，/clear 绝不出按钮
 * - 白名单新增命令（/skills /context /usage /compact 等）可解析，/clear 仍被拒
 * - FeishuCommands 端到端：回复提到命令 → 追发快捷卡片；选择题优先；/help 出菜单卡片
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import {
  detectSuggestedCommands,
  commandSuggestionCard,
  helpMenuCard,
  parseCardCommandValue,
} from "../src/channels/card-actions.js";
import { FeishuCommands, type FeishuCommandsDeps } from "../src/channels/feishu-commands.js";
import type { FeishuMessageContext } from "../src/channels/feishu.js";

const DATA_DIR = process.env.MYCC_DATA_DIR || path.resolve(import.meta.dirname, "../src/data");

function cleanPersistedState() {
  for (const f of ["channel-sessions.json", "channel-models.json", "channel-agents.json"]) {
    try { fs.rmSync(path.join(DATA_DIR, f)); } catch { /* absent */ }
  }
}

// 2026-10-31 容器按钮（形态5）：从 2.0 卡提取 interactive_container 按钮
function extractButtons(card: Record<string, unknown>): any[] {
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

describe("detectSuggestedCommands", () => {
  it("反引号包裹的命令也能检测（AI 常写成 `/model`）", () => {
    expect(detectSuggestedCommands("发 `/model` 可以切换模型")).toEqual(["/model"]);
  });

  it("大小写不敏感，统一转小写", () => {
    expect(detectSuggestedCommands("发 /Status 看看")).toEqual(["/status"]);
  });

  it("排除路径/标识符：src/status、/model/foo、/status.ts、/context-manager 都不算", () => {
    expect(detectSuggestedCommands("改一下 src/status 目录")).toBeNull();
    expect(detectSuggestedCommands("路由是 /model/foo 这个")).toBeNull();
    expect(detectSuggestedCommands("看 /status.ts 文件")).toBeNull();
    expect(detectSuggestedCommands("用 /context-manager 模块")).toBeNull();
    expect(detectSuggestedCommands("变量 a/model 引用")).toBeNull();
  });

  it("/agents 和 /agent 互不误配", () => {
    expect(detectSuggestedCommands("发 /agents 看在线小工")).toEqual(["/agents"]);
    expect(detectSuggestedCommands("发 /agent 切换供应商")).toEqual(["/agent"]);
  });

  it("白名单外的命令不建议（/clear /switch /rm-rf）", () => {
    expect(detectSuggestedCommands("发 /clear 清空，或 /switch 3 切换，别跑 /rm-rf")).toBeNull();
  });

  it("没提到命令 → null；空文本 → null", () => {
    expect(detectSuggestedCommands("今天天气不错")).toBeNull();
    expect(detectSuggestedCommands("")).toBeNull();
  });

  it("提到超过 4 个（像在罗列命令清单）→ null，不出噪音卡片", () => {
    expect(
      detectSuggestedCommands("命令有 /new /sessions /current /status /model 等等")
    ).toBeNull();
  });
});

describe("commandSuggestionCard / helpMenuCard", () => {
  it("commandSuggestionCard：每个命令一个按钮，value 全部能过白名单校验", () => {
    const card = commandSuggestionCard(["/context", "/compact"]);
    const buttons = extractButtons(card);
    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => b.text.content)).toEqual(["/context", "/compact"]);
    for (const b of buttons) {
      expect(parseCardCommandValue(b.value)).not.toBeNull();
    }
  });

  it("helpMenuCard：所有按钮都在白名单内，且没有 /clear 按钮", () => {
    const card = helpMenuCard();
    const buttons = extractButtons(card);
    expect(buttons.length).toBeGreaterThanOrEqual(10);
    for (const b of buttons) {
      expect(parseCardCommandValue(b.value)).not.toBeNull();
      expect(b.value.cmd).not.toBe("/clear");
    }
  });

  it("白名单：新增的 CC 原生/查询命令可解析，/clear 仍被拒", () => {
    for (const cmd of ["/skills", "/agents", "/device", "/context", "/usage", "/compact"]) {
      expect(parseCardCommandValue({ cmd })).toEqual({ cmd, arg: undefined });
    }
    expect(parseCardCommandValue({ cmd: "/clear" })).toBeNull();
  });
});

describe("FeishuCommands 快捷命令端到端", () => {
  let broadcasts: string[];
  let cardReplies: Array<Record<string, unknown>>;

  function createDeps(replyText: string): FeishuCommandsDeps {
    return {
      adapter: {
        chat: vi.fn(async function* () {
          yield { type: "system", session_id: "sess-1" };
          yield { type: "assistant", message: { content: [{ type: "text", text: replyText }] } };
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
      feishuChannel: {
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
      },
      loadConfig: vi.fn(() => null),
    };
  }

  const ctx: FeishuMessageContext = {
    scope: "oc_chat1",
    chatId: "oc_chat1",
    chatType: "group",
    messageId: "om_msg1",
    senderId: "ou_alice",
  };

  beforeEach(() => {
    broadcasts = [];
    cardReplies = [];
    cleanPersistedState();
  });

  it("回复提到命令 → 追发快捷命令卡片；点击 → 命令真的执行", async () => {
    const deps = createDeps("上下文还剩不少。想看细节可以发 /context，紧张时用 /compact 压缩。");
    const commands = new FeishuCommands(deps);
    await commands.processMessage("我们还有多少上下文", undefined, undefined, "om_msg1", ctx);

    expect(cardReplies).toHaveLength(1);
    const buttons = extractButtons(cardReplies[0]);
    expect(buttons.map((b) => b.value.cmd)).toEqual(["/context", "/compact"]);

    // 点击 /context：CC 原生命令透传给 Claude（作为消息进入会话）
    await commands.processCardAction(buttons[0].value, ctx);
    const chatCalls = (deps.adapter.chat as any).mock.calls;
    expect(chatCalls).toHaveLength(2);
    expect(chatCalls[1][0].message).toBe("/context");
  });

  it("回复同时是选择题 → 只出选项卡片，不出快捷命令卡片", async () => {
    const deps = createDeps("要不要压缩？可以发 /compact 处理。选一个：\n1. 现在压缩\n2. 先不动");
    const commands = new FeishuCommands(deps);
    await commands.processMessage("上下文咋样", undefined, undefined, "om_msg1", ctx);

    expect(cardReplies).toHaveLength(1);
    const buttons = extractButtons(cardReplies[0]);
    expect(buttons.map((b) => b.text.content)).toEqual(["A · 现在压缩", "B · 先不动"]);
  });

  it("回复没提命令 → 不追发卡片", async () => {
    const deps = createDeps("这段代码没问题，放心合并。");
    const commands = new FeishuCommands(deps);
    await commands.processMessage("看下代码", undefined, undefined, "om_msg1", ctx);
    expect(cardReplies).toHaveLength(0);
  });

  it("/help + 通道支持卡片 → 出命令菜单卡片", async () => {
    const deps = createDeps("");
    const commands = new FeishuCommands(deps);
    await commands.processMessage("/help", undefined, undefined, "om_msg1", ctx);
    expect(cardReplies).toHaveLength(1);
    expect(JSON.stringify(cardReplies[0])).toContain("命令菜单");
    const buttons = extractButtons(cardReplies[0]);
    expect(buttons.some((b) => b.value.cmd === "/sessions")).toBe(true);
  });

  it("/help + 通道不支持卡片 → 回退纯文本帮助", async () => {
    const deps = createDeps("");
    deps.feishuChannel = { clearTypingIndicator: vi.fn(async () => {}) };
    const commands = new FeishuCommands(deps);
    await commands.processMessage("/help", undefined, undefined, "om_msg1", ctx);
    expect(cardReplies).toHaveLength(0);
    expect(broadcasts.join("\n")).toContain("飞书命令帮助");
  });
});
