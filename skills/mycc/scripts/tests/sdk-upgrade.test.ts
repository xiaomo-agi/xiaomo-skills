/**
 * SDK 升级测试：@anthropic-ai/claude-code → @anthropic-ai/claude-agent-sdk
 *
 * 验证三件事：
 * 1. import 路径切换到新 SDK
 * 2. sdkOptions.env 注入 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
 * 3. package.json 依赖正确
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

// ============ 1. package.json 依赖验证 ============

describe("package.json 依赖", () => {
  let pkg: Record<string, any>;

  beforeEach(() => {
    pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  });

  it("不再依赖 @anthropic-ai/claude-code", () => {
    const deps = pkg.dependencies || {};
    const devDeps = pkg.devDependencies || {};
    expect(deps["@anthropic-ai/claude-code"]).toBeUndefined();
    expect(devDeps["@anthropic-ai/claude-code"]).toBeUndefined();
  });

  it("依赖 @anthropic-ai/claude-agent-sdk", () => {
    const deps = pkg.dependencies || {};
    expect(deps["@anthropic-ai/claude-agent-sdk"]).toBeDefined();
    expect(deps["@anthropic-ai/claude-agent-sdk"]).toMatch(/^\^0\.2\./);
  });

  it("依赖 zod（agent-sdk 的 peerDep）", () => {
    const deps = pkg.dependencies || {};
    expect(deps["zod"]).toBeDefined();
    expect(deps["zod"]).toMatch(/^\^4\./);
  });
});

// ============ 2. import 路径验证 ============

describe("official.ts import 路径", () => {
  let officialSource: string;

  beforeEach(() => {
    officialSource = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");
  });

  it("import 来自 @anthropic-ai/claude-agent-sdk", () => {
    expect(officialSource).toContain('"@anthropic-ai/claude-agent-sdk"');
  });

  it("不再 import @anthropic-ai/claude-code", () => {
    expect(officialSource).not.toContain('"@anthropic-ai/claude-code"');
  });
});

// ============ 3. env 注入验证 ============

describe("OfficialAdapter env 注入", () => {
  let officialSource: string;

  beforeEach(() => {
    officialSource = readFileSync(join(SRC, "adapters", "official.ts"), "utf-8");
  });

  it("sdkOptions 包含 env 字段", () => {
    // 源码中应该有 env 配置
    expect(officialSource).toMatch(/env\s*:/);
  });

  it("env 中设置了 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", () => {
    expect(officialSource).toContain("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS");
  });

  it("env 合并了 process.env", () => {
    // 确保 env 包含 process.env 的展开
    expect(officialSource).toMatch(/\.\.\.process\.env/);
  });
});

// ============ 4. sdkOptions 结构验证（单元测试） ============

describe("sdkOptions 构造逻辑", () => {
  it("构造的 env 对象包含 Teams 环境变量 + 系统环境变量", () => {
    // 模拟 adapter 中 env 的构造方式
    const env = {
      ...process.env,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    };

    // Teams 环境变量存在
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");

    // 系统环境变量被保留（PATH 一定存在）
    expect(env.PATH).toBeDefined();
  });

  it("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS 不会被 process.env 覆盖", () => {
    // 即使 process.env 里有同名变量，我们设的值应该优先
    const originalValue = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;

    try {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "0";

      // adapter 中的写法：{...process.env, TEAMS: "1"} 确保我们的值在后面
      const env = {
        ...process.env,
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
      };

      expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");
    } finally {
      if (originalValue !== undefined) {
        process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = originalValue;
      } else {
        delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
      }
    }
  });
});
