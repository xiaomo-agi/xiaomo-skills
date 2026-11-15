/**
 * 处理锁生命周期回归测试（2026-07-06 /stop 失灵修复）
 *
 * 旧实现：处理锁在固定 2 分钟后被 setTimeout 强制删除，从不因任务活跃刷新。
 * 后果：长任务（>2 分钟）期间 /stop 报"当前没有正在处理的任务"、/status 谎报
 * 空闲、同 scope 新消息挤进来并发跑同一 session、finally 无条件 delete 还会
 * 误删新回合的锁（守卫级联失效）。
 *
 * 修复后语义：
 * - 兜底解锁改为"空闲判定"——连续 20 分钟无任何流事件才认为回合已死；
 * - 每个流事件（含心跳）都刷新兜底计时器，任务活着锁就不超时；
 * - finally 与兜底解锁都只释放自己创建的锁条目，不误删新回合的锁。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FeishuCommands, type FeishuCommandsDeps } from "../src/channels/feishu-commands.js";
import type { FeishuMessageContext } from "../src/channels/feishu.js";

const SESSION_ID = "sess-lock-life-1";
const SCOPE = "oc_lock_chat";

const ctx: FeishuMessageContext = {
  scope: SCOPE,
  chatId: SCOPE,
  chatType: "group",
  messageId: "om_lock_msg",
};

describe("处理锁生命周期（长任务不失锁）", () => {
  let broadcasts: string[];
  let interruptSession: ReturnType<typeof vi.fn>;
  /** 每次 chat() 调用挂起一个 gate，测试端逐个放行来控制回合何时结束 */
  let turnGates: Array<() => void>;
  /** chat() 在首个 system 事件后、等 gate 前额外产出的事件队列（模拟心跳等） */
  let extraEvents: Array<{ delayMs: number; event: Record<string, unknown> }>;

  function createDeps(): FeishuCommandsDeps {
    const events = extraEvents;
    const gates = turnGates;
    return {
      adapter: {
        chat: vi.fn(async function* () {
          yield { type: "system", session_id: SESSION_ID };
          for (const { delayMs, event } of events) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            yield event;
          }
          await new Promise<void>((resolve) => gates.push(resolve));
        }),
        listHistory: vi.fn(async () => ({ conversations: [], total: 0, hasMore: false })),
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
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    broadcasts = [];
    turnGates = [];
    extraEvents = [];
    interruptSession = vi.fn(async () => true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("回合跑 10 分钟后 /stop 仍能找到任务并打断（旧实现 2 分钟就丢锁）", async () => {
    const commands = new FeishuCommands(createDeps());

    const turn = commands.processMessage("跑个长任务", undefined, undefined, "om_1", ctx);
    await vi.advanceTimersByTimeAsync(0); // 让回合启动、system 事件绑定会话
    expect((commands as any).processingScopes.has(SCOPE)).toBe(true);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // 旧实现此刻锁已被 2 分钟定时器删除，/stop 会直接回"没有正在处理的任务"
    expect((commands as any).processingScopes.has(SCOPE)).toBe(true);

    await commands.processMessage("/stop", undefined, undefined, "om_2", ctx);
    expect(interruptSession).toHaveBeenCalledWith(SESSION_ID);
    expect(broadcasts.join("\n")).toContain("已发送终止指令");
    expect(broadcasts.join("\n")).not.toContain("没有正在处理的任务");

    turnGates[0]();
    await turn;
    expect((commands as any).processingScopes.has(SCOPE)).toBe(false);
  });

  it("流事件持续到达时，总时长超过空闲阈值也不解锁（心跳刷新计时器）", async () => {
    // 每 10 分钟来一个心跳，共 3 个 → 总时长 30 分钟 > 20 分钟空闲阈值
    extraEvents = [
      { delayMs: 10 * 60_000, event: { type: "heartbeat" } },
      { delayMs: 10 * 60_000, event: { type: "heartbeat" } },
      { delayMs: 10 * 60_000, event: { type: "heartbeat" } },
    ];
    const commands = new FeishuCommands(createDeps());

    const turn = commands.processMessage("超长任务", undefined, undefined, "om_1", ctx);
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1000);

    expect((commands as any).processingScopes.has(SCOPE)).toBe(true);
    await commands.processMessage("/stop", undefined, undefined, "om_2", ctx);
    expect(interruptSession).toHaveBeenCalledWith(SESSION_ID);

    turnGates[0]();
    await turn;
  });

  it("流真正挂死（连续 20 分钟无事件）→ 兜底解锁仍然生效", async () => {
    const commands = new FeishuCommands(createDeps());

    const turn = commands.processMessage("会挂死的任务", undefined, undefined, "om_1", ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect((commands as any).processingScopes.has(SCOPE)).toBe(true);

    await vi.advanceTimersByTimeAsync(20 * 60_000 + 1000);
    expect((commands as any).processingScopes.has(SCOPE)).toBe(false);

    // 兜底解锁后 /stop 如实报告无任务
    await commands.processMessage("/stop", undefined, undefined, "om_2", ctx);
    expect(interruptSession).not.toHaveBeenCalled();
    expect(broadcasts.join("\n")).toContain("没有正在处理的任务");

    turnGates[0]();
    await turn;
  });

  it("finally 只释放自己创建的锁，不误删新回合的锁", async () => {
    const commands = new FeishuCommands(createDeps());
    const scopes = (commands as any).processingScopes as Map<string, unknown>;

    const turnA = commands.processMessage("任务A", undefined, undefined, "om_a", ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(turnGates).toHaveLength(1);

    // 模拟锁被外力清掉（旧实现的 2 分钟强制解锁就是这种场景）后新回合上锁
    scopes.delete(SCOPE);
    const turnB = commands.processMessage("任务B", undefined, undefined, "om_b", ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(turnGates).toHaveLength(2);
    const entryB = scopes.get(SCOPE);
    expect(entryB).toBeTruthy();

    // 回合 A 结束：旧实现的 finally 会把 B 的锁一起删掉
    turnGates[0]();
    await turnA;
    expect(scopes.get(SCOPE)).toBe(entryB);

    turnGates[1]();
    await turnB;
    expect(scopes.has(SCOPE)).toBe(false);
  });

  it("兜底解锁触发时锁已易主 → 不动新回合的锁", async () => {
    const commands = new FeishuCommands(createDeps());
    const scopes = (commands as any).processingScopes as Map<string, unknown>;

    const turnA = commands.processMessage("任务A", undefined, undefined, "om_a", ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(scopes.has(SCOPE)).toBe(true);

    // 锁易主：A 的条目被移除，新回合 B 上锁（A 的兜底计时器还挂着）
    scopes.delete(SCOPE);
    const turnB = commands.processMessage("任务B", undefined, undefined, "om_b", ctx);
    await vi.advanceTimersByTimeAsync(0);
    const entryB = scopes.get(SCOPE);
    expect(entryB).toBeTruthy();

    // 5 分钟后刷新一次 B 的计时器，让 A（20 分）和 B（25 分）的到期点错开；
    // 推进到 21 分钟：A 的旧计时器已触发，但锁已易主，不该动 B 的锁
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    (commands as any).touchProcessing(SCOPE);
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    expect(scopes.get(SCOPE)).toBe(entryB);

    turnGates[0]();
    turnGates[1]();
    await turnA;
    await turnB;
  });

  it("锁占用期间到达的图片消息：不拒绝、暂存，回合结束后自动续跑（丢图修复）", async () => {
    const deps = createDeps();
    const commands = new FeishuCommands(deps);
    const img = (n: string) => ({ data: `b64_${n}`, mediaType: "image/png" });

    const turn1 = commands.processMessage("识别第一张", [img("1")], undefined, "om_1", ctx);
    await vi.advanceTimersByTimeAsync(0); // 回合1 启动、锁占上
    expect(turnGates).toHaveLength(1);

    // 锁占用时又来一批图（2026-10-09 实测丢图场景）
    await commands.processMessage("", [img("2"), img("3")], undefined, "om_2", ctx);

    // 不回「请稍等」拒绝卡，图进了暂存队列
    expect(broadcasts.join("\n")).not.toContain("请稍等");
    const deferred = (commands as any).deferredMediaByScope.get(SCOPE);
    expect(deferred.images).toHaveLength(2);

    // 回合1 结束 → finally 解锁 → 自动续跑暂存图
    turnGates[0]();
    await turn1;
    await vi.advanceTimersByTimeAsync(0);
    expect(turnGates).toHaveLength(2); // 续跑的回合2 已启动

    const chatCalls = (deps.adapter.chat as any).mock.calls;
    expect(chatCalls).toHaveLength(2);
    expect(chatCalls[1][0].images).toHaveLength(2);
    expect(chatCalls[1][0].images[0].data).toBe("b64_2");

    // 收尾：回合2 结束后锁释放、暂存清空、不再链式续跑
    turnGates[1]();
    await vi.advanceTimersByTimeAsync(100);
    expect((commands as any).processingScopes.has(SCOPE)).toBe(false);
    expect((commands as any).deferredMediaByScope.size).toBe(0);
  });

  it("锁占用期间的多批图累积暂存：文字合并、图全量，一次续跑", async () => {
    const deps = createDeps();
    const commands = new FeishuCommands(deps);
    const img = (n: string) => ({ data: `b64_${n}`, mediaType: "image/png" });

    const turn1 = commands.processMessage("跑任务", undefined, undefined, "om_1", ctx);
    await vi.advanceTimersByTimeAsync(0);

    await commands.processMessage("", [img("2")], undefined, "om_2", ctx);
    await commands.processMessage("这批也要识别", [img("3"), img("4")], undefined, "om_3", ctx);

    turnGates[0]();
    await turn1;
    await vi.advanceTimersByTimeAsync(0);

    const chatCalls = (deps.adapter.chat as any).mock.calls;
    expect(chatCalls).toHaveLength(2);
    expect(chatCalls[1][0].images).toHaveLength(3);
    expect(chatCalls[1][0].message).toContain("这批也要识别");

    turnGates[1]();
    await vi.advanceTimersByTimeAsync(100);
  });

  it("锁占用期间纯文字消息仍走拒绝提示，不进暂存", async () => {
    const commands = new FeishuCommands(createDeps());

    const turn1 = commands.processMessage("跑任务", undefined, undefined, "om_1", ctx);
    await vi.advanceTimersByTimeAsync(0);

    await commands.processMessage("在吗？", undefined, undefined, "om_2", ctx);
    expect(broadcasts.join("\n")).toContain("请稍等");
    expect((commands as any).deferredMediaByScope.size).toBe(0);

    turnGates[0]();
    await turn1;
    await vi.advanceTimersByTimeAsync(100);
    // 无暂存 → 不续跑，chat 只被调了 1 次
    //（broadcasts 里也没有续跑日志，锁已释放）
    expect((commands as any).processingScopes.has(SCOPE)).toBe(false);
  });

  it("暂存媒体超上限（20）→ 拒绝新增并提示，保留已暂存", async () => {
    const deps = createDeps();
    const commands = new FeishuCommands(deps);
    const img = (n: string) => ({ data: `b64_${n}`, mediaType: "image/png" });

    const turn1 = commands.processMessage("跑任务", undefined, undefined, "om_1", ctx);
    await vi.advanceTimersByTimeAsync(0);

    // 先暂存 18 张，再试图一次塞 3 张 → 超限拒绝
    await commands.processMessage("", Array.from({ length: 18 }, (_, i) => img(`a${i}`)), undefined, "om_2", ctx);
    await commands.processMessage("", [img("x"), img("y"), img("z")], undefined, "om_3", ctx);

    const deferred = (commands as any).deferredMediaByScope.get(SCOPE);
    expect(deferred.images).toHaveLength(18); // 新增 3 张没进来
    expect(broadcasts.join("\n")).toContain("上限");

    turnGates[0]();
    await turn1;
    await vi.advanceTimersByTimeAsync(0);
    const chatCalls = (deps.adapter.chat as any).mock.calls;
    expect(chatCalls[1][0].images).toHaveLength(18);

    turnGates[1]();
    await vi.advanceTimersByTimeAsync(100);
  });
});
