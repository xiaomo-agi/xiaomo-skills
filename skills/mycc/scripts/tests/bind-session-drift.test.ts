/**
 * 会话绑定防劫持回归测试（2026-07-06 审查问题 #3/M1）
 *
 * 旧实现：streamChatToFeishu 对回合内每个带 session_id 的 system 事件都调
 * bindSession。Teams/subagent 回合中，子会话的 system 事件晚于主会话 init 到达，
 * 会把 scope 绑定改写成 subagent 的 sessionId 并持久化：
 * - /stop 拿劫持后的 id 调 interruptSession → 池里没有 → "没找到任务进程"
 * - 下一条消息 resume 的是 subagent 会话，上下文全错
 * - 错误绑定写进 channel-sessions.json，跨重启存活
 *
 * 修复后：会话绑定只认本回合首个 system 事件（与 adapter 层 extractSessionId
 * 的"首个生效"语义对齐）；跨回合仍可正常重绑（会话恢复/新会话场景不受影响）。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FeishuCommands, type FeishuCommandsDeps } from "../src/channels/feishu-commands.js";
import type { FeishuMessageContext } from "../src/channels/feishu.js";

const MAIN_SESSION = "sess-main-1";
const SUBAGENT_SESSION = "sess-subagent-1";
const SCOPE = "oc_drift_chat";

const ctx: FeishuMessageContext = {
  scope: SCOPE,
  chatId: SCOPE,
  chatType: "group",
  messageId: "om_drift_msg",
};

describe("会话绑定防 subagent 劫持", () => {
  let broadcasts: string[];
  /** 每次 chat() 调用产出的事件序列，测试按回合塞入 */
  let turnEvents: Array<Array<Record<string, unknown>>>;

  function createDeps(): FeishuCommandsDeps {
    const queues = turnEvents;
    return {
      adapter: {
        chat: vi.fn(async function* () {
          const events = queues.shift() ?? [];
          for (const event of events) {
            yield event;
          }
        }),
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
      feishuChannel: { clearTypingIndicator: vi.fn(async () => {}) },
      loadConfig: vi.fn(() => null),
    };
  }

  beforeEach(() => {
    broadcasts = [];
    turnEvents = [];
  });

  it("回合中 subagent 的 system 事件不改写绑定（旧实现会被劫持并持久化）", async () => {
    turnEvents = [[
      { type: "system", subtype: "init", session_id: MAIN_SESSION },
      { type: "text", text: "开始干活" },
      // Teams/后台 Task 期间子会话的 system 事件（带不同 session_id）
      { type: "system", subtype: "init", session_id: SUBAGENT_SESSION, parent_tool_use_id: "toolu_task_1" },
      { type: "text", text: "干完了" },
    ]];
    const commands = new FeishuCommands(createDeps());

    await commands.processMessage("跑个 Teams 任务", undefined, undefined, "om_1", ctx);
    expect(commands.getSession(SCOPE)).toBe(MAIN_SESSION);
  });

  it("跨回合重绑不受影响：下一回合首个 system 事件正常生效", async () => {
    const RECOVERED_SESSION = "sess-recovered-2";
    turnEvents = [
      [{ type: "system", session_id: MAIN_SESSION }],
      [{ type: "system", session_id: RECOVERED_SESSION }],
    ];
    const commands = new FeishuCommands(createDeps());

    await commands.processMessage("第一回合", undefined, undefined, "om_1", ctx);
    expect(commands.getSession(SCOPE)).toBe(MAIN_SESSION);

    await commands.processMessage("第二回合", undefined, undefined, "om_2", ctx);
    expect(commands.getSession(SCOPE)).toBe(RECOVERED_SESSION);
  });

  it("/new 回合同样只认首个 system 事件", async () => {
    turnEvents = [[
      { type: "system", session_id: MAIN_SESSION },
      { type: "system", session_id: SUBAGENT_SESSION, parent_tool_use_id: "toolu_task_2" },
      { type: "text", text: "新会话已就绪" },
    ]];
    const commands = new FeishuCommands(createDeps());

    await commands.processMessage("/new 测试会话", undefined, undefined, "om_1", ctx);
    expect(commands.getSession(SCOPE)).toBe(MAIN_SESSION);
    expect(broadcasts.join("\n")).toContain(MAIN_SESSION);
    expect(broadcasts.join("\n")).not.toContain(SUBAGENT_SESSION);
  });
});
