/**
 * 工具调用摘要（Phase 2：飞书卡片工具调用摘要优化）
 * 按工具类型选取最有信息量的字段，替代固定优先级猜字段/裸 JSON dump。
 */
import { describe, it, expect } from "vitest";
import { summarizeToolInput, toolUseLine } from "../src/channels/tool-summary.js";

describe("summarizeToolInput", () => {
  it("Bash 显示命令", () => {
    expect(summarizeToolInput("Bash", { command: "npm test", description: "跑测试" })).toBe("npm test");
  });

  it("Grep 显示搜索词+目录，而不是只有目录", () => {
    // 旧实现固定优先级 path > pattern，Grep 会显示目录丢掉搜索词
    expect(summarizeToolInput("Grep", { pattern: "TODO", path: "/src" })).toBe("TODO in /src");
    expect(summarizeToolInput("Grep", { pattern: "TODO" })).toBe("TODO");
  });

  it("文件类工具显示文件路径", () => {
    expect(summarizeToolInput("Edit", { file_path: "/a/b.ts", old_string: "x", new_string: "y" })).toBe("/a/b.ts");
    expect(summarizeToolInput("Write", { file_path: "/a/c.ts", content: "巨大的文件内容".repeat(100) })).toBe("/a/c.ts");
  });

  it("Task/Agent 显示描述", () => {
    expect(summarizeToolInput("Task", { description: "修复 bug", prompt: "很长的提示词" })).toBe("修复 bug");
  });

  it("超长摘要截断并压成单行", () => {
    const s = summarizeToolInput("Bash", { command: "echo " + "很长".repeat(100) + "\n第二行" });
    expect(s.length).toBeLessThanOrEqual(61); // 60 + 省略号
    expect(s).not.toContain("\n");
    expect(s.endsWith("…")).toBe(true);
  });

  it("未知工具走兜底字段，非法输入返回空", () => {
    expect(summarizeToolInput("SomeMcpTool", { query: "天气" })).toBe("天气");
    expect(summarizeToolInput("Weird", null)).toBe("");
    expect(summarizeToolInput("Weird", "not-object")).toBe("");
  });

  it("toolUseLine 生成带图标的展示行", () => {
    expect(toolUseLine("Bash", { command: "ls" })).toBe("\n🔧 Bash：ls\n");
    expect(toolUseLine("Bash", {})).toBe("\n🔧 Bash\n");
  });
});
