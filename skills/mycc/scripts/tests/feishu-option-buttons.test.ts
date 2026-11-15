/**
 * agent 主动出选择题测试（Phase 5 步骤 2）
 *
 * 覆盖：
 * - detectTrailingOptions 保守启发式：正例（编号/字母/带 markdown）+ 反例（步骤清单/
 *   正文列表/超长/超数量/序号不连续）——误报会把普通回复变成选择题，必须严防
 * - extractAskUserQuestionOptions：AskUserQuestion tool_use input 结构化解析
 * - OptionCallbackAuth 验票全失败路径：篡改/过期/scope 不符/他人点击/会话已切换/重放
 * - FeishuCommands 端到端：回复带选项 → 出选项卡片；点击 → 选项文本转回会话；
 *   重复点击/伪造 token 的拒绝提示
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import {
  detectTrailingOptions,
  extractAskUserQuestionOptions,
  extractOptionCallbackToken,
  newOptionGroupId,
  OptionCallbackAuth,
  OPTION_CALLBACK_TTL_MS,
} from "../src/channels/option-buttons.js";
import { optionPickerCard } from "../src/channels/card-actions.js";
import { FeishuCommands, type FeishuCommandsDeps } from "../src/channels/feishu-commands.js";
import type { FeishuMessageContext } from "../src/channels/feishu.js";

const DATA_DIR = process.env.MYCC_DATA_DIR || path.resolve(import.meta.dirname, "../src/data");

function cleanPersistedState() {
  for (const f of ["channel-sessions.json", "channel-models.json", "channel-agents.json"]) {
    try { fs.rmSync(path.join(DATA_DIR, f)); } catch { /* absent */ }
  }
}

describe("detectTrailingOptions", () => {
  it("问号引导 + 编号选项 → 命中", () => {
    const r = detectTrailingOptions("分析完了。接下来怎么处理？\n1. 直接合并\n2. 先跑测试\n3. 放弃");
    expect(r).not.toBeNull();
    expect(r!.question).toBe("分析完了。接下来怎么处理？");
    expect(r!.options).toEqual(["直接合并", "先跑测试", "放弃"]);
  });

  it("'还是'措辞（无问号）+ 字母选项 → 命中", () => {
    const r = detectTrailingOptions("看你想走哪条路，A 还是 B\nA. 继续重构\nB) 先修 bug");
    expect(r).not.toBeNull();
    expect(r!.options).toEqual(["继续重构", "先修 bug"]);
  });

  it("选项带 markdown 加粗/行内代码 → 剥掉格式符", () => {
    const r = detectTrailingOptions("用哪个方案？\n\n1. **方案A** — 快\n2. `方案B` — 稳");
    expect(r).not.toBeNull();
    expect(r!.options).toEqual(["方案A — 快", "方案B — 稳"]);
  });

  it("问题和选项之间隔空行 → 命中", () => {
    const r = detectTrailingOptions("要不要我继续？\n\n1. 继续\n2. 停下");
    expect(r).not.toBeNull();
    expect(r!.question).toContain("要不要");
  });

  it("步骤清单（无问句引导）→ 不误报", () => {
    expect(detectTrailingOptions("接下来我会：\n1. 建分支\n2. 写代码\n3. 提交 PR")).toBeNull();
  });

  it("陈述句里的'是否'不算问句引导 → 不误报", () => {
    expect(detectTrailingOptions("先检查是否安装依赖，然后执行：\n1. 建分支\n2. 写代码")).toBeNull();
  });

  it("编号列表后面还有正文（列表不在尾部）→ 不误报", () => {
    expect(detectTrailingOptions("选哪个？\n1. 甲\n2. 乙\n\n我个人建议选甲，因为更稳妥。")).toBeNull();
  });

  it("只有 1 个选项 / 超过 6 个选项 → 不误报", () => {
    expect(detectTrailingOptions("选哪个？\n1. 唯一选项")).toBeNull();
    const seven = Array.from({ length: 7 }, (_, i) => `${i + 1}. 选项${i + 1}`).join("\n");
    expect(detectTrailingOptions(`选哪个？\n${seven}`)).toBeNull();
  });

  it("单项超过 60 字（更像段落列表）→ 不误报", () => {
    const long = "这个选项特别长".repeat(10);
    expect(detectTrailingOptions(`选哪个？\n1. ${long}\n2. 短的`)).toBeNull();
  });

  it("序号不从 1 开始（正文里截到半截列表）→ 不误报", () => {
    expect(detectTrailingOptions("选哪个？\n3. 丙\n4. 丁")).toBeNull();
  });

  it("空文本 / 纯正文 → null", () => {
    expect(detectTrailingOptions("")).toBeNull();
    expect(detectTrailingOptions("今天天气不错。")).toBeNull();
  });
});

describe("extractAskUserQuestionOptions", () => {
  it("标准 input：取第一个 question 的 options label", () => {
    const r = extractAskUserQuestionOptions({
      questions: [
        { question: "用哪种部署方式？", options: [{ label: "Docker" }, { label: "裸机" }] },
        { question: "第二题不取", options: [{ label: "X" }, { label: "Y" }] },
      ],
    });
    expect(r).toEqual({ question: "用哪种部署方式？", options: ["Docker", "裸机"] });
  });

  it("options 是字符串数组也接受", () => {
    const r = extractAskUserQuestionOptions({ questions: [{ question: "选？", options: ["a", "b"] }] });
    expect(r!.options).toEqual(["a", "b"]);
  });

  it("畸形 input → null", () => {
    expect(extractAskUserQuestionOptions(null)).toBeNull();
    expect(extractAskUserQuestionOptions({})).toBeNull();
    expect(extractAskUserQuestionOptions({ questions: [] })).toBeNull();
    expect(extractAskUserQuestionOptions({ questions: [{ question: "q", options: [{ label: "只有一个" }] }] })).toBeNull();
  });
});

describe("OptionCallbackAuth", () => {
  let now: number;
  const clock = () => now;
  const input = (over?: Partial<Parameters<OptionCallbackAuth["sign"]>[0]>) => ({
    scope: "oc_chat1",
    senderId: "ou_alice",
    sessionId: "sess-1",
    option: "直接合并",
    groupId: "g1",
    ...over,
  });
  const expected = { scope: "oc_chat1", operatorId: "ou_alice", sessionId: "sess-1" };

  beforeEach(() => { now = 1_000_000; });

  it("正常签发 → 验票通过并返回选项文本", () => {
    const auth = new OptionCallbackAuth({ now: clock });
    const r = auth.verify(auth.sign(input()), expected);
    expect(r).toEqual({ ok: true, option: "直接合并" });
  });

  it("篡改载荷（换选项文本）→ bad-signature", () => {
    const auth = new OptionCallbackAuth({ now: clock });
    const token = auth.sign(input());
    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[2], "base64url").toString("utf8"));
    payload.o = "帮我删库";
    parts[2] = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const r = auth.verify(parts.join("."), expected);
    expect(r).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("别的进程/重启后的 secret 签的 token → bad-signature", () => {
    const authA = new OptionCallbackAuth({ now: clock });
    const authB = new OptionCallbackAuth({ now: clock });
    const r = authB.verify(authA.sign(input()), expected);
    expect(r).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("过了 TTL → expired", () => {
    const auth = new OptionCallbackAuth({ now: clock });
    const token = auth.sign(input());
    now += OPTION_CALLBACK_TTL_MS + 1;
    expect(auth.verify(token, expected)).toEqual({ ok: false, reason: "expired" });
  });

  it("scope 不符（卡片被转发到别的群）→ scope-mismatch", () => {
    const auth = new OptionCallbackAuth({ now: clock });
    const r = auth.verify(auth.sign(input()), { ...expected, scope: "oc_chat2" });
    expect(r).toEqual({ ok: false, reason: "scope-mismatch" });
  });

  it("他人点击 → operator-mismatch；出题时未绑定提问者（senderId 空）→ 放行", () => {
    const auth = new OptionCallbackAuth({ now: clock });
    const r = auth.verify(auth.sign(input()), { ...expected, operatorId: "ou_bob" });
    expect(r).toEqual({ ok: false, reason: "operator-mismatch" });
    const open = auth.verify(auth.sign(input({ senderId: "", groupId: "g2" })), { ...expected, operatorId: "ou_bob" });
    expect(open.ok).toBe(true);
  });

  it("出题后会话已切换 → session-changed", () => {
    const auth = new OptionCallbackAuth({ now: clock });
    const r = auth.verify(auth.sign(input()), { ...expected, sessionId: "sess-2" });
    expect(r).toEqual({ ok: false, reason: "session-changed" });
  });

  it("同一张卡答过一次 → 再点任何按钮都是 already-answered", () => {
    const auth = new OptionCallbackAuth({ now: clock });
    const tokenA = auth.sign(input({ option: "选项甲" }));
    const tokenB = auth.sign(input({ option: "选项乙" }));
    expect(auth.verify(tokenA, expected).ok).toBe(true);
    expect(auth.verify(tokenB, expected)).toEqual({ ok: false, reason: "already-answered" });
    expect(auth.verify(tokenA, expected)).toEqual({ ok: false, reason: "already-answered" });
  });

  it("不同卡片组互不影响", () => {
    const auth = new OptionCallbackAuth({ now: clock });
    expect(auth.verify(auth.sign(input({ groupId: "g1" })), expected).ok).toBe(true);
    expect(auth.verify(auth.sign(input({ groupId: "g2" })), expected).ok).toBe(true);
  });

  it("垃圾 token → malformed", () => {
    const auth = new OptionCallbackAuth({ now: clock });
    expect(auth.verify("mycc_cb.v1.!!!", expected)).toEqual({ ok: false, reason: "malformed" });
    expect(auth.verify("别的东西", expected)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("optionPickerCard", () => {
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

describe("FeishuCommands 选项按钮端到端", () => {
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

  function extractButtons(card: Record<string, unknown>): any[] {
    const els = (card as any).body?.elements ?? (card as any).elements ?? [];
    return els
      .filter((e: any) => e.tag === "interactive_container" && Array.isArray(e.behaviors))
      .map((e: any) => ({
        text: {
          content: String(e.elements?.[0]?.content ?? "")
            .replace(/<[^>]+>/g, "")
            .replace(/\*\*/g, ""),
        },
        value: e.behaviors[0].value,
      }));
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

  it("回复尾部带选择题 → 追发选项卡片；点击 → 选项文本转回当前会话", async () => {
    const deps = createDeps("我看完了。接下来怎么处理？\n1. 直接合并\n2. 先跑测试");
    const commands = new FeishuCommands(deps);
    await commands.processMessage("看下这个 PR", undefined, undefined, "om_msg1", ctx);

    expect(cardReplies).toHaveLength(1);
    const buttons = extractButtons(cardReplies[0]);
    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => b.text.content)).toEqual(["A · 直接合并", "B · 先跑测试"]);

    // 点击第 2 个按钮：选项文本被当成用户消息转回会话
    await commands.processCardAction(buttons[1].value, ctx);
    const chatCalls = (deps.adapter.chat as any).mock.calls;
    expect(chatCalls).toHaveLength(2);
    expect(chatCalls[1][0].message).toBe("先跑测试");
    expect(chatCalls[1][0].sessionId).toBe("sess-1");
  });

  it("同一张卡点第二次 → 提示已答过，不再触发会话", async () => {
    const deps = createDeps("选哪个？\n1. 甲\n2. 乙");
    const commands = new FeishuCommands(deps);
    await commands.processMessage("问个事", undefined, undefined, "om_msg1", ctx);
    const buttons = extractButtons(cardReplies[0]);

    await commands.processCardAction(buttons[0].value, ctx);
    expect((deps.adapter.chat as any).mock.calls).toHaveLength(2);
    await commands.processCardAction(buttons[1].value, ctx);
    expect((deps.adapter.chat as any).mock.calls).toHaveLength(2);
    expect(broadcasts.join("\n")).toContain("已经答过了");
  });

  it("别人点提问者的题 → 拒绝", async () => {
    const deps = createDeps("选哪个？\n1. 甲\n2. 乙");
    const commands = new FeishuCommands(deps);
    await commands.processMessage("问个事", undefined, undefined, "om_msg1", ctx);
    const buttons = extractButtons(cardReplies[0]);

    await commands.processCardAction(buttons[0].value, { ...ctx, senderId: "ou_bob" });
    expect((deps.adapter.chat as any).mock.calls).toHaveLength(1);
    expect(broadcasts.join("\n")).toContain("提问者本人");
  });

  it("伪造 {cb} token → 拒绝且不触发会话", async () => {
    const deps = createDeps("普通回复，没有选择题。");
    const commands = new FeishuCommands(deps);
    await commands.processCardAction({ cb: "mycc_cb.v1.fake.fake" }, ctx);
    expect((deps.adapter.chat as any).mock.calls).toHaveLength(0);
    expect(broadcasts.join("\n")).toContain("失效");
  });

  it("回复没有选择题 → 不出卡片", async () => {
    const deps = createDeps("普通回复。\n1. 这是清单\n2. 不是选择题");
    const commands = new FeishuCommands(deps);
    await commands.processMessage("随便聊", undefined, undefined, "om_msg1", ctx);
    expect(cardReplies).toHaveLength(0);
  });

  it("AskUserQuestion 工具事件 → 结构化选项优先出卡", async () => {
    const deps = createDeps("");
    (deps.adapter.chat as any) = vi.fn(async function* () {
      yield { type: "system", session_id: "sess-1" };
      yield {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "AskUserQuestion",
              input: { questions: [{ question: "部署到哪？", options: [{ label: "测试机" }, { label: "生产机" }] }] },
            },
          ],
        },
      };
    });
    const commands = new FeishuCommands(deps);
    await commands.processMessage("部署一下", undefined, undefined, "om_msg1", ctx);
    expect(cardReplies).toHaveLength(1);
    const buttons = extractButtons(cardReplies[0]);
    expect(buttons.map((b) => b.text.content)).toEqual(["A · 测试机", "B · 生产机"]);
    expect(JSON.stringify(cardReplies[0])).toContain("部署到哪");
  });
});

describe("extractOptionCallbackToken", () => {
  it("{cb: token} → token；命令 value / 垃圾 → null", () => {
    expect(extractOptionCallbackToken({ cb: "tok" })).toBe("tok");
    expect(extractOptionCallbackToken({ cmd: "/model" })).toBeNull();
    expect(extractOptionCallbackToken({ cb: "" })).toBeNull();
    expect(extractOptionCallbackToken(null)).toBeNull();
    expect(extractOptionCallbackToken("cb")).toBeNull();
  });

  it("newOptionGroupId 每次不同", () => {
    expect(newOptionGroupId()).not.toBe(newOptionGroupId());
  });
});
