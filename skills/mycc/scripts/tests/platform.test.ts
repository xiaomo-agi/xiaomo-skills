/**
 * 跨平台工具函数测试
 * 测试 Windows / Mac / Linux 的兼容性
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parse } from "path";

// 导入待测试的函数
import {
  isWindows,
  NULL_DEVICE,
  sleep,
  getRoot,
  detectCloudflaredPath,
  getCloudflaredInstallHint,
} from "../src/platform";

describe("平台检测常量", () => {
  describe("isWindows", () => {
    it("返回当前平台是否是 Windows", () => {
      // 这个测试在不同平台上结果不同，但类型应该是 boolean
      expect(typeof isWindows).toBe("boolean");
      expect(isWindows).toBe(process.platform === "win32");
    });
  });

  describe("NULL_DEVICE", () => {
    it("根据平台返回正确的空设备路径", () => {
      if (process.platform === "win32") {
        expect(NULL_DEVICE).toBe("NUL");
      } else {
        expect(NULL_DEVICE).toBe("/dev/null");
      }
    });
  });
});

describe("sleep - 跨平台延迟", () => {
  it("异步等待指定毫秒", async () => {
    const start = Date.now();
    await sleep(100);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90); // 允许一点误差
    expect(elapsed).toBeLessThan(200); // 不应该太长
  });

  it("sleep(0) 立即返回", async () => {
    const start = Date.now();
    await sleep(0);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});

describe("getRoot - 根目录获取", () => {
  it("Mac/Linux 路径返回 /", () => {
    expect(getRoot("/Users/aster/project")).toBe("/");
    expect(getRoot("/home/user/work")).toBe("/");
    expect(getRoot("/")).toBe("/");
  });

  it("Windows 路径返回盘符根目录", () => {
    // 使用 path.parse 来验证我们的实现是正确的
    expect(getRoot("C:\\Users\\pc\\project")).toBe(parse("C:\\Users\\pc\\project").root);
    expect(getRoot("D:\\work")).toBe(parse("D:\\work").root);
  });
});

describe("detectCloudflaredPath - cloudflared 路径检测", () => {
  const originalEnv = process.env.CLOUDFLARED_PATH;

  beforeEach(() => {
    delete process.env.CLOUDFLARED_PATH;
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.CLOUDFLARED_PATH = originalEnv;
    } else {
      delete process.env.CLOUDFLARED_PATH;
    }
  });

  describe("环境变量优先", () => {
    it("设置了 CLOUDFLARED_PATH 环境变量，直接返回", () => {
      process.env.CLOUDFLARED_PATH = "/custom/path/cloudflared";
      expect(detectCloudflaredPath()).toBe("/custom/path/cloudflared");
    });
  });

  describe("无环境变量时", () => {
    it("返回字符串类型的路径", () => {
      const result = detectCloudflaredPath();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("Mac/Linux 返回路径或 cloudflared", () => {
      if (process.platform !== "win32") {
        const result = detectCloudflaredPath();
        // 要么是完整路径，要么是 cloudflared
        expect(
          result === "cloudflared" ||
          result.startsWith("/")
        ).toBe(true);
      }
    });

    it("Windows 返回 cloudflared（依赖 PATH）", () => {
      if (process.platform === "win32") {
        const result = detectCloudflaredPath();
        expect(result).toBe("cloudflared");
      }
    });
  });
});

describe("getCloudflaredInstallHint - 安装提示", () => {
  it("返回非空字符串", () => {
    const hint = getCloudflaredInstallHint();
    expect(typeof hint).toBe("string");
    expect(hint.length).toBeGreaterThan(0);
  });

  it("Mac/Linux 包含 brew", () => {
    if (process.platform !== "win32") {
      const hint = getCloudflaredInstallHint();
      expect(hint).toContain("brew");
    }
  });

  it("Windows 包含下载链接和 PATH 说明", () => {
    if (process.platform === "win32") {
      const hint = getCloudflaredInstallHint();
      expect(hint).toContain("cloudflare.com");
      expect(hint).toContain("PATH");
    }
  });
});

// 以下测试需要 mock，在实际运行时可能跳过
describe("killPortProcess - 端口进程清理", () => {
  // 这个函数涉及系统命令，不好直接测试
  // 主要验证不会抛异常
  it("对未占用的端口不抛异常", async () => {
    const { killPortProcess } = await import("../src/platform");
    // 使用一个不太可能被占用的端口
    await expect(killPortProcess(59999)).resolves.not.toThrow();
  });
});

describe("detectClaudeCliPath - Claude CLI 路径检测", () => {
  it("返回正确的结构 { executable, cliPath }", async () => {
    const { detectClaudeCliPath } = await import("../src/platform");
    const result = detectClaudeCliPath();

    expect(result).toHaveProperty("executable");
    expect(result).toHaveProperty("cliPath");
    expect(typeof result.executable).toBe("string");
    expect(typeof result.cliPath).toBe("string");
  });

  it("executable 是 claude 或 node", async () => {
    const { detectClaudeCliPath } = await import("../src/platform");
    const result = detectClaudeCliPath();

    expect(["claude", "node"]).toContain(result.executable);
  });

  it("Mac/Linux npm 全局安装返回 node + cli.js 路径", async () => {
    if (process.platform === "win32") return; // Windows 跳过

    const { detectClaudeCliPath } = await import("../src/platform");
    const result = detectClaudeCliPath();

    // 如果是 npm 全局安装，应该检测到 node + cli.js
    if (result.executable === "node") {
      expect(result.cliPath).toContain("cli.js");
      expect(result.cliPath).toContain("@anthropic-ai/claude-code");
    }
  });

  it("cliPath 指向有效路径或命令名", async () => {
    const { detectClaudeCliPath } = await import("../src/platform");
    const { existsSync } = await import("fs");
    const result = detectClaudeCliPath();

    // 要么是存在的文件路径，要么是命令名（依赖 PATH）
    const isFile = existsSync(result.cliPath);
    const isCommand = result.cliPath === "claude" || result.cliPath === "claude.exe";
    expect(isFile || isCommand).toBe(true);
  });

  it("Windows 返回 claude 或 node（取决于安装方式）", async () => {
    if (process.platform !== "win32") return; // 非 Windows 跳过

    const { detectClaudeCliPath } = await import("../src/platform");
    const result = detectClaudeCliPath();

    // Windows npm 安装返回 node，native binary 返回 claude
    expect(["claude", "node"]).toContain(result.executable);

    // 如果是 node，cliPath 应该指向 cli.js
    if (result.executable === "node") {
      expect(result.cliPath).toContain("cli.js");
    }
  });
});

// ========== 逻辑验证测试（不依赖 mock，验证返回值的合理性）==========

describe("detectClaudeCliPath - 逻辑验证", () => {
  it("返回值始终有效：executable 和 cliPath 都非空", async () => {
    const { detectClaudeCliPath } = await import("../src/platform");
    const result = detectClaudeCliPath();

    expect(result.executable).toBeTruthy();
    expect(result.cliPath).toBeTruthy();
    expect(result.executable.length).toBeGreaterThan(0);
    expect(result.cliPath.length).toBeGreaterThan(0);
  });

  it("executable 为 node 时，cliPath 必须包含 cli.js", async () => {
    const { detectClaudeCliPath } = await import("../src/platform");
    const result = detectClaudeCliPath();

    if (result.executable === "node") {
      expect(result.cliPath).toContain("cli.js");
    }
  });

  it("executable 为 claude 时，cliPath 应该是路径或命令名", async () => {
    const { detectClaudeCliPath } = await import("../src/platform");
    const result = detectClaudeCliPath();

    if (result.executable === "claude") {
      // 要么是绝对路径，要么是命令名
      const isAbsolutePath = result.cliPath.startsWith("/") || /^[A-Z]:\\/.test(result.cliPath);
      const isCommandName = result.cliPath === "claude" || result.cliPath === "claude.exe";
      expect(isAbsolutePath || isCommandName).toBe(true);
    }
  });

  it("多次调用返回相同结果（幂等性）", async () => {
    const { detectClaudeCliPath } = await import("../src/platform");
    const result1 = detectClaudeCliPath();
    const result2 = detectClaudeCliPath();

    expect(result1).toEqual(result2);
  });

  it("Windows: cliPath 不会包含 Unix 风格路径", async () => {
    if (process.platform !== "win32") return;

    const { detectClaudeCliPath } = await import("../src/platform");
    const result = detectClaudeCliPath();

    // Windows 路径不应该以 / 开头（除非是命令名 "claude"）
    if (result.cliPath !== "claude" && result.cliPath !== "claude.exe") {
      expect(result.cliPath.startsWith("/")).toBe(false);
    }
  });

  it("Mac/Linux: cliPath 不会包含 Windows 风格路径", async () => {
    if (process.platform === "win32") return;

    const { detectClaudeCliPath } = await import("../src/platform");
    const result = detectClaudeCliPath();

    // Mac/Linux 路径不应该包含反斜杠
    expect(result.cliPath).not.toContain("\\");
  });
});

// ========== 补充测试：覆盖遗漏场景 ==========

describe("checkCloudflared - cloudflared 可用性检测", () => {
  it("返回 boolean 类型", async () => {
    const { checkCloudflared } = await import("../src/platform");
    const result = await checkCloudflared();
    expect(typeof result).toBe("boolean");
  });

  it("不抛异常（即使 cloudflared 不存在）", async () => {
    const { checkCloudflared } = await import("../src/platform");
    await expect(checkCloudflared()).resolves.not.toThrow();
  });
});

describe("getRoot - 边界值", () => {
  it("空字符串返回空", () => {
    expect(getRoot("")).toBe("");
  });

  it("相对路径返回空（无根目录）", () => {
    expect(getRoot("relative/path")).toBe("");
  });
});

describe("sleep - 边界值", () => {
  it("负数等同于 0，立即返回", async () => {
    const start = Date.now();
    await sleep(-100);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});
