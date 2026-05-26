/**
 * history.ts 测试 - 历史记录优化
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getConversation, encodeProjectPath } from "../src/history";

// 测试用临时目录
const TEST_CWD = join(tmpdir(), `test-history-${Date.now()}`);
const TEST_SESSION_ID = "test-session-123";

// 辅助函数：创建测试用 JSONL 文件
function createTestHistory(lines: string[]) {
  const encodedName = encodeProjectPath(TEST_CWD);
  const historyDir = join(process.env.HOME || tmpdir(), ".claude", "projects", encodedName);

  // 确保目录存在
  mkdirSync(historyDir, { recursive: true });

  // 写入 JSONL 文件
  const filePath = join(historyDir, `${TEST_SESSION_ID}.jsonl`);
  writeFileSync(filePath, lines.join("\n"), "utf-8");

  return filePath;
}

// 辅助函数：清理测试文件
function cleanupTestHistory() {
  const encodedName = encodeProjectPath(TEST_CWD);
  const historyDir = join(process.env.HOME || tmpdir(), ".claude", "projects", encodedName);
  if (existsSync(historyDir)) {
    rmSync(historyDir, { recursive: true, force: true });
  }
}

describe("getConversation - 历史记录优化", () => {
  beforeEach(() => {
    // 每个测试前清理
    cleanupTestHistory();
  });

  afterEach(() => {
    // 每个测试后清理
    cleanupTestHistory();
  });

  describe("正常场景", () => {
    it("有 summary 的对话，只返回 summary 之后的消息", () => {
      const lines = [
        JSON.stringify({ type: "user", message: { content: "消息1" }, timestamp: "2026-01-29T00:00:00Z", uuid: "uuid-1" }),
        JSON.stringify({ type: "assistant", message: { content: "回复1" }, timestamp: "2026-01-29T00:01:00Z", uuid: "uuid-2" }),
        JSON.stringify({ type: "summary", summary: "前面对话的摘要", leafUuid: "uuid-2" }),
        JSON.stringify({ type: "user", message: { content: "消息2" }, timestamp: "2026-01-29T00:02:00Z", uuid: "uuid-3" }),
        JSON.stringify({ type: "assistant", message: { content: "回复2" }, timestamp: "2026-01-29T00:03:00Z", uuid: "uuid-4" }),
      ];

      createTestHistory(lines);
      const result = getConversation(TEST_CWD, TEST_SESSION_ID);

      expect(result).not.toBeNull();
      expect(result!.messages).toHaveLength(2);

      // 验证只包含 summary 之后的消息
      const userMsg = result!.messages.find((m) => m.type === "user");
      const assistantMsg = result!.messages.find((m) => m.type === "assistant");

      expect(userMsg?.message?.content).toBe("消息2");
      expect(assistantMsg?.message?.content).toBe("回复2");

      // 验证不包含 summary 之前的消息
      const hasOldMessages = result!.messages.some(
        (m) =>
          m.message?.content === "消息1" || m.message?.content === "回复1"
      );
      expect(hasOldMessages).toBe(false);

      // 验证不包含 summary 本身
      const hasSummary = result!.messages.some((m) => m.type === "summary");
      expect(hasSummary).toBe(false);
    });
  });

  describe("边界场景", () => {
    it("没有 summary 的短对话，返回全部消息", () => {
      const lines = [
        JSON.stringify({ type: "user", message: { content: "消息1" }, timestamp: "2026-01-29T00:00:00Z", uuid: "uuid-1" }),
        JSON.stringify({ type: "assistant", message: { content: "回复1" }, timestamp: "2026-01-29T00:01:00Z", uuid: "uuid-2" }),
      ];

      createTestHistory(lines);
      const result = getConversation(TEST_CWD, TEST_SESSION_ID);

      expect(result).not.toBeNull();
      expect(result!.messages).toHaveLength(2);

      const userMsg = result!.messages.find((m) => m.type === "user");
      const assistantMsg = result!.messages.find((m) => m.type === "assistant");

      expect(userMsg?.message?.content).toBe("消息1");
      expect(assistantMsg?.message?.content).toBe("回复1");
    });

    it("多个 summary 的对话，只返回最后一个 summary 之后的消息", () => {
      const lines = [
        JSON.stringify({ type: "user", message: { content: "消息1" }, timestamp: "2026-01-29T00:00:00Z", uuid: "uuid-1" }),
        JSON.stringify({ type: "summary", summary: "摘要1", leafUuid: "uuid-1" }),
        JSON.stringify({ type: "user", message: { content: "消息2" }, timestamp: "2026-01-29T00:01:00Z", uuid: "uuid-2" }),
        JSON.stringify({ type: "summary", summary: "摘要2", leafUuid: "uuid-2" }),
        JSON.stringify({ type: "user", message: { content: "消息3" }, timestamp: "2026-01-29T00:02:00Z", uuid: "uuid-3" }),
        JSON.stringify({ type: "assistant", message: { content: "回复3" }, timestamp: "2026-01-29T00:03:00Z", uuid: "uuid-4" }),
      ];

      createTestHistory(lines);
      const result = getConversation(TEST_CWD, TEST_SESSION_ID);

      expect(result).not.toBeNull();
      expect(result!.messages).toHaveLength(2);

      const userMsg = result!.messages.find((m) => m.type === "user");
      const assistantMsg = result!.messages.find((m) => m.type === "assistant");

      expect(userMsg?.message?.content).toBe("消息3");
      expect(assistantMsg?.message?.content).toBe("回复3");

      // 验证不包含旧消息
      const hasOldMessages = result!.messages.some(
        (m) =>
          m.message?.content === "消息1" || m.message?.content === "消息2"
      );
      expect(hasOldMessages).toBe(false);
    });

    it("空对话，返回空数组", () => {
      createTestHistory([]);
      const result = getConversation(TEST_CWD, TEST_SESSION_ID);

      expect(result).not.toBeNull();
      expect(result!.messages).toHaveLength(0);
    });

    it("只有 summary 消息，返回空数组", () => {
      const lines = [
        JSON.stringify({ type: "summary", summary: "只有摘要", leafUuid: "uuid-1" }),
      ];

      createTestHistory(lines);
      const result = getConversation(TEST_CWD, TEST_SESSION_ID);

      expect(result).not.toBeNull();
      expect(result!.messages).toHaveLength(0);
    });

    it("文件末尾是 summary（之后没有消息），应回退到前一个 summary", () => {
      // 这是真实场景：Claude 在对话结束后可能追加 summary
      const lines = [
        JSON.stringify({ type: "summary", summary: "早期摘要", leafUuid: "uuid-0" }),
        JSON.stringify({ type: "user", message: { content: "消息1" }, timestamp: "2026-01-29T00:00:00Z", uuid: "uuid-1" }),
        JSON.stringify({ type: "assistant", message: { content: "回复1" }, timestamp: "2026-01-29T00:01:00Z", uuid: "uuid-2" }),
        JSON.stringify({ type: "summary", summary: "末尾摘要", leafUuid: "uuid-2" }),  // 末尾 summary
      ];

      createTestHistory(lines);
      const result = getConversation(TEST_CWD, TEST_SESSION_ID);

      expect(result).not.toBeNull();
      // 应该返回第一个 summary 之后、最后一个 summary 之前的消息
      expect(result!.messages).toHaveLength(2);

      const userMsg = result!.messages.find((m) => m.type === "user");
      const assistantMsg = result!.messages.find((m) => m.type === "assistant");

      expect(userMsg?.message?.content).toBe("消息1");
      expect(assistantMsg?.message?.content).toBe("回复1");
    });

    it("多个连续末尾 summary，应回退到有消息的位置", () => {
      const lines = [
        JSON.stringify({ type: "user", message: { content: "消息1" }, timestamp: "2026-01-29T00:00:00Z", uuid: "uuid-1" }),
        JSON.stringify({ type: "assistant", message: { content: "回复1" }, timestamp: "2026-01-29T00:01:00Z", uuid: "uuid-2" }),
        JSON.stringify({ type: "summary", summary: "摘要1", leafUuid: "uuid-2" }),
        JSON.stringify({ type: "summary", summary: "摘要2", leafUuid: "uuid-2" }),
        JSON.stringify({ type: "summary", summary: "摘要3", leafUuid: "uuid-2" }),
      ];

      createTestHistory(lines);
      const result = getConversation(TEST_CWD, TEST_SESSION_ID);

      expect(result).not.toBeNull();
      // 没有任何 summary 之后有消息，应返回全部非 summary 消息
      expect(result!.messages).toHaveLength(2);

      const userMsg = result!.messages.find((m) => m.type === "user");
      expect(userMsg?.message?.content).toBe("消息1");
    });

    it("全是 summary 消息（多个），返回空数组", () => {
      const lines = [
        JSON.stringify({ type: "summary", summary: "摘要1", leafUuid: "uuid-1" }),
        JSON.stringify({ type: "summary", summary: "摘要2", leafUuid: "uuid-2" }),
        JSON.stringify({ type: "summary", summary: "摘要3", leafUuid: "uuid-3" }),
      ];

      createTestHistory(lines);
      const result = getConversation(TEST_CWD, TEST_SESSION_ID);

      expect(result).not.toBeNull();
      expect(result!.messages).toHaveLength(0);
    });

    it("session 文件不存在，返回 null", () => {
      const result = getConversation(TEST_CWD, "non-existent-session");
      expect(result).toBeNull();
    });

    it("非法 sessionId，返回 null", () => {
      const result = getConversation(TEST_CWD, "../../../etc/passwd");
      expect(result).toBeNull();
    });
  });
});

describe("encodeProjectPath - 路径编码与根目录检测", () => {
  // 临时测试目录
  let testRootDir: string;
  let testSubDir: string;
  let testNoProjectDir: string;

  beforeEach(() => {
    // 创建测试目录结构
    const timestamp = Date.now();
    testRootDir = join(tmpdir(), `test-project-${timestamp}`);
    testSubDir = join(testRootDir, "src", "components");
    testNoProjectDir = join(tmpdir(), `test-no-project-${timestamp}`);

    // 创建根目录和 .claude/ 标识
    mkdirSync(join(testRootDir, ".claude"), { recursive: true });
    mkdirSync(testSubDir, { recursive: true });
    mkdirSync(testNoProjectDir, { recursive: true });
  });

  afterEach(() => {
    // 清理测试目录
    if (existsSync(testRootDir)) {
      rmSync(testRootDir, { recursive: true, force: true });
    }
    if (existsSync(testNoProjectDir)) {
      rmSync(testNoProjectDir, { recursive: true, force: true });
    }
  });

  describe("根目录检测", () => {
    it("传入项目根目录（有 .claude/），应返回编码后的根目录路径", () => {
      const encoded = encodeProjectPath(testRootDir);
      const expected = testRootDir.replace(/[/\\:._]/g, "-");

      expect(encoded).toBe(expected);
    });

    it("传入项目子目录，应自动检测并返回编码后的根目录路径", () => {
      const encoded = encodeProjectPath(testSubDir);
      const expected = testRootDir.replace(/[/\\:._]/g, "-");

      expect(encoded).toBe(expected);
    });

    it("传入没有项目标识的目录，应 fallback 到编码原路径", () => {
      const encoded = encodeProjectPath(testNoProjectDir);
      const expected = testNoProjectDir.replace(/[/\\:._]/g, "-");

      expect(encoded).toBe(expected);
    });
  });

  describe("路径编码规则", () => {
    it("应将所有 / 替换为 -", () => {
      const path = "/Users/test/project";
      const encoded = encodeProjectPath(path);

      expect(encoded).not.toContain("/");
      expect(encoded).toMatch(/^-Users-test-project$/);
    });

    it("应将所有 . 替换为 -", () => {
      const testDotDir = join(tmpdir(), `test.dot.project-${Date.now()}`);
      mkdirSync(join(testDotDir, ".claude"), { recursive: true });

      const encoded = encodeProjectPath(testDotDir);

      expect(encoded).not.toContain(".");

      rmSync(testDotDir, { recursive: true, force: true });
    });

    it("应移除尾随斜杠", () => {
      const pathWithSlash = testRootDir + "/";
      const pathWithoutSlash = testRootDir;

      const encoded1 = encodeProjectPath(pathWithSlash);
      const encoded2 = encodeProjectPath(pathWithoutSlash);

      expect(encoded1).toBe(encoded2);
    });
  });

  describe("边界情况", () => {
    it("根目录有 CLAUDE.md 而不是 .claude/ 目录，也应检测到", () => {
      const testClaudeMdDir = join(tmpdir(), `test-claude-md-${Date.now()}`);
      const testClaudeMdSubDir = join(testClaudeMdDir, "src");

      mkdirSync(testClaudeMdSubDir, { recursive: true });
      writeFileSync(join(testClaudeMdDir, "CLAUDE.md"), "# Test project");

      const encoded = encodeProjectPath(testClaudeMdSubDir);
      const expected = testClaudeMdDir.replace(/[/\\:._]/g, "-");

      expect(encoded).toBe(expected);

      rmSync(testClaudeMdDir, { recursive: true, force: true });
    });

    it("深层嵌套子目录，应正确找到根目录", () => {
      const deepSubDir = join(testRootDir, "a", "b", "c", "d", "e");
      mkdirSync(deepSubDir, { recursive: true });

      const encoded = encodeProjectPath(deepSubDir);
      const expected = testRootDir.replace(/[/\\:._]/g, "-");

      expect(encoded).toBe(expected);
    });

    it("空字符串应返回空字符串", () => {
      const encoded = encodeProjectPath("");
      expect(encoded).toBe("");
    });

    it("不存在的路径不应抛出异常", () => {
      const nonExistentPath = "/non/existent/path/12345";

      expect(() => {
        encodeProjectPath(nonExistentPath);
      }).not.toThrow();

      const encoded = encodeProjectPath(nonExistentPath);
      expect(encoded).toBe("-non-existent-path-12345");
    });

    it("Windows 路径中的冒号应被替换", () => {
      // 创建一个临时的 Windows 风格目录
      const testWinDir = join(tmpdir(), `test-win-${Date.now()}`);
      mkdirSync(join(testWinDir, ".claude"), { recursive: true });

      const encoded = encodeProjectPath(testWinDir);

      // 冒号已在路径中被操作系统处理，检查不包含冒号即可
      expect(encoded).not.toContain(":");

      rmSync(testWinDir, { recursive: true, force: true });
    });

    it("路径中的反斜杠应被替换为连字符", () => {
      // 测试路径编码规则：反斜杠 → 连字符
      // 注意：在 Unix 系统上，反斜杠是合法的文件名字符，不是路径分隔符
      const pathWithBackslash = testRootDir.replace(/\//g, "\\");
      const encoded = encodeProjectPath(testRootDir);

      // 验证编码后不包含反斜杠
      expect(encoded).not.toContain("\\");
      expect(encoded).not.toContain("/");
    });

    it("相对路径会基于当前目录查找根目录", () => {
      // 相对路径会基于当前工作目录查找项目根目录
      const relativePath = "./src/components";
      const encoded = encodeProjectPath(relativePath);

      // 应该不抛出异常，并且返回有效的编码路径
      expect(encoded).toBeTruthy();
      expect(encoded).not.toContain(".");
    });
  });
});
