/**
 * Codex 历史存储测试
 *
 * 数据目录遵守 MYCC_DATA_DIR（tests/setup.ts 已全局重定向到临时目录；
 * 这里每个用例再各自 mkdtemp 一层，验证 env 是运行期读取而非模块加载时固化）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { CodexHistoryStore } from "../src/adapters/codex-history.js";
import type { RawHistoryLine } from "../src/types.js";

let dataDir: string;
let savedEnv: string | undefined;
const store = new CodexHistoryStore();

function userLine(text: string): RawHistoryLine {
  return { type: "user", message: { role: "user", content: text } };
}

function assistantLine(text: string): RawHistoryLine {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

beforeEach(() => {
  savedEnv = process.env.MYCC_DATA_DIR;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mycc-codex-history-test-"));
  process.env.MYCC_DATA_DIR = dataDir;
});

afterEach(() => {
  process.env.MYCC_DATA_DIR = savedEnv;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("CodexHistoryStore", () => {
  it("appendTurn 落盘到 MYCC_DATA_DIR/codex-history/<sessionId>.json（原子写）", () => {
    store.appendTurn("thread-1", "/repo", [userLine("你好"), assistantLine("你好！")]);

    const file = path.join(dataDir, "codex-history", "thread-1.json");
    expect(fs.existsSync(file)).toBe(true);
    const record = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(record.sessionId).toBe("thread-1");
    expect(record.cwd).toBe("/repo");
    expect(record.messages).toHaveLength(2);
    // 没有残留 tmp 文件
    const leftover = fs.readdirSync(path.join(dataDir, "codex-history")).filter((f) => f.includes(".tmp"));
    expect(leftover).toEqual([]);
  });

  it("多轮 appendTurn 追加消息并更新 lastTime", async () => {
    store.appendTurn("thread-1", "/repo", [userLine("第一轮"), assistantLine("回1")]);
    const first = store.get("thread-1");
    await new Promise((r) => setTimeout(r, 5));
    store.appendTurn("thread-1", "/repo", [userLine("第二轮"), assistantLine("回2")]);

    const history = store.get("thread-1");
    expect(history?.messages).toHaveLength(4);
    const summaries = store.list("/repo");
    expect(summaries[0].messageCount).toBe(4);
    expect(summaries[0].startTime <= summaries[0].lastTime).toBe(true);
    expect(first).not.toBeNull();
  });

  it("list 按 cwd 过滤、按 lastTime 倒序，摘要含 firstPrompt/lastMessagePreview", async () => {
    store.appendTurn("thread-a", "/repo", [userLine("问题A"), assistantLine("答案A")]);
    await new Promise((r) => setTimeout(r, 5));
    store.appendTurn("thread-b", "/repo", [userLine("问题B"), assistantLine("答案B")]);
    store.appendTurn("thread-other", "/elsewhere", [userLine("别处")]);

    const list = store.list("/repo");
    expect(list.map((s) => s.sessionId)).toEqual(["thread-b", "thread-a"]);
    expect(list[0].firstPrompt).toBe("问题B");
    expect(list[0].lastMessagePreview).toBe("答案B");
    expect(list[0].customTitle).toBeNull();
    expect(store.list("/elsewhere")).toHaveLength(1);
    expect(store.list("/nowhere")).toEqual([]);
  });

  it("get 返回完整消息；不存在的 session 返回 null", () => {
    store.appendTurn("thread-1", "/repo", [userLine("你好")]);
    expect(store.get("thread-1")?.messages[0].message?.content).toBe("你好");
    expect(store.get("no-such-session")).toBeNull();
  });

  it("损坏的 JSON 文件不崩：list 跳过、appendTurn 当作新会话重建", () => {
    const dir = path.join(dataDir, "codex-history");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "corrupt.json"), "{ 不是 JSON");

    expect(store.list("/repo")).toEqual([]);
    store.appendTurn("corrupt", "/repo", [userLine("重建")]);
    expect(store.get("corrupt")?.messages).toHaveLength(1);
  });

  it("sessionId 里的危险字符被清洗，不发生路径穿越", () => {
    store.appendTurn("../../evil/id", "/repo", [userLine("x")]);
    const files = fs.readdirSync(path.join(dataDir, "codex-history"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("/");
    expect(files[0]).not.toMatch(/^\.\./);
    // 目录外没有文件泄漏
    expect(fs.existsSync(path.join(dataDir, "evil"))).toBe(false);
  });

  it("空 lines 或空 sessionId 不写盘", () => {
    store.appendTurn("", "/repo", [userLine("x")]);
    store.appendTurn("thread-1", "/repo", []);
    expect(fs.existsSync(path.join(dataDir, "codex-history"))).toBe(false);
  });
});
