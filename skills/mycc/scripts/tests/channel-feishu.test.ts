/**
 * FeishuChannel 测试
 *
 * mock 飞书 SDK（@larksuiteoapi/node-sdk），测试：
 * - 消息过滤逻辑（filter）
 * - 消息发送流程（send）
 * - 图片处理（handleImages）
 * - 表格渲染（parseMarkdownTable）
 * - 环境变量缺失时的降级
 * - start / stop 生命周期
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 捕获 EventDispatcher 注册的事件回调，测试里可直接驱动 WS 事件（多图聚合回归用）
const sdkEvents = vi.hoisted(() => ({ handles: {} as Record<string, (data: unknown) => Promise<void> | void> }));

// mock 飞书 SDK（必须在 import FeishuChannel 之前）
vi.mock("@larksuiteoapi/node-sdk", () => {
  return {
    default: {
      WSClient: vi.fn().mockImplementation(() => ({
        start: vi.fn(),
        close: vi.fn(),
      })),
      EventDispatcher: vi.fn().mockImplementation(() => ({
        register: vi.fn((handles: Record<string, unknown>) => { Object.assign(sdkEvents.handles, handles); }),
      })),
      Domain: { Feishu: "feishu" },
      LoggerLevel: { info: "info" },
    },
  };
});

// mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { FeishuChannel } from "../src/channels/feishu";
import type { SSEEvent } from "../src/adapters/interface";

describe("FeishuChannel", () => {
  let channel: FeishuChannel;
  const validConfig = {
    appId: "test-app-id",
    appSecret: "test-app-secret",
    receiveUserId: "ou_test_user",
    receiveIdType: "open_id" as const,
    connectionMode: "poll" as const,
    showToolUse: true,
    streamingCards: false,  // 静态卡片模式（流式卡片另有专项测试）
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // suppress console output in tests
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("filter 逻辑", () => {
    it("showToolUse=true 时通过 text/content_block_delta/system/assistant/tool_use", () => {
      channel = new FeishuChannel({ ...validConfig, showToolUse: true });

      expect(channel.filter({ type: "text" })).toBe(true);
      expect(channel.filter({ type: "content_block_delta" })).toBe(true);
      expect(channel.filter({ type: "system" })).toBe(true);
      expect(channel.filter({ type: "assistant" })).toBe(true);
      expect(channel.filter({ type: "tool_use" })).toBe(true);
    });

    it("showToolUse=true 时拦截未知类型", () => {
      channel = new FeishuChannel({ ...validConfig, showToolUse: true });

      expect(channel.filter({ type: "unknown" })).toBe(false);
      expect(channel.filter({ type: "result" })).toBe(false);
    });

    it("showToolUse=false 时拦截 tool_use", () => {
      channel = new FeishuChannel({ ...validConfig, showToolUse: false });

      expect(channel.filter({ type: "tool_use" })).toBe(false);
    });

    it("showToolUse=false 时仍通过 text/content_block_delta/system/assistant", () => {
      channel = new FeishuChannel({ ...validConfig, showToolUse: false });

      expect(channel.filter({ type: "text" })).toBe(true);
      expect(channel.filter({ type: "content_block_delta" })).toBe(true);
      expect(channel.filter({ type: "system" })).toBe(true);
      expect(channel.filter({ type: "assistant" })).toBe(true);
    });
  });

  describe("环境变量降级", () => {
    it("没有 appId/appSecret 时 send 静默跳过", async () => {
      channel = new FeishuChannel({
        appId: "",
        appSecret: "",
      });

      // 不应 fetch 也不应报错
      await channel.send({ type: "text", text: "hello" });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("没有 receiveUserId 时 send 静默跳过", async () => {
      channel = new FeishuChannel({
        appId: "id",
        appSecret: "secret",
        receiveUserId: undefined,
      });

      await channel.send({ type: "text", text: "hello" });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("从环境变量构造默认配置", () => {
      const saved = {
        FEISHU_APP_ID: process.env.FEISHU_APP_ID,
        FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET,
        FEISHU_RECEIVE_USER_ID: process.env.FEISHU_RECEIVE_USER_ID,
      };

      try {
        process.env.FEISHU_APP_ID = "env-id";
        process.env.FEISHU_APP_SECRET = "env-secret";
        process.env.FEISHU_RECEIVE_USER_ID = "env-user";

        // 不传 config，从 env 读取
        const ch = new FeishuChannel();

        // 验证 filter 正常工作（说明构造成功）
        expect(ch.filter({ type: "text" })).toBe(true);
      } finally {
        // 精确恢复，避免污染其他测试
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });
  });

  describe("send 消息发送", () => {
    beforeEach(() => {
      channel = new FeishuChannel(validConfig);

      // mock getAccessToken
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("tenant_access_token")) {
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                code: 0,
                tenant_access_token: "test-token",
                expire: 7200,
              }),
          });
        }
        // 默认：发消息成功
        return Promise.resolve({
          json: () => Promise.resolve({ code: 0 }),
        });
      });
    });

    it("发送 text 事件", async () => {
      await channel.send({ type: "text", text: "hello world" });

      // 第一次 fetch 获取 token，第二次发消息
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // 验证发消息的请求
      const sendCall = mockFetch.mock.calls[1];
      expect(sendCall[0]).toContain("/im/v1/messages");
      const body = JSON.parse(sendCall[1].body);
      expect(body.msg_type).toBe("interactive");
      expect(body.receive_id).toBe("ou_test_user");
    });

    it("发送 content_block_delta 事件", async () => {
      await channel.send({
        type: "content_block_delta",
        delta: { text: "partial" },
      });

      // 应该请求 token + 发消息
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("system 事件不发消息（处理图片元数据）", async () => {
      await channel.send({ type: "system", session_id: "abc" });

      // 只获取 token 不发消息（实际上 system 事件有 return 分支，可能不 fetch）
      // system 事件不调用 sendMessageToFeishu，但会检查图片
      // 由于没有 images 字段，直接 return
      // 没有凭据检查后的 fetch
    });

    it("空文本不发送消息", async () => {
      await channel.send({ type: "text", text: "" });

      // text 为空，extractText 返回 ""，不发送
      // 只有 token 请求（如果到了那一步）或者完全不请求
      const sendCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/im/v1/messages?")
      );
      expect(sendCalls).toHaveLength(0);
    });

    it("tool_use 事件在 showToolUse=true 时发送", async () => {
      await channel.send({
        type: "tool_use",
        name: "Bash",
        input: { command: "ls" },
      });

      // token + 1 条消息
      const sendCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/im/v1/messages?")
      );
      expect(sendCalls).toHaveLength(1);
    });

    it("tool_use 事件在 showToolUse=false 时不发送", async () => {
      channel = new FeishuChannel({ ...validConfig, showToolUse: false });

      await channel.send({
        type: "tool_use",
        name: "Bash",
        input: { command: "ls" },
      });

      // 不应发送消息
      const sendCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/im/v1/messages?")
      );
      expect(sendCalls).toHaveLength(0);
    });
  });

  describe("assistant 事件（v2 SDK）", () => {
    beforeEach(() => {
      channel = new FeishuChannel(validConfig);

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("tenant_access_token")) {
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                code: 0,
                tenant_access_token: "test-token",
                expire: 7200,
              }),
          });
        }
        return Promise.resolve({
          json: () => Promise.resolve({ code: 0 }),
        });
      });
    });

    it("发送包含 text block 的 assistant 事件", async () => {
      await channel.send({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Hello from v2" }],
        },
      });

      const sendCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/im/v1/messages?")
      );
      expect(sendCalls).toHaveLength(1);
    });

    it("assistant 事件包含多个 text block 时合并发送", async () => {
      channel = new FeishuChannel(validConfig);
      await channel.send({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Part 1" },
            { type: "text", text: "Part 2" },
          ],
        },
      });

      const sendCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/im/v1/messages?")
      );
      // text block 合并为一条消息，不再逐条发送
      expect(sendCalls).toHaveLength(1);
    });

    it("assistant 事件包含 tool_use block（showToolUse=true）时合并发送", async () => {
      channel = new FeishuChannel(validConfig);
      await channel.send({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Let me check" },
            { type: "tool_use", name: "Read", input: { file: "test.ts" } },
          ],
        },
      });

      const sendCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/im/v1/messages?")
      );
      // text + tool_use 合并为一条消息
      expect(sendCalls).toHaveLength(1);
    });

    it("assistant 事件 tool_use block（showToolUse=false）不发送工具调用", async () => {
      channel = new FeishuChannel({ ...validConfig, showToolUse: false });

      await channel.send({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Let me check" },
            { type: "tool_use", name: "Read", input: { file: "test.ts" } },
          ],
        },
      });

      const sendCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/im/v1/messages?")
      );
      // 只有 text，tool_use 被跳过
      expect(sendCalls).toHaveLength(1);
    });
  });

  describe("图片处理", () => {
    beforeEach(() => {
      channel = new FeishuChannel(validConfig);
    });

    it("system 事件带 images 时上传图片", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("tenant_access_token")) {
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                code: 0,
                tenant_access_token: "test-token",
                expire: 7200,
              }),
          });
        }
        if (url.includes("/im/v1/images")) {
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                code: 0,
                data: { image_key: "img_v3_test" },
              }),
          });
        }
        return Promise.resolve({
          json: () => Promise.resolve({ code: 0 }),
        });
      });

      await channel.send({
        type: "system",
        session_id: "test-session",
        images: [{ data: "base64data", mediaType: "image/png" }],
      });

      // token 1 次 + 上传图片 1 次
      const uploadCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/im/v1/images")
      );
      expect(uploadCalls).toHaveLength(1);
    });
  });

  describe("表格渲染", () => {
    beforeEach(() => {
      channel = new FeishuChannel(validConfig);

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("tenant_access_token")) {
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                code: 0,
                tenant_access_token: "test-token",
                expire: 7200,
              }),
          });
        }
        return Promise.resolve({
          json: () => Promise.resolve({ code: 0 }),
        });
      });
    });

    it("包含 Markdown 表格的文本发送交互卡片", async () => {
      const tableText = [
        "结果如下：",
        "| 名称 | 状态 |",
        "|------|------|",
        "| web | 正常 |",
        "| feishu | 正常 |",
      ].join("\n");

      await channel.send({ type: "text", text: tableText });

      // 应该发送 1 条 interactive 消息
      const sendCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/im/v1/messages?")
      );
      expect(sendCalls).toHaveLength(1);
      const body = JSON.parse(sendCalls[0][1].body);
      expect(body.msg_type).toBe("interactive");
    });

    it("纯文本消息发送 interactive card 格式（schema 2.0）", async () => {
      await channel.send({ type: "text", text: "no table here" });

      const sendCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/im/v1/messages?")
      );
      expect(sendCalls).toHaveLength(1);
      const body = JSON.parse(sendCalls[0][1].body);
      expect(body.msg_type).toBe("interactive");
      const card = JSON.parse(body.content);
      expect(card.schema).toBe("2.0");
    });
  });

  describe("start / stop 生命周期", () => {
    it("没有 appId/appSecret 时 start 直接跳过", async () => {
      channel = new FeishuChannel({ appId: "", appSecret: "" });
      await channel.start();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("凭证有效时 start 获取 token", async () => {
      channel = new FeishuChannel(validConfig);

      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            code: 0,
            tenant_access_token: "valid-token",
            expire: 7200,
          }),
      });

      await channel.start();

      const tokenCalls = mockFetch.mock.calls.filter((call) => String(call[0]).includes("tenant_access_token"));
      expect(tokenCalls).toHaveLength(1);
    });

    it("凭证无效时 start 不启动 WebSocket", async () => {
      channel = new FeishuChannel({
        ...validConfig,
        connectionMode: "websocket",
      });

      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            code: 10003,
            msg: "invalid credentials",
          }),
      });

      await channel.start();

      // 不应尝试创建 WSClient
      // 只调用了一次 fetch（获取 token 失败）
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // 清掉自愈重试定时器，避免 30s 后的重试泄漏进后续用例
      channel.stop();
    });

    it("stop 清理状态", () => {
      channel = new FeishuChannel(validConfig);
      channel.stop();
      // 不应抛出异常
    });

    it("onMessage 设置回调", () => {
      channel = new FeishuChannel(validConfig);
      const cb = vi.fn();
      channel.onMessage(cb);
      // 验证不报错即可（内部状态无法直接检查）
    });
  });

  describe("启动自愈（start 失败自动重试，2026-10-12 断网事故回归）", () => {
    beforeEach(async () => {
      vi.useFakeTimers();
      // 重装 SDK mock（clearAllMocks 会清掉此前的 mockImplementation）
      const Lark = await import("@larksuiteoapi/node-sdk");
      (Lark.default.WSClient as any).mockImplementation(() => ({
        start: vi.fn(),
        close: vi.fn(),
      }));
      (Lark.default.EventDispatcher as any).mockImplementation(() => ({
        register: vi.fn(),
      }));
    });

    afterEach(() => {
      channel.stop();
      vi.useRealTimers();
    });

    it("start 取凭证失败（断网）→ 30s 后自动重试，网络恢复后通道上线", async () => {
      const Lark = await import("@larksuiteoapi/node-sdk");
      channel = new FeishuChannel({
        ...validConfig,
        connectionMode: "websocket" as const,
      });

      // 第一次：网络断了，取 token 抛 fetch failed（同 2026-10-12 事故）
      mockFetch.mockImplementationOnce(() =>
        Promise.reject(new TypeError("fetch failed"))
      );
      await channel.start();

      // 只有一次失败的 token 请求，没建 WSClient
      const tokenCallsAfterFail = mockFetch.mock.calls.filter((c) =>
        String(c[0]).includes("tenant_access_token")
      );
      expect(tokenCallsAfterFail).toHaveLength(1);
      expect(Lark.default.WSClient).not.toHaveBeenCalled();

      // 网络恢复：token + bot info 都成功
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("tenant_access_token")) {
          return { json: async () => ({ code: 0, tenant_access_token: "healed-token", expire: 3600 }) };
        }
        return { json: async () => ({ code: 0, bot: { open_id: "ou_bot" } }) };
      });

      // 30s 重试窗口到期 → 重试成功，WSClient 建起来
      await vi.advanceTimersByTimeAsync(30_000);

      const tokenCallsAfterHeal = mockFetch.mock.calls.filter((c) =>
        String(c[0]).includes("tenant_access_token")
      );
      expect(tokenCallsAfterHeal).toHaveLength(2);
      expect(Lark.default.WSClient).toHaveBeenCalled();
    });

    it("连续失败 → 退避间隔递增 30s→60s→120s", async () => {
      channel = new FeishuChannel(validConfig);
      mockFetch.mockImplementation(() =>
        Promise.reject(new TypeError("fetch failed"))
      );

      await channel.start(); // t=0 失败，安排 30s 后重试

      await vi.advanceTimersByTimeAsync(30_000); // t=30s：第 1 次重试（失败，下次 60s 后）
      expect(mockFetch.mock.calls.length).toBe(2);

      await vi.advanceTimersByTimeAsync(30_000); // t=60s：还不到点，不应重试
      expect(mockFetch.mock.calls.length).toBe(2);

      await vi.advanceTimersByTimeAsync(30_000); // t=90s：第 2 次重试
      expect(mockFetch.mock.calls.length).toBe(3);

      await vi.advanceTimersByTimeAsync(120_000); // t=210s：第 3 次重试（120s 间隔到期）
      expect(mockFetch.mock.calls.length).toBe(4);
    });

    it("stop() 后不再重试", async () => {
      channel = new FeishuChannel(validConfig);
      mockFetch.mockImplementation(() =>
        Promise.reject(new TypeError("fetch failed"))
      );

      await channel.start();
      channel.stop();

      await vi.advanceTimersByTimeAsync(600_000); // 前进 10 分钟
      expect(mockFetch.mock.calls.length).toBe(1); // 只有最初那次失败
    });
  });

  describe("token 过期刷新", () => {
    it("token 过期后重新获取", async () => {
      channel = new FeishuChannel(validConfig);

      let callCount = 0;
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("tenant_access_token")) {
          callCount++;
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                code: 0,
                tenant_access_token: `token-${callCount}`,
                expire: 0, // 立即过期
              }),
          });
        }
        return Promise.resolve({
          json: () => Promise.resolve({ code: 0 }),
        });
      });

      // 第一次 send - 获取 token
      await channel.send({ type: "text", text: "first" });
      // 第二次 send - token 已过期，重新获取
      await channel.send({ type: "text", text: "second" });

      // 应该获取了 2 次 token
      const tokenCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("tenant_access_token")
      );
      expect(tokenCalls).toHaveLength(2);
    });
  });

  describe("clearTypingIndicator", () => {
    it("没有活跃的 typing indicator 时不报错", async () => {
      channel = new FeishuChannel(validConfig);
      await expect(channel.clearTypingIndicator()).resolves.toBeUndefined();
    });
  });

  describe("P0 覆盖率补齐：边界 + 异常", () => {
    beforeEach(() => {
      channel = new FeishuChannel(validConfig);

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("tenant_access_token")) {
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                code: 0,
                tenant_access_token: "test-token",
                expire: 7200,
              }),
          });
        }
        return Promise.resolve({
          json: () => Promise.resolve({ code: 0 }),
        });
      });
    });

    it("assistant 事件缺 message 字段 → 不崩不发消息", async () => {
      await channel.send({
        type: "assistant",
        // 没有 message 字段
      });

      const sendCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/im/v1/messages?")
      );
      expect(sendCalls).toHaveLength(0);
    });

    it("assistant.message 缺 content 数组 → 不崩", async () => {
      await channel.send({
        type: "assistant",
        message: {
          // 没有 content 数组
          role: "assistant",
        },
      });

      const sendCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/im/v1/messages?")
      );
      expect(sendCalls).toHaveLength(0);
    });

    it("content 中有非 text/tool_use block → 跳过不崩", async () => {
      await channel.send({
        type: "assistant",
        message: {
          content: [
            { type: "image", source: { data: "abc" } },
            { type: "text", text: "after image" },
            { type: "thinking", thinking: "hmm" },
          ],
        },
      });

      // 只有 text block 被发送，image 和 thinking 被跳过
      const sendCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/im/v1/messages?")
      );
      expect(sendCalls).toHaveLength(1);

      const body = JSON.parse(sendCalls[0][1].body);
      expect(body.msg_type).toBe("interactive");
    });

    it("sendMessageToFeishu - getAccessToken 返回 null → 返回 false", async () => {
      // 让 token 请求返回非 0 code
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("tenant_access_token")) {
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                code: 10003,
                msg: "invalid credentials",
              }),
          });
        }
        return Promise.resolve({
          json: () => Promise.resolve({ code: 0 }),
        });
      });

      // 强制 token 过期，让 sendMessageToFeishu 重新获取
      channel = new FeishuChannel(validConfig);

      await channel.send({ type: "text", text: "will fail" });

      // 只有 token 请求，不应有消息发送请求
      const sendCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/im/v1/messages?")
      );
      expect(sendCalls).toHaveLength(0);
    });

    it("sendMessageToFeishu - fetch 网络异常 → 不向上抛", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("tenant_access_token")) {
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                code: 0,
                tenant_access_token: "test-token",
                expire: 7200,
              }),
          });
        }
        // 发消息时网络异常
        return Promise.reject(new Error("ECONNREFUSED"));
      });

      channel = new FeishuChannel(validConfig);

      // 不应抛出异常
      await expect(
        channel.send({ type: "text", text: "network error" })
      ).resolves.toBeUndefined();
    });

    it("sendMessageToFeishu - 飞书 API 返回非 0 code → 不崩", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("tenant_access_token")) {
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                code: 0,
                tenant_access_token: "test-token",
                expire: 7200,
              }),
          });
        }
        // 发消息返回错误码
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              code: 230001,
              msg: "bot has no permission",
            }),
        });
      });

      channel = new FeishuChannel(validConfig);

      // 不应抛出异常
      await expect(
        channel.send({ type: "text", text: "no permission" })
      ).resolves.toBeUndefined();

      // 确认发消息请求被发出了
      const sendCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/im/v1/messages?")
      );
      expect(sendCalls).toHaveLength(1);
    });

    it("pendingImages 先发图片再发文字 → 验证顺序", async () => {
      const callOrder: string[] = [];

      mockFetch.mockImplementation((url: string, opts?: any) => {
        if (url.includes("tenant_access_token")) {
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                code: 0,
                tenant_access_token: "test-token",
                expire: 7200,
              }),
          });
        }
        if (url.includes("/im/v1/images")) {
          callOrder.push("upload_image");
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                code: 0,
                data: { image_key: "img_test_key" },
              }),
          });
        }
        if (url.includes("/im/v1/messages?")) {
          const body = JSON.parse(opts?.body || "{}");
          callOrder.push(`send_${body.msg_type}`);
          return Promise.resolve({
            json: () => Promise.resolve({ code: 0 }),
          });
        }
        return Promise.resolve({
          json: () => Promise.resolve({ code: 0 }),
        });
      });

      channel = new FeishuChannel({ ...validConfig, streamingCards: false });

      // Step 1: system 事件带图片 → 上传并缓存 image_key
      await channel.send({
        type: "system",
        session_id: "sess-1",
        images: [{ data: "base64data", mediaType: "image/png" }],
      });

      // Step 2: text 事件 → 触发 sendMessageToFeishu，先发图片再发文字
      await channel.send({
        type: "text",
        text: "这是图片描述",
        session_id: "sess-1",
      });

      // 验证顺序：先上传图片 → 发送图片消息 → 发送文字消息（现在文字走 interactive card）
      expect(callOrder).toEqual(["upload_image", "send_image", "send_interactive"]);
    });

    it("system + images 上传失败 → 不崩", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("tenant_access_token")) {
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                code: 0,
                tenant_access_token: "test-token",
                expire: 7200,
              }),
          });
        }
        if (url.includes("/im/v1/images")) {
          // 上传失败
          return Promise.reject(new Error("upload network error"));
        }
        return Promise.resolve({
          json: () => Promise.resolve({ code: 0 }),
        });
      });

      channel = new FeishuChannel(validConfig);

      // 不应抛出异常
      await expect(
        channel.send({
          type: "system",
          session_id: "sess-1",
          images: [{ data: "base64data", mediaType: "image/png" }],
        })
      ).resolves.toBeUndefined();
    });
  });

  describe("P1 补充：关键异常路径", () => {
    beforeEach(() => {
      channel = new FeishuChannel(validConfig);

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("tenant_access_token")) {
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                code: 0,
                tenant_access_token: "test-token",
                expire: 7200,
              }),
          });
        }
        return Promise.resolve({
          json: () => Promise.resolve({ code: 0 }),
        });
      });
    });

    it("sendMarkdownCardMessage - 飞书 API 返回 code != 0 → 返回 false 不崩", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("tenant_access_token")) {
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                code: 0,
                tenant_access_token: "test-token",
                expire: 7200,
              }),
          });
        }
        // 发消息返回业务错误
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              code: 99991,
              msg: "frequency limit",
            }),
        });
      });

      // 纯文本走 sendMarkdownCardMessage 路径
      await expect(
        channel.send({ type: "text", text: "rate limited message" })
      ).resolves.toBeUndefined();

      // 确认发消息请求被发出了
      const sendCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/im/v1/messages?")
      );
      expect(sendCalls).toHaveLength(1);
      const body = JSON.parse(sendCalls[0][1].body);
      expect(body.msg_type).toBe("interactive"); // 现在所有文本都走 interactive card
    });

    it("sendMarkdownCardMessage - fetch 抛异常（网络中断）→ 不向上抛", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("tenant_access_token")) {
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                code: 0,
                tenant_access_token: "test-token",
                expire: 7200,
              }),
          });
        }
        // 发消息时网络中断
        return Promise.reject(new Error("ETIMEDOUT"));
      });

      await expect(
        channel.send({ type: "text", text: "timeout message" })
      ).resolves.toBeUndefined();
    });

    it("sendInteractiveCard - 飞书 API 返回 code != 0 → 不崩", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("tenant_access_token")) {
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                code: 0,
                tenant_access_token: "test-token",
                expire: 7200,
              }),
          });
        }
        // 发卡片返回错误
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              code: 230002,
              msg: "card format error",
            }),
        });
      });

      // 含表格的文本走 sendInteractiveCard 路径
      const tableText = [
        "结果：",
        "| 名称 | 状态 |",
        "|------|------|",
        "| web | OK |",
      ].join("\n");

      await expect(
        channel.send({ type: "text", text: tableText })
      ).resolves.toBeUndefined();

      // 确认发了 interactive 消息
      const sendCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/im/v1/messages?")
      );
      expect(sendCalls).toHaveLength(1);
      const body = JSON.parse(sendCalls[0][1].body);
      expect(body.msg_type).toBe("interactive");
    });

    it("start() websocket 模式 + 凭证有效 → 创建 WSClient", async () => {
      // 重新设置 mock（clearAllMocks 会清除 mockImplementation）
      const Lark = await import("@larksuiteoapi/node-sdk");
      (Lark.default.WSClient as any).mockImplementation(() => ({
        start: vi.fn(),
        close: vi.fn(),
      }));
      (Lark.default.EventDispatcher as any).mockImplementation(() => ({
        register: vi.fn(),
      }));

      channel = new FeishuChannel({
        ...validConfig,
        connectionMode: "websocket",
      });

      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            code: 0,
            tenant_access_token: "ws-token",
            expire: 7200,
          }),
      });

      await channel.start();

      // token 获取成功
      const tokenCalls = mockFetch.mock.calls.filter((call) => String(call[0]).includes("tenant_access_token"));
      expect(tokenCalls).toHaveLength(1);
      // WSClient 和 EventDispatcher 应该被创建
      expect(Lark.default.WSClient).toHaveBeenCalled();
      expect(Lark.default.EventDispatcher).toHaveBeenCalled();
    });

    it("stop() 有 wsClient 时调用 close()", async () => {
      // 重新设置 mock
      const Lark = await import("@larksuiteoapi/node-sdk");
      (Lark.default.WSClient as any).mockImplementation(() => ({
        start: vi.fn(),
        close: vi.fn(),
      }));
      (Lark.default.EventDispatcher as any).mockImplementation(() => ({
        register: vi.fn(),
      }));

      channel = new FeishuChannel({
        ...validConfig,
        connectionMode: "websocket",
      });

      // 先启动 websocket
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            code: 0,
            tenant_access_token: "ws-token",
            expire: 7200,
          }),
      });

      await channel.start();

      // 获取 mock 的 WSClient 实例
      const wsClientInstance = (Lark.default.WSClient as any).mock.results[0]?.value;

      // 停止通道
      channel.stop();

      // wsClient.close() 应该被调用
      expect(wsClientInstance.close).toHaveBeenCalled();
    });

    it("stop() wsClient.close() 抛异常 → 不崩", async () => {
      // 重新设置 mock
      const Lark = await import("@larksuiteoapi/node-sdk");
      (Lark.default.WSClient as any).mockImplementation(() => ({
        start: vi.fn(),
        close: vi.fn(),
      }));
      (Lark.default.EventDispatcher as any).mockImplementation(() => ({
        register: vi.fn(),
      }));

      channel = new FeishuChannel({
        ...validConfig,
        connectionMode: "websocket",
      });

      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            code: 0,
            tenant_access_token: "ws-token",
            expire: 7200,
          }),
      });

      await channel.start();

      // 让 close() 抛异常
      const wsClientInstance = (Lark.default.WSClient as any).mock.results[0]?.value;
      wsClientInstance.close.mockImplementation(() => {
        throw new Error("ws close failed");
      });

      // 不应抛出异常
      expect(() => channel.stop()).not.toThrow();
    });

    it("clearTypingIndicator 有活跃 indicator 时调用 removeTypingIndicator", async () => {
      channel = new FeishuChannel(validConfig);

      // 模拟有活跃 indicator（通过设置内部状态）
      // addTypingIndicator 会设置 currentMessageId 和 currentReactionId
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("tenant_access_token")) {
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                code: 0,
                tenant_access_token: "test-token",
                expire: 7200,
              }),
          });
        }
        if (url.includes("/reactions")) {
          if (url.includes("DELETE") || !url.includes("msg-id")) {
            // DELETE 请求（清理）
            return Promise.resolve({
              json: () => Promise.resolve({ code: 0 }),
            });
          }
          // POST 请求（添加表态）
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                code: 0,
                data: { reaction_id: "reaction-123" },
              }),
          });
        }
        return Promise.resolve({
          json: () => Promise.resolve({ code: 0 }),
        });
      });

      // 通过反射设置内部状态（typingReactions 按 messageId 记录，支持多会话并发）
      (channel as any).typingReactions.set("msg-123", "reaction-456");

      await channel.clearTypingIndicator();

      // 应该发起 DELETE 请求删除表态
      const deleteCalls = mockFetch.mock.calls.filter(
        (c: any[]) =>
          typeof c[0] === "string" &&
          c[0].includes("/reactions/reaction-456") &&
          c[1]?.method === "DELETE"
      );
      expect(deleteCalls).toHaveLength(1);

      // 内部状态应该被清除
      expect((channel as any).typingReactions.size).toBe(0);
    });

    it("text 事件含 Markdown 表格 → 走 schema 2.0 markdown 卡片路径", async () => {
      const tableText = [
        "以下是分析结果：",
        "",
        "| 指标 | 值 | 变化 |",
        "|------|-----|------|",
        "| DAU | 1200 | +5% |",
        "| 留存 | 45% | -2% |",
        "",
        "整体表现良好。",
      ].join("\n");

      await channel.send({ type: "text", text: tableText });

      const sendCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/im/v1/messages?")
      );
      expect(sendCalls).toHaveLength(1);
      const body = JSON.parse(sendCalls[0][1].body);
      expect(body.msg_type).toBe("interactive");

      // 验证是 schema 2.0 markdown 卡片，表格内容保留在 markdown 中
      const card = JSON.parse(body.content);
      expect(card.schema).toBe("2.0");
      // 2026-10-31 表格转换：markdown 表格升级为原生 table 组件（body 根级）
      const tableElement = card.body.elements.find((e: any) => e.tag === "table");
      expect(tableElement).toBeDefined();
      expect(tableElement.rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(tableElement)).toContain("DAU");
      expect(JSON.stringify(tableElement)).toContain("留存");
    });

    it("parseMarkdownTable 表格前后有文字 → schema 2.0 卡片包含完整内容", async () => {
      const textWithTable = [
        "前置文字第一行",
        "前置文字第二行",
        "",
        "| A | B |",
        "|---|---|",
        "| 1 | 2 |",
        "",
        "后置文字",
      ].join("\n");

      await channel.send({ type: "text", text: textWithTable });

      const sendCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/im/v1/messages?")
      );
      expect(sendCalls).toHaveLength(1);
      const body = JSON.parse(sendCalls[0][1].body);
      expect(body.msg_type).toBe("interactive");

      const card = JSON.parse(body.content);
      expect(card.schema).toBe("2.0");
      // 2026-10-31 表格转换：markdown 表格升级为原生 table 组件（body 根级）
      const tableElement = card.body.elements.find((e: any) => e.tag === "table");
      expect(tableElement).toBeDefined();
      expect(tableElement.rows.length).toBeGreaterThan(0);
      // 前置文字、表格内容、后置文字都在 markdown 中
      const bodyText = JSON.stringify(card.body.elements);
      expect(bodyText).toContain("前置文字");
      expect(bodyText).toContain("后置文字");
    });

    it("parseMarkdownTable 多列复杂表格 → schema 2.0 卡片保留表格内容", async () => {
      const complexTable = [
        "| 项目 | 负责人 | 状态 | 截止日期 | 备注 |",
        "|------|--------|------|----------|------|",
        "| 登录 | 张三 | 完成 | 2026-01 | 已上线 |",
        "| 支付 | 李四 | 进行中 | 2026-02 | 联调中 |",
        "| 报表 | 王五 | 待开始 | 2026-03 | 排期中 |",
      ].join("\n");

      await channel.send({ type: "text", text: complexTable });

      const sendCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/im/v1/messages?")
      );
      expect(sendCalls).toHaveLength(1);
      const body = JSON.parse(sendCalls[0][1].body);
      expect(body.msg_type).toBe("interactive");

      const card = JSON.parse(body.content);
      expect(card.schema).toBe("2.0");
      // 2026-10-31 表格转换：markdown 表格升级为原生 table 组件（body 根级）
      const tableElement = card.body.elements.find((e: any) => e.tag === "table");
      expect(tableElement).toBeDefined();
      expect(tableElement.rows.length).toBeGreaterThan(0);
      // 验证表格内容保留
      expect(JSON.stringify(tableElement.rows)).toContain("登录");
      expect(JSON.stringify(tableElement.rows)).toContain("李四");
      expect(JSON.stringify(tableElement.rows)).toContain("待开始");
    });
  });

  describe("多图消息聚合（MEDIA_BUFFER_DELAY 回归）", () => {
    // 复现 2026-10-09 丢图根因：飞书把一次多图拆成多条 image 事件，300ms 窗口
    // 等不齐 → 每张图各自成批。修复后含图片/文件的缓冲走 2s 长窗口聚成一批。

    const makeImageEvent = (n: number) => ({
      sender: { sender_id: { open_id: "ou_sender" } },
      message: {
        message_id: `om_img_${n}`,
        chat_id: "oc_agg_chat",
        chat_type: "p2p",
        message_type: "image",
        content: JSON.stringify({ image_key: `img_key_${n}` }),
      },
    });

    const makeTextEvent = (text: string) => ({
      sender: { sender_id: { open_id: "ou_sender" } },
      message: {
        message_id: `om_text_${Math.random().toString(36).slice(2, 8)}`,
        chat_id: "oc_agg_chat",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text }),
      },
    });

    beforeEach(async () => {
      vi.useFakeTimers();
      // 外层 afterEach 的 vi.restoreAllMocks 会把 vi.mock 工厂里 EventDispatcher/WSClient
      // 的 mockImplementation 一并清掉（此前跑过的用例越多丢得越干净），这里每用例重装
      const Lark = await import("@larksuiteoapi/node-sdk");
      vi.mocked(Lark.default.EventDispatcher).mockImplementation((() => ({
        register: (h: Record<string, unknown>) => { Object.assign(sdkEvents.handles, h); },
      })) as any);
      vi.mocked(Lark.default.WSClient).mockImplementation((() => ({
        start: vi.fn(),
        close: vi.fn(),
      })) as any);
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("/auth/v3/tenant_access_token")) {
          return { ok: true, json: async () => ({ code: 0, tenant_access_token: "t-token", expire: 3600 }) };
        }
        if (url.includes("/resources/")) {
          return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
        }
        // typing 表态 / bot info 等其余 API：成功空响应即可（失败也会被静默 catch）
        return { ok: true, json: async () => ({ code: 0, bot: { open_id: "ou_bot" } }) };
      });
      channel = new FeishuChannel({ ...validConfig, connectionMode: "websocket" as const });
      await channel.start();
    });

    afterEach(() => {
      channel.stop();
      vi.useRealTimers();
    });

    it("多条图片事件间隔 800ms 到达 → 只 flush 一次，一批带全部图", async () => {
      const received: Array<{ text: string; images?: Array<unknown> }> = [];
      channel.onMessage((text, images) => { received.push({ text, images }); });
      const handler = sdkEvents.handles["im.message.receive_v1"];
      expect(handler).toBeDefined();

      await handler!(makeImageEvent(1));
      await vi.advanceTimersByTimeAsync(800);
      await handler!(makeImageEvent(2));
      await vi.advanceTimersByTimeAsync(800);
      await handler!(makeImageEvent(3));

      // 图1(t=0) 图2(t=800) 图3(t=1600)，每次到达都重置 2s 窗 → 此刻未 flush
      expect(received).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(2000); // t=3600，图3 的窗口到期
      expect(received).toHaveLength(1);
      expect(received[0].images).toHaveLength(3);
    });

    it("单张图片也走长窗口：300ms 旧窗口时间点不 flush，2s 后一次带 1 图", async () => {
      const received: Array<{ text: string; images?: Array<unknown> }> = [];
      channel.onMessage((text, images) => { received.push({ text, images }); });
      const handler = sdkEvents.handles["im.message.receive_v1"];

      await handler!(makeImageEvent(1));
      await vi.advanceTimersByTimeAsync(300);
      expect(received).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1700);
      expect(received).toHaveLength(1);
      expect(received[0].images).toHaveLength(1);
    });

    it("图后跟文字：缓冲含图时文字到达仍保持长窗口，图+文字合并成一批", async () => {
      const received: Array<{ text: string; images?: Array<unknown> }> = [];
      channel.onMessage((text, images) => { received.push({ text, images }); });
      const handler = sdkEvents.handles["im.message.receive_v1"];

      await handler!(makeImageEvent(1));
      await vi.advanceTimersByTimeAsync(1500);
      await handler!(makeTextEvent("这两张是今天的情绪记录"));

      await vi.advanceTimersByTimeAsync(300); // 文字到达后 300ms：buffer 含图，仍不 flush
      expect(received).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1700); // 长窗口到期
      expect(received).toHaveLength(1);
      expect(received[0].images).toHaveLength(1);
      expect(received[0].text).toContain("情绪记录");
    });

    it("纯文字消息仍用 300ms 短窗口", async () => {
      const received: Array<{ text: string; images?: Array<unknown> }> = [];
      channel.onMessage((text, images) => { received.push({ text, images }); });
      const handler = sdkEvents.handles["im.message.receive_v1"];

      await handler!(makeTextEvent("你好"));
      await vi.advanceTimersByTimeAsync(400);
      expect(received).toHaveLength(1);
      expect(received[0].text).toBe("你好");
    });
  });

  describe("post 富文本消息解析（图文混排）", () => {
    // 2026-10-09 前 post 直接 return null 整条丢弃；现在提取文字+下载全部 img 段

    const makePostEvent = (post: unknown) => ({
      sender: { sender_id: { open_id: "ou_sender" } },
      message: {
        message_id: "om_post_1",
        chat_id: "oc_post_chat",
        chat_type: "p2p",
        message_type: "post",
        content: JSON.stringify(post),
      },
    });

    beforeEach(() => {
      // 直调 parseFeishuMessage：预置 token 绕过 getAccessToken
      channel = new FeishuChannel({ ...validConfig });
      (channel as any).accessToken = "preset-token";
      (channel as any).tokenExpireTime = Date.now() + 3600_000;
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("/resources/")) {
          return { ok: true, arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer };
        }
        return { ok: true, json: async () => ({ code: 0 }) };
      });
    });

    it("图文混排：文字按段落拼接 + 所有 img 段并行下载", async () => {
      const parsed = await (channel as any).parseFeishuMessage(makePostEvent({
        title: "今天的记录",
        content: [
          [
            { tag: "text", text: "识别这两张：" },
            { tag: "img", image_key: "img_key_a" },
          ],
          [
            { tag: "text", text: "链接 " },
            { tag: "a", text: "参考", href: "https://example.com" },
            { tag: "img", image_key: "img_key_b" },
          ],
        ],
      }), "om_post_1");

      expect(parsed.text).toBe("今天的记录\n识别这两张：\n链接 参考(https://example.com)");
      expect(parsed.images).toHaveLength(2);
      const resourceCalls = mockFetch.mock.calls.filter((c: any[]) => typeof c[0] === "string" && c[0].includes("/resources/"));
      expect(resourceCalls).toHaveLength(2);
      expect(resourceCalls[0][0]).toContain("img_key_a");
      expect(resourceCalls[1][0]).toContain("img_key_b");
    });

    it("纯文字 post：无图片下载，只返回文字", async () => {
      const parsed = await (channel as any).parseFeishuMessage(makePostEvent({
        content: [[{ tag: "text", text: "只是说句话" }]],
      }), "om_post_1");

      expect(parsed.text).toBe("只是说句话");
      expect(parsed.images).toBeUndefined();
    });

    it("media/文件段：跳过并在文字中标注数量", async () => {
      const parsed = await (channel as any).parseFeishuMessage(makePostEvent({
        content: [
          [
            { tag: "text", text: "带视频的" },
            { tag: "media", file_key: "file_v1", name: "a.mp4" },
          ],
        ],
      }), "om_post_1");

      expect(parsed.text).toContain("带视频的");
      expect(parsed.text).toContain("1 个媒体/文件段");
      expect(parsed.images).toBeUndefined();
    });

    it("空 post / 异常结构：返回空文本不崩溃", async () => {
      const parsed = await (channel as any).parseFeishuMessage(makePostEvent({ content: [] }), "om_post_1");
      expect(parsed).toEqual({ text: "" });
      const parsed2 = await (channel as any).parseFeishuMessage(makePostEvent(null), "om_post_1");
      expect(parsed2).toEqual({ text: "" });
    });
  });
});
