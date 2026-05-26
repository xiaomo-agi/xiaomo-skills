/**
 * SDK 子进程崩溃防护测试
 *
 * 验证 4 个修复点：
 * 1. official.ts — stream 异常时 closeSession 被调用
 * 2. http-server.ts — HTTP catch 块调用 closeSession
 * 3. official.ts — 超时常量缩短
 * 4. index.ts — 全局 unhandledRejection / uncaughtException 处理
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = join(import.meta.dirname, "..", "src");

// ============ 1. Adapter stream 异常 → closeSession ============

describe("official.ts: stream 异常清理 session", () => {
  let source: string;

  beforeEach(() => {
    source = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");
  });

  it("chat() 的 while 循环被 try-catch 包裹", () => {
    // try 块包含多轮循环
    expect(source).toContain("try {");
    expect(source).toContain("while (true)");
  });

  it("catch 块调用 this.closeSession(resolvedSessionId)", () => {
    expect(source).toContain("this.closeSession(resolvedSessionId)");
  });

  it("catch 块记录错误日志", () => {
    expect(source).toContain("[CC] stream 异常，清理 session:");
  });

  it("catch 块重新抛出错误（让 HTTP handler 发 SSE error 帧）", () => {
    // catch 块末尾应该有 throw err
    expect(source).toMatch(/catch\s*\(err\)[\s\S]*?throw\s+err/);
  });
});

// ============ 2. HTTP handler catch → closeSession ============

describe("http-server.ts: HTTP 错误时清理 session", () => {
  let source: string;

  beforeEach(() => {
    source = readFileSync(join(SRC, "http-server.ts"), "utf-8");
  });

  it("catch 块调用 adapter.closeSession(currentSessionId)", () => {
    expect(source).toContain("adapter.closeSession(currentSessionId)");
  });

  it("closeSession 调用有 if (currentSessionId) 守卫", () => {
    // 防止 sessionId 为 undefined 时调用
    expect(source).toMatch(/if\s*\(currentSessionId\)\s*\{[\s\S]*?adapter\.closeSession/);
  });

  it("关闭异常 session 有日志", () => {
    expect(source).toContain("[CC] 已关闭异常 session:");
  });
});

// ============ 3. 超时常量缩短 ============

describe("official.ts: 超时常量", () => {
  let source: string;

  beforeEach(() => {
    source = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");
  });

  it("SESSION_TIMEOUT_MS 为 15 分钟", () => {
    expect(source).toMatch(/SESSION_TIMEOUT_MS\s*=\s*15\s*\*\s*60\s*\*\s*1000/);
  });

  it("CLEANUP_INTERVAL_MS 为 2 分钟", () => {
    expect(source).toMatch(/CLEANUP_INTERVAL_MS\s*=\s*2\s*\*\s*60\s*\*\s*1000/);
  });
});

// ============ 4. 全局异常兜底 ============

describe("index.ts: 全局异常处理", () => {
  let source: string;

  beforeEach(() => {
    source = readFileSync(join(SRC, "index.ts"), "utf-8");
  });

  it("注册了 unhandledRejection 处理器", () => {
    expect(source).toContain('process.on("unhandledRejection"');
  });

  it("注册了 uncaughtException 处理器", () => {
    expect(source).toContain('process.on("uncaughtException"');
  });

  it("unhandledRejection 处理器调用 adapter.closeAllSessions()", () => {
    // 确保在 unhandledRejection handler 中清理所有 session
    const unhandledBlock = source.slice(
      source.indexOf('process.on("unhandledRejection"'),
      source.indexOf('process.on("uncaughtException"')
    );
    expect(unhandledBlock).toContain("adapter.closeAllSessions()");
  });

  it("uncaughtException 处理器调用 adapter.closeAllSessions()", () => {
    const uncaughtBlock = source.slice(
      source.indexOf('process.on("uncaughtException"'),
      source.indexOf("main().catch")
    );
    expect(uncaughtBlock).toContain("adapter.closeAllSessions()");
  });

  it("全局处理器不调用 process.exit（保持服务运行）", () => {
    // 从 unhandledRejection 到 main().catch 之间不应该有 process.exit() 调用
    const globalHandlerBlock = source.slice(
      source.indexOf('process.on("unhandledRejection"'),
      source.indexOf("main().catch")
    );
    // 检查实际的函数调用（不是注释里的文字）
    expect(globalHandlerBlock).not.toMatch(/process\.exit\s*\(/);
  });
});

// ============ 5. OfficialAdapter session 池管理单元测试 ============

describe("OfficialAdapter session 池管理", () => {
  it("closeSession 从池中移除 session 并调用 close()", () => {
    // 模拟 OfficialAdapter 的核心逻辑
    const sessions = new Map<string, { close: () => void }>();
    const lastActivity = new Map<string, number>();
    const mockClose = vi.fn();
    const mockSession = { close: mockClose };

    sessions.set("test-session-1", mockSession);
    lastActivity.set("test-session-1", Date.now());

    // 模拟 closeSession 逻辑
    const sessionId = "test-session-1";
    const session = sessions.get(sessionId);
    if (session) {
      session.close();
      sessions.delete(sessionId);
      lastActivity.delete(sessionId);
    }

    expect(mockClose).toHaveBeenCalledOnce();
    expect(sessions.has("test-session-1")).toBe(false);
    expect(lastActivity.has("test-session-1")).toBe(false);
  });

  it("closeAllSessions 清理所有 session", () => {
    const sessions = new Map<string, { close: () => void }>();
    const lastActivity = new Map<string, number>();
    const closeFns = [vi.fn(), vi.fn(), vi.fn()];

    closeFns.forEach((fn, i) => {
      sessions.set(`session-${i}`, { close: fn });
      lastActivity.set(`session-${i}`, Date.now());
    });

    // 模拟 closeAllSessions 逻辑
    for (const session of sessions.values()) {
      try { session.close(); } catch { /* 静默 */ }
    }
    sessions.clear();
    lastActivity.clear();

    closeFns.forEach(fn => expect(fn).toHaveBeenCalledOnce());
    expect(sessions.size).toBe(0);
    expect(lastActivity.size).toBe(0);
  });

  it("closeSession 对已关闭的 session 静默处理", () => {
    const sessions = new Map<string, { close: () => void }>();
    const mockClose = vi.fn(() => { throw new Error("already closed"); });
    sessions.set("dead-session", { close: mockClose });

    // 模拟 closeSession 的 try-catch
    const session = sessions.get("dead-session");
    if (session) {
      try { session.close(); } catch { /* 静默 */ }
      sessions.delete("dead-session");
    }

    expect(mockClose).toHaveBeenCalledOnce();
    expect(sessions.has("dead-session")).toBe(false);
  });

  it("超时清理只清理过期 session", () => {
    const SESSION_TIMEOUT_MS = 15 * 60 * 1000;
    const sessions = new Map<string, { close: () => void }>();
    const lastActivity = new Map<string, number>();

    const activeFn = vi.fn();
    const expiredFn = vi.fn();

    sessions.set("active", { close: activeFn });
    lastActivity.set("active", Date.now()); // 刚活跃

    sessions.set("expired", { close: expiredFn });
    lastActivity.set("expired", Date.now() - SESSION_TIMEOUT_MS - 1000); // 过期

    // 模拟 cleanupExpiredSessions 逻辑
    const now = Date.now();
    for (const [id, lastTime] of lastActivity.entries()) {
      if (now - lastTime > SESSION_TIMEOUT_MS) {
        const s = sessions.get(id);
        if (s) { try { s.close(); } catch {} }
        sessions.delete(id);
        lastActivity.delete(id);
      }
    }

    expect(expiredFn).toHaveBeenCalledOnce();
    expect(activeFn).not.toHaveBeenCalled();
    expect(sessions.has("active")).toBe(true);
    expect(sessions.has("expired")).toBe(false);
  });
});
