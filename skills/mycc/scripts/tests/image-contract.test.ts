/**
 * 图片上传 — 前后端契约测试
 *
 * 防止前后端字段名不匹配导致图片功能静默失败。
 * 这组测试模拟前端实际发送的 JSON 格式，验证后端能正确解析。
 *
 * 覆盖场景：
 * 1. Web 前端（mycc-web）发送的格式 → 后端校验通过
 * 2. 小程序前端发送的格式 → 后端校验通过
 * 3. 错误格式（media_type 而非 mediaType）→ 后端校验失败
 * 4. buildMessageContent 对新会话和旧会话都能正确构造图文消息
 */

import { describe, it, expect } from "vitest";
import { validateImages, buildMessageContent, type ImageData } from "../src/image-utils";

// 最小有效 PNG
const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// ============ 前端 JSON 格式样本 ============

/**
 * mycc-web 前端发出的 chat 请求 body
 * 来源：src/shared/lib/api.ts createChatRequest()
 */
function makeWebFrontendBody(message: string, hasImage: boolean) {
  const body: Record<string, unknown> = {
    message,
    sessionId: undefined,
    model: "claude-sonnet-4-5-20250929",
  };

  if (hasImage) {
    body.images = [
      {
        mediaType: "image/png",  // Web 前端用驼峰
        data: VALID_PNG_BASE64,
      },
    ];
  }

  return body;
}

/**
 * 小程序前端发出的 chat 请求 body（修复后）
 * 来源：miniprogram/pages/chat/chat.js sendMessage()
 */
function makeMiniProgramBody(message: string, hasImage: boolean) {
  const body: Record<string, unknown> = {
    message,
    sessionId: undefined,
    model: "claude-sonnet-4-5-20250929",
  };

  if (hasImage) {
    body.images = [
      {
        mediaType: "image/jpeg",  // 修复后的小程序格式：驼峰
        data: VALID_PNG_BASE64,
      },
    ];
  }

  return body;
}

/**
 * 错误格式：使用 media_type（下划线）而不是 mediaType（驼峰）
 * 这是之前的 bug：前端发 media_type，后端期望 mediaType
 */
function makeBrokenBody() {
  return {
    message: "请分析这张图片",
    images: [
      {
        type: "base64",           // 多余的字段
        media_type: "image/png",  // 下划线命名 ← BUG
        data: VALID_PNG_BASE64,
      },
    ],
  };
}

// ============ 契约测试 ============

describe("前后端图片契约", () => {
  describe("Web 前端格式", () => {
    it("带图片的请求，后端校验通过", () => {
      const body = makeWebFrontendBody("分析这张图", true);
      // 模拟后端解析：const { images } = JSON.parse(body)
      const parsed = JSON.parse(JSON.stringify(body));
      const result = validateImages(parsed.images as ImageData[]);
      expect(result.valid).toBe(true);
    });

    it("纯文本请求，后端校验通过", () => {
      const body = makeWebFrontendBody("你好", false);
      const parsed = JSON.parse(JSON.stringify(body));
      const result = validateImages(parsed.images);
      expect(result.valid).toBe(true);
    });

    it("图片能正确构造为 multimodal 消息", () => {
      const body = makeWebFrontendBody("这是什么？", true);
      const parsed = JSON.parse(JSON.stringify(body));
      const content = buildMessageContent(
        parsed.message,
        parsed.images as ImageData[]
      );

      expect(Array.isArray(content)).toBe(true);
      const arr = content as any[];
      expect(arr).toHaveLength(2);
      expect(arr[0].type).toBe("image");
      expect(arr[0].source.type).toBe("base64");
      expect(arr[0].source.media_type).toBe("image/png");
      expect(arr[0].source.data).toBe(VALID_PNG_BASE64);
      expect(arr[1].type).toBe("text");
      expect(arr[1].text).toBe("这是什么？");
    });
  });

  describe("小程序前端格式", () => {
    it("带图片的请求，后端校验通过", () => {
      const body = makeMiniProgramBody("请分析这张图片", true);
      const parsed = JSON.parse(JSON.stringify(body));
      const result = validateImages(parsed.images as ImageData[]);
      expect(result.valid).toBe(true);
    });

    it("纯图片（默认提示语），后端构造消息使用默认文字", () => {
      const body = makeMiniProgramBody("", true);
      const parsed = JSON.parse(JSON.stringify(body));
      const content = buildMessageContent(
        parsed.message,
        parsed.images as ImageData[]
      );

      expect(Array.isArray(content)).toBe(true);
      const arr = content as any[];
      expect(arr[1].text).toBe("请分析这张图片");
    });
  });

  describe("回归保护：错误字段名必须被检测到", () => {
    it("media_type（下划线）导致 mediaType 为 undefined，校验失败", () => {
      const body = makeBrokenBody();
      const parsed = JSON.parse(JSON.stringify(body));

      // 关键：后端按 ImageData 接口取 mediaType 字段
      // 但前端发的是 media_type，所以 mediaType 是 undefined
      const images = parsed.images as ImageData[];
      expect(images[0].mediaType).toBeUndefined(); // 这就是 bug 的根因

      const result = validateImages(images);
      expect(result.valid).toBe(false);
      expect(result.code).toBe(415);
    });

    it("缺少 mediaType 字段时，报明确的错误信息", () => {
      const images = [{ data: VALID_PNG_BASE64 }] as any as ImageData[];
      const result = validateImages(images);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("不支持的图片格式");
    });
  });

  describe("边界值保护", () => {
    it("纯空白 data 应被拒绝", () => {
      const images: ImageData[] = [
        { mediaType: "image/png", data: "   " },
      ];
      const result = validateImages(images);
      expect(result.valid).toBe(false);
      expect(result.code).toBe(400);
    });

    it("data 带 data:image/png;base64, 前缀时，base64 校验失败", () => {
      const images: ImageData[] = [
        {
          mediaType: "image/png",
          data: `data:image/png;base64,${VALID_PNG_BASE64}`,
        },
      ];
      const result = validateImages(images);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("base64");
    });

    it("image/jpg 经过 buildMessageContent 归一化为 image/jpeg", () => {
      const images: ImageData[] = [
        { mediaType: "image/jpg", data: VALID_PNG_BASE64 },
      ];
      const content = buildMessageContent("测试", images);

      expect(Array.isArray(content)).toBe(true);
      const arr = content as any[];
      expect(arr[0].type).toBe("image");
      expect(arr[0].source.media_type).toBe("image/jpeg");
    });
  });
});
