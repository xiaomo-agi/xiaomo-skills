/**
 * /model 驱逐保护回归测试（2026-07-06 审查问题 #4/C4）
 *
 * 旧实现：/model 切换时遍历所有 scope 的会话绑定，无差别 closeSession。
 * 后果：其他群/话题正在跑的回合被 session.close() 直接掐断（用户看到
 * "❌ 出错中断"），错误信息还会命中 isRecoverableSessionError 的宽松正则，
 * 触发整条消息重发（已执行一半的任务从头重跑，副作用重复）；绑到 codex 的
 * scope 也被无差别驱逐（杀活跃 codex 子进程），尽管 /model 对 codex 根本不生效。
 *
 * 修复后语义：
 * - codex scope 跳过不驱逐（/model 只对 claude 生效）
 * - 正在跑回合的 scope 延迟驱逐：标记后由该回合的 finally 在结束时驱逐重建，
 *   新模型从该 scope 的下一条消息起生效，任务不被打断
 * - 空闲 scope 行为不变：立即驱逐（已有测试覆盖，此处一并回归）
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FeishuCommands, type FeishuCommandsDeps } from "../src/channels/feishu-commands.js";
import type { FeishuMessageContext } from "../src/channels/feishu.js";

const BUSY_SESSION = "sess-busy-A";
const IDLE_SESSION = "sess-idle-B";
const CODEX_SESSION = "sess-codex-X";

const ctxA: FeishuMessageContext = { scope: "oc_busy_A", chatId: "oc_busy_A", chatType: "group", messageId: "om_a" };
const ctxC: FeishuMessageContext = { scope: "oc_cmd_C", chatId: "oc_cmd_C", chatType: "group", messageId: "om_c" };

describe("/model 驱逐保护", () => {
  let broadcasts: string[];
  let closeSession: ReturnType<typeof vi.fn>;
  let turnGates: Array<() => void>;

  function createDeps(): FeishuCommandsDeps {
    const gates = turnGates;
    return {
      adapter: {
        chat: vi.fn(async function* () {
          yield { type: "system", session_id: BUSY_SESSION };
          await new Promise<void>((resolve) => gates.push(resolve));
        }),
        listHistory: vi.fn(async () => ({ conversations: [], total: 0, hasMore: false })),
        getHistory: vi.fn(async () => null),
        interruptSession: vi.fn(async () => true),
        closeSession,
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
    turnGates = [];
    closeSession = vi.fn();
  });

  it("其他 scope 正在跑任务时 /model 不立即驱逐，回合结束后再驱逐", async () => {
    const commands = new FeishuCommands(createDeps());

    // scope A 跑长任务（回合挂起，锁保持）
    const turnA = commands.processMessage("跑个长任务", undefined, undefined, "om_1", ctxA);
    await new Promise((r) => setImmediate(r)); // 让回合启动、绑定会话、拿到锁
    expect(commands.getSession(ctxA.scope)).toBe(BUSY_SESSION);
    expect(turnGates).toHaveLength(1);

    // 另一个 scope 发 /model：A 的会话不能被立即驱逐（旧实现会掐断 A 的任务）
    await commands.processMessage("/model opus", undefined, undefined, "om_2", ctxC);
    expect(broadcasts.join("\n")).toContain("已切换模型: opus");
    expect(closeSession).not.toHaveBeenCalledWith(BUSY_SESSION);

    // A 的回合结束 → finally 延迟驱逐，新模型对 A 的下一条消息生效
    turnGates[0]();
    await turnA;
    expect(closeSession).toHaveBeenCalledWith(BUSY_SESSION);
  });

  it("空闲 scope 的会话仍然立即驱逐（原行为不变）", async () => {
    const commands = new FeishuCommands(createDeps());
    (commands as any).convSessions.set("oc_idle_B", IDLE_SESSION);

    await commands.processMessage("/model opus", undefined, undefined, "om_1", ctxC);
    expect(closeSession).toHaveBeenCalledWith(IDLE_SESSION);
  });

  it("codex scope 不驱逐（/model 对 codex 不生效，不该杀它的会话）", async () => {
    const commands = new FeishuCommands(createDeps());
    (commands as any).convSessions.set("oc_codex_X", CODEX_SESSION);
    (commands as any).agentProviders.set("oc_codex_X", "codex");

    await commands.processMessage("/model opus", undefined, undefined, "om_1", ctxC);
    expect(broadcasts.join("\n")).toContain("已切换模型: opus");
    expect(closeSession).not.toHaveBeenCalledWith(CODEX_SESSION);
  });
});
