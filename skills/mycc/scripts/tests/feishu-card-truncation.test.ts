/**
 * 卡片超长截断 + 流式翻页测试
 *
 * 背景：飞书卡片整体约 30KB 上限，超限时 API 返回 400 且旧代码静默吞掉，
 * 用户看到的是回复凭空消失/卡片永远停在中途。
 * 修复一（截断收口）：truncateForFeishuCard 统一截断 + 提示（降级路径仍在用）。
 * 修复二（流式翻页）：FeishuStreamingSession 超限时自动收尾当前卡片并开新卡续写，
 * 长回复完整送达，不再"截断后剩下的内容永远看不到"。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  truncateForFeishuCard,
  splitForCardRollover,
  buildMarkdownCard,
  FEISHU_CARD_MAX_BYTES,
  FeishuStreamingSession,
} from "../src/channels/feishu-streaming.js";

function jsonBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8");
}

describe("truncateForFeishuCard", () => {
  it("短文本原样返回，不标记截断", () => {
    const r = truncateForFeishuCard("hello 你好");
    expect(r.truncated).toBe(false);
    expect(r.text).toBe("hello 你好");
  });

  it("超长文本截断到预算内并追加提示", () => {
    const long = "第一行内容\n".repeat(10000); // 远超 28KB
    const r = truncateForFeishuCard(long);
    expect(r.truncated).toBe(true);
    expect(jsonBytes(r.text)).toBeLessThanOrEqual(FEISHU_CARD_MAX_BYTES);
    expect(r.text).toContain("内容过长");
    // 优先在换行处断开，正文部分不应出现半行
    const body = r.text.slice(0, r.text.indexOf("\n\n---\n"));
    expect(body.endsWith("第一行内容") || body.endsWith("\n")).toBe(true);
  });

  it("截断点落在代码块内部时补全围栏", () => {
    const long = "开头\n```js\n" + "console.log('x')\n".repeat(5000);
    const r = truncateForFeishuCard(long);
    expect(r.truncated).toBe(true);
    const fences = r.text.slice(0, r.text.indexOf("内容过长")).match(/```/g)?.length ?? 0;
    expect(fences % 2).toBe(0);
  });

  it("不拆散 emoji 代理对", () => {
    const long = "🎉".repeat(20000);
    const r = truncateForFeishuCard(long);
    expect(r.truncated).toBe(true);
    // 截断后的字符串必须是合法 UTF-8（无孤立代理项）
    expect(() => new TextEncoder().encode(r.text)).not.toThrow();
    expect(r.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("多字节字符按 JSON 转义后的真实字节数计算", () => {
    const long = "换行\n引号\"和中文混排。".repeat(3000);
    const r = truncateForFeishuCard(long);
    expect(r.truncated).toBe(true);
    expect(jsonBytes(r.text)).toBeLessThanOrEqual(FEISHU_CARD_MAX_BYTES);
  });
});

describe("buildMarkdownCard 截断收口", () => {
  it("短文本卡片内容不变", () => {
    const card = buildMarkdownCard("正常回复") as any;
    expect(card.body.elements[0].content).toBe("正常回复");
  });

  it("超长文本进卡片前被截断", () => {
    const long = "很长的回复\n".repeat(10000);
    const card = buildMarkdownCard(long) as any;
    const content = card.body.elements[0].content as string;
    expect(jsonBytes(content)).toBeLessThanOrEqual(FEISHU_CARD_MAX_BYTES);
    expect(content).toContain("内容过长");
  });
});

describe("splitForCardRollover", () => {
  it("短文本预算内不需要切分（cut = 全长）", () => {
    const r = splitForCardRollover("短内容", FEISHU_CARD_MAX_BYTES);
    expect(r.cut).toBe(3);
    expect(r.headSuffix).toBe("");
    expect(r.restPrefix).toBe("");
  });

  it("切分点在代码块内部时给出围栏闭合/重开", () => {
    const long = "开头\n```js\n" + "console.log('x')\n".repeat(5000);
    const r = splitForCardRollover(long);
    expect(r.cut).toBeGreaterThan(0);
    expect(r.cut).toBeLessThan(long.length);
    expect(r.headSuffix).toBe("\n```");
    expect(r.restPrefix).toBe("```\n");
  });

  it("预算为 0 或过小时返回 cut=0（调用方回退截断）", () => {
    expect(splitForCardRollover("内容", 10).cut).toBe(0);
  });
});

describe("FeishuStreamingSession 超长翻页", () => {
  // 每次 PUT 记录 {cardId, content}，最后按卡片重建各页最终内容
  const putCalls: Array<{ cardId: string; content: string }> = [];
  let createdCards: string[] = [];
  let failCreateAfter = Infinity;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    putCalls.length = 0;
    createdCards = [];
    failCreateAfter = Infinity;
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const ok = (data: unknown) =>
        ({ json: async () => data }) as unknown as Response;
      if (u.includes("/auth/v3/tenant_access_token"))
        return ok({ code: 0, msg: "ok", tenant_access_token: "t", expire: 7200 });
      if (u.includes("/cardkit/v1/cards") && u.includes("/elements/content/content")) {
        const cardId = u.match(/cards\/([^/]+)\//)![1];
        putCalls.push({ cardId, content: JSON.parse(String(init?.body)).content });
        return ok({ code: 0, msg: "ok" });
      }
      if (u.includes("/cardkit/v1/cards") && u.endsWith("/settings"))
        return ok({ code: 0, msg: "ok" });
      if (u.includes("/cardkit/v1/cards")) {
        if (createdCards.length >= failCreateAfter)
          return ok({ code: 999, msg: "create blocked" });
        const cardId = `card${createdCards.length + 1}`;
        createdCards.push(cardId);
        return ok({ code: 0, msg: "ok", data: { card_id: cardId } });
      }
      if (u.includes("/im/v1/messages"))
        return ok({ code: 0, msg: "ok", data: { message_id: `msg${createdCards.length}` } });
      return ok({ code: 0, msg: "ok" });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 每张卡片的最终显示内容（按 PUT 先后取最后一份） */
  function finalContents(): Map<string, string> {
    const m = new Map<string, string>();
    for (const { cardId, content } of putCalls) m.set(cardId, content);
    return m;
  }

  /** 去掉翻页标记，把各卡片内容拼回原文 */
  function reassemble(): string {
    const m = finalContents();
    return createdCards
      .map((id) => m.get(id) ?? "")
      .map((c) =>
        c
          .replace(/\n\n---\n⬇️ \*\*内容较长，接下一张卡片\*\*$/, "")
          .replace(/^⬆️ \*接上一张卡片\*\n\n/, "")
      )
      .join("");
  }

  let appSeq = 0;
  function newSession() {
    appSeq++;
    return new FeishuStreamingSession({ appId: `app-roll-${appSeq}`, appSecret: "s" });
  }

  it("超长更新自动翻页：多张卡片完整承载全文，每次 PUT 不超上限", async () => {
    const session = newSession();
    await session.start("chat1", "chat_id");

    const long = "行内容\n".repeat(10000); // 远超单卡上限，需要多页
    await session.update(long);
    await session.close();

    expect(createdCards.length).toBeGreaterThan(1);
    for (const { content } of putCalls) {
      expect(jsonBytes(content)).toBeLessThanOrEqual(FEISHU_CARD_MAX_BYTES);
    }
    const m = finalContents();
    // 前面每一页尾部有"接下一张"，续页开头有"接上一张"，最后一页没有尾部标记
    for (const id of createdCards.slice(0, -1)) {
      expect(m.get(id)).toContain("接下一张卡片");
    }
    for (const id of createdCards.slice(1)) {
      expect(m.get(id)).toContain("接上一张卡片");
    }
    expect(m.get(createdCards.at(-1)!)).not.toContain("接下一张卡片");
    // 全文无损：去掉翻页标记后拼回原文
    expect(reassemble()).toBe(long);
  });

  it("翻页后继续流式更新：新增内容落在新卡片上", async () => {
    const session = newSession();
    await session.start("chat1", "chat_id");

    const page1 = "第一页内容\n".repeat(3000); // 刚好超过一页
    await session.update(page1);
    expect(createdCards.length).toBe(2);

    await new Promise((r) => setTimeout(r, 150)); // 过掉节流窗口
    await session.update(page1 + "追加的新内容");
    const m = finalContents();
    expect(m.get("card2")).toContain("追加的新内容");
    // 第一张卡片保持定格，不再被后续更新触碰
    expect(m.get("card1")).toContain("接下一张卡片");
    expect(m.get("card1")).not.toContain("追加的新内容");
  });

  it("翻页切到代码块内部时跨卡片闭合围栏", async () => {
    const session = newSession();
    await session.start("chat1", "chat_id");

    const long = "开头\n```js\n" + "console.log('x')\n".repeat(5000);
    await session.update(long);
    await session.close();

    const m = finalContents();
    const first = m.get("card1")!;
    const fences = first.slice(0, first.indexOf("接下一张")).match(/```/g)?.length ?? 0;
    expect(fences % 2).toBe(0); // 第一页围栏闭合
    expect(m.get("card2")).toMatch(/接上一张卡片\*\n\n```/); // 续页重开围栏
  });

  it("建新卡失败时回退截断显示（旧行为兜底），不抛错不静默", async () => {
    const session = newSession();
    await session.start("chat1", "chat_id");
    failCreateAfter = 1; // 第一张卡之后禁止再建

    const long = "行内容\n".repeat(10000);
    await session.update(long);
    await session.close();

    expect(createdCards).toEqual(["card1"]);
    const m = finalContents();
    expect(m.get("card1")).toContain("内容过长");
    expect(jsonBytes(m.get("card1")!)).toBeLessThanOrEqual(FEISHU_CARD_MAX_BYTES);
  });

  it("close 收尾内容超长时同样翻页，全文完整送达", async () => {
    const session = newSession();
    await session.start("chat1", "chat_id");
    const long = "收尾长文\n".repeat(10000);
    await session.close(long);

    expect(createdCards.length).toBeGreaterThan(1);
    expect(reassemble()).toBe(long);
  });
});
