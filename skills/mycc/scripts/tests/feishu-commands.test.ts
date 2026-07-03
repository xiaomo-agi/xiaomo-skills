/**
 * FeishuCommands 单元测试
 *
 * 验证从 HttpServer 提取的飞书命令模块：
 * - 命令解析与分发（/new, /sessions, /switch, /current, /device, /help）
 * - 普通消息走 adapter.chat
 * - 无活跃 session 时自动选择最近历史
 * - 错误处理
 * - currentSessionId 的读写
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import type { FeishuCommandsDeps } from "../src/channels/feishu-commands.js";
import { FeishuCommands } from "../src/channels/feishu-commands.js";

/** 会话/模型持久化文件（测试前清理，避免测试间状态泄漏） */
/** 必须跟 src 侧一致地读 MYCC_DATA_DIR（tests/setup.ts 已重定向到临时目录），
 *  否则清理逻辑会绕过重定向、直接删生产环境的 src/data/ 文件 */
const DATA_DIR = process.env.MYCC_DATA_DIR || path.resolve(import.meta.dirname, "../src/data");
function cleanPersistedState() {
  for (const f of ["channel-sessions.json", "channel-models.json"]) {
    try { fs.rmSync(path.join(DATA_DIR, f)); } catch { /* absent */ }
  }
}

/** 创建 mock 依赖 */
function createMockDeps(overrides?: Partial<FeishuCommandsDeps>): FeishuCommandsDeps {
  return {
    adapter: {
      chat: vi.fn(async function* () {
        yield { type: "system", session_id: "new-sess-123" };
        yield {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello from CC" }],
          },
        };
      }),
      listHistory: vi.fn(async () => ({
        conversations: [
          {
            sessionId: "hist-1",
            customTitle: "历史对话1",
            firstPrompt: "第一条消息",
            lastTime: new Date().toISOString(),
            modified: new Date().toISOString(),
            startTime: new Date().toISOString(),
            messageCount: 5,
            lastMessagePreview: "最后一条",
          },
          {
            sessionId: "hist-2",
            customTitle: null,
            firstPrompt: "另一条消息",
            lastTime: new Date(Date.now() - 3600000).toISOString(),
            modified: new Date(Date.now() - 3600000).toISOString(),
            startTime: new Date(Date.now() - 7200000).toISOString(),
            messageCount: 3,
            lastMessagePreview: "预览",
          },
        ],
        total: 2,
        hasMore: false,
      })),
      getHistory: vi.fn(async () => ({
        sessionId: "hist-1",
        messages: [
          { type: "custom-title" as const, customTitle: "测试会话" },
          {
            type: "user" as const,
            message: { role: "user", content: "你好" },
            timestamp: new Date().toISOString(),
          },
          {
            type: "assistant" as const,
            message: { role: "assistant", content: [{ type: "text", text: "你好！" }] },
            timestamp: new Date().toISOString(),
          },
        ],
      })),
      closeSession: vi.fn(),
      closeAllSessions: vi.fn(),
      getOrCreateSession: vi.fn(),
      setLifecycleCallbacks: vi.fn(),
    } as any,
    channelManager: {
      broadcast: vi.fn(async () => {}),
    } as any,
    cwd: "/test/cwd",
    feishuChannel: {
      clearTypingIndicator: vi.fn(async () => {}),
    },
    loadConfig: vi.fn(() => ({
      deviceId: "dev-001",
      pairCode: "ABC123",
      routeToken: "ROUTE1",
      authToken: "AUTH1",
      createdAt: "2026-01-01T00:00:00.000Z",
    })),
    ...overrides,
  };
}

/** 从 broadcast 调用中提取发送的文本 */
function getLastBroadcastText(deps: FeishuCommandsDeps): string {
  const calls = (deps.channelManager.broadcast as any).mock.calls;
  if (calls.length === 0) return "";
  const lastCall = calls[calls.length - 1][0];
  return lastCall?.message?.content?.[0]?.text || "";
}

/** 获取所有 broadcast 的文本 */
function getAllBroadcastTexts(deps: FeishuCommandsDeps): string[] {
  const calls = (deps.channelManager.broadcast as any).mock.calls;
  return calls.map((c: any) => c[0]?.message?.content?.[0]?.text || "").filter(Boolean);
}

describe("FeishuCommands", () => {
  let deps: FeishuCommandsDeps;
  let fc: FeishuCommands;

  beforeEach(() => {
    cleanPersistedState();
    deps = createMockDeps();
    fc = new FeishuCommands(deps);
  });

  // ============ currentSessionId getter/setter ============

  describe("currentSessionId", () => {
    it("初始为 null", () => {
      expect(fc.currentSessionId).toBeNull();
    });

    it("可读写", () => {
      fc.currentSessionId = "test-session";
      expect(fc.currentSessionId).toBe("test-session");
    });
  });

  // ============ /help 命令 ============

  describe("/help 命令", () => {
    it("返回帮助文本", async () => {
      await fc.processMessage("/help");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("飞书命令帮助");
      expect(text).toContain("/new");
      expect(text).toContain("/sessions");
      expect(text).toContain("/switch");
      expect(text).toContain("/current");
      expect(text).toContain("/device");
    });

    it("/? 也触发帮助", async () => {
      await fc.processMessage("/?");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("飞书命令帮助");
    });
  });

  // ============ /new 命令 ============

  describe("/new 命令", () => {
    it("创建新会话并更新 currentSessionId", async () => {
      await fc.processMessage("/new");

      expect(fc.currentSessionId).toBe("new-sess-123");
      expect(deps.adapter.chat).toHaveBeenCalled();
    });

    it("带标题参数", async () => {
      await fc.processMessage("/new 我的新对话");

      const chatCall = (deps.adapter.chat as any).mock.calls[0][0];
      expect(chatCall.message).toBe("我的新对话");
    });

    it("/create 也能触发", async () => {
      await fc.processMessage("/create 测试");

      expect(deps.adapter.chat).toHaveBeenCalled();
    });

    it("创建失败时发送错误消息", async () => {
      deps.adapter.chat = vi.fn(async function* () {
        throw new Error("SDK error");
      }) as any;

      await fc.processMessage("/new");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("创建会话失败");
    });
  });

  // ============ /sessions 命令 ============

  describe("/sessions 命令", () => {
    it("列出历史会话", async () => {
      await fc.processMessage("/sessions");

      expect(deps.adapter.listHistory).toHaveBeenCalledWith("/test/cwd", 10);
      const text = getLastBroadcastText(deps);
      expect(text).toContain("历史会话");
      expect(text).toContain("历史对话1");
    });

    it("/list 也能触发", async () => {
      await fc.processMessage("/list");
      expect(deps.adapter.listHistory).toHaveBeenCalled();
    });

    it("/history 也能触发", async () => {
      await fc.processMessage("/history");
      expect(deps.adapter.listHistory).toHaveBeenCalled();
    });

    it("标记当前会话 [当前]", async () => {
      fc.currentSessionId = "hist-1";
      await fc.processMessage("/sessions");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("[当前]");
    });

    it("空历史时显示提示", async () => {
      deps.adapter.listHistory = vi.fn(async () => ({
        conversations: [],
        total: 0,
        hasMore: false,
      })) as any;

      await fc.processMessage("/sessions");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("还没有历史会话");
    });

    it("获取列表失败时发送错误", async () => {
      deps.adapter.listHistory = vi.fn(async () => {
        throw new Error("DB error");
      }) as any;

      await fc.processMessage("/sessions");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("获取会话列表失败");
    });
  });

  // ============ /switch 命令 ============

  describe("/switch 命令", () => {
    it("切换到指定序号的会话", async () => {
      await fc.processMessage("/switch 1");

      expect(fc.currentSessionId).toBe("hist-1");
      const text = getLastBroadcastText(deps);
      expect(text).toContain("已切换到会话");
      expect(text).toContain("历史对话1");
    });

    it("切换到序号 2", async () => {
      await fc.processMessage("/switch 2");

      expect(fc.currentSessionId).toBe("hist-2");
    });

    it("无序号参数时提示", async () => {
      await fc.processMessage("/switch");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("请指定要切换的会话序号");
    });

    it("无效序号（超范围）提示", async () => {
      await fc.processMessage("/switch 99");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("无效的序号");
    });

    it("无效序号（非数字）提示", async () => {
      await fc.processMessage("/switch abc");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("无效的序号");
    });

    it("切换到已是当前的会话时提示", async () => {
      fc.currentSessionId = "hist-1";
      await fc.processMessage("/switch 1");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("已经在这个会话中了");
    });

    it("切换失败时发送错误", async () => {
      deps.adapter.listHistory = vi.fn(async () => {
        throw new Error("error");
      }) as any;

      await fc.processMessage("/switch 1");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("切换会话失败");
    });
  });

  // ============ /current 命令 ============

  describe("/current 命令", () => {
    it("无活跃会话时提示", async () => {
      await fc.processMessage("/current");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("当前没有活跃的会话");
    });

    it("显示当前会话信息", async () => {
      fc.currentSessionId = "hist-1";
      await fc.processMessage("/current");

      expect(deps.adapter.getHistory).toHaveBeenCalledWith("/test/cwd", "hist-1");
      const text = getLastBroadcastText(deps);
      expect(text).toContain("当前会话信息");
      expect(text).toContain("测试会话");
      expect(text).toContain("hist-1");
    });

    it("会话不存在时提示", async () => {
      fc.currentSessionId = "gone";
      deps.adapter.getHistory = vi.fn(async () => null) as any;

      await fc.processMessage("/current");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("当前会话不存在");
    });

    it("获取信息失败时发送错误", async () => {
      fc.currentSessionId = "hist-1";
      deps.adapter.getHistory = vi.fn(async () => {
        throw new Error("error");
      }) as any;

      await fc.processMessage("/current");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("获取会话信息失败");
    });
  });

  // ============ /device 命令 ============

  describe("/device 命令", () => {
    it("显示设备信息", async () => {
      await fc.processMessage("/device");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("当前设备信息");
      expect(text).toContain("dev-001");
      expect(text).toContain("ABC123");
      expect(text).toContain("ROUTE1");
      expect(text).toContain("已配对");
    });

    it("/devices 也能触发", async () => {
      await fc.processMessage("/devices");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("当前设备信息");
    });

    it("无配置时提示", async () => {
      deps.loadConfig = vi.fn(() => null);
      fc = new FeishuCommands(deps);

      await fc.processMessage("/device");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("未找到设备配置");
    });

    it("未配对设备显示未配对", async () => {
      deps.loadConfig = vi.fn(() => ({
        deviceId: "dev-002",
        pairCode: "XYZ",
        createdAt: "2026-01-01T00:00:00.000Z",
      }));
      fc = new FeishuCommands(deps);

      await fc.processMessage("/device");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("未配对");
    });

    it("获取信息失败时发送错误", async () => {
      deps.loadConfig = vi.fn(() => {
        throw new Error("config error");
      });
      fc = new FeishuCommands(deps);

      await fc.processMessage("/device");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("获取设备信息失败");
    });
  });

  // ============ /model 命令 ============

  describe("/model 命令", () => {
    it("无参数时显示当前模型和用法", async () => {
      await fc.processMessage("/model");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("当前模型");
      expect(text).toContain("sonnet");
      expect(text).toContain("opus");
    });

    it("合法别名切换成功并持久化", async () => {
      await fc.processMessage("/model opus");

      expect(fc.currentModel).toBe("opus");
      const text = getLastBroadcastText(deps);
      expect(text).toContain("已切换模型: opus");
    });

    it("fable5 别名解析为完整模型 ID", async () => {
      await fc.processMessage("/model fable5");

      expect(fc.currentModel).toBe("claude-fable-5");
    });

    it("合法完整模型 ID 直接透传", async () => {
      await fc.processMessage("/model claude-opus-4-6");

      expect(fc.currentModel).toBe("claude-opus-4-6");
    });

    it("非法输入被拒绝，不修改 currentModel", async () => {
      await fc.processMessage("/model opus"); // 先设置一个已知合法值
      await fc.processMessage("/model gpt5"); // 再尝试非法输入

      expect(fc.currentModel).toBe("opus"); // 保持不变
      const text = getLastBroadcastText(deps);
      expect(text).toContain("无效的模型");
      expect(text).toContain("gpt5");
    });

    it("非法输入（随机打字）给出清晰的错误提示和可选项", async () => {
      await fc.processMessage("/model sonet"); // 打错的别名

      expect(fc.currentModel).toBeNull();
      const text = getLastBroadcastText(deps);
      expect(text).toContain("无效的模型");
      expect(text).toContain("sonnet");
    });

    it("切换模型时会驱逐当前 scope 已绑定的活跃 session，下一条消息用新 model 重新走 resumeSession", async () => {
      fc.currentSessionId = "active-sess";

      await fc.processMessage("/model opus");

      // 已绑定的 session 应该被从 adapter 池里驱逐（closeSession），
      // 这样下一条消息触发的 chat() 会走 resumeSession 拿到新 model，而不是复用池里的旧 session 对象
      expect(deps.adapter.closeSession).toHaveBeenCalledWith("active-sess");

      // sessionId 绑定本身保留（不丢失会话身份/历史），只是底层 session 对象被驱逐重建
      expect(fc.currentSessionId).toBe("active-sess");

      await fc.processMessage("继续聊");

      const chatCall = (deps.adapter.chat as any).mock.calls[0][0];
      expect(chatCall.sessionId).toBe("active-sess");
      expect(chatCall.model).toBe("opus");
    });

    it("非法输入不会驱逐已绑定的 session", async () => {
      fc.currentSessionId = "active-sess";
      (deps.adapter.closeSession as any).mockClear();

      await fc.processMessage("/model gpt5");

      expect(deps.adapter.closeSession).not.toHaveBeenCalled();
    });
  });

  // ============ 未知命令 ============

  describe("未知命令", () => {
    it("转发给 Claude Code 作为普通消息（飞书调 skill 的入口）", async () => {
      await fc.processMessage("/unknown");

      const chatCall = (deps.adapter.chat as any).mock.calls[0][0];
      expect(chatCall.message).toBe("/unknown");
    });
  });

  // ============ 普通消息 ============

  describe("普通消息", () => {
    it("有 currentSessionId 时使用当前会话", async () => {
      fc.currentSessionId = "active-sess";
      await fc.processMessage("你好");

      const chatCall = (deps.adapter.chat as any).mock.calls[0][0];
      expect(chatCall.message).toBe("你好");
      expect(chatCall.sessionId).toBe("active-sess");
      expect(chatCall.cwd).toBe("/test/cwd");
    });

    it("chat 返回的 session_id 更新 currentSessionId", async () => {
      fc.currentSessionId = "old-sess";
      await fc.processMessage("你好");

      // mock chat yields { type: "system", session_id: "new-sess-123" }
      expect(fc.currentSessionId).toBe("new-sess-123");
    });

    it("chat 返回文本通过 broadcast 发送", async () => {
      fc.currentSessionId = "active-sess";
      await fc.processMessage("你好");

      const texts = getAllBroadcastTexts(deps);
      expect(texts.some(t => t === "Hello from CC")).toBe(true);
    });

    it("完成后调用 clearTypingIndicator", async () => {
      fc.currentSessionId = "active-sess";
      await fc.processMessage("你好");

      expect(deps.feishuChannel.clearTypingIndicator).toHaveBeenCalled();
    });

    it("无活跃会话时自动选择最近历史", async () => {
      await fc.processMessage("你好");

      // 先 listHistory 查最近会话
      expect(deps.adapter.listHistory).toHaveBeenCalledWith("/test/cwd", 1);
      // 自动设为 hist-1
      expect(fc.currentSessionId).not.toBeNull();
    });

    it("无历史会话时提示创建", async () => {
      deps.adapter.listHistory = vi.fn(async () => ({
        conversations: [],
        total: 0,
        hasMore: false,
      })) as any;

      await fc.processMessage("你好");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("还没有会话记录");
    });

    it("获取历史失败时提示", async () => {
      deps.adapter.listHistory = vi.fn(async () => {
        throw new Error("error");
      }) as any;

      await fc.processMessage("你好");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("无法加载历史会话");
    });

    it("chat 出错时发送错误提示", async () => {
      fc.currentSessionId = "active-sess";
      deps.adapter.chat = vi.fn(async function* () {
        throw new Error("stream error");
      }) as any;

      await fc.processMessage("你好");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("处理消息时出错");
    });

    it("流式模式下出错时，错误提示追加在已生成的部分内容之后，而不是被吞掉", async () => {
      fc.currentSessionId = "active-sess";

      // 启用流式卡片：feishuChannel 需要提供 getConfig/getReplyTarget/createStreamingSession
      const closeMock = vi.fn(async () => {});
      const streamingSession = {
        start: vi.fn(async () => {}),
        update: vi.fn(async () => {}),
        close: closeMock,
      };
      deps.feishuChannel = {
        ...deps.feishuChannel,
        getConfig: vi.fn(() => ({ appId: "app1", appSecret: "secret1" })),
        getReplyTarget: vi.fn(() => ({ receiveId: "chat1", receiveIdType: "chat_id" as const })),
        createStreamingSession: vi.fn(() => streamingSession),
      };

      // chat 先吐出部分正文，再在流中途报错（模拟原 bug 场景：accumulatedText 非空 + 出错）
      deps.adapter.chat = vi.fn(async function* () {
        yield {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "已经写了一部分回复" }] },
        };
        throw new Error("adapter boom");
      }) as any;

      await fc.processMessage("你好", undefined, undefined, "msg-1");

      expect(closeMock).toHaveBeenCalledTimes(1);
      const finalText = closeMock.mock.calls[0][0];
      // 回归断言：修复前 `accumulatedText || 错误提示` 会因为 accumulatedText 非空
      // 而把错误提示整个丢掉，这里必须两者都在
      expect(finalText).toContain("已经写了一部分回复");
      expect(finalText).toContain("处理消息时出错");
    });

    it("支持传递图片", async () => {
      fc.currentSessionId = "active-sess";
      const images = [{ data: "base64data", mediaType: "image/png" }];

      await fc.processMessage("看看这张图", images);

      const chatCall = (deps.adapter.chat as any).mock.calls[0][0];
      expect(chatCall.images).toEqual(images);
    });

    it("消息会被 trim", async () => {
      fc.currentSessionId = "active-sess";
      await fc.processMessage("  hello  ");

      const chatCall = (deps.adapter.chat as any).mock.calls[0][0];
      expect(chatCall.message).toBe("hello");
    });
  });

  // ============ 文本事件处理 ============

  describe("文本事件处理", () => {
    it("处理 type=text 事件", async () => {
      fc.currentSessionId = "active-sess";
      deps.adapter.chat = vi.fn(async function* () {
        yield { type: "text", text: "纯文本消息" };
      }) as any;

      await fc.processMessage("你好");

      const texts = getAllBroadcastTexts(deps);
      expect(texts.some(t => t === "纯文本消息")).toBe(true);
    });

    it("处理 assistant 事件中的 tool_use block", async () => {
      fc.currentSessionId = "active-sess";
      deps.adapter.chat = vi.fn(async function* () {
        yield {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                name: "Read",
                input: { file_path: "/test.ts" },
              },
            ],
          },
        };
      }) as any;

      await fc.processMessage("读文件");

      const texts = getAllBroadcastTexts(deps);
      expect(texts.some(t => t.includes("使用工具: Read"))).toBe(true);
    });
  });

  // ============ formatTimeAgo ============

  describe("formatTimeAgo（通过 /sessions 间接测试）", () => {
    it("刚刚（< 1 分钟）", async () => {
      deps.adapter.listHistory = vi.fn(async () => ({
        conversations: [{
          sessionId: "s1",
          customTitle: "Test",
          firstPrompt: "",
          lastTime: new Date().toISOString(),
          modified: new Date().toISOString(),
          startTime: new Date().toISOString(),
          messageCount: 1,
          lastMessagePreview: "",
        }],
        total: 1,
        hasMore: false,
      })) as any;

      await fc.processMessage("/sessions");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("刚刚");
    });

    it("N 分钟前", async () => {
      deps.adapter.listHistory = vi.fn(async () => ({
        conversations: [{
          sessionId: "s1",
          customTitle: "Test",
          firstPrompt: "",
          lastTime: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          modified: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          startTime: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
          messageCount: 1,
          lastMessagePreview: "",
        }],
        total: 1,
        hasMore: false,
      })) as any;

      await fc.processMessage("/sessions");

      const text = getLastBroadcastText(deps);
      expect(text).toContain("分钟前");
    });
  });

  // ============ feishuChannel 为 null ============

  describe("feishuChannel 为 null", () => {
    it("chat 完成后不报错", async () => {
      deps.feishuChannel = null;
      fc = new FeishuCommands(deps);
      fc.currentSessionId = "active-sess";

      await expect(fc.processMessage("你好")).resolves.not.toThrow();
    });
  });
});
