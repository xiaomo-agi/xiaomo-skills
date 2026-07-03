/**
 * /chat 多供应商路由 + /history provider 穿透测试（Phase 3）
 *
 * 覆盖场景：
 * 1. 不传 provider → 默认 claude adapter（向后兼容，web 小程序不受影响）
 * 2. provider 非法（未知供应商名）→ 400 + 明确错误信息
 * 3. provider=codex 未注册 → 400 "尚未接入"
 * 4. registerAdapter("codex", fake) 后 provider=codex → 走 fake adapter
 * 5. /history/list 与 /history/{id} 支持 ?provider= 穿透
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import http from "http";
import {
  adapter,
  registerAdapter,
  listRegisteredProviders,
  type CCAdapter,
} from "../src/adapters/index.js";

const TOKEN = "provider-routing-test-token";

let server: any;
let port: number;
const originalPort = process.env.PORT;

/** 记录调用参数的假 codex adapter */
const fakeCodexCalls: { chat: any[]; listHistory: any[]; getHistory: any[] } = {
  chat: [],
  listHistory: [],
  getHistory: [],
};

const fakeCodexAdapter = {
  async *chat(params: any) {
    fakeCodexCalls.chat.push(params);
    yield { type: "system", session_id: "codex-session-1" };
    yield {
      type: "assistant",
      message: { content: [{ type: "text", text: "reply-from-fake-codex" }] },
    };
  },
  listHistory: async (cwd: string, limit?: number) => {
    fakeCodexCalls.listHistory.push({ cwd, limit });
    return {
      conversations: [{ sessionId: "codex-history-1", title: "codex 会话" }],
      total: 1,
      hasMore: false,
    };
  },
  getHistory: async (cwd: string, sessionId: string) => {
    fakeCodexCalls.getHistory.push({ cwd, sessionId });
    return { sessionId, title: "codex-detail-marker", messages: [] };
  },
  getOrCreateSession: () => {
    throw new Error("not implemented in fake");
  },
  closeSession: () => {},
  closeAllSessions: () => {},
  setLifecycleCallbacks: () => {},
} as unknown as CCAdapter;

/** 发起 HTTP 请求并收集完整响应 */
function request(opts: {
  path: string;
  method?: string;
  body?: unknown;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: opts.path,
        method: opts.method || "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body: data }));
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 给 adapter（claude 默认实例）打 chat 桩，避免测试真的拉起 CLI */
function stubDefaultChat() {
  return vi.spyOn(adapter, "chat").mockImplementation(async function* () {
    yield { type: "system", session_id: "claude-default-session" };
    yield {
      type: "assistant",
      message: { content: [{ type: "text", text: "reply-from-default-claude" }] },
    };
  });
}

beforeAll(async () => {
  process.env.PORT = "0";
  const { HttpServer } = await import("../src/http-server.js");
  // 传入 authToken → 已配对状态，直接带 Bearer token 调用
  server = new HttpServer("ABC123", process.cwd(), TOKEN);
  await server.start();
  port = (server as any).server.address().port;
});

afterAll(() => {
  server.stop();
  if (originalPort !== undefined) {
    process.env.PORT = originalPort;
  } else {
    delete process.env.PORT;
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/chat 多供应商路由", () => {
  it("provider 非法（未知供应商）→ 400 + 明确错误信息，不触发任何 adapter", async () => {
    const chatSpy = stubDefaultChat();

    const res = await request({
      path: "/chat",
      method: "POST",
      body: { message: "你好", provider: "gpt5" },
    });

    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toMatch(/未知的 agent 供应商: gpt5/);
    expect(chatSpy).not.toHaveBeenCalled();
  });

  it("provider=codex 未注册 → 400 尚未接入（不是 500 裸抛）", async () => {
    // 本测试必须在 registerAdapter("codex") 之前跑（文件内顺序保证）
    if (listRegisteredProviders().includes("codex")) return;

    const res = await request({
      path: "/chat",
      method: "POST",
      body: { message: "你好", provider: "codex" },
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/尚未接入/);
  });

  it("registerAdapter 后 provider=codex → 走注册的 codex adapter", async () => {
    registerAdapter("codex", fakeCodexAdapter);
    const chatSpy = stubDefaultChat();

    const res = await request({
      path: "/chat",
      method: "POST",
      body: { message: "codex 你好", provider: "codex" },
    });

    expect(res.status).toBe(200);
    // SSE 流里包含 fake codex 的事件和 done
    expect(res.body).toContain("codex-session-1");
    expect(res.body).toContain("reply-from-fake-codex");
    expect(res.body).toContain('"type":"done"');
    // 请求参数完整穿透
    expect(fakeCodexCalls.chat).toHaveLength(1);
    expect(fakeCodexCalls.chat[0].message).toContain("codex 你好");
    // 默认 claude adapter 没被碰
    expect(chatSpy).not.toHaveBeenCalled();
  });

  it("不传 provider → 默认 claude adapter（向后兼容，行为与现状一致）", async () => {
    const chatSpy = stubDefaultChat();
    const codexCallsBefore = fakeCodexCalls.chat.length;

    const res = await request({
      path: "/chat",
      method: "POST",
      body: { message: "默认通道" },
    });

    expect(res.status).toBe(200);
    expect(res.body).toContain("reply-from-default-claude");
    expect(res.body).toContain('"type":"done"');
    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(fakeCodexCalls.chat).toHaveLength(codexCallsBefore);
  });

  it("provider 传空字符串 → 视为未传，走默认 claude adapter", async () => {
    const chatSpy = stubDefaultChat();

    const res = await request({
      path: "/chat",
      method: "POST",
      body: { message: "空 provider", provider: "" },
    });

    expect(res.status).toBe(200);
    expect(res.body).toContain("reply-from-default-claude");
    expect(chatSpy).toHaveBeenCalledTimes(1);
  });

  it("provider=claude 显式传 → 与不传等价", async () => {
    const chatSpy = stubDefaultChat();

    const res = await request({
      path: "/chat",
      method: "POST",
      body: { message: "显式 claude", provider: "claude" },
    });

    expect(res.status).toBe(200);
    expect(res.body).toContain("reply-from-default-claude");
    expect(chatSpy).toHaveBeenCalledTimes(1);
  });
});

describe("/history provider 穿透", () => {
  it("GET /history/list?provider=bogus → 400 + 明确错误", async () => {
    const res = await request({ path: "/history/list?provider=bogus" });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/未知的 agent 供应商: bogus/);
  });

  it("GET /history/list?provider=codex → 走 codex adapter 的 listHistory", async () => {
    registerAdapter("codex", fakeCodexAdapter);
    const listSpy = vi
      .spyOn(adapter, "listHistory")
      .mockResolvedValue({ conversations: [], total: 0, hasMore: false });

    const res = await request({ path: "/history/list?provider=codex&limit=5" });

    expect(res.status).toBe(200);
    expect(res.body).toContain("codex-history-1");
    expect(fakeCodexCalls.listHistory.at(-1)).toEqual({
      cwd: process.cwd(),
      limit: 5,
    });
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("GET /history/list 不传 provider → 默认 claude adapter（向后兼容）", async () => {
    const listSpy = vi
      .spyOn(adapter, "listHistory")
      .mockResolvedValue({ conversations: [], total: 0, hasMore: false });

    const res = await request({ path: "/history/list" });

    expect(res.status).toBe(200);
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenCalledWith(process.cwd(), 20);
  });

  it("GET /history/{id}?provider=codex → 走 codex adapter 的 getHistory", async () => {
    registerAdapter("codex", fakeCodexAdapter);
    const getSpy = vi.spyOn(adapter, "getHistory").mockResolvedValue(null);

    const res = await request({ path: "/history/abc-123?provider=codex" });

    expect(res.status).toBe(200);
    expect(res.body).toContain("codex-detail-marker");
    expect(fakeCodexCalls.getHistory.at(-1)).toEqual({
      cwd: process.cwd(),
      sessionId: "abc-123",
    });
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("GET /history/{id}?provider=bogus → 400", async () => {
    const res = await request({ path: "/history/abc-123?provider=bogus" });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/未知的 agent 供应商/);
  });

  it("GET /history/{id} 不传 provider → 默认 claude adapter", async () => {
    const getSpy = vi
      .spyOn(adapter, "getHistory")
      .mockResolvedValue({ sessionId: "abc-123", messages: [] } as any);

    const res = await request({ path: "/history/abc-123" });

    expect(res.status).toBe(200);
    expect(getSpy).toHaveBeenCalledWith(process.cwd(), "abc-123");
  });
});
