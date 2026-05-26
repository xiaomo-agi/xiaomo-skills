/**
 * WebChannel 测试
 *
 * 测试 Web 通道的核心功能：
 * - send：SSE 事件写入 HTTP 响应
 * - session_id 提取
 * - sendDone / sendError
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { WebChannel } from "../src/channels/web";
import type { SSEEvent } from "../src/adapters/interface";

/** 创建一个 mock ServerResponse */
function createMockResponse() {
  return {
    write: vi.fn().mockReturnValue(true),
    end: vi.fn(),
    // 其他常见属性
    headersSent: false,
    statusCode: 200,
  };
}

describe("WebChannel", () => {
  let res: ReturnType<typeof createMockResponse>;
  let channel: WebChannel;

  beforeEach(() => {
    res = createMockResponse();
    channel = new WebChannel({ res: res as any });
  });

  describe("基本属性", () => {
    it("id 为 web", () => {
      expect(channel.id).toBe("web");
    });

    it("初始 sessionId 为 undefined", () => {
      expect(channel.getSessionId()).toBeUndefined();
    });
  });

  describe("send", () => {
    it("将事件序列化为 SSE 格式写入响应", async () => {
      const event: SSEEvent = { type: "text", text: "hello" };
      await channel.send(event);

      expect(res.write).toHaveBeenCalledTimes(1);
      const written = res.write.mock.calls[0][0] as string;
      expect(written).toMatch(/^data: /);
      expect(written).toMatch(/\n\n$/);

      // 验证 JSON 内容
      const json = JSON.parse(written.replace(/^data: /, "").trim());
      expect(json.type).toBe("text");
      expect(json.text).toBe("hello");
    });

    it("多次 send 写入多条 SSE 事件", async () => {
      await channel.send({ type: "text", text: "a" });
      await channel.send({ type: "text", text: "b" });

      expect(res.write).toHaveBeenCalledTimes(2);
    });

    it("send 后不调用 end", async () => {
      await channel.send({ type: "text", text: "hello" });
      expect(res.end).not.toHaveBeenCalled();
    });
  });

  describe("session_id 提取", () => {
    it("从 system 事件中提取 session_id", async () => {
      const event: SSEEvent = {
        type: "system",
        session_id: "abc-123",
      };
      await channel.send(event);

      expect(channel.getSessionId()).toBe("abc-123");
    });

    it("非 system 事件不更新 session_id", async () => {
      const event: SSEEvent = { type: "text", text: "hello" };
      await channel.send(event);

      expect(channel.getSessionId()).toBeUndefined();
    });

    it("setSessionId 可以手动设置", () => {
      channel.setSessionId("manual-id");
      expect(channel.getSessionId()).toBe("manual-id");
    });

    it("system 事件覆盖手动设置的 session_id", async () => {
      channel.setSessionId("old-id");

      await channel.send({
        type: "system",
        session_id: "new-id",
      });

      expect(channel.getSessionId()).toBe("new-id");
    });
  });

  describe("sendDone", () => {
    it("发送 done 事件并关闭连接", async () => {
      channel.setSessionId("test-session");
      await channel.sendDone();

      expect(res.write).toHaveBeenCalledTimes(1);
      const written = res.write.mock.calls[0][0] as string;
      const json = JSON.parse(written.replace(/^data: /, "").trim());
      expect(json.type).toBe("done");
      expect(json.sessionId).toBe("test-session");

      expect(res.end).toHaveBeenCalledTimes(1);
    });

    it("没有 session_id 时 done 事件的 sessionId 为 undefined", async () => {
      await channel.sendDone();

      const written = res.write.mock.calls[0][0] as string;
      const json = JSON.parse(written.replace(/^data: /, "").trim());
      expect(json.type).toBe("done");
      expect(json.sessionId).toBeUndefined();
    });
  });

  describe("sendError", () => {
    it("发送 error 事件并关闭连接", async () => {
      await channel.sendError("something went wrong");

      expect(res.write).toHaveBeenCalledTimes(1);
      const written = res.write.mock.calls[0][0] as string;
      const json = JSON.parse(written.replace(/^data: /, "").trim());
      expect(json.type).toBe("error");
      expect(json.error).toBe("something went wrong");

      expect(res.end).toHaveBeenCalledTimes(1);
    });
  });

  describe("无 filter 方法", () => {
    it("WebChannel 不定义 filter，接收所有消息", () => {
      // WebChannel 的 filter 属性应为 undefined
      expect(channel.filter).toBeUndefined();
    });
  });

  describe("P1 补充：异常路径", () => {
    it("res.write 抛异常时 send 向上传播", async () => {
      const errorRes = createMockResponse();
      errorRes.write.mockImplementation(() => {
        throw new Error("client disconnected");
      });
      const errorChannel = new WebChannel({ res: errorRes as any });

      // send 内部没有 try/catch，异常会向上传播
      await expect(
        errorChannel.send({ type: "text", text: "will fail" })
      ).rejects.toThrow("client disconnected");
    });
  });
});
