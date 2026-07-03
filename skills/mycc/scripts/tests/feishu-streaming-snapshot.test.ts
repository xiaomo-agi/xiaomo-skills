/**
 * 流式卡片快照语义测试（mergeStreamingText 重设计的回归测试）
 *
 * 背景：FeishuStreamingSession.update 之前用 includes() 启发式猜测入参是
 * 增量还是全量——feishu.ts 每次只传"本事件的文本片段"，当 AI 输出重复内容
 * 时（新片段等于/包含于已有文本），启发式把它误判为旧内容静默丢掉。
 * 重设计：update/close 一律接收全量快照（后写覆盖），按事件类型累积文本
 * 的职责上移到调用方（feishu.ts 按事件追加、feishu-commands.ts 原本就累积）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// mock 飞书 SDK（必须在 import FeishuChannel 之前）
vi.mock("@larksuiteoapi/node-sdk", () => {
  return {
    default: {
      WSClient: vi.fn().mockImplementation(() => ({
        start: vi.fn(),
        close: vi.fn(),
      })),
      EventDispatcher: vi.fn().mockImplementation(() => ({
        register: vi.fn(),
      })),
      Domain: { Feishu: "feishu" },
      LoggerLevel: { info: "info" },
    },
  };
});

import { FeishuStreamingSession } from "../src/channels/feishu-streaming.js";
import { FeishuChannel } from "../src/channels/feishu";

const putCalls: string[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

function installFetchMock() {
  putCalls.length = 0;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const ok = (data: unknown) => ({ json: async () => data }) as unknown as Response;
    if (u.includes("/auth/v3/tenant_access_token"))
      return ok({ code: 0, msg: "ok", tenant_access_token: "t", expire: 7200 });
    if (u.includes("/cardkit/v1/cards") && u.includes("/elements/content/content")) {
      putCalls.push(JSON.parse(String(init?.body)).content);
      return ok({ code: 0, msg: "ok" });
    }
    if (u.includes("/cardkit/v1/cards") && u.endsWith("/settings"))
      return ok({ code: 0, msg: "ok" });
    if (u.includes("/cardkit/v1/cards"))
      return ok({ code: 0, msg: "ok", data: { card_id: "card1" } });
    if (u.includes("/im/v1/messages"))
      return ok({ code: 0, msg: "ok", data: { message_id: "msg1" } });
    return ok({ code: 0, msg: "ok" });
  });
  vi.stubGlobal("fetch", fetchMock);
}

const overThrottle = () => new Promise((r) => setTimeout(r, 150));

describe("FeishuStreamingSession 快照语义", () => {
  let appSeq = 0;

  beforeEach(() => {
    installFetchMock();
    appSeq++;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function newSession() {
    // 每个用例用独立 appId，避开模块级 token 缓存
    return new FeishuStreamingSession({ appId: `app-snap-${appSeq}`, appSecret: "s" });
  }

  it("快照增长时逐次 PUT 最新全量", async () => {
    const session = newSession();
    await session.start("chat1", "chat_id");

    await session.update("你好");
    await overThrottle();
    await session.update("你好，世界");

    expect(putCalls).toEqual(["你好", "你好，世界"]);
  });

  it("与已发内容相同的快照不重复 PUT", async () => {
    const session = newSession();
    await session.start("chat1", "chat_id");

    await session.update("同一份内容");
    await overThrottle();
    await session.update("同一份内容");
    await session.close();

    expect(putCalls).toEqual(["同一份内容"]);
  });

  it("节流窗口内的最新快照由 close 收尾发出，不丢内容", async () => {
    const session = newSession();
    await session.start("chat1", "chat_id");

    await session.update("第一段");
    // 立即再更新：落在 100ms 节流窗口内，只记为 pending
    await session.update("第一段第二段");
    expect(putCalls).toEqual(["第一段"]);

    await session.close();
    expect(putCalls).toEqual(["第一段", "第一段第二段"]);
  });

  it("close 的 finalText 是全量快照，直接覆盖而不是启发式拼接", async () => {
    const session = newSession();
    await session.start("chat1", "chat_id");

    await session.update("中间状态");
    // 旧启发式会把 finalText 与已有文本 includes() 互猜；快照语义下直接覆盖
    await session.close("最终回复全文");

    expect(putCalls[putCalls.length - 1]).toBe("最终回复全文");
  });
});

describe("FeishuChannel 按事件累积（重复内容不丢）", () => {
  beforeEach(() => {
    installFetchMock();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function assistantEvent(text: string) {
    return {
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    } as any;
  }

  it("AI 连续两条相同文本的 assistant 事件都出现在卡片上", async () => {
    const channel = new FeishuChannel({
      appId: "app-chan-1",
      appSecret: "s",
      receiveUserId: "ou_user",
      receiveIdType: "open_id",
      connectionMode: "poll",
      showToolUse: true,
      streamingCards: true,
    });

    // 旧实现：streamUpdate 用片段覆盖累积 + includes() 启发式，
    // 第二条相同片段被误判为"旧内容"直接丢弃
    await channel.send(assistantEvent("好的，收到。"));
    await overThrottle();
    await channel.send(assistantEvent("好的，收到。"));
    await channel.closeStreamingCard();

    const finalContent = putCalls[putCalls.length - 1];
    expect(finalContent).toBe("好的，收到。好的，收到。");
  });

  it("多个 assistant 片段按事件顺序累积成全量快照", async () => {
    const channel = new FeishuChannel({
      appId: "app-chan-2",
      appSecret: "s",
      receiveUserId: "ou_user",
      receiveIdType: "open_id",
      connectionMode: "poll",
      showToolUse: true,
      streamingCards: true,
    });

    await channel.send(assistantEvent("先跑测试。"));
    await overThrottle();
    // 新片段是已有文本的子串——旧启发式会静默丢掉
    await channel.send(assistantEvent("跑测试"));
    await channel.closeStreamingCard();

    const finalContent = putCalls[putCalls.length - 1];
    expect(finalContent).toBe("先跑测试。跑测试");
  });
});
