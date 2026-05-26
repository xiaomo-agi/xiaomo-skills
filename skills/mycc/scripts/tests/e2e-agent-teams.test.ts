/**
 * Agent Teams 端到端集成测试
 *
 * 前置条件：
 * - 后端服务必须运行（localhost:18080）
 * - current.json 配置文件必须存在
 * - Claude Code CLI 必须可用
 *
 * 目的：验证通过 mycc API 走完 Agent Teams 全生命周期
 *   建队 → 建任务 → 派成员 → 成员干活 → 关队
 *
 * 运行方式：
 *   npx vitest run tests/e2e-agent-teams.test.ts
 *
 * 注意：
 * - 此测试消耗真实 API 额度，不要在 CI 中运行
 * - 超时设置 5 分钟（Agent Teams 流程较长）
 * - 默认跳过，设置环境变量 RUN_E2E=1 启用
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// ============ 配置 ============

const BASE_URL = "http://localhost:18080";
const TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

// Agent Teams 测试 prompt：简单的 TeamCreate → Task → TeamDelete 全生命周期
const TEAM_PROMPT = [
  "用 TeamCreate 创建一个名为 e2e-test 的团队，",
  "然后用 Task 工具派一个 haiku 成员回答 1+1=?，",
  "等他完成后用 TeamDelete 关闭团队。",
].join("");

// ============ SSE 事件类型 ============

interface SSEEvent {
  type: string;
  subtype?: string;
  [key: string]: unknown;
}

// ============ 工具函数 ============

function loadConfig(): { authToken: string; cwd: string } {
  const possiblePaths = [
    join(process.cwd(), "../current.json"),
    join(process.cwd(), "current.json"),
    join(process.cwd(), ".claude/skills/mycc/current.json"),
  ];

  for (const path of possiblePaths) {
    if (existsSync(path)) {
      const config = JSON.parse(readFileSync(path, "utf-8"));
      if (config.authToken && config.cwd) {
        return { authToken: config.authToken, cwd: config.cwd };
      }
    }
  }

  throw new Error("current.json 未找到或配置不完整，请先启动后端");
}

/**
 * 调用 /chat API 并收集所有 SSE 事件
 * 返回 { events, result }
 */
async function chatAndCollectEvents(
  authToken: string,
  message: string,
  timeoutMs: number = TIMEOUT_MS,
): Promise<{ events: SSEEvent[]; result: SSEEvent | null; rawTexts: string[] }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${BASE_URL}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ message }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const events: SSEEvent[] = [];
    const rawTexts: string[] = [];
    let result: SSEEvent | null = null;

    // 读取 SSE 流
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // 保留未完成的行

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;

        try {
          const event = JSON.parse(line.slice(6)) as SSEEvent;
          events.push(event);

          // 提取文本内容
          if (event.type === "assistant") {
            const msg = event.message as any;
            if (msg?.content) {
              for (const block of msg.content) {
                if (block.type === "text" && block.text) {
                  rawTexts.push(block.text);
                }
              }
            }
          }

          // 记录 result
          if (event.type === "result") {
            result = event;
          }
        } catch {
          // 跳过非 JSON 行
        }
      }
    }

    return { events, result, rawTexts };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 从 SSE 事件中提取所有 tool_use 调用
 */
function extractToolUses(events: SSEEvent[]): Array<{ name: string; input: any }> {
  const toolUses: Array<{ name: string; input: any }> = [];

  for (const event of events) {
    if (event.type === "assistant") {
      const msg = event.message as any;
      if (msg?.content) {
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            toolUses.push({ name: block.name, input: block.input });
          }
        }
      }
    }
  }

  return toolUses;
}

// ============ 测试 ============

const shouldRun = process.env.RUN_E2E === "1";

describe.skipIf(!shouldRun)("Agent Teams 端到端集成测试", () => {
  let authToken: string;
  let cwd: string;

  beforeAll(() => {
    const config = loadConfig();
    authToken = config.authToken;
    cwd = config.cwd;
  });

  it(
    "完整生命周期：建队 → 派成员 → 干活 → 关队",
    async () => {
      console.log("📤 发送 Agent Teams 请求...");
      console.log(`   Prompt: ${TEAM_PROMPT.substring(0, 60)}...`);

      const { events, result, rawTexts } = await chatAndCollectEvents(
        authToken,
        TEAM_PROMPT,
      );

      console.log(`📥 收到 ${events.length} 个 SSE 事件`);

      // ---- 1. 基础：请求成功完成 ----
      expect(result).not.toBeNull();
      expect(result!.is_error).toBe(false);
      console.log(
        `✅ 请求成功完成，耗时 ${result!.duration_ms}ms，花费 $${result!.total_cost_usd}`,
      );

      // ---- 2. 提取 tool_use 调用 ----
      const toolUses = extractToolUses(events);
      const toolNames = toolUses.map((t) => t.name);
      console.log(
        `🔧 工具调用: ${toolNames.join(", ")}`,
      );

      // ---- 3. 验证 TeamCreate 被调用 ----
      const teamCreates = toolUses.filter((t) => t.name === "TeamCreate");
      expect(teamCreates.length).toBeGreaterThanOrEqual(1);
      console.log(
        `✅ TeamCreate 调用 ${teamCreates.length} 次`,
      );

      // ---- 4. 验证 Task 工具被调用（派成员，至少 1 个） ----
      const taskSpawns = toolUses.filter(
        (t) => t.name === "Task" && t.input?.team_name,
      );
      expect(taskSpawns.length).toBeGreaterThanOrEqual(1);
      console.log(
        `✅ 派出 ${taskSpawns.length} 个队友`,
      );

      // ---- 5. TaskCreate 可选（模型可能不显式建任务） ----
      const taskCreates = toolUses.filter((t) => t.name === "TaskCreate");
      console.log(
        `ℹ️ TaskCreate 调用 ${taskCreates.length} 次`,
      );

      // ---- 6. 验证 SendMessage 被调用（关队 shutdown） ----
      const shutdowns = toolUses.filter(
        (t) =>
          t.name === "SendMessage" &&
          t.input?.type === "shutdown_request",
      );
      // shutdown 可能没发（如果队友先自己退了），所以只检查有没有 TeamDelete
      const teamDeletes = toolUses.filter((t) => t.name === "TeamDelete");
      // 有 shutdown 或 teamDelete 都算正常收尾
      const hasCleanup = shutdowns.length > 0 || teamDeletes.length > 0;
      expect(hasCleanup).toBe(true);
      console.log(
        `✅ 团队清理: shutdown_request=${shutdowns.length}, TeamDelete=${teamDeletes.length}`,
      );

      // ---- 7. 打印最终回复 ----
      const resultText =
        typeof result!.result === "string" ? result!.result : "";
      console.log(`\n📝 最终回复:\n${resultText.substring(0, 500)}`);
    },
    TIMEOUT_MS,
  );

  it(
    "结果包含 turns 统计",
    async () => {
      // 这个测试依赖上一个测试的 result，但 vitest 不共享状态
      // 所以这里只验证 result 的 usage 结构
      // 实际 turns 验证在上一个测试的 console.log 中体现

      // 简单验证：发一个普通消息确认 API 可用
      const { result } = await chatAndCollectEvents(
        authToken,
        "说 ok",
        30_000,
      );

      expect(result).not.toBeNull();
      expect(result!.type).toBe("result");
      expect(result!.subtype).toBe("success");
      expect(typeof result!.num_turns).toBe("number");
      expect(typeof result!.duration_ms).toBe("number");
      console.log(
        `✅ API 正常: ${result!.num_turns} turns, ${result!.duration_ms}ms`,
      );
    },
    60_000,
  );
});
