/**
 * Codex 会话历史存储
 *
 * Codex CLI（exec 模式）没有本仓库可直接读取的会话 JSONL（rollout 在 CODEX_HOME
 * 内部格式不稳定），所以 mycc 自己维护一份历史：每个 session 一个 JSON 文件，
 * 存在 MYCC_DATA_DIR/codex-history/ 下，写入走 json-store 的原子写。
 *
 * 注意：MYCC_DATA_DIR 必须在每次调用时读取（不能模块加载时固化），
 * 测试 setup（tests/setup.ts）依赖运行期重定向该变量来隔离生产数据。
 */
import fs from "fs";
import path from "path";
import type { ConversationSummary, ConversationHistory, RawHistoryLine } from "../types.js";
import { readJsonFile, writeJsonFileAtomic } from "../json-store.js";

/** 单个 Codex 会话的落盘结构 */
export interface CodexSessionRecord {
  sessionId: string;
  cwd: string;
  startTime: string;
  lastTime: string;
  messages: RawHistoryLine[];
}

/** 运行时状态目录：与 feishu-commands/process-registry 同一约定，但按调用时读取 */
function dataDir(): string {
  return process.env.MYCC_DATA_DIR || path.resolve(import.meta.dirname, "../data");
}

function historyDir(): string {
  return path.join(dataDir(), "codex-history");
}

/** sessionId 里出现意外字符时防路径穿越（codex thread id 正常是 UUID 形状） */
function sanitizeId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
}

function fileFor(sessionId: string): string {
  return path.join(historyDir(), `${sanitizeId(sessionId)}.json`);
}

/** 从一条历史行里抽出可预览的文本 */
function previewOf(line: RawHistoryLine | undefined): string {
  if (!line?.message) return "";
  const content = line.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("");
  }
  return "";
}

export class CodexHistoryStore {
  /**
   * 追加一轮对话的历史行；文件不存在时创建。
   * 每轮结束调用一次，整文件原子重写（会话体量小，简单优先）。
   */
  appendTurn(sessionId: string, cwd: string, lines: RawHistoryLine[]): void {
    if (!sessionId || lines.length === 0) return;
    const file = fileFor(sessionId);
    const now = new Date().toISOString();
    const existing = readJsonFile<CodexSessionRecord>(file);
    const record: CodexSessionRecord = existing ?? {
      sessionId,
      cwd,
      startTime: now,
      lastTime: now,
      messages: [],
    };
    record.messages.push(...lines);
    record.lastTime = now;
    record.cwd = cwd;
    writeJsonFileAtomic(file, record);
  }

  /** 按 cwd 列出会话摘要，最近活跃在前 */
  list(cwd: string): ConversationSummary[] {
    let files: string[];
    try {
      files = fs.readdirSync(historyDir()).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }

    const summaries: ConversationSummary[] = [];
    for (const f of files) {
      const record = readJsonFile<CodexSessionRecord>(path.join(historyDir(), f));
      if (!record || record.cwd !== cwd) continue;
      const firstUser = record.messages.find((m) => m.type === "user");
      const last = record.messages[record.messages.length - 1];
      summaries.push({
        sessionId: record.sessionId,
        startTime: record.startTime,
        lastTime: record.lastTime,
        messageCount: record.messages.length,
        lastMessagePreview: previewOf(last).substring(0, 100),
        customTitle: null,
        firstPrompt: previewOf(firstUser).substring(0, 100) || undefined,
        modified: record.lastTime,
      });
    }

    summaries.sort((a, b) => (a.lastTime < b.lastTime ? 1 : a.lastTime > b.lastTime ? -1 : 0));
    return summaries;
  }

  /** 读取单个会话详情；不存在返回 null */
  get(sessionId: string): ConversationHistory | null {
    const record = readJsonFile<CodexSessionRecord>(fileFor(sessionId));
    if (!record) return null;
    return { sessionId: record.sessionId, messages: record.messages };
  }
}
