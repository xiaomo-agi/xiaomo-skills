/**
 * history.ts 测试 - getConversationList 重写（CC 2.1.33 兼容）
 *
 * 测试纯文件系统扫描方案：
 * - scanSessionFiles: readdirSync + statSync
 * - getConversationList: 排序 + limit + hydrate
 * - extractFirstPrompt: 从 head 内容提取第一条 user 消息
 * - extractLastField: 从 tail 内容提取最后一个匹配字段
 * - readFileSummary: 读 head+tail 16KB
 * - renameSession: 只写 .jsonl，不更新索引
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync, utimesSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// 被测函数（实现后导出）
import {
  getConversationList,
  renameSession,
  encodeProjectPath,
  getHistoryDir,
  // 新增的内部函数，需要导出供测试
  scanSessionFiles,
  readFileSummary,
  extractFirstPrompt,
  extractLastField,
} from "../src/history";

// ============ 测试工具 ============

const TEST_BASE = join(tmpdir(), `mycc-history-test-${Date.now()}`);
let testCounter = 0;

/** 创建一个隔离的测试项目目录 */
function createTestProject(): { cwd: string; historyDir: string } {
  testCounter++;
  const cwd = join(TEST_BASE, `project-${testCounter}`);
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  const encodedName = encodeProjectPath(cwd);
  const historyDir = join(process.env.HOME || tmpdir(), ".claude", "projects", encodedName);
  mkdirSync(historyDir, { recursive: true });
  return { cwd, historyDir };
}

/** 在 historyDir 中创建一个 .jsonl 会话文件 */
function createSession(
  historyDir: string,
  sessionId: string,
  lines: string[],
  mtime?: Date
): string {
  const filePath = join(historyDir, `${sessionId}.jsonl`);
  writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
  if (mtime) {
    utimesSync(filePath, mtime, mtime);
  }
  return filePath;
}

/** 构造一条 user 类型的 JSONL 行 */
function userLine(content: string, sessionId = "s1", extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "user",
    message: { role: "human", content },
    sessionId,
    timestamp: new Date().toISOString(),
    uuid: `uuid-${Math.random().toString(36).slice(2, 8)}`,
    ...extra,
  });
}

/** 构造一条 assistant 类型的 JSONL 行 */
function assistantLine(content: string, sessionId = "s1"): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content },
    sessionId,
    timestamp: new Date().toISOString(),
    uuid: `uuid-${Math.random().toString(36).slice(2, 8)}`,
  });
}

/** 构造一条 custom-title 类型的 JSONL 行 */
function customTitleLine(title: string, sessionId = "s1"): string {
  return JSON.stringify({
    type: "custom-title",
    customTitle: title,
    sessionId,
  });
}

/** 构造一条 file-history-snapshot 类型的 JSONL 行 */
function snapshotLine(messageId = "msg-1"): string {
  return JSON.stringify({
    type: "file-history-snapshot",
    messageId,
    snapshot: { files: ["/src/index.ts"] },
  });
}

/** 构造一条 tool_result user 消息（应被 firstPrompt 跳过） */
function toolResultLine(sessionId = "s1"): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "human",
      content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
    },
    sessionId,
    timestamp: new Date().toISOString(),
    uuid: `uuid-${Math.random().toString(36).slice(2, 8)}`,
  });
}

/** 构造一条 isMeta user 消息（CC 内部系统消息，应被 firstPrompt 跳过） */
function metaUserLine(content: string, sessionId = "s1"): string {
  return JSON.stringify({
    type: "user",
    message: { role: "human", content },
    sessionId,
    timestamp: new Date().toISOString(),
    uuid: `uuid-${Math.random().toString(36).slice(2, 8)}`,
    isMeta: true,
  });
}

// ============ 清理 ============

afterEach(() => {
  // 清理测试项目目录
  if (existsSync(TEST_BASE)) {
    // 清理 ~/.claude/projects 下对应的测试目录
    for (let i = 1; i <= testCounter; i++) {
      const cwd = join(TEST_BASE, `project-${i}`);
      try {
        const encodedName = encodeProjectPath(cwd);
        const historyDir = join(process.env.HOME || tmpdir(), ".claude", "projects", encodedName);
        if (existsSync(historyDir)) {
          rmSync(historyDir, { recursive: true, force: true });
        }
      } catch {}
    }
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
  testCounter = 0;
});

// ============ extractFirstPrompt 测试 ============

describe("extractFirstPrompt", () => {
  it("从普通 user 消息中提取 firstPrompt", () => {
    const content = [
      userLine("你好，帮我写个函数"),
      assistantLine("好的"),
    ].join("\n");

    const result = extractFirstPrompt(content);
    expect(result).toBe("你好，帮我写个函数");
  });

  it("跳过 file-history-snapshot 行", () => {
    const content = [
      snapshotLine("msg-1"),
      snapshotLine("msg-2"),
      snapshotLine("msg-3"),
      userLine("真正的第一条消息"),
    ].join("\n");

    const result = extractFirstPrompt(content);
    expect(result).toBe("真正的第一条消息");
  });

  it("跳过 tool_result 类型的 user 消息", () => {
    const content = [
      toolResultLine(),
      userLine("这才是第一条"),
    ].join("\n");

    const result = extractFirstPrompt(content);
    expect(result).toBe("这才是第一条");
  });

  it("处理 content 为数组格式（多模态）", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "human",
        content: [
          { type: "image", source: { data: "base64..." } },
          { type: "text", text: "描述这张图片" },
        ],
      },
      sessionId: "s1",
      timestamp: new Date().toISOString(),
      uuid: "uuid-multi",
    });
    const content = line + "\n";

    const result = extractFirstPrompt(content);
    expect(result).toBe("描述这张图片");
  });

  it("截断超过 200 字符的内容", () => {
    const longText = "a".repeat(300);
    const content = userLine(longText) + "\n";

    const result = extractFirstPrompt(content);
    expect(result!.length).toBeLessThanOrEqual(201); // 200 + "…"
  });

  it("没有 user 消息时返回空字符串", () => {
    const content = [
      snapshotLine("msg-1"),
      assistantLine("只有 assistant"),
    ].join("\n");

    const result = extractFirstPrompt(content);
    expect(result).toBe("");
  });

  it("空内容返回空字符串", () => {
    expect(extractFirstPrompt("")).toBe("");
  });

  it("跳过 isMeta: true 的 user 消息", () => {
    // isMeta 是 CC 内部标记（IDE 上下文、session 钩子等），不应作为 firstPrompt
    const content = [
      metaUserLine("这是系统元消息"),
      userLine("这才是用户的第一条"),
    ].join("\n");

    const result = extractFirstPrompt(content);
    expect(result).toBe("这才是用户的第一条");
  });

  it("所有 user 消息都是 isMeta 时返回空字符串", () => {
    const content = [
      metaUserLine("元消息1"),
      metaUserLine("元消息2"),
    ].join("\n");

    const result = extractFirstPrompt(content);
    expect(result).toBe("");
  });
});

// ============ extractLastField 测试 ============

describe("extractLastField", () => {
  it("提取 customTitle 字段", () => {
    const content = [
      customTitleLine("第一个标题"),
      userLine("一些消息"),
      customTitleLine("第二个标题"),
    ].join("\n");

    const result = extractLastField(content, "customTitle");
    expect(result).toBe("第二个标题");
  });

  it("只有一个匹配时返回该值", () => {
    const content = customTitleLine("唯一标题") + "\n";

    const result = extractLastField(content, "customTitle");
    expect(result).toBe("唯一标题");
  });

  it("没有匹配时返回 undefined", () => {
    const content = userLine("没有标题") + "\n";

    const result = extractLastField(content, "customTitle");
    expect(result).toBeUndefined();
  });

  it("处理带引号的值", () => {
    const line = JSON.stringify({
      type: "custom-title",
      customTitle: '包含"引号"的标题',
      sessionId: "s1",
    });

    const result = extractLastField(line, "customTitle");
    expect(result).toBe('包含"引号"的标题');
  });

  it("处理带空格的 JSON 格式", () => {
    // 有些 JSON 格式化后 key: value 之间有空格
    const content = '"customTitle": "带空格格式"';

    const result = extractLastField(content, "customTitle");
    expect(result).toBe("带空格格式");
  });
});

// ============ scanSessionFiles 测试 ============

describe("scanSessionFiles", () => {
  it("扫描目录中所有 .jsonl 文件", () => {
    const { historyDir } = createTestProject();
    createSession(historyDir, "session-a", [userLine("a")]);
    createSession(historyDir, "session-b", [userLine("b")]);

    const result = scanSessionFiles(historyDir);

    expect(result.size).toBe(2);
    expect(result.has("session-a")).toBe(true);
    expect(result.has("session-b")).toBe(true);
  });

  it("忽略非 .jsonl 文件", () => {
    const { historyDir } = createTestProject();
    createSession(historyDir, "session-a", [userLine("a")]);
    writeFileSync(join(historyDir, "sessions-index.json"), "{}");
    writeFileSync(join(historyDir, "notes.txt"), "hello");

    const result = scanSessionFiles(historyDir);

    expect(result.size).toBe(1);
    expect(result.has("session-a")).toBe(true);
  });

  it("返回正确的 mtime 和 size", () => {
    const { historyDir } = createTestProject();
    const filePath = createSession(historyDir, "session-a", [userLine("hello")]);
    const stats = statSync(filePath);

    const result = scanSessionFiles(historyDir);
    const info = result.get("session-a")!;

    expect(info.path).toBe(filePath);
    expect(info.mtime).toBe(stats.mtime.getTime());
    expect(info.size).toBe(stats.size);
  });

  it("目录不存在返回空 Map", () => {
    const result = scanSessionFiles("/nonexistent/path");
    expect(result.size).toBe(0);
  });

  it("空目录返回空 Map", () => {
    const { historyDir } = createTestProject();
    const result = scanSessionFiles(historyDir);
    expect(result.size).toBe(0);
  });
});

// ============ readFileSummary 测试 ============

describe("readFileSummary", () => {
  it("提取 firstPrompt 和 customTitle", () => {
    const { historyDir } = createTestProject();
    const lines = [
      userLine("你好世界", "s1"),
      assistantLine("你好！"),
      customTitleLine("我的标题", "s1"),
    ];
    const filePath = createSession(historyDir, "s1", lines);
    const stats = statSync(filePath);

    const result = readFileSummary(filePath, stats.size);

    expect(result.firstPrompt).toBe("你好世界");
    expect(result.customTitle).toBe("我的标题");
  });

  it("文件只有 head 部分（小文件 < 16KB）也能正确提取", () => {
    const { historyDir } = createTestProject();
    const lines = [
      userLine("小文件消息", "s1"),
      customTitleLine("小文件标题", "s1"),
    ];
    const filePath = createSession(historyDir, "s1", lines);
    const stats = statSync(filePath);

    const result = readFileSummary(filePath, stats.size);

    expect(result.firstPrompt).toBe("小文件消息");
    expect(result.customTitle).toBe("小文件标题");
  });

  it("没有 customTitle 时返回 undefined", () => {
    const { historyDir } = createTestProject();
    const lines = [userLine("没有标题的会话", "s1")];
    const filePath = createSession(historyDir, "s1", lines);
    const stats = statSync(filePath);

    const result = readFileSummary(filePath, stats.size);

    expect(result.firstPrompt).toBe("没有标题的会话");
    expect(result.customTitle).toBeUndefined();
  });

  it("file-history-snapshot 开头的文件能正确提取 firstPrompt", () => {
    const { historyDir } = createTestProject();
    const lines = [
      snapshotLine("msg-1"),
      snapshotLine("msg-2"),
      snapshotLine("msg-3"),
      snapshotLine("msg-4"),
      snapshotLine("msg-5"),
      userLine("经过 5 个 snapshot 后的第一条消息", "s1"),
      assistantLine("回复"),
    ];
    const filePath = createSession(historyDir, "s1", lines);
    const stats = statSync(filePath);

    const result = readFileSummary(filePath, stats.size);

    expect(result.firstPrompt).toBe("经过 5 个 snapshot 后的第一条消息");
  });

  it("空文件返回空结果", () => {
    const { historyDir } = createTestProject();
    const filePath = join(historyDir, "empty.jsonl");
    writeFileSync(filePath, "");

    const result = readFileSummary(filePath, 0);

    expect(result.firstPrompt).toBe("");
    expect(result.customTitle).toBeUndefined();
  });

  it("大文件（>32KB）：head 有 firstPrompt，tail 有 customTitle，分离读取", () => {
    const { historyDir } = createTestProject();

    // 构造 > 32KB 的文件：head 区域有 user 消息，中间填充，tail 区域有 customTitle
    const headLines = [userLine("大文件的第一条消息", "s1")];
    // 填充约 40KB 的 assistant 消息（确保 head 和 tail 不重叠）
    const padding: string[] = [];
    const paddingText = "x".repeat(500);
    for (let i = 0; i < 80; i++) {
      padding.push(assistantLine(paddingText, "s1"));
    }
    const tailLines = [customTitleLine("大文件标题", "s1")];

    const allLines = [...headLines, ...padding, ...tailLines];
    const filePath = createSession(historyDir, "s1", allLines);
    const stats = statSync(filePath);

    // 确认文件确实 > 32KB
    expect(stats.size).toBeGreaterThan(32768);

    const result = readFileSummary(filePath, stats.size);

    expect(result.firstPrompt).toBe("大文件的第一条消息");
    expect(result.customTitle).toBe("大文件标题");
  });
});

// ============ getConversationList 测试 ============

describe("getConversationList", () => {
  it("返回按 mtime 降序排列的会话列表", () => {
    const { cwd, historyDir } = createTestProject();

    const now = new Date();
    const older = new Date(now.getTime() - 3600_000); // 1 小时前
    const oldest = new Date(now.getTime() - 7200_000); // 2 小时前

    createSession(historyDir, "old", [userLine("旧的")], oldest);
    createSession(historyDir, "mid", [userLine("中间")], older);
    createSession(historyDir, "new", [userLine("最新")], now);

    const result = getConversationList(cwd);

    expect(result.length).toBe(3);
    expect(result[0].sessionId).toBe("new");
    expect(result[1].sessionId).toBe("mid");
    expect(result[2].sessionId).toBe("old");
  });

  it("limit 参数限制返回数量", () => {
    const { cwd, historyDir } = createTestProject();

    const now = new Date();
    for (let i = 0; i < 5; i++) {
      const mtime = new Date(now.getTime() - i * 60_000);
      createSession(historyDir, `s${i}`, [userLine(`消息${i}`)], mtime);
    }

    const result = getConversationList(cwd, 3);

    expect(result.length).toBe(3);
    // 前 3 个是最新的
    expect(result[0].sessionId).toBe("s0");
    expect(result[1].sessionId).toBe("s1");
    expect(result[2].sessionId).toBe("s2");
  });

  it("不传 limit 时返回所有（默认行为，adapter 层会 slice）", () => {
    const { cwd, historyDir } = createTestProject();

    for (let i = 0; i < 5; i++) {
      createSession(historyDir, `s${i}`, [userLine(`消息${i}`)]);
    }

    const result = getConversationList(cwd);
    expect(result.length).toBe(5);
  });

  it("正确提取 firstPrompt", () => {
    const { cwd, historyDir } = createTestProject();
    createSession(historyDir, "s1", [
      userLine("这是第一条消息"),
      assistantLine("这是回复"),
    ]);

    const result = getConversationList(cwd);

    expect(result[0].firstPrompt).toBe("这是第一条消息");
  });

  it("正确提取 customTitle", () => {
    const { cwd, historyDir } = createTestProject();
    createSession(historyDir, "s1", [
      userLine("消息"),
      assistantLine("回复"),
      customTitleLine("自定义标题"),
    ]);

    const result = getConversationList(cwd);

    expect(result[0].customTitle).toBe("自定义标题");
  });

  it("messageCount 为 0（不再计算）", () => {
    const { cwd, historyDir } = createTestProject();
    createSession(historyDir, "s1", [
      userLine("消息1"),
      assistantLine("回复1"),
      userLine("消息2"),
      assistantLine("回复2"),
    ]);

    const result = getConversationList(cwd);

    expect(result[0].messageCount).toBe(0);
  });

  it("使用文件 mtime 作为 lastTime", () => {
    const { cwd, historyDir } = createTestProject();
    const specificTime = new Date("2026-02-06T10:00:00Z");
    createSession(historyDir, "s1", [userLine("消息")], specificTime);

    const result = getConversationList(cwd);

    // lastTime 应该基于文件 mtime
    const resultTime = new Date(result[0].lastTime).getTime();
    expect(resultTime).toBe(specificTime.getTime());
  });

  it("使用文件 ctime/birthtime 作为 startTime", () => {
    const { cwd, historyDir } = createTestProject();
    const filePath = createSession(historyDir, "s1", [userLine("消息")]);
    const stats = statSync(filePath);

    const result = getConversationList(cwd);

    // startTime 应该基于文件创建时间
    const resultTime = new Date(result[0].startTime).getTime();
    expect(resultTime).toBe(stats.birthtime.getTime());
  });

  it("空目录返回空数组", () => {
    const { cwd } = createTestProject();
    const result = getConversationList(cwd);
    expect(result).toEqual([]);
  });

  it("目录不存在返回空数组", () => {
    const result = getConversationList("/nonexistent/project/path");
    expect(result).toEqual([]);
  });

  it("过滤掉没有 firstPrompt 且没有 customTitle 的会话", () => {
    const { cwd, historyDir } = createTestProject();

    // 正常会话
    createSession(historyDir, "good", [userLine("正常消息")]);

    // 只有 snapshot 没有 user 消息的会话（在 16KB 内找不到 firstPrompt）
    createSession(historyDir, "empty", [
      snapshotLine("msg-1"),
      assistantLine("只有 assistant"),
    ]);

    const result = getConversationList(cwd);

    // 应该只返回有内容的会话
    const sessionIds = result.map(r => r.sessionId);
    expect(sessionIds).toContain("good");
    expect(sessionIds).not.toContain("empty");
  });

  it("600 权限的文件也能正常读取", () => {
    const { cwd, historyDir } = createTestProject();
    const filePath = createSession(historyDir, "s1", [userLine("600权限文件")]);

    // 模拟 CC 2.1.33 设置 600 权限
    chmodSync(filePath, 0o600);

    const result = getConversationList(cwd);

    expect(result.length).toBe(1);
    expect(result[0].firstPrompt).toBe("600权限文件");
  });
});

// ============ renameSession 测试 ============

describe("renameSession - 简化版（只写 .jsonl）", () => {
  it("成功改名：追加 custom-title 到 .jsonl", () => {
    const { cwd, historyDir } = createTestProject();
    const filePath = createSession(historyDir, "s1", [userLine("消息")]);

    const result = renameSession("s1", "新标题", cwd);

    expect(result).toBe(true);

    // 验证 .jsonl 文件末尾有 custom-title 行
    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    const lastLine = JSON.parse(lines[lines.length - 1]);
    expect(lastLine.type).toBe("custom-title");
    expect(lastLine.customTitle).toBe("新标题");
  });

  it("不再更新 sessions-index.json", () => {
    const { cwd, historyDir } = createTestProject();
    createSession(historyDir, "s1", [userLine("消息")]);

    // 创建一个假的索引文件
    const indexPath = join(historyDir, "sessions-index.json");
    const indexContent = JSON.stringify({ version: 1, entries: [] });
    writeFileSync(indexPath, indexContent);

    renameSession("s1", "新标题", cwd);

    // 索引文件应该不变
    const afterContent = readFileSync(indexPath, "utf-8");
    expect(afterContent).toBe(indexContent);
  });

  it("空标题返回 false", () => {
    const { cwd, historyDir } = createTestProject();
    createSession(historyDir, "s1", [userLine("消息")]);

    const result = renameSession("s1", "   ", cwd);
    expect(result).toBe(false);
  });

  it("会话文件不存在返回 false", () => {
    const { cwd } = createTestProject();

    const result = renameSession("nonexistent", "标题", cwd);
    expect(result).toBe(false);
  });

  it("多次改名，最后一个生效", () => {
    const { cwd, historyDir } = createTestProject();
    createSession(historyDir, "s1", [userLine("消息")]);

    renameSession("s1", "标题1", cwd);
    renameSession("s1", "标题2", cwd);
    renameSession("s1", "最终标题", cwd);

    // 通过 getConversationList 验证最终标题
    const list = getConversationList(cwd);
    expect(list[0].customTitle).toBe("最终标题");
  });
});
