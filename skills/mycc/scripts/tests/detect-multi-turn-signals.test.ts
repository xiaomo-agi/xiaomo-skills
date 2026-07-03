/**
 * detectMultiTurnSignals 结构化解析回归测试（2026-07-02 代码核查新发现的【高】问题）
 *
 * bug：旧实现用 JSON.stringify(msg).includes('"name":"TeamCreate"') 之类的字符串搜索，
 * 正文文本里引用/讨论这些字符串（比如贴 Workflow 脚本、讨论 mycc 自己的代码）也会误触发，
 * 导致 SSE 多轮等待被错误开启或提前关闭。
 * 修复：只解析消息结构（tool_use block 的 name/input，system 消息的 subtype/status）。
 */
import { describe, it, expect } from "vitest";
import { detectMultiTurnSignals } from "../src/adapters/official.js";

function toolUseMsg(name: string, input: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name, input }] },
    uuid: "u1",
    session_id: "s1",
  };
}

describe("detectMultiTurnSignals", () => {
  it("tool_use TeamCreate → teamsStarted", () => {
    const r = detectMultiTurnSignals(toolUseMsg("TeamCreate"));
    expect(r.teamsStarted).toBe(true);
    expect(r.teamsFinished).toBe(false);
  });

  it("tool_use TeamDelete → teamsFinished", () => {
    const r = detectMultiTurnSignals(toolUseMsg("TeamDelete"));
    expect(r.teamsFinished).toBe(true);
  });

  it("tool_use Task + run_in_background:true → bgTaskLaunched", () => {
    const r = detectMultiTurnSignals(toolUseMsg("Task", { run_in_background: true }));
    expect(r.bgTaskLaunched).toBe(true);
  });

  it("tool_use Task 但 run_in_background 不是 true → 不触发", () => {
    const r = detectMultiTurnSignals(toolUseMsg("Task", { run_in_background: false }));
    expect(r.bgTaskLaunched).toBe(false);
  });

  it("system task_notification + completed → bgTaskCompleted", () => {
    const r = detectMultiTurnSignals({
      type: "system",
      subtype: "task_notification",
      status: "completed",
      task_id: "x",
      uuid: "u2",
      session_id: "s1",
    });
    expect(r.bgTaskCompleted).toBe(true);
  });

  it("system task_notification 但 status 是 failed → 不触发", () => {
    const r = detectMultiTurnSignals({
      type: "system",
      subtype: "task_notification",
      status: "failed",
      uuid: "u3",
      session_id: "s1",
    });
    expect(r.bgTaskCompleted).toBe(false);
  });

  it("正文文本讨论/引用这些字符串不应误触发（核心回归点）", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: '这段代码里有 "name":"TeamCreate" 和 "run_in_background":true，还提到了 task-notification 和 completed 状态',
          },
        ],
      },
      uuid: "u4",
      session_id: "s1",
    };
    const r = detectMultiTurnSignals(msg);
    expect(r).toEqual({
      teamsStarted: false,
      teamsFinished: false,
      bgTaskLaunched: false,
      bgTaskCompleted: false,
    });
  });

  it("非对象 / 无关消息类型 → 全 false", () => {
    expect(detectMultiTurnSignals(null)).toEqual({
      teamsStarted: false,
      teamsFinished: false,
      bgTaskLaunched: false,
      bgTaskCompleted: false,
    });
    expect(detectMultiTurnSignals({ type: "result" })).toEqual({
      teamsStarted: false,
      teamsFinished: false,
      bgTaskLaunched: false,
      bgTaskCompleted: false,
    });
  });
});
