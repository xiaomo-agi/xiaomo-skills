/**
 * 心跳循环消息丢失回归测试（2026-07-02 代码核查新发现的【高】问题）
 *
 * bug：多轮等待的心跳循环每次超时后都重新调 streamGen.next()——上一次被
 * Promise.race 抛弃的 next() promise 仍挂在 async generator 的拉取队列里，
 * 下一条真实消息会被这个"没人听"的弃单消费掉，表现为后台任务已完成但
 * 飞书收不到结果、卡片永远"生成中"。
 * 修复：pendingNext 跨心跳复用，只有真正拿到数据后才发起下一次 next()。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OfficialAdapter } from "../src/adapters/official.js";

/** 模拟真实 async generator 的 next() 排队语义：多个未决 next() 按 FIFO 消费后续 push 的值 */
function createQueueStream() {
  const values: unknown[] = [];
  const waiters: Array<(r: IteratorResult<unknown>) => void> = [];
  return {
    push(value: unknown) {
      const w = waiters.shift();
      if (w) w({ done: false, value });
      else values.push(value);
    },
    stream() {
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next(): Promise<IteratorResult<unknown>> {
          return new Promise((resolve) => {
            if (values.length > 0) resolve({ done: false, value: values.shift() });
            else waiters.push(resolve);
          });
        },
      };
    },
  };
}

const TEAM_CREATE_MSG = {
  type: "assistant",
  message: { content: [{ type: "tool_use", id: "t1", name: "TeamCreate", input: {} }] },
  parent_tool_use_id: null,
  uuid: "u1",
  session_id: "s1",
};

describe("official.ts: 心跳循环不丢失消息", () => {
  let adapter: OfficialAdapter;

  beforeEach(() => {
    vi.useFakeTimers();
    adapter = new OfficialAdapter();
  });

  afterEach(() => {
    adapter.closeAllSessions();
    vi.useRealTimers();
  });

  it(
    "心跳超时后才到达的消息，下一次 next() 仍能收到，不会被丢弃",
    async () => {
      const queue = createQueueStream();
      let streamCalls = 0;
      const fakeSession: any = {
        send: vi.fn(async () => {}),
        close: vi.fn(),
        stream: vi.fn(() => {
          streamCalls++;
          if (streamCalls === 1) {
            return (async function* () {
              yield TEAM_CREATE_MSG;
            })();
          }
          return queue.stream();
        }),
      };
      (adapter as any).sessions.set("s1", fakeSession);
      (adapter as any).lastActivity.set("s1", Date.now());

      const gen = adapter.chat({ message: "go" as any, sessionId: "s1" } as any);
      const it_ = gen[Symbol.asyncIterator]();

      // 第一轮：TeamCreate 触发多轮 teams 模式
      const r1 = await it_.next();
      expect((r1.value as any).type).toBe("assistant");
      const r2 = await it_.next();
      expect((r2.value as any).type).toBe("turn_complete");

      // 第二轮进入心跳循环：先等满一个心跳周期，此时还没有真实数据
      const p3 = it_.next();
      await vi.advanceTimersByTimeAsync(15_000);
      const r3 = await p3;
      expect((r3.value as any).type).toBe("heartbeat");

      // 心跳之后，真实消息才姗姗来迟——这条不能被上一轮的弃单 next() 吞掉
      const REAL_MSG = { type: "assistant", message: { content: [] }, uuid: "u2", session_id: "s1" };
      queue.push(REAL_MSG);

      const r4 = await it_.next();
      expect(r4.value).toBe(REAL_MSG);
    },
    3000
  );
});
