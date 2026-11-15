/**
 * 方案A 静态卡片折叠面板集成测试（2026-11-04）
 *
 * 背景：降级模式 / 非流式场景的静态卡片，工具调用行原来是混在正文里的纯文本
 * （"🔧 **Bash** npm test"），现改为传 blocks 给 buildMarkdownCard——正文段进
 * markdown 容器、工具调用渲染成 collapsible_panel（收起态只显示「🔧 工具名
 * （点开看详情）」短条，命令长摘要放面板内容里）。
 *
 * 覆盖路径：
 * - FeishuChannel.send() 静态模式（streamingCards: false）assistant 事件
 * - FeishuChannel.sendMarkdownReply() blocks 入参（命令层降级路径的出口）
 * - 纯文本回复不变形 / showToolUse=false 不产生面板
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

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { FeishuChannel } from "../src/channels/feishu";

describe("FeishuChannel 静态卡折叠面板（方案A）", () => {
  let channel: FeishuChannel;

  const staticConfig = {
    appId: "test-app-id",
    appSecret: "test-app-secret",
    receiveUserId: "ou_test_user",
    receiveIdType: "open_id" as const,
    connectionMode: "poll" as const,
    showToolUse: true,
    streamingCards: false, // 静态卡片模式
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    channel = new FeishuChannel(staticConfig);

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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 取 send()/sendMarkdownReply() 实际发出的卡片 JSON */
  function sentCards(): any[] {
    return mockFetch.mock.calls
      .filter((c: any[]) => typeof c[0] === "string" && c[0].includes("/im/v1/messages"))
      .map((c: any[]) => {
        const body = JSON.parse(c[1].body);
        return JSON.parse(body.content);
      });
  }

  const panelsOf = (card: any): any[] =>
    (card.body?.elements ?? []).filter((e: any) => e.tag === "collapsible_panel");

  const textContentsOf = (card: any): string[] =>
    (card.body?.elements ?? [])
      .filter((e: any) => e.tag === "interactive_container")
      .flatMap((e: any) => (e.elements ?? []).map((x: any) => x.content));

  it("send() 静态模式：assistant 事件带 tool_use → 卡片含 collapsible_panel，标题短条、长摘要进面板", async () => {
    await channel.send({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me check the file" },
          { type: "tool_use", name: "Read", input: { file_path: "/test/main.ts" } },
        ],
      },
    } as any);

    const cards = sentCards();
    expect(cards).toHaveLength(1);
    const panels = panelsOf(cards[0]);
    expect(panels).toHaveLength(1);

    const panel = panels[0];
    // 收起态只显示短条，不含命令长摘要（2026-10-30 真卡实测口径）
    expect(panel.header.title).toEqual({
      tag: "plain_text",
      content: "🔧 Read（点开看详情）",
    });
    // 面板内容 = 工具行 + 入参 JSON 摘要
    expect(panel.elements[0].content).toContain("Read");
    expect(panel.elements[0].content).toContain("/test/main.ts");
    // 正文进 markdown 容器
    expect(textContentsOf(cards[0])).toContain("Let me check the file");
  });

  it("send() 静态模式：纯文本回复不变形（无折叠面板，正文原样）", async () => {
    await channel.send({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "第一段" },
          { type: "text", text: "第二段" },
        ],
      },
    } as any);

    const cards = sentCards();
    expect(cards).toHaveLength(1);
    expect(panelsOf(cards[0])).toHaveLength(0);
    // 纯文本走字符串入参：与旧版式一致，两段合进同一容器
    const contents = textContentsOf(cards[0]);
    expect(contents.join("\n")).toContain("第一段");
    expect(contents.join("\n")).toContain("第二段");
  });

  it("send() 静态模式：showToolUse=false 时不产生面板", async () => {
    const quiet = new FeishuChannel({ ...staticConfig, showToolUse: false });
    await quiet.send({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "只发正文" },
          { type: "tool_use", name: "Read", input: { file_path: "/test.ts" } },
        ],
      },
    } as any);

    const cards = sentCards();
    expect(cards).toHaveLength(1);
    expect(panelsOf(cards[0])).toHaveLength(0);
    expect(textContentsOf(cards[0])).toContain("只发正文");
  });

  it("sendMarkdownReply() blocks 入参：回复卡片含折叠面板（命令层降级路径出口）", async () => {
    const ok = await channel.sendMarkdownReply("om_test", [
      { type: "text", content: "命令执行结果" },
      {
        type: "tool",
        name: "Bash",
        line: "**使用工具: Bash**\n`npm test`",
        detail: '```json\n{"command": "npm test"}\n```',
      },
    ]);

    expect(ok).toBe(true);
    const cards = sentCards();
    expect(cards).toHaveLength(1);
    const panels = panelsOf(cards[0]);
    expect(panels).toHaveLength(1);
    expect(panels[0].header.title.content).toBe("🔧 Bash（点开看详情）");
    expect(panels[0].elements[0].content).toContain("npm test");
    expect(textContentsOf(cards[0])).toContain("命令执行结果");
  });

  it("sendMarkdownReply() 纯文本入参：版式与旧版一致，无折叠面板", async () => {
    const ok = await channel.sendMarkdownReply("om_test", "普通命令回复");
    expect(ok).toBe(true);
    const cards = sentCards();
    expect(cards).toHaveLength(1);
    expect(panelsOf(cards[0])).toHaveLength(0);
    expect(textContentsOf(cards[0])).toContain("普通命令回复");
  });
});
