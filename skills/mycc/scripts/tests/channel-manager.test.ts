/**
 * ChannelManager 测试
 *
 * 测试通道管理器的核心功能：
 * - register / unregister
 * - broadcast（含 filter 逻辑）
 * - startAll / stopAll
 * - broadcast 错误隔离（单通道失败不影响其他）
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelManager } from "../src/channels/manager";
import type { MessageChannel } from "../src/channels/interface";
import type { SSEEvent } from "../src/adapters/interface";

/** 创建一个 mock channel */
function createMockChannel(
  id: string,
  opts?: {
    filter?: (event: SSEEvent) => boolean;
    sendError?: Error;
    start?: () => Promise<void> | void;
    stop?: () => void;
    startError?: Error;
  }
): MessageChannel & { start?: () => Promise<void> | void; stop?: () => void } {
  const channel: MessageChannel & { start?: () => Promise<void> | void; stop?: () => void } = {
    id,
    send: opts?.sendError
      ? vi.fn().mockRejectedValue(opts.sendError)
      : vi.fn().mockResolvedValue(undefined),
  };

  if (opts?.filter) {
    channel.filter = opts.filter;
  }

  if (opts?.start || opts?.startError) {
    channel.start = opts?.startError
      ? vi.fn().mockRejectedValue(opts.startError)
      : opts?.start || vi.fn().mockResolvedValue(undefined);
  }

  if (opts?.stop) {
    channel.stop = opts.stop;
  }

  return channel;
}

describe("ChannelManager", () => {
  let manager: ChannelManager;

  beforeEach(() => {
    manager = new ChannelManager();
    // suppress console output in tests
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  describe("register / unregister", () => {
    it("注册通道后 size 增加", () => {
      const ch = createMockChannel("web");
      manager.register(ch);
      expect(manager.size).toBe(1);
      expect(manager.has("web")).toBe(true);
    });

    it("注册多个不同 id 的通道", () => {
      manager.register(createMockChannel("web"));
      manager.register(createMockChannel("feishu"));
      expect(manager.size).toBe(2);
      expect(manager.getChannelIds()).toEqual(
        expect.arrayContaining(["web", "feishu"])
      );
    });

    it("相同 id 注册会覆盖", () => {
      const ch1 = createMockChannel("web");
      const ch2 = createMockChannel("web");
      manager.register(ch1);
      manager.register(ch2);
      expect(manager.size).toBe(1);
    });

    it("unregister 已注册的通道", () => {
      const ch = createMockChannel("web");
      manager.register(ch);
      manager.unregister("web");
      expect(manager.size).toBe(0);
      expect(manager.has("web")).toBe(false);
    });

    it("unregister 不存在的通道不报错", () => {
      expect(() => manager.unregister("nonexistent")).not.toThrow();
    });

    it("unregister 时调用通道的 stop 方法", () => {
      const stopFn = vi.fn();
      const ch = createMockChannel("web", { stop: stopFn });
      manager.register(ch);
      manager.unregister("web");
      expect(stopFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("broadcast", () => {
    it("广播消息到所有通道", async () => {
      const ch1 = createMockChannel("web");
      const ch2 = createMockChannel("feishu");
      manager.register(ch1);
      manager.register(ch2);

      const event: SSEEvent = { type: "text", text: "hello" };
      await manager.broadcast(event);

      expect(ch1.send).toHaveBeenCalledWith(event);
      expect(ch2.send).toHaveBeenCalledWith(event);
    });

    it("没有注册通道时广播不报错", async () => {
      await expect(
        manager.broadcast({ type: "text", text: "hello" })
      ).resolves.toBeUndefined();
    });

    it("filter 返回 false 时跳过该通道", async () => {
      const ch1 = createMockChannel("web");
      const ch2 = createMockChannel("feishu", {
        filter: (e) => e.type !== "tool_use",
      });
      manager.register(ch1);
      manager.register(ch2);

      const event: SSEEvent = { type: "tool_use", name: "Bash" };
      await manager.broadcast(event);

      expect(ch1.send).toHaveBeenCalledWith(event);
      expect(ch2.send).not.toHaveBeenCalled();
    });

    it("filter 返回 true 时正常发送", async () => {
      const ch = createMockChannel("feishu", {
        filter: (e) => e.type === "text",
      });
      manager.register(ch);

      const event: SSEEvent = { type: "text", text: "hello" };
      await manager.broadcast(event);

      expect(ch.send).toHaveBeenCalledWith(event);
    });

    it("没有 filter 方法的通道接收所有消息", async () => {
      const ch = createMockChannel("web"); // no filter
      manager.register(ch);

      const events: SSEEvent[] = [
        { type: "text", text: "hello" },
        { type: "tool_use", name: "Bash" },
        { type: "system", session_id: "123" },
      ];

      for (const event of events) {
        await manager.broadcast(event);
      }

      expect(ch.send).toHaveBeenCalledTimes(3);
    });
  });

  describe("broadcast 错误隔离（allSettled）", () => {
    it("单通道 send 失败不影响其他通道", async () => {
      const ch1 = createMockChannel("web");
      const ch2 = createMockChannel("feishu", {
        sendError: new Error("feishu down"),
      });
      manager.register(ch1);
      manager.register(ch2);

      // allSettled：不抛异常，所有通道都会被尝试
      await expect(
        manager.broadcast({ type: "text", text: "hello" })
      ).resolves.toBeUndefined();

      // 两个通道都被调用了
      expect(ch1.send).toHaveBeenCalled();
      expect(ch2.send).toHaveBeenCalled();
    });

    it("多个通道都失败也不抛异常", async () => {
      const ch1 = createMockChannel("web", {
        sendError: new Error("web down"),
      });
      const ch2 = createMockChannel("feishu", {
        sendError: new Error("feishu down"),
      });
      manager.register(ch1);
      manager.register(ch2);

      await expect(
        manager.broadcast({ type: "text", text: "hello" })
      ).resolves.toBeUndefined();
    });
  });

  describe("startAll", () => {
    it("启动所有有 start 方法的通道", async () => {
      const startFn = vi.fn().mockResolvedValue(undefined);
      const ch1 = createMockChannel("web", { start: startFn });
      const ch2 = createMockChannel("feishu", { start: vi.fn().mockResolvedValue(undefined) });
      manager.register(ch1);
      manager.register(ch2);

      await manager.startAll();

      expect(startFn).toHaveBeenCalled();
      expect((ch2 as any).start).toHaveBeenCalled();
    });

    it("没有 start 方法的通道不报错", async () => {
      const ch = createMockChannel("web"); // no start method
      manager.register(ch);

      await expect(manager.startAll()).resolves.toBeUndefined();
    });

    it("单通道启动失败不影响其他通道", async () => {
      const startOk = vi.fn().mockResolvedValue(undefined);
      const ch1 = createMockChannel("web", { start: startOk });
      const ch2 = createMockChannel("feishu", {
        startError: new Error("feishu start failed"),
      });
      manager.register(ch1);
      manager.register(ch2);

      // startAll 不应抛出异常
      await expect(manager.startAll()).resolves.toBeUndefined();
      expect(startOk).toHaveBeenCalled();
    });
  });

  describe("stopAll", () => {
    it("停止所有有 stop 方法的通道", () => {
      const stop1 = vi.fn();
      const stop2 = vi.fn();
      const ch1 = createMockChannel("web", { stop: stop1 });
      const ch2 = createMockChannel("feishu", { stop: stop2 });
      manager.register(ch1);
      manager.register(ch2);

      manager.stopAll();

      expect(stop1).toHaveBeenCalled();
      expect(stop2).toHaveBeenCalled();
    });

    it("没有 stop 方法的通道不报错", () => {
      const ch = createMockChannel("web"); // no stop method
      manager.register(ch);

      expect(() => manager.stopAll()).not.toThrow();
    });
  });

  describe("getChannelIds / has", () => {
    it("getChannelIds 返回所有已注册的通道 ID", () => {
      manager.register(createMockChannel("web"));
      manager.register(createMockChannel("feishu"));

      const ids = manager.getChannelIds();
      expect(ids).toHaveLength(2);
      expect(ids).toContain("web");
      expect(ids).toContain("feishu");
    });

    it("has 对已注册通道返回 true", () => {
      manager.register(createMockChannel("web"));
      expect(manager.has("web")).toBe(true);
      expect(manager.has("feishu")).toBe(false);
    });
  });
});
