/**
 * Codex JSONL translator 测试
 *
 * 关键点：翻译输出必须是 feishu-streaming / web 通道能吃的 SSE 事件形状——
 * assistant 消息带 message.content blocks、system 事件带 session_id 等，
 * 与 OfficialAdapter（官方 SDK）的事件形状兼容。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { CodexJsonlTranslator } from "../src/adapters/codex.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CodexJsonlTranslator", () => {
  it("thread.started → system 事件（session_id = thread_id，feishu 靠它绑定会话）", () => {
    const t = new CodexJsonlTranslator();
    const events = t.translate({ type: "thread.started", thread_id: "thread-1" });
    expect(events).toEqual([
      { type: "system", subtype: "init", session_id: "thread-1", provider: "codex" },
    ]);
    expect(t.sessionId()).toBe("thread-1");
  });

  it("turn.started 无输出", () => {
    const t = new CodexJsonlTranslator();
    expect(t.translate({ type: "turn.started" })).toEqual([]);
  });

  it("item.started(command_execution) → assistant 消息内嵌 tool_use block", () => {
    const t = new CodexJsonlTranslator();
    t.translate({ type: "thread.started", thread_id: "thread-1" });
    const events = t.translate({
      type: "item.started",
      item: { id: "cmd-1", type: "command_execution", command: "pwd" },
    });
    expect(events).toEqual([
      {
        type: "assistant",
        session_id: "thread-1",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "cmd-1", name: "Bash", input: { command: "pwd" } }],
        },
      },
    ]);
  });

  it("item.completed(command_execution) → 顶层 tool_result（exit_code 非 0 记为 is_error）", () => {
    const t = new CodexJsonlTranslator();
    t.translate({ type: "thread.started", thread_id: "thread-1" });
    t.translate({ type: "item.started", item: { id: "cmd-1", type: "command_execution", command: "x" } });
    const ok = t.translate({
      type: "item.completed",
      item: { id: "cmd-1", type: "command_execution", output: "/repo\n", exit_code: 0 },
    });
    expect(ok).toEqual([
      {
        type: "tool_result",
        id: "cmd-1",
        name: "Bash",
        output: "/repo\n",
        is_error: false,
        session_id: "thread-1",
      },
    ]);
  });

  it("exit_code 缺失视为成功", () => {
    const t = new CodexJsonlTranslator();
    t.translate({ type: "item.started", item: { id: "c", type: "command_execution", command: "x" } });
    const events = t.translate({
      type: "item.completed",
      item: { id: "c", type: "command_execution", output: "done" },
    });
    expect((events[0] as { is_error: boolean }).is_error).toBe(false);
  });

  it("item.completed(agent_message) → assistant 文本 block，并累计 finalText", () => {
    const t = new CodexJsonlTranslator();
    const events = t.translate({
      type: "item.completed",
      item: { id: "m1", type: "agent_message", text: "你好" },
    });
    expect(events).toEqual([
      {
        type: "assistant",
        session_id: undefined,
        message: { role: "assistant", content: [{ type: "text", text: "你好" }] },
      },
    ]);
    expect(t.finalText()).toBe("你好");
  });

  it("旧版顶层 agent_message 事件同样翻译为 assistant 文本", () => {
    const t = new CodexJsonlTranslator();
    const events = t.translate({ type: "agent_message", message: "hello" });
    expect((events[0] as any).message.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("turn.completed → result（success，带 usage 与累计文本），此后事件被忽略", () => {
    const t = new CodexJsonlTranslator();
    t.translate({ type: "thread.started", thread_id: "thread-1" });
    t.translate({ type: "item.completed", item: { id: "m", type: "agent_message", text: "答案" } });
    const events = t.translate({
      type: "turn.completed",
      usage: { input_tokens: 12, output_tokens: 34, cached_input_tokens: 5 },
    });
    expect(events).toEqual([
      {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "thread-1",
        result: "答案",
        usage: { input_tokens: 12, output_tokens: 34, cached_input_tokens: 5 },
      },
    ]);
    expect(t.terminalEmitted()).toBe(true);
    // 终态后不再产出事件
    expect(t.translate({ type: "agent_message", message: "太迟了" })).toEqual([]);
  });

  it("resume 场景：构造时给 resumeSessionId，事件在 thread.started 前也带 session_id", () => {
    const t = new CodexJsonlTranslator({ resumeSessionId: "thread-old" });
    const events = t.translate({
      type: "item.completed",
      item: { id: "m", type: "agent_message", text: "继续" },
    });
    expect((events[0] as any).session_id).toBe("thread-old");
  });

  it("turn.failed → 记录 failureMessage、进入终态、不产出事件（由 chat() 抛错）", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = new CodexJsonlTranslator();
    const events = t.translate({ type: "turn.failed", error: { message: "command denied" } });
    expect(events).toEqual([]);
    expect(t.terminalEmitted()).toBe(true);
    expect(t.failureMessage()).toBe("command denied");
    expect(t.translate({ type: "agent_message", message: "太迟了" })).toEqual([]);
  });

  it("error 事件非终态：记录细节但流可继续", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = new CodexJsonlTranslator();
    expect(
      t.translate({ type: "error", error: { message: "Reconnecting... 2/5" } })
    ).toEqual([]);
    expect(t.terminalEmitted()).toBe(false);
    expect(t.lastErrorDetail()).toBe("Reconnecting... 2/5");
    // 之后正常事件照常翻译
    expect(t.translate({ type: "agent_message", message: "after retry" })).toHaveLength(1);
  });

  it("protocol drift：未知事件类型累计计数并告警，不崩", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = new CodexJsonlTranslator();
    expect(t.translate({ type: "unknown.future", value: 1 })).toEqual([]);
    expect(t.translate({ type: "another.new.event" })).toEqual([]);
    expect(t.protocolDrift().unknownEvents).toBe(2);
    expect(warn).toHaveBeenCalled();
  });

  it("protocol drift：结构异常（非对象/缺 id/未 started 的 completed）计入 anomalies", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = new CodexJsonlTranslator();
    t.translate("not-an-object");
    t.translate({ type: "thread.started" }); // 缺 thread_id
    t.translate({
      type: "item.completed",
      item: { id: "never-started", type: "command_execution", output: "x", exit_code: 1 },
    }); // completed 但没 started
    expect(t.protocolDrift().anomalies).toBe(3);
  });

  it("未知 item 类型（如 reasoning）静默忽略，不计 drift", () => {
    const t = new CodexJsonlTranslator();
    expect(
      t.translate({ type: "item.completed", item: { id: "r1", type: "reasoning", text: "思考" } })
    ).toEqual([]);
    expect(t.protocolDrift()).toEqual({ unknownEvents: 0, anomalies: 0 });
  });
});
