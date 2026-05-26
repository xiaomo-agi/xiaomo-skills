/**
 * 真实数据边界测试（集成测试）
 *
 * 前置条件：
 * - 后端服务必须运行（localhost:18080）
 * - current.json 配置文件必须存在
 * - 测试的历史对话文件必须存在于 ~/.claude/projects/
 *
 * 目的：验证历史记录优化在真实对话数据上的表现
 *
 * 测试场景：
 * 1. 无 summary 短对话 → 应返回全部消息
 * 2. 无 summary 中等对话 → 应返回全部消息
 * 3. 大量 summary 对话 → 应只返回最后一个 summary 之后的消息
 * 4. 有 summary 对话 → 应只返回最后一个 summary 之后的消息
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// 测试配置
interface TestCase {
  sessionId: string;
  totalLines: number;
  summaryCount: number;
  description: string;
}

const TEST_CASES: TestCase[] = [
  {
    // 12 行，无 summary
    sessionId: "011b900f-008d-4db5-af22-1afa6b5a590f",
    totalLines: 12,
    summaryCount: 0,
    description: "无 summary 短对话",
  },
  {
    // 48 行，无 summary
    sessionId: "039ce774-11d6-46d5-81e5-f29d16a0167f",
    totalLines: 48,
    summaryCount: 0,
    description: "无 summary 中等对话",
  },
  {
    // 48 行，32 个 summary
    sessionId: "0779d8ea-5731-4a89-9e87-58285be23f92",
    totalLines: 48,
    summaryCount: 32,
    description: "大量 summary 对话",
  },
  {
    // 153 行，10 个 summary
    sessionId: "015b3b9b-3232-4890-9ef3-96561722958e",
    totalLines: 153,
    summaryCount: 10,
    description: "有 summary 中等对话",
  },
];

// 工具函数：计算预期返回的消息数量
function calculateExpectedMessages(sessionId: string, cwd: string): number {
  const encodedName = cwd.replace(/\/$/, "").replace(/[/\\:._]/g, "-");
  const historyDir = join(homedir(), ".claude", "projects", encodedName);
  const filePath = join(historyDir, `${sessionId}.jsonl`);

  if (!existsSync(filePath)) {
    throw new Error(`History file not found: ${filePath}`);
  }

  const content = readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n").filter(line => line.trim());

  let lastSummaryIndex = -1;

  // 找到最后一个 summary 的位置
  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed.type === "summary") {
        lastSummaryIndex = i;
      }
    } catch {
      // 忽略解析错误的行
    }
  }

  // 返回最后一个 summary 之后的消息数量
  // 如果没有 summary，返回全部行数
  return lastSummaryIndex === -1 ? lines.length : lines.length - lastSummaryIndex - 1;
}

// 工具函数：从 current.json 读取配置
function loadCurrentConfig(): { token: string; cwd: string } {
  // 尝试多个可能的路径
  const possiblePaths = [
    join(process.cwd(), "../current.json"), // 在 scripts/ 目录下运行（配置在上一级）
    join(process.cwd(), "current.json"), // 直接在 mycc/ 目录运行
    join(process.cwd(), ".claude/skills/mycc/current.json"), // 在项目根目录运行
  ];

  let configPath: string | null = null;
  for (const path of possiblePaths) {
    if (existsSync(path)) {
      configPath = path;
      break;
    }
  }

  if (!configPath) {
    throw new Error(`Config file not found. 尝试的路径: ${possiblePaths.join(", ")}. 请先启动后端服务。`);
  }

  const config = JSON.parse(readFileSync(configPath, "utf-8"));

  if (!config.authToken || !config.cwd) {
    throw new Error("Invalid config: missing authToken or cwd");
  }

  return {
    token: config.authToken,
    cwd: config.cwd,
  };
}

// 工具函数：调用后端 API 获取历史
async function fetchHistory(token: string, sessionId: string): Promise<number> {
  const url = `http://localhost:18080/history/${sessionId}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.messages || !Array.isArray(data.messages)) {
    throw new Error("Invalid API response: missing messages array");
  }

  return data.messages.length;
}

describe("真实数据边界测试", () => {
  let token: string;
  let cwd: string;

  beforeAll(() => {
    const config = loadCurrentConfig();
    token = config.token;
    cwd = config.cwd;
  });

  for (const testCase of TEST_CASES) {
    it(`${testCase.description}（${testCase.sessionId.substring(0, 8)}...）`, async () => {
      // 计算预期返回数量
      const expectedCount = calculateExpectedMessages(testCase.sessionId, cwd);

      // 调用 API 获取实际返回数量
      const actualCount = await fetchHistory(token, testCase.sessionId);

      // 验证
      expect(actualCount).toBe(expectedCount);

      // 额外验证：无 summary 的对话应返回全部消息
      if (testCase.summaryCount === 0) {
        expect(actualCount).toBe(testCase.totalLines);
      }

      // 额外验证：有 summary 的对话应返回少于总行数
      if (testCase.summaryCount > 0) {
        expect(actualCount).toBeLessThan(testCase.totalLines);
      }

      console.log(`✅ ${testCase.description}: 预期 ${expectedCount} 条，实际 ${actualCount} 条`);
    });
  }
});
