/**
 * 清理器不杀正在干活的会话（2026-07-02 实测复现的 bug 回归测试）
 *
 * bug：cleanupExpiredSessions 只看 lastActivity，而 lastActivity 在回合进行中
 * 不刷新，长任务（>15 分钟）会被清理器中途 abort，用户端回复凭空消失。
 * 修复：回合进行中的 session 打 inFlight 标记，清理器跳过并刷新其活跃时间。
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { OfficialAdapter } from "../src/adapters/official.js";

const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

describe("official.ts: 清理器跳过回合进行中的会话", () => {
  let adapter: OfficialAdapter | null = null;

  afterEach(() => {
    adapter?.closeAllSessions();
    adapter = null;
  });

  function setup() {
    adapter = new OfficialAdapter();
    const a = adapter as any;
    const close = vi.fn();
    a.sessions.set("s1", { close });
    // 模拟"最后活跃时间已超时"（回合开始后一直在跑工具，没有新事件）
    a.lastActivity.set("s1", Date.now() - SESSION_TIMEOUT_MS - 60_000);
    return { a, close };
  }

  it("回合进行中（inFlight>0）：不清理，且刷新活跃时间", () => {
    const { a, close } = setup();
    a.markInFlight("s1", +1);

    a.cleanupExpiredSessions();

    expect(close).not.toHaveBeenCalled();
    expect(a.sessions.has("s1")).toBe(true);
    expect(Date.now() - a.lastActivity.get("s1")).toBeLessThan(1000);
  });

  it("回合结束（inFlight 归零）：超时会话正常清理", () => {
    const { a, close } = setup();
    a.markInFlight("s1", +1);
    a.markInFlight("s1", -1);

    a.cleanupExpiredSessions();

    expect(close).toHaveBeenCalled();
    expect(a.sessions.has("s1")).toBe(false);
  });

  it("未标记的超时会话仍然被清理（原有行为不变）", () => {
    const { a, close } = setup();

    a.cleanupExpiredSessions();

    expect(close).toHaveBeenCalled();
  });

  it("markInFlight 计数正确增减，归零后从 Map 删除", () => {
    adapter = new OfficialAdapter();
    const a = adapter as any;

    a.markInFlight("s1", +1);
    a.markInFlight("s1", +1);
    expect(a.inFlight.get("s1")).toBe(2);

    a.markInFlight("s1", -1);
    expect(a.inFlight.get("s1")).toBe(1);

    a.markInFlight("s1", -1);
    expect(a.inFlight.has("s1")).toBe(false);
  });

  it("chat() 源码：进行中标记在 finally 中释放，异常也不会泄漏", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const source = readFileSync(
      join(import.meta.dirname, "..", "src", "adapters", "official.ts"),
      "utf-8"
    );
    expect(source).toMatch(/finally\s*\{[^}]*markInFlight\(inFlightId, -1\)/);
  });
});
