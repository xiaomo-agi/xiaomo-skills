/**
 * v2 Session API 改造测试
 *
 * 验证 OfficialAdapter 从 query() 迁移到 v2 Session API 后的行为：
 * 1. Session 池管理（创建、复用、关闭）
 * 2. chat() 方法（新对话、续接、图文混合）
 * 3. Session 超时清理（30min 无活动）
 * 4. 边界情况（model 必填、异常处理）
 * 5. 退出时 closeAllSessions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

// ============ 1. 接口定义验证 ============

describe("CCAdapter 接口 — v2 Session 方法", () => {
  let interfaceSource: string;

  beforeEach(() => {
    interfaceSource = readFileSync(join(SRC, "adapters", "interface.ts"), "utf-8");
  });

  it("接口声明了 getOrCreateSession 方法", () => {
    expect(interfaceSource).toContain("getOrCreateSession");
  });

  it("接口声明了 closeSession 方法", () => {
    expect(interfaceSource).toContain("closeSession");
  });

  it("接口声明了 closeAllSessions 方法", () => {
    expect(interfaceSource).toContain("closeAllSessions");
  });

  it("保留了原有的 chat 方法", () => {
    expect(interfaceSource).toContain("chat(");
  });

  it("保留了原有的 listHistory 方法", () => {
    expect(interfaceSource).toContain("listHistory(");
  });

  it("保留了原有的 getHistory 方法", () => {
    expect(interfaceSource).toContain("getHistory(");
  });
});

// ============ 2. official.ts import 验证 ============

describe("official.ts v2 API 导入", () => {
  let officialSource: string;

  beforeEach(() => {
    officialSource = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");
  });

  it("导入 unstable_v2_createSession", () => {
    expect(officialSource).toContain("unstable_v2_createSession");
  });

  it("导入 unstable_v2_resumeSession", () => {
    expect(officialSource).toContain("unstable_v2_resumeSession");
  });

  it("导入 SDKSession 类型", () => {
    expect(officialSource).toContain("SDKSession");
  });
});

// ============ 3. Session 池基础 ============

describe("Session 池管理", () => {
  it("sessions 池应该是一个 Map 结构", () => {
    const officialSource = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");
    // 源码中应声明 Map<string, SDKSession> 或类似结构
    expect(officialSource).toMatch(/Map\s*</);
  });

  it("getOrCreateSession — 无现有 session 时调用 createSession", () => {
    // Mock v2 API
    const mockSession = {
      sessionId: "test-session-123",
      send: vi.fn(),
      stream: vi.fn(),
      close: vi.fn(),
    };

    const createSession = vi.fn().mockReturnValue(mockSession);

    // 模拟 getOrCreateSession 逻辑
    const sessions = new Map<string, typeof mockSession>();

    function getOrCreateSession(sessionId?: string) {
      if (sessionId && sessions.has(sessionId)) {
        return sessions.get(sessionId)!;
      }
      const session = createSession({ model: "claude-sonnet-4-5-20250929" });
      sessions.set(session.sessionId, session);
      return session;
    }

    const session = getOrCreateSession();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(sessions.size).toBe(1);
    expect(session.sessionId).toBe("test-session-123");
  });

  it("getOrCreateSession — 有现有 session 时复用", () => {
    const mockSession = {
      sessionId: "existing-session",
      send: vi.fn(),
      stream: vi.fn(),
      close: vi.fn(),
    };

    const createSession = vi.fn();
    const sessions = new Map<string, typeof mockSession>();
    sessions.set("existing-session", mockSession);

    function getOrCreateSession(sessionId?: string) {
      if (sessionId && sessions.has(sessionId)) {
        return sessions.get(sessionId)!;
      }
      const session = createSession({ model: "claude-sonnet-4-5-20250929" });
      sessions.set(session.sessionId, session);
      return session;
    }

    const session = getOrCreateSession("existing-session");
    expect(createSession).not.toHaveBeenCalled();
    expect(session.sessionId).toBe("existing-session");
  });

  it("closeSession — 关闭指定 session 并从池中移除", () => {
    const mockSession = {
      sessionId: "to-close",
      send: vi.fn(),
      stream: vi.fn(),
      close: vi.fn(),
    };

    const sessions = new Map<string, typeof mockSession>();
    sessions.set("to-close", mockSession);

    function closeSession(sessionId: string) {
      const session = sessions.get(sessionId);
      if (session) {
        session.close();
        sessions.delete(sessionId);
      }
    }

    closeSession("to-close");
    expect(mockSession.close).toHaveBeenCalledTimes(1);
    expect(sessions.size).toBe(0);
  });

  it("closeSession — 关闭不存在的 session 不会报错", () => {
    const sessions = new Map();

    function closeSession(sessionId: string) {
      const session = sessions.get(sessionId);
      if (session) {
        session.close();
        sessions.delete(sessionId);
      }
    }

    expect(() => closeSession("nonexistent")).not.toThrow();
  });

  it("closeAllSessions — 关闭所有 session 并清空池", () => {
    const mockSessions = [
      { sessionId: "s1", close: vi.fn() },
      { sessionId: "s2", close: vi.fn() },
      { sessionId: "s3", close: vi.fn() },
    ];

    const sessions = new Map<string, (typeof mockSessions)[0]>();
    mockSessions.forEach((s) => sessions.set(s.sessionId, s));

    function closeAllSessions() {
      for (const session of sessions.values()) {
        session.close();
      }
      sessions.clear();
    }

    closeAllSessions();
    expect(sessions.size).toBe(0);
    mockSessions.forEach((s) => {
      expect(s.close).toHaveBeenCalledTimes(1);
    });
  });
});

// ============ 4. chat() 方法（v2 Session 版） ============

describe("chat() — v2 Session 模式", () => {
  it("新对话：创建 session → send → stream", async () => {
    const messages: Array<{ type: string; session_id: string }> = [
      { type: "system", session_id: "new-session-1" },
      { type: "assistant", session_id: "new-session-1" },
      { type: "result", session_id: "new-session-1" },
    ];

    const mockSession = {
      sessionId: "new-session-1",
      send: vi.fn(),
      stream: vi.fn(async function* () {
        for (const msg of messages) {
          yield msg;
        }
      }),
      close: vi.fn(),
    };

    // 模拟 chat 的流程
    await mockSession.send("hello");
    const events: unknown[] = [];
    for await (const msg of mockSession.stream()) {
      events.push(msg);
    }

    expect(mockSession.send).toHaveBeenCalledWith("hello");
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: "system", session_id: "new-session-1" });
  });

  it("续接对话：复用已有 session → send → stream", async () => {
    const mockSession = {
      sessionId: "continued-session",
      send: vi.fn(),
      stream: vi.fn(async function* () {
        yield { type: "assistant", session_id: "continued-session" };
        yield { type: "result", session_id: "continued-session" };
      }),
      close: vi.fn(),
    };

    const sessions = new Map();
    sessions.set("continued-session", mockSession);

    // 续接时不应创建新 session
    const session = sessions.get("continued-session");
    expect(session).toBeDefined();

    await session!.send("follow up message");
    const events: unknown[] = [];
    for await (const msg of session!.stream()) {
      events.push(msg);
    }

    expect(events).toHaveLength(2);
    expect(mockSession.send).toHaveBeenCalledWith("follow up message");
  });

  it("chat 输出的每条消息都应该是 SSEEvent（Record<string, unknown>）", async () => {
    const mockMessages = [
      { type: "system", subtype: "init", session_id: "s1", cwd: "/tmp" },
      { type: "assistant", message: { role: "assistant" }, session_id: "s1" },
      { type: "result", subtype: "success", result: "done", session_id: "s1" },
    ];

    for (const msg of mockMessages) {
      // SSEEvent = Record<string, unknown>
      expect(typeof msg).toBe("object");
      expect(msg).not.toBeNull();
      expect(msg).toHaveProperty("type");
    }
  });
});

// ============ 4b. chat() 图文混合消息 ============

describe("chat() — 图文混合消息", () => {
  it("纯文本消息：send 接收字符串", async () => {
    const mockSession = {
      sessionId: "text-session",
      send: vi.fn(),
      stream: vi.fn(async function* () {
        yield { type: "result", session_id: "text-session" };
      }),
      close: vi.fn(),
    };

    // 纯文本直接 send 字符串
    await mockSession.send("hello world");
    expect(mockSession.send).toHaveBeenCalledWith("hello world");
  });

  it("图文混合消息：send 接收 SDKUserMessage 对象", async () => {
    const mockSession = {
      sessionId: "image-session",
      send: vi.fn(),
      stream: vi.fn(async function* () {
        yield { type: "result", session_id: "image-session" };
      }),
      close: vi.fn(),
    };

    // 图文混合需要构造 SDKUserMessage
    const userMessage = {
      type: "user" as const,
      session_id: "image-session",
      message: {
        role: "user" as const,
        content: [
          {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: "image/png",
              data: "iVBORw0KGgo=",
            },
          },
          {
            type: "text" as const,
            text: "分析这张图片",
          },
        ],
      },
      parent_tool_use_id: null,
    };

    await mockSession.send(userMessage);
    expect(mockSession.send).toHaveBeenCalledWith(userMessage);

    // send 的参数应包含 image 块
    const sentArg = mockSession.send.mock.calls[0][0];
    expect(sentArg).toHaveProperty("message");
    expect(sentArg.message.content).toHaveLength(2);
    expect(sentArg.message.content[0].type).toBe("image");
    expect(sentArg.message.content[1].type).toBe("text");
  });

  it("buildMessageContent 返回字符串时 send 字符串，返回数组时 send SDKUserMessage", async () => {
    // 这是 chat() 内部逻辑的核心分支
    const { buildMessageContent } = await import("../src/image-utils.js");

    // 纯文本
    const textContent = buildMessageContent("hello", undefined);
    expect(typeof textContent).toBe("string");

    // 图文混合
    const imageContent = buildMessageContent("分析", [{
      data: "iVBORw0KGgo=",
      mediaType: "image/png",
    }]);
    expect(Array.isArray(imageContent)).toBe(true);
    expect((imageContent as any[])[0].type).toBe("image");
  });
});

// ============ 5. SDKSessionOptions 构造验证 ============

describe("SDKSessionOptions 构造", () => {
  it("model 是必填字段", () => {
    // SDKSessionOptions 要求 model 是必填
    // 构造时必须提供 model
    const options = {
      model: "claude-sonnet-4-5-20250929",
    };
    expect(options.model).toBeDefined();
    expect(typeof options.model).toBe("string");
  });

  it("不传 model 时应使用默认值", () => {
    // adapter 应该有默认 model 策略
    const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
    const userModel: string | undefined = undefined;

    const model = userModel || DEFAULT_MODEL;
    expect(model).toBe("claude-sonnet-4-5-20250929");
  });

  it("用户指定 model 时使用用户的值", () => {
    const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
    const userModel = "claude-opus-4-6";

    const model = userModel || DEFAULT_MODEL;
    expect(model).toBe("claude-opus-4-6");
  });

  it("v2 SDKSessionOptions 没有 cwd — 需要用 process.chdir 传递", () => {
    // SDKSessionOptions 没有 cwd 字段（SDK v2 限制）
    // 需要在创建 session 前 process.chdir(cwd)，让子进程继承正确的工作目录
    const options = {
      model: "claude-sonnet",
      permissionMode: "bypassPermissions" as const,
      env: { ...process.env },
    };

    // options 中不应有 cwd（SDK 不支持）
    expect(options).not.toHaveProperty("cwd");
  });

  it("v2 没有 allowDangerouslySkipPermissions — 不应出现在 options 中", () => {
    const options = {
      model: "claude-sonnet-4-5-20250929",
      permissionMode: "bypassPermissions" as const,
    };

    expect(options).not.toHaveProperty("allowDangerouslySkipPermissions");
  });

  it("permissionMode 应设为 bypassPermissions", () => {
    const options = {
      model: "claude-sonnet-4-5-20250929",
      permissionMode: "bypassPermissions" as const,
    };
    expect(options.permissionMode).toBe("bypassPermissions");
  });

  it("env 应包含 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", () => {
    const env = {
      ...process.env,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    };
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");
  });

  it("env 应保留 process.env 中的已有变量", () => {
    const env = {
      ...process.env,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    };
    expect(env.PATH).toBeDefined();
  });
});

// ============ 6. Session 超时清理 ============

describe("Session 超时清理", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

  it("30 分钟无活动的 session 应被自动关闭", () => {
    const mockSession = {
      sessionId: "timeout-session",
      close: vi.fn(),
    };

    const sessions = new Map<string, typeof mockSession>();
    const lastActivity = new Map<string, number>();

    sessions.set("timeout-session", mockSession);
    lastActivity.set("timeout-session", Date.now());

    // 模拟超时清理逻辑
    function cleanupExpiredSessions() {
      const now = Date.now();
      for (const [id, lastTime] of lastActivity.entries()) {
        if (now - lastTime > SESSION_TIMEOUT_MS) {
          const session = sessions.get(id);
          if (session) {
            session.close();
            sessions.delete(id);
          }
          lastActivity.delete(id);
        }
      }
    }

    // 前进 30 分钟 + 1 毫秒
    vi.advanceTimersByTime(SESSION_TIMEOUT_MS + 1);

    cleanupExpiredSessions();

    expect(mockSession.close).toHaveBeenCalledTimes(1);
    expect(sessions.size).toBe(0);
  });

  it("活跃 session 不应被清理", () => {
    const mockSession = {
      sessionId: "active-session",
      close: vi.fn(),
    };

    const sessions = new Map<string, typeof mockSession>();
    const lastActivity = new Map<string, number>();

    sessions.set("active-session", mockSession);
    lastActivity.set("active-session", Date.now());

    function cleanupExpiredSessions() {
      const now = Date.now();
      for (const [id, lastTime] of lastActivity.entries()) {
        if (now - lastTime > SESSION_TIMEOUT_MS) {
          const session = sessions.get(id);
          if (session) {
            session.close();
            sessions.delete(id);
          }
          lastActivity.delete(id);
        }
      }
    }

    // 只前进 15 分钟
    vi.advanceTimersByTime(15 * 60 * 1000);

    cleanupExpiredSessions();

    expect(mockSession.close).not.toHaveBeenCalled();
    expect(sessions.size).toBe(1);
  });

  it("发送消息后应更新 lastActivity 时间戳", () => {
    const lastActivity = new Map<string, number>();
    lastActivity.set("session-1", Date.now());

    // 前进 20 分钟
    vi.advanceTimersByTime(20 * 60 * 1000);

    // 模拟发送消息 → 更新时间戳
    lastActivity.set("session-1", Date.now());

    // 再前进 15 分钟（总共 35 分钟，但从上次活动只过了 15 分钟）
    vi.advanceTimersByTime(15 * 60 * 1000);

    const now = Date.now();
    const elapsed = now - lastActivity.get("session-1")!;

    // 从上次活动只过了 15 分钟，不应超时
    expect(elapsed).toBe(15 * 60 * 1000);
    expect(elapsed).toBeLessThan(SESSION_TIMEOUT_MS);
  });

  it("定时清理间隔应合理（建议 5 分钟一次）", () => {
    const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 min

    // 清理间隔应小于超时时间
    expect(CLEANUP_INTERVAL_MS).toBeLessThan(SESSION_TIMEOUT_MS);
    // 但不应太频繁
    expect(CLEANUP_INTERVAL_MS).toBeGreaterThanOrEqual(60 * 1000);
  });
});

// ============ 7. resumeSession 逻辑 ============

describe("resumeSession 逻辑", () => {
  it("池中没有但 sessionId 存在 → 用 resumeSession 恢复", () => {
    const mockResumedSession = {
      sessionId: "old-session-to-resume",
      send: vi.fn(),
      stream: vi.fn(),
      close: vi.fn(),
    };

    const resumeSession = vi.fn().mockReturnValue(mockResumedSession);
    const createSession = vi.fn();

    const sessions = new Map<string, typeof mockResumedSession>();

    function getOrCreateSession(sessionId?: string) {
      if (sessionId && sessions.has(sessionId)) {
        return sessions.get(sessionId)!;
      }
      if (sessionId) {
        // 有 sessionId 但不在池中 → resumeSession
        const session = resumeSession(sessionId, { model: "claude-sonnet-4-5-20250929" });
        sessions.set(session.sessionId, session);
        return session;
      }
      // 全新对话
      const session = createSession({ model: "claude-sonnet-4-5-20250929" });
      sessions.set(session.sessionId, session);
      return session;
    }

    const session = getOrCreateSession("old-session-to-resume");

    expect(resumeSession).toHaveBeenCalledWith("old-session-to-resume", {
      model: "claude-sonnet-4-5-20250929",
    });
    expect(createSession).not.toHaveBeenCalled();
    expect(session.sessionId).toBe("old-session-to-resume");
  });

  it("无 sessionId → 用 createSession 创建新 session", () => {
    const mockNewSession = {
      sessionId: "brand-new-session",
      send: vi.fn(),
      stream: vi.fn(),
      close: vi.fn(),
    };

    const resumeSession = vi.fn();
    const createSession = vi.fn().mockReturnValue(mockNewSession);

    const sessions = new Map<string, typeof mockNewSession>();

    function getOrCreateSession(sessionId?: string) {
      if (sessionId && sessions.has(sessionId)) {
        return sessions.get(sessionId)!;
      }
      if (sessionId) {
        const session = resumeSession(sessionId, { model: "claude-sonnet-4-5-20250929" });
        sessions.set(session.sessionId, session);
        return session;
      }
      const session = createSession({ model: "claude-sonnet-4-5-20250929" });
      sessions.set(session.sessionId, session);
      return session;
    }

    const session = getOrCreateSession(undefined);

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(resumeSession).not.toHaveBeenCalled();
    expect(session.sessionId).toBe("brand-new-session");
  });
});

// ============ 8. 异常处理 ============

describe("异常处理", () => {
  it("session.send 失败时 chat 应抛出或 yield error 事件", async () => {
    const mockSession = {
      sessionId: "error-session",
      send: vi.fn().mockRejectedValue(new Error("Connection lost")),
      stream: vi.fn(async function* () {
        // 不会执行到这里
      }),
      close: vi.fn(),
    };

    await expect(mockSession.send("hello")).rejects.toThrow("Connection lost");
  });

  it("session.stream 中途出错时应正确处理", async () => {
    const mockSession = {
      sessionId: "stream-error",
      send: vi.fn(),
      stream: vi.fn(async function* () {
        yield { type: "system", session_id: "stream-error" };
        throw new Error("Stream interrupted");
      }),
      close: vi.fn(),
    };

    await mockSession.send("hello");

    const events: unknown[] = [];
    let caughtError: Error | null = null;

    try {
      for await (const msg of mockSession.stream()) {
        events.push(msg);
      }
    } catch (e) {
      caughtError = e as Error;
    }

    expect(events).toHaveLength(1);
    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toBe("Stream interrupted");
  });

  it("closeSession 时 session.close 失败不应影响池清理", () => {
    const mockSession = {
      sessionId: "close-error",
      close: vi.fn(() => {
        throw new Error("Close failed");
      }),
    };

    const sessions = new Map<string, typeof mockSession>();
    sessions.set("close-error", mockSession);

    function closeSession(sessionId: string) {
      const session = sessions.get(sessionId);
      if (session) {
        try {
          session.close();
        } catch {
          // 静默处理
        }
        sessions.delete(sessionId);
      }
    }

    expect(() => closeSession("close-error")).not.toThrow();
    expect(sessions.size).toBe(0);
  });

  it("closeAllSessions 时个别 session close 失败不阻塞其他", () => {
    const sessions = new Map<string, { sessionId: string; close: ReturnType<typeof vi.fn> }>();

    const s1 = { sessionId: "s1", close: vi.fn(() => { throw new Error("fail"); }) };
    const s2 = { sessionId: "s2", close: vi.fn() };
    const s3 = { sessionId: "s3", close: vi.fn() };

    sessions.set("s1", s1);
    sessions.set("s2", s2);
    sessions.set("s3", s3);

    function closeAllSessions() {
      for (const session of sessions.values()) {
        try {
          session.close();
        } catch {
          // 静默处理，继续关闭其他 session
        }
      }
      sessions.clear();
    }

    expect(() => closeAllSessions()).not.toThrow();
    expect(s2.close).toHaveBeenCalled();
    expect(s3.close).toHaveBeenCalled();
    expect(sessions.size).toBe(0);
  });
});

// ============ 9. 退出时清理 ============

describe("进程退出时 closeAllSessions", () => {
  it("index.ts SIGINT/SIGTERM handler 应调用 closeAllSessions", () => {
    const indexSource = readFileSync(join(SRC, "index.ts"), "utf-8");

    // 退出处理中应该有 session 清理逻辑
    expect(indexSource).toMatch(/SIGINT/);
    expect(indexSource).toMatch(/SIGTERM/);

    // 改造后应包含 closeAllSessions 调用
    expect(indexSource).toContain("closeAllSessions");
  });
});

// ============ 10. chat() 与 http-server 集成 ============

describe("chat() SSE 输出格式兼容", () => {
  it("v2 session 的 stream 输出应作为 SSEEvent yield", () => {
    // SDKMessage 类型可以安全转换为 Record<string, unknown>
    const sdkMessage = {
      type: "assistant" as const,
      message: { role: "assistant", content: "hello" },
      parent_tool_use_id: null,
      uuid: "uuid-123" as any,
      session_id: "s1",
    };

    // 应该能安全地 JSON.stringify（SSE 需要）
    const json = JSON.stringify(sdkMessage);
    expect(json).toBeTruthy();

    // 解析回来后应保持结构
    const parsed = JSON.parse(json);
    expect(parsed.type).toBe("assistant");
    expect(parsed.session_id).toBe("s1");
  });

  it("done 事件应包含 sessionId", () => {
    const sessionId = "session-from-v2";
    const doneEvent = { type: "done", sessionId };

    expect(doneEvent.type).toBe("done");
    expect(doneEvent.sessionId).toBe("session-from-v2");
  });

  it("session_id 应从 v2 session 的 stream 消息中提取", () => {
    const messages = [
      { type: "system", subtype: "init", session_id: "auto-assigned-id" },
      { type: "assistant", session_id: "auto-assigned-id" },
    ];

    let extractedSessionId: string | undefined;
    for (const msg of messages) {
      if (msg.type === "system" && "session_id" in msg) {
        extractedSessionId = msg.session_id;
      }
    }

    expect(extractedSessionId).toBe("auto-assigned-id");
  });
});

// ============ 10b. 新 session 的 sessionId 延迟可用 ============

describe("新 session sessionId 延迟初始化", () => {
  it("createSession 返回的 session，在收到消息前不应读取 sessionId", () => {
    // v2 SDK 文档：sessionId "Available after receiving the first message.
    // For resumed sessions, available immediately.
    // Throws if accessed before the session is initialized."
    const officialSource = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");

    // getOrCreateSession 中新 session（无 sessionId）不应立即读 session.sessionId 存池
    // 应该用 registerSession 在 stream 收到 sessionId 后再存
    expect(officialSource).toContain("registerSession");
  });

  it("chat() 应从 stream 的 system 消息中提取 sessionId 后注册到池", () => {
    const officialSource = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");

    // chat() 中应有从 stream 消息提取 session_id 并调用 registerSession 的逻辑
    expect(officialSource).toContain("registerSession");
    expect(officialSource).toMatch(/session_id.*registerSession|registerSession.*session_id/s);
  });

  it("resumeSession 的 sessionId 立即可用 — 可以直接存池", () => {
    const officialSource = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");

    // resumeSession 路径应该立即存池（因为 sessionId 已知）
    expect(officialSource).toMatch(/resumeSession[\s\S]*?sessions\.set/);
  });

  it("新 session 的 chat 流程：send → stream → 第一个 system 消息 → 注册池", async () => {
    // 模拟完整的新 session 流程
    let sessionIdAvailable = false;
    const mockSession = {
      get sessionId() {
        if (!sessionIdAvailable) throw new Error("Session ID not available until after receiving messages");
        return "delayed-session-id";
      },
      send: vi.fn(async () => {
        // send 后 sessionId 仍不可用
      }),
      stream: vi.fn(async function* () {
        // 第一条消息后 sessionId 可用
        sessionIdAvailable = true;
        yield { type: "system", subtype: "init", session_id: "delayed-session-id" };
        yield { type: "assistant", session_id: "delayed-session-id" };
      }),
      close: vi.fn(),
    };

    // 1. send 前不应读 sessionId
    expect(() => mockSession.sessionId).toThrow("Session ID not available");

    // 2. send
    await mockSession.send("hello");

    // 3. stream 中从 system 消息拿 sessionId
    const sessions = new Map();
    let resolvedSessionId: string | undefined;

    for await (const msg of mockSession.stream()) {
      const m = msg as Record<string, unknown>;
      if (!resolvedSessionId && m.type === "system" && typeof m.session_id === "string") {
        resolvedSessionId = m.session_id;
        sessions.set(resolvedSessionId, mockSession);
      }
    }

    // 4. 验证 sessionId 已注册
    expect(resolvedSessionId).toBe("delayed-session-id");
    expect(sessions.has("delayed-session-id")).toBe(true);
  });
});

// ============ 10c. cwd 传递验证（SDKSessionOptions.cwd 直传方案） ============
//
// 历史背景：早期认为 v2 SDKSessionOptions 没有 cwd 字段，只能靠
// process.chdir(cwd) → create/resumeSession → process.chdir(originalCwd) 来传递工作目录。
// 但这会修改进程级全局状态 process.cwd()，与其他并发的 getOrCreateSession() 调用存在竞态
// （不同请求的 cwd 互相踩踏）。
//
// 实测（读 node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs 源码 + monkey-patch
// child_process.spawn 验证）发现：当前安装的 SDK 版本 SDKSessionOptions 已经支持 cwd 字段，
// 且 unstable_v2_createSession/resumeSession 内部同步 spawn 子进程时把 options.cwd 原样
// 传给 child_process.spawn 的 cwd 选项，完全不依赖 process.cwd()。
// 因此改为直接把 cwd 放进 SDKSessionOptions，彻底不再 touch process.chdir，从根上消除竞态。
describe("cwd 传递 — SDKSessionOptions.cwd 直传方案", () => {
  it("v2 SDKSessionOptions 类型中包含 cwd 字段", () => {
    const sdkTypes = readFileSync(
      join(ROOT, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts"),
      "utf-8"
    );
    const sessionOptionsMatch = sdkTypes.match(/SDKSessionOptions\s*=\s*\{[\s\S]*?\n\};/);
    expect(sessionOptionsMatch).toBeTruthy();
    expect(sessionOptionsMatch![0]).toMatch(/cwd\?:\s*string/);
  });

  it("getOrCreateSession 不再使用 process.chdir（消除并发竞态）", () => {
    const officialSource = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");
    // 只判定实际调用（后面跟括号），允许注释里提及这个 API 名字做说明
    const codeWithoutComments = officialSource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(codeWithoutComments).not.toContain("process.chdir(");
  });

  it("chat() 应从 params 解构出 cwd 并传给 getOrCreateSession", () => {
    const officialSource = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");
    // chat() 中应从 params 解构出 cwd
    expect(officialSource).toMatch(/const\s*\{[^}]*cwd[^}]*\}\s*=\s*params/);
  });

  it("buildSessionOptions 把 cwd 直接放进 SDKSessionOptions", () => {
    const officialSource = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");
    // 09-06 串卡修复：签名加了第三参数 approvalHandle（当时漏改本断言，09-07 补）
    expect(officialSource).toMatch(/function buildSessionOptions\(model\?:\s*string,\s*cwd\?:\s*string,\s*approvalHandle\?:\s*ApprovalCardHandle\)/);
    expect(officialSource).toMatch(/\.\.\.\(cwd\s*&&\s*\{\s*cwd\s*\}\)/);
  });

  it("getOrCreateSession 把 cwd 传给 buildSessionOptions", () => {
    const officialSource = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");
    // 09-06 串卡修复：审批句柄作为第三个参数随 cwd 一起传入
    expect(officialSource).toMatch(/buildSessionOptions\(model,\s*cwd,\s*params\.approvalHandle\)/);
  });

  it("SessionParams 应包含 cwd 可选字段", () => {
    const interfaceSource = readFileSync(join(SRC, "adapters", "interface.ts"), "utf-8");
    // SessionParams 中应有 cwd
    expect(interfaceSource).toMatch(/interface\s+SessionParams[\s\S]*?cwd/);
  });
});

// ============ 10e. 并发 getOrCreateSession 不同 cwd 竞态回归测试 ============
//
// 回归测试：process.chdir 方案下，两个并发的 getOrCreateSession({cwd: A}) 和
// getOrCreateSession({cwd: B}) 调用如果交错执行（chdir(A) → chdir(B) → create → restore(B)
// → restore(A)），会导致其中一个 session 拿到错误的 cwd。
//
// 新方案下每次调用只构造一个携带自己 cwd 的 options 对象，不修改任何共享/全局状态，
// 所以两个并发调用互相之间不可能观测到对方的 cwd，也不需要加锁/排队。
describe("并发 getOrCreateSession — 不同 cwd 不再竞态", () => {
  /** 模拟新方案：cwd 直接放进 per-call 的 options，不碰 process.cwd() */
  function buildOptionsNoGlobalState(model: string | undefined, cwd: string | undefined) {
    return {
      model: model || "sonnet",
      permissionMode: "bypassPermissions" as const,
      ...(cwd && { cwd }),
    };
  }

  it("两个并发 createSession 调用（不同 cwd）各自拿到自己传入的 cwd，不受另一方影响", async () => {
    const capturedCwds: string[] = [];

    // 模拟 SDK 内部同步 spawn：拿到 options.cwd 就立刻记录下来（模拟子进程真正启动那一刻）
    function fakeCreateSession(options: { cwd?: string }) {
      // 加一个 microtask 延迟，模拟真实场景中两个调用交错执行的可能性
      capturedCwds.push(options.cwd ?? "(default)");
      return { cwd: options.cwd };
    }

    async function getOrCreateSession(cwd: string, delayMs: number) {
      await new Promise((r) => setTimeout(r, delayMs));
      const options = buildOptionsNoGlobalState("sonnet", cwd);
      // 关键：options 是本次调用的局部变量，不依赖任何跨调用共享的可变状态
      return fakeCreateSession(options);
    }

    // A 先开始但故意让它在 B 之后才真正调用 fakeCreateSession，制造交错
    const [resultA, resultB] = await Promise.all([
      getOrCreateSession("/project/A", 10),
      getOrCreateSession("/project/B", 0),
    ]);

    expect(resultA.cwd).toBe("/project/A");
    expect(resultB.cwd).toBe("/project/B");
    // 两次调用各自拿到了正确的 cwd，没有互相覆盖
    expect(capturedCwds.sort()).toEqual(["/project/A", "/project/B"]);
  });

  it("旧的 process.chdir 方案在非嵌套交错场景下会产生错误 cwd（对照组，证明新方案必要性）", async () => {
    // 用一个真实的可变全局变量模拟 process.cwd()，复现旧代码 chdir → create → restore 的结构。
    // 用显式的 gate（手动 resolve 的 Promise）而不是 setTimeout 竞速来精确控制交错顺序：
    // 这重现了「未来有人在 chdir 和 restore 之间不小心插入了一个 await」时会发生的真实损坏
    // （任务描述里点 1 提到的"fragile against future edits"）。
    let globalCwd = "/original";
    const results: Array<{ requested: string; observedAtSpawn: string }> = [];

    let releaseA: () => void;
    let releaseB: () => void;
    const gateA = new Promise<void>((r) => { releaseA = r; });
    const gateB = new Promise<void>((r) => { releaseB = r; });

    async function legacyGetOrCreateSession(cwd: string, waitFor: Promise<void>) {
      const originalCwd = globalCwd;
      const needsChdir = cwd !== originalCwd;
      if (needsChdir) globalCwd = cwd; // process.chdir(cwd)

      await waitFor; // 模拟 chdir 和 spawn 之间被插入了一个 await 点（未来有人加了一段异步准备工作）

      const observedAtSpawn = globalCwd; // "spawn 时刻" 读到的全局 cwd

      if (needsChdir) globalCwd = originalCwd; // process.chdir(originalCwd)
      results.push({ requested: cwd, observedAtSpawn });
    }

    // A、B 都先各自 chdir 到自己的目录，然后都卡在各自的 gate 上（此时全局 cwd 已经是
    // "/project/B"，且两边都还没 restore）。关键是按「非 LIFO」顺序释放——先放开 A、再放开 B
    // （现实中两个并发请求谁先完成完全不可控，不一定是后进先出）：
    const pA = legacyGetOrCreateSession("/project/A", gateA);
    const pB = legacyGetOrCreateSession("/project/B", gateB);
    releaseA!(); // A 先"spawn"：此时全局 cwd 已被 B 的 chdir 改成 /project/B
    await pA;
    releaseB!(); // B 后"spawn"：此时全局 cwd 已被 A 的 restore 改回 /original
    await pB;

    // 核心断言：至少有一次调用在"spawn 时刻"读到的 cwd 与它自己请求的 cwd 不一致 —— 这就是
    // process.chdir 方案在非嵌套交错下的竞态本质，新方案（cwd 直接放进局部 options，
    // 不碰共享/全局状态）完全不存在这类问题。
    const mismatched = results.filter((r) => r.requested !== r.observedAtSpawn);
    expect(mismatched.length).toBeGreaterThan(0);
  });
});

// ============ 10d. settingSources — Skills/CLAUDE.md 加载 ============
// 历史：曾靠 patch-sdk.mjs 改写 sdk.mjs 里的 settingSources:[] 硬编码。SDK 0.2.141
// 提供官方 settingSources 字段后补丁静默失配（本组旧测试因此长红，一直被当
// "存量环境噪音"忽略——2026-07-06 审查 H2）。现改为 buildSessionOptions 显式
// 传入官方字段，测试对准新方案：断言我们自己的 options 形状 + SDK 支持透传。

describe("settingSources — Skills/CLAUDE.md 加载（官方字段直传）", () => {
  const SDK_MJS_PATH = join(ROOT, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs");
  const PATCH_SCRIPT_PATH = join(ROOT, "scripts/patch-sdk.mjs");

  it("buildSessionOptions 显式传 settingSources:['user','project']", async () => {
    const { buildSessionOptions } = await import("../src/adapters/official.js");
    const options = buildSessionOptions("claude-fable-5", "/tmp") as any;
    expect(options.settingSources).toEqual(["user", "project"]);
  });

  it("当前 SDK 支持 settingSources 透传（官方字段，无需再 patch sdk.mjs）", () => {
    const sdkSource = readFileSync(SDK_MJS_PATH, "utf-8");
    // 形如 settingSources:$.settingSources??[]（$ 是压缩后的变量名，随版本变化）
    expect(sdkSource).toMatch(/settingSources:[\w$]+\.settingSources\?\?/);
  });

  it("patch-sdk.mjs 不再改写 sdk.mjs（只保留 cli.js 的 lP 补丁）", () => {
    const patchSource = readFileSync(PATCH_SCRIPT_PATH, "utf-8");
    expect(patchSource).not.toContain("SETTINGS_ORIGINAL");
    expect(patchSource).toContain("lP");
  });

  it("package.json 保留 postinstall 执行 patch（cli.js 补丁仍需要）", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
    expect(pkg.scripts).toHaveProperty("postinstall");
    expect(pkg.scripts.postinstall).toContain("patch-sdk");
  });
});

// ============ 11. official.ts 源码结构验证 ============

describe("official.ts 实现结构", () => {
  let officialSource: string;

  beforeEach(() => {
    officialSource = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");
  });

  it("OfficialAdapter 类实现了 CCAdapter 接口", () => {
    expect(officialSource).toMatch(/class\s+OfficialAdapter\s+implements\s+CCAdapter/);
  });

  it("不再使用 query() 的 cwd 参数", () => {
    // 改造后，不应在 SDKSessionOptions 中设置 cwd
    // 注意：v2 API 的 SDKSessionOptions 没有 cwd 字段
    // 这个测试在实现后验证
  });

  it("不再使用 query() 的 allowDangerouslySkipPermissions", () => {
    // v2 API 没有 allowDangerouslySkipPermissions 字段
    // 改造后应该只用 permissionMode
    // 这个测试在实现后验证
  });
});

// ============ 12. 默认 model 策略 ============

describe("默认 model 策略", () => {
  it("DEFAULT_MODEL 常量应存在于 official.ts", () => {
    const officialSource = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");
    // 改造后应有默认 model 定义
    // 当前可能还没有，这是实现需要通过的测试
    expect(officialSource).toMatch(/DEFAULT_MODEL|defaultModel|model.*sonnet|model.*claude/i);
  });

  it("model 为 undefined 或空字符串时使用默认值", () => {
    const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

    const testCases = [
      { input: undefined, expected: DEFAULT_MODEL },
      { input: "", expected: DEFAULT_MODEL },
      { input: "claude-opus-4-6", expected: "claude-opus-4-6" },
    ];

    for (const { input, expected } of testCases) {
      const model = input || DEFAULT_MODEL;
      expect(model).toBe(expected);
    }
  });
});

// ============ 13. Teams 生命周期检测 ============

describe("Teams 多轮 stream — 生命周期信号检测", () => {
  it("official.ts 应包含 detectMultiTurnSignals 函数", () => {
    const officialSource = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");
    expect(officialSource).toContain("detectMultiTurnSignals");
  });

  it("detectTeamsSignals 应检测 TeamCreate → started", () => {
    const officialSource = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");
    expect(officialSource).toContain('"TeamCreate"');
  });

  it("detectTeamsSignals 应检测 TeamDelete → finished", () => {
    const officialSource = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");
    expect(officialSource).toContain('"TeamDelete"');
  });

  it("chat() 应有 isTeamsMode 和 teamsFinished 状态追踪", () => {
    const officialSource = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");
    expect(officialSource).toContain("isTeamsMode");
    expect(officialSource).toContain("teamsFinished");
  });

  it("chat() 应 yield turn_complete 事件标识一轮结束", () => {
    const officialSource = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");
    expect(officialSource).toContain("turn_complete");
  });

  it("chat() 普通对话（非 Teams）：一轮后直接 break", () => {
    const officialSource = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");
    // 非 Teams 模式应直接退出
    expect(officialSource).toMatch(/!isTeamsMode.*break/s);
  });

  it("chat() Teams 模式：TeamDelete 后 break", () => {
    const officialSource = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");
    // Teams 结束后应退出
    expect(officialSource).toMatch(/teamsFinished.*break/s);
  });

  it("安全阀：MAX_DURATION_MS 应存在（防止永远不关闭）", () => {
    const officialSource = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");
    expect(officialSource).toContain("MAX_DURATION_MS");
  });
});

// ============ 14. Teams 多轮交互模拟 ============

describe("Teams 多轮 stream — 模拟交互", () => {
  it("普通对话：一轮 stream 后因无 Teams 信号直接结束", async () => {
    const turn1Messages = [
      { type: "system", session_id: "normal-chat" },
      { type: "assistant", session_id: "normal-chat" },
      { type: "result", session_id: "normal-chat", subtype: "success" },
    ];

    const events: unknown[] = [];
    // 模拟一轮 stream
    for (const msg of turn1Messages) events.push(msg);
    events.push({ type: "turn_complete" });

    // 无 Teams 信号 → isTeamsMode = false → break
    const hasTeams = turn1Messages.some(m => JSON.stringify(m).includes("TeamCreate"));
    expect(hasTeams).toBe(false);
    expect(events).toHaveLength(4);
  });

  it("Teams 对话：检测到 TeamCreate 后继续等待后续轮次", async () => {
    // Turn 1: 包含 TeamCreate tool_use
    const turn1Messages = [
      { type: "system", session_id: "teams-chat" },
      { type: "assistant", message: { content: [
        { type: "tool_use", name: "TeamCreate", input: { team_name: "test" } }
      ] } },
      { type: "result", session_id: "teams-chat" },
    ];

    // Turn 2: teammate 回来
    const turn2Messages = [
      { type: "assistant", session_id: "teams-chat" },
      { type: "result", session_id: "teams-chat" },
    ];

    const allEvents = [...turn1Messages, { type: "turn_complete" }, ...turn2Messages, { type: "turn_complete" }];

    // 检测 Teams 信号
    const hasTeamCreate = turn1Messages.some(m => JSON.stringify(m).includes("TeamCreate"));
    expect(hasTeamCreate).toBe(true);
    expect(allEvents.filter((e: any) => e.type === "turn_complete")).toHaveLength(2);
  });

  it("Teams 结束：检测到 TeamDelete 后停止等待", async () => {
    const finalTurnMessages = [
      { type: "assistant", message: { content: [
        { type: "tool_use", name: "TeamDelete", input: {} }
      ] } },
      { type: "result", session_id: "teams-chat" },
    ];

    const hasTeamDelete = finalTurnMessages.some(m => JSON.stringify(m).includes("TeamDelete"));
    expect(hasTeamDelete).toBe(true);
    // teamsFinished = true → 下一个 result 后 break
  });

  it("detectTeamsSignals 检测逻辑：序列化消息搜索工具名", () => {
    // 模拟 detectTeamsSignals 的逻辑
    function detectTeamsSignals(msg: unknown) {
      const str = JSON.stringify(msg);
      return {
        started: str.includes('"TeamCreate"'),
        finished: str.includes('"TeamDelete"'),
      };
    }

    // TeamCreate 嵌套在 content 中
    const teamCreateMsg = {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "TeamCreate", input: {} }] },
    };
    expect(detectTeamsSignals(teamCreateMsg).started).toBe(true);
    expect(detectTeamsSignals(teamCreateMsg).finished).toBe(false);

    // TeamDelete
    const teamDeleteMsg = {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "TeamDelete", input: {} }] },
    };
    expect(detectTeamsSignals(teamDeleteMsg).started).toBe(false);
    expect(detectTeamsSignals(teamDeleteMsg).finished).toBe(true);

    // 普通消息
    const normalMsg = { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } };
    expect(detectTeamsSignals(normalMsg).started).toBe(false);
    expect(detectTeamsSignals(normalMsg).finished).toBe(false);
  });
});

// ============ 15. SSE 输出兼容 ============

describe("Teams 多轮 stream — SSE 输出兼容", () => {
  it("turn_complete 事件应能 JSON.stringify", () => {
    const event = { type: "turn_complete" };
    const json = JSON.stringify(event);
    expect(json).toBe('{"type":"turn_complete"}');
  });

  it("http-server handleChat 的 for-await 循环应能处理多轮事件", () => {
    const httpSource = readFileSync(join(SRC, "http-server.ts"), "utf-8");
    // Phase 3 多供应商路由后，chat 走按 provider 解析出的 chatAdapter
    expect(httpSource).toMatch(/for\s+await\s*\(.*chatAdapter\.chat/);
  });

  it("chat() while 循环持续调用 stream()，SSE 连接保持打开", () => {
    const officialSource = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");
    // while (true) 循环 + for await stream()
    expect(officialSource).toMatch(/while\s*\(true\)/);
    expect(officialSource).toMatch(/for\s+await.*session\.stream\(\)/);
  });

  it("多轮等待日志：应打印等待消息便于调试", () => {
    const officialSource = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");
    expect(officialSource).toContain("多轮模式：等待下一轮");
  });
});
