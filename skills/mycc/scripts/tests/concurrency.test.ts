/**
 * 并发测试 - 验证多个 Claude API 调用同时执行是否会失败
 *
 * 目的：验证假设 "同时启动多个 CC 会导致 API 调用失败"
 *
 * 使用方法：
 *   cd .claude/skills/mycc/scripts
 *   npx tsx tests/concurrency.test.ts
 *
 * 注意：这个测试会真正调用 Claude API，会消耗额度
 */

import { adapter } from "../src/adapters/index.js";

const CWD = process.cwd().replace("/scripts", "").replace("/.claude/skills/mycc", "");

interface TestResult {
  taskId: number;
  success: boolean;
  error?: string;
  duration: number;
}

/**
 * 模拟定时任务执行
 */
async function simulateTask(taskId: number): Promise<TestResult> {
  const startTime = Date.now();
  const message = `[并发测试 #${taskId}] 请直接回复"收到 ${taskId}"，不要执行任何其他操作`;

  console.log(`[Task ${taskId}] 开始执行...`);

  try {
    for await (const event of adapter.chat({ message, cwd: CWD })) {
      // 忽略输出，只关心是否成功
    }

    const duration = Date.now() - startTime;
    console.log(`[Task ${taskId}] ✅ 成功 (${duration}ms)`);
    return { taskId, success: true, duration };
  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.log(`[Task ${taskId}] ❌ 失败: ${error.message}`);
    return {
      taskId,
      success: false,
      error: error.message || String(error),
      duration,
    };
  }
}

/**
 * 并发执行多个任务
 */
async function runConcurrencyTest(concurrency: number): Promise<TestResult[]> {
  console.log(`\n========================================`);
  console.log(`测试: 同时启动 ${concurrency} 个 Claude 调用`);
  console.log(`========================================\n`);

  // 同时启动所有任务
  const promises = Array.from({ length: concurrency }, (_, i) => simulateTask(i + 1));

  // 等待所有完成
  const results = await Promise.all(promises);

  return results;
}

/**
 * 打印测试报告
 */
function printReport(results: TestResult[]): void {
  console.log(`\n========================================`);
  console.log(`测试报告`);
  console.log(`========================================\n`);

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  console.log(`总任务数: ${results.length}`);
  console.log(`成功: ${successCount}`);
  console.log(`失败: ${failCount}`);
  console.log(`成功率: ${((successCount / results.length) * 100).toFixed(1)}%`);

  if (failCount > 0) {
    console.log(`\n失败详情:`);
    results
      .filter((r) => !r.success)
      .forEach((r) => {
        console.log(`  - Task ${r.taskId}: ${r.error}`);
      });
  }

  console.log(`\n结论: ${failCount === 0 ? "✅ 并发调用未发现问题" : "⚠️ 并发调用存在失败"}`);
}

/**
 * 主函数
 */
async function main() {
  console.log(`\n🧪 Claude API 并发测试`);
  console.log(`时间: ${new Date().toLocaleString()}`);
  console.log(`CWD: ${CWD}`);

  // 测试: 同时 10 个
  const results = await runConcurrencyTest(10);
  printReport(results);
}

main().catch(console.error);
