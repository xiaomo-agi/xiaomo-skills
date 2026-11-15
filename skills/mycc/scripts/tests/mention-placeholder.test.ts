/**
 * @ 占位符还原测试（2026-07-06 审查问题 C2）
 *
 * 飞书群里 @机器人 的消息，文本原样是 "@_user_1 /help" 这类占位符形式。
 * 旧实现 parseFeishuMessage 原样返回，startsWith("/") 判定失败，
 * 命令整条被当普通消息喂给 Claude——B–E 通道群里只处理被 @ 的消息，
 * 等于这些通道群聊命令功能整体不可用；任务运行中 "@bot /stop" 也会被
 * 并发锁拒绝而不是终止任务。
 *
 * 修复后：@机器人自己 → 从文本删除；@其他人/@all → 替换成 "@名字"。
 * 路由判断（@all/@本bot）走 ctx.mentions 数组，不受影响。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

import { FeishuChannel } from "../src/channels/feishu";

const BOT_OPEN_ID = "ou_bot_self";

function createChannel(): FeishuChannel {
  const channel = new FeishuChannel({
    appId: "test-app-id",
    appSecret: "test-app-secret",
    receiveUserId: "ou_test_user",
    receiveIdType: "open_id" as const,
    connectionMode: "poll" as const,
    showToolUse: true,
    streamingCards: false,
  });
  (channel as any).botOpenId = BOT_OPEN_ID;
  return channel;
}

function restore(channel: FeishuChannel, text: string, mentions?: any[]): string {
  return (channel as any).restoreMentionPlaceholders(text, mentions);
}

describe("restoreMentionPlaceholders", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("@机器人 + 命令 → 占位符删除，命令可被识别", () => {
    const channel = createChannel();
    const result = restore(channel, "@_user_1 /help", [
      { key: "@_user_1", id: { open_id: BOT_OPEN_ID }, name: "cc机器人" },
    ]);
    expect(result).toBe("/help");
    expect(result.startsWith("/")).toBe(true);
  });

  it("@机器人 /stop 前后带空格也能还原成命令", () => {
    const channel = createChannel();
    const result = restore(channel, "@_user_1  /stop", [
      { key: "@_user_1", id: { open_id: BOT_OPEN_ID }, name: "cc机器人" },
    ]);
    expect(result).toBe("/stop");
  });

  it("@其他人替换成名字，消息语义保留", () => {
    const channel = createChannel();
    const result = restore(channel, "@_user_1 帮 @_user_2 查一下部署状态", [
      { key: "@_user_1", id: { open_id: BOT_OPEN_ID }, name: "cc机器人" },
      { key: "@_user_2", id: { open_id: "ou_someone" }, name: "小王" },
    ]);
    expect(result).toBe("帮 @小王 查一下部署状态");
  });

  it("@all（id 为字符串）替换成名字，不当成机器人自己", () => {
    const channel = createChannel();
    const result = restore(channel, "@_user_1 大家看下", [
      { key: "@_user_1", id: "all", name: "所有人" },
    ]);
    expect(result).toBe("@所有人 大家看下");
  });

  it("无 mentions 时原样返回", () => {
    const channel = createChannel();
    expect(restore(channel, "/help", undefined)).toBe("/help");
    expect(restore(channel, "/help", [])).toBe("/help");
  });

  it("botOpenId 未知时不误删任何 mention（替换成名字兜底）", () => {
    const channel = createChannel();
    (channel as any).botOpenId = null;
    const result = restore(channel, "@_user_1 /help", [
      { key: "@_user_1", id: { open_id: BOT_OPEN_ID }, name: "cc机器人" },
    ]);
    expect(result).toBe("@cc机器人 /help");
  });

  it("parseFeishuMessage 文本消息端到端：@bot /help → /help", async () => {
    const channel = createChannel();
    const parsed = await (channel as any).parseFeishuMessage(
      {
        message: {
          message_id: "om_1",
          chat_id: "oc_1",
          message_type: "text",
          content: JSON.stringify({ text: "@_user_1 /help" }),
          mentions: [{ key: "@_user_1", id: { open_id: BOT_OPEN_ID }, name: "cc机器人" }],
        },
      },
      "om_1"
    );
    expect(parsed?.text).toBe("/help");
  });
});
