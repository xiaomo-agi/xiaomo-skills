/**
 * CodexAdapter 端到端测试（fake codex 二进制）
 *
 * 本机没有 codex CLI：用临时 node 脚本假冒 codex，可执行文件读 stdin 的
 * prompt、把 argv 落盘（供断言 resume/--image 等旗标）、往 stdout 吐 JSONL。
 * 验证 chat() 的 SSE 事件形状与 OfficialAdapter 兼容、resume 映射、
 * 历史落盘、错误路径。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { CodexAdapter } from "../src/adapters/codex.js";
import type { SSEEvent } from "../src/adapters/interface.js";

let workDir: string;
let dataDir: string;
let argsFile: string;
let savedDataDir: string | undefined;

beforeEach(() => {
  savedDataDir = process.env.MYCC_DATA_DIR;
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mycc-codex-e2e-"));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mycc-codex-e2e-data-"));
  process.env.MYCC_DATA_DIR = dataDir;
  argsFile = path.join(workDir, "captured-args.json");
  process.env.CODEX_FAKE_ARGS_FILE = argsFile;
});

afterEach(() => {
  process.env.MYCC_DATA_DIR = savedDataDir;
  delete process.env.CODEX_FAKE_ARGS_FILE;
  delete process.env.MYCC_CODEX_BIN;
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** 生成 fake codex 可执行脚本（CJS，tmpdir 下无 package.json 所以 require 可用） */
function writeFakeCodex(body: string): string {
  const file = path.join(workDir, `fake-codex-${Math.random().toString(36).slice(2)}.js`);
  const script = `#!/usr/bin/env node
const fs = require("fs");
let input = "";
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  if (process.env.CODEX_FAKE_ARGS_FILE) {
    fs.writeFileSync(process.env.CODEX_FAKE_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
  }
  const emit = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
  ${body}
});
`;
  fs.writeFileSync(file, script, { mode: 0o755 });
  return file;
}

/** 标准的一回合成功输出 */
function happyFakeCodex(): string {
  return writeFakeCodex(`
  emit({ type: "thread.started", thread_id: "thread-abc" });
  emit({ type: "turn.started" });
  emit({ type: "item.started", item: { id: "cmd-1", type: "command_execution", command: "pwd" } });
  emit({ type: "item.completed", item: { id: "cmd-1", type: "command_execution", output: "/repo\\n", exit_code: 0 } });
  emit({ type: "item.completed", item: { id: "msg-1", type: "agent_message", text: "收到：" + input.trim() } });
  emit({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 7 } });
`);
}

async function collect(iter: AsyncIterable<SSEEvent>): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  for await (const e of iter) events.push(e);
  return events;
}

function capturedArgs(): string[] {
  return JSON.parse(fs.readFileSync(argsFile, "utf-8"));
}

describe("CodexAdapter.chat 端到端（fake codex）", () => {
  it("新会话：完整事件序列 system → tool_use → tool_result → 文本 → result → turn_complete", async () => {
    const adapter = new CodexAdapter({ binary: happyFakeCodex() });
    const created: string[] = [];
    adapter.setLifecycleCallbacks({ onSessionCreate: (id) => created.push(id) });

    const events = await collect(adapter.chat({ message: "你好 codex", cwd: workDir }));

    // 1. system 事件带 session_id（feishu/web 靠它绑定会话）
    const system = events.find((e) => e.type === "system") as any;
    expect(system.session_id).toBe("thread-abc");
    expect(created).toEqual(["thread-abc"]);

    // 2. assistant tool_use block（feishu 卡片渲染 🔧 行的形状）
    const toolUse = events.find(
      (e: any) => e.type === "assistant" && e.message?.content?.[0]?.type === "tool_use"
    ) as any;
    expect(toolUse.message.content[0]).toMatchObject({ name: "Bash", input: { command: "pwd" } });

    // 3. 顶层 tool_result（web 端工具状态广播的形状）
    const toolResult = events.find((e) => e.type === "tool_result") as any;
    expect(toolResult).toMatchObject({ id: "cmd-1", output: "/repo\n", is_error: false });

    // 4. assistant 文本 block，且 prompt 确实从 stdin 传给了 codex
    const text = events.find(
      (e: any) => e.type === "assistant" && e.message?.content?.[0]?.type === "text"
    ) as any;
    expect(text.message.content[0].text).toBe("收到：你好 codex");

    // 5. result + turn_complete 收尾（与 OfficialAdapter 对齐）
    const result = events.find((e) => e.type === "result") as any;
    expect(result).toMatchObject({
      subtype: "success",
      is_error: false,
      session_id: "thread-abc",
      usage: { input_tokens: 3, output_tokens: 7 },
    });
    expect(result.result).toContain("收到：你好 codex");
    expect(events[events.length - 1]).toEqual({ type: "turn_complete" });

    // 6. argv：新会话不带 resume
    const args = capturedArgs();
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args).not.toContain("resume");
    expect(args).toContain("workspace-write");
    expect(args).toContain('approval_policy="never"');
  });

  it("resume：带 sessionId 时 argv 走 exec resume <thread_id>，多轮对话连续", async () => {
    const adapter = new CodexAdapter({ binary: happyFakeCodex() });

    await collect(adapter.chat({ message: "第一轮", cwd: workDir }));
    await collect(adapter.chat({ message: "第二轮", sessionId: "thread-abc", cwd: workDir }));

    const args = capturedArgs();
    expect(args).toContain("resume");
    expect(args[args.length - 2]).toBe("thread-abc");
    expect(args[args.length - 1]).toBe("-");
  });

  it("历史落盘：chat 后 listHistory/getHistory 能查到本轮对话", async () => {
    const adapter = new CodexAdapter({ binary: happyFakeCodex() });
    await collect(adapter.chat({ message: "记住这句话", cwd: workDir }));

    const list = await adapter.listHistory(workDir);
    expect(list.total).toBe(1);
    expect(list.conversations[0].sessionId).toBe("thread-abc");
    expect(list.conversations[0].firstPrompt).toBe("记住这句话");

    const history = await adapter.getHistory(workDir, "thread-abc");
    expect(history).not.toBeNull();
    // 用户消息 + 工具调用 + 助手文本都在
    const types = history!.messages.map((m) => m.type);
    expect(types[0]).toBe("user");
    expect(types).toContain("assistant");
    expect(history!.messages[0].message?.content).toBe("记住这句话");

    // 多轮追加
    await collect(adapter.chat({ message: "第二轮", sessionId: "thread-abc", cwd: workDir }));
    const after = await adapter.getHistory(workDir, "thread-abc");
    expect(after!.messages.length).toBeGreaterThan(history!.messages.length);

    // listHistory 的 limit 语义与 OfficialAdapter 一致
    const limited = await adapter.listHistory(workDir, 1);
    expect(limited.conversations).toHaveLength(1);
    expect(limited.hasMore).toBe(false);
  });

  it("图片：base64 落成临时文件传 --image，回合结束后清理", async () => {
    const adapter = new CodexAdapter({ binary: happyFakeCodex() });
    const png = Buffer.from("fake-png-bytes").toString("base64");

    await collect(
      adapter.chat({
        message: "看图",
        cwd: workDir,
        images: [{ data: png, mediaType: "image/png" }],
      })
    );

    const args = capturedArgs();
    const imgIdx = args.indexOf("--image");
    expect(imgIdx).toBeGreaterThan(-1);
    const imgPath = args[imgIdx + 1];
    expect(imgPath.endsWith(".png")).toBe(true);
    // 回合结束后临时图片已清理
    expect(fs.existsSync(imgPath)).toBe(false);
  });

  it("turn.failed：抛错（供上层 SSE error/飞书错误提示），已产出的事件不丢", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const binary = writeFakeCodex(`
  emit({ type: "thread.started", thread_id: "thread-fail" });
  emit({ type: "item.completed", item: { id: "m", type: "agent_message", text: "先说一半" } });
  emit({ type: "turn.failed", error: { message: "model stopped" } });
`);
    const adapter = new CodexAdapter({ binary });

    const events: SSEEvent[] = [];
    await expect(async () => {
      for await (const e of adapter.chat({ message: "会失败", cwd: workDir })) events.push(e);
    }).rejects.toThrow(/codex 回合失败: model stopped/);

    // 失败前的 system + 文本事件已经流出去了
    expect(events.some((e) => e.type === "system")).toBe(true);
    expect(events.some((e) => e.type === "assistant")).toBe(true);
    // 失败回合的历史也保留（用户消息 + 已产出内容）
    const history = await adapter.getHistory(workDir, "thread-fail");
    expect(history!.messages[0].message?.content).toBe("会失败");
  });

  it("非零退出码且无终态事件：抛错并带 stderr 细节", async () => {
    const binary = writeFakeCodex(`
  process.stderr.write("boom: sandbox denied\\n");
  process.exit(2);
`);
    const adapter = new CodexAdapter({ binary });

    await expect(collect(adapter.chat({ message: "x", cwd: workDir }))).rejects.toThrow(
      /退出码 2.*boom: sandbox denied/s
    );
  });

  it("二进制不存在：抛'无法启动 codex'", async () => {
    const adapter = new CodexAdapter({ binary: path.join(workDir, "no-such-codex") });
    await expect(collect(adapter.chat({ message: "x", cwd: workDir }))).rejects.toThrow(
      /无法启动 codex/
    );
  });

  it("未指定 binary 时吃 MYCC_CODEX_BIN 环境变量（运行期读取）", async () => {
    process.env.MYCC_CODEX_BIN = happyFakeCodex();
    const adapter = new CodexAdapter();
    const events = await collect(adapter.chat({ message: "env 注入", cwd: workDir }));
    expect(events.some((e) => e.type === "result")).toBe(true);
  });

  it("protocol drift：流里混入未知事件不崩，回合正常完成", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const binary = writeFakeCodex(`
  emit({ type: "thread.started", thread_id: "thread-drift" });
  emit({ type: "brand.new.event", payload: 1 });
  emit({ type: "item.completed", item: { id: "m", type: "agent_message", text: "ok" } });
  emit({ type: "turn.completed" });
`);
    const adapter = new CodexAdapter({ binary });
    const events = await collect(adapter.chat({ message: "x", cwd: workDir }));
    expect(events.some((e) => e.type === "result")).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("protocol drift"))).toBe(true);
  });

  it("getOrCreateSession 明确不支持（Codex 无常驻 session）", () => {
    const adapter = new CodexAdapter();
    expect(() => adapter.getOrCreateSession({})).toThrow(/不支持 getOrCreateSession/);
  });

  it("closeSession/closeAllSessions 幂等且触发生命周期回调", () => {
    const adapter = new CodexAdapter();
    const closed: string[] = [];
    adapter.setLifecycleCallbacks({ onSessionClose: (id) => closed.push(id) });
    adapter.closeSession("thread-x");
    adapter.closeAllSessions();
    expect(closed).toEqual(["thread-x"]);
  });
});
