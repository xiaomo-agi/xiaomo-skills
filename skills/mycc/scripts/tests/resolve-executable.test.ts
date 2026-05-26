/**
 * resolveExecutable 通用路径探测器 - 测试
 *
 * 通过依赖注入 ResolveContext 实现纯单元测试，不依赖真实文件系统和命令。
 */

import { describe, it, expect } from "vitest";
import { join } from "path";
import {
  resolveExecutable,
  envVar,
  whichCommand,
  npmGlobal,
  knownPaths,
  fallback,
  type ResolveContext,
  type ResolveResult,
} from "../src/resolve-executable";

// ============ 测试辅助 ============

/** 创建 mock context */
function createCtx(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return {
    env: {},
    platform: "darwin",
    existsSync: () => false,
    execSync: () => {
      throw new Error("command not found");
    },
    ...overrides,
  };
}

// ============ resolveExecutable 核心 ============

describe("resolveExecutable - 策略链核心", () => {
  it("返回第一个成功的策略结果", () => {
    const ctx = createCtx();
    const result = resolveExecutable(
      [
        () => null,
        () => ({ executable: "node", path: "/a/cli.js" }),
        () => ({ executable: "node", path: "/b/cli.js" }),
      ],
      ctx
    );
    expect(result).toEqual({ executable: "node", path: "/a/cli.js" });
  });

  it("跳过返回 null 的策略", () => {
    const ctx = createCtx();
    const result = resolveExecutable(
      [() => null, () => null, () => ({ executable: "x", path: "x" })],
      ctx
    );
    expect(result).toEqual({ executable: "x", path: "x" });
  });

  it("所有策略都返回 null 时返回 null", () => {
    const ctx = createCtx();
    const result = resolveExecutable([() => null, () => null], ctx);
    expect(result).toBeNull();
  });

  it("空策略数组返回 null", () => {
    const ctx = createCtx();
    const result = resolveExecutable([], ctx);
    expect(result).toBeNull();
  });

  it("策略按顺序执行（惰性求值，成功后不再继续）", () => {
    const ctx = createCtx();
    const calls: number[] = [];
    resolveExecutable(
      [
        (c) => {
          calls.push(1);
          return null;
        },
        (c) => {
          calls.push(2);
          return { executable: "ok", path: "ok" };
        },
        (c) => {
          calls.push(3);
          return { executable: "no", path: "no" };
        },
      ],
      ctx
    );
    expect(calls).toEqual([1, 2]); // 第 3 个不应该被调用
  });
});

// ============ envVar 策略 ============

describe("envVar - 环境变量策略", () => {
  it("环境变量存在时返回路径", () => {
    const ctx = createCtx({ env: { CLAUDE_PATH: "/custom/claude" } });
    const strategy = envVar("CLAUDE_PATH");
    const result = strategy(ctx);
    expect(result).toEqual({
      executable: "/custom/claude",
      path: "/custom/claude",
    });
  });

  it("环境变量不存在时返回 null", () => {
    const ctx = createCtx({ env: {} });
    const strategy = envVar("CLAUDE_PATH");
    expect(strategy(ctx)).toBeNull();
  });

  it("环境变量为空字符串时返回 null", () => {
    const ctx = createCtx({ env: { CLAUDE_PATH: "" } });
    const strategy = envVar("CLAUDE_PATH");
    expect(strategy(ctx)).toBeNull();
  });

  it("环境变量有值但只有空格时返回 null", () => {
    const ctx = createCtx({ env: { CLAUDE_PATH: "   " } });
    const strategy = envVar("CLAUDE_PATH");
    expect(strategy(ctx)).toBeNull();
  });
});

// ============ whichCommand 策略 ============

describe("whichCommand - which/where 命令策略", () => {
  it("Mac/Linux 使用 which 命令", () => {
    const ctx = createCtx({
      platform: "darwin",
      execSync: (cmd: string) => {
        if (cmd === "which claude") return "/usr/local/bin/claude\n";
        throw new Error("not found");
      },
    });
    const result = whichCommand("claude")(ctx);
    expect(result).toEqual({
      executable: "claude",
      path: "/usr/local/bin/claude",
    });
  });

  it("Windows 使用 where 命令", () => {
    const ctx = createCtx({
      platform: "win32",
      execSync: (cmd: string) => {
        if (cmd === "where claude")
          return "C:\\Users\\pc\\.local\\bin\\claude.exe\r\n";
        throw new Error("not found");
      },
    });
    const result = whichCommand("claude")(ctx);
    expect(result).toEqual({
      executable: "claude",
      path: "C:\\Users\\pc\\.local\\bin\\claude.exe",
    });
  });

  it("where 返回多行时取第一行", () => {
    const ctx = createCtx({
      platform: "win32",
      execSync: (cmd: string) => {
        if (cmd === "where claude")
          return "C:\\first\\claude.exe\r\nC:\\second\\claude.exe\r\n";
        throw new Error("not found");
      },
    });
    const result = whichCommand("claude")(ctx);
    expect(result!.path).toBe("C:\\first\\claude.exe");
  });

  it("命令未找到时返回 null", () => {
    const ctx = createCtx({
      execSync: () => {
        throw new Error("not found");
      },
    });
    expect(whichCommand("nonexistent")(ctx)).toBeNull();
  });

  it("路径以 .js 结尾时 executable 为 node", () => {
    const ctx = createCtx({
      execSync: (cmd: string) => {
        if (cmd === "which claude") return "/path/to/cli.js\n";
        throw new Error();
      },
    });
    const result = whichCommand("claude")(ctx);
    expect(result).toEqual({ executable: "node", path: "/path/to/cli.js" });
  });

  it("路径不以 .js 结尾时 executable 为命令名", () => {
    const ctx = createCtx({
      execSync: (cmd: string) => {
        if (cmd === "which cloudflared")
          return "/opt/homebrew/bin/cloudflared\n";
        throw new Error();
      },
    });
    const result = whichCommand("cloudflared")(ctx);
    expect(result).toEqual({
      executable: "cloudflared",
      path: "/opt/homebrew/bin/cloudflared",
    });
  });

  it("返回结果会 trim 空白", () => {
    const ctx = createCtx({
      execSync: (cmd: string) => {
        if (cmd === "which claude") return "  /usr/local/bin/claude  \n";
        throw new Error();
      },
    });
    const result = whichCommand("claude")(ctx);
    expect(result!.path).toBe("/usr/local/bin/claude");
  });

  it("返回空字符串时返回 null", () => {
    const ctx = createCtx({
      platform: "win32",
      execSync: (cmd: string) => {
        if (cmd === "where claude") return "\r\n";
        throw new Error();
      },
    });
    expect(whichCommand("claude")(ctx)).toBeNull();
  });
});

// ============ npmGlobal 策略 ============

describe("npmGlobal - npm 全局包策略", () => {
  it("通过 npm root -g 找到 cli.js（Mac/Linux）", () => {
    const ctx = createCtx({
      platform: "darwin",
      execSync: (cmd: string) => {
        if (cmd === "npm root -g")
          return "/usr/local/lib/node_modules\n";
        throw new Error();
      },
      existsSync: (p: string) =>
        p ===
        "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    });
    const result = npmGlobal("@anthropic-ai/claude-code", "cli.js")(ctx);
    expect(result).toEqual({
      executable: "node",
      path: "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    });
  });

  it("通过 npm root -g 找到 cli.js（Windows）", () => {
    const npmRoot = "C:\\Users\\pc\\AppData\\Roaming\\npm\\node_modules";
    const expectedPath = join(
      npmRoot,
      "@anthropic-ai",
      "claude-code",
      "cli.js"
    );
    const ctx = createCtx({
      platform: "win32",
      execSync: (cmd: string) => {
        if (cmd === "npm root -g") return npmRoot + "\r\n";
        throw new Error();
      },
      existsSync: (p: string) => p === expectedPath,
    });
    const result = npmGlobal("@anthropic-ai/claude-code", "cli.js")(ctx);
    expect(result).toEqual({ executable: "node", path: expectedPath });
  });

  it("nvm for Windows 的 npm root -g 也能找到", () => {
    const npmRoot = "C:\\nvm4w\\nodejs\\node_modules";
    const expectedPath = join(
      npmRoot,
      "@anthropic-ai",
      "claude-code",
      "cli.js"
    );
    const ctx = createCtx({
      platform: "win32",
      execSync: (cmd: string) => {
        if (cmd === "npm root -g") return npmRoot + "\r\n";
        throw new Error();
      },
      existsSync: (p: string) => p === expectedPath,
    });
    const result = npmGlobal("@anthropic-ai/claude-code", "cli.js")(ctx);
    expect(result).toEqual({ executable: "node", path: expectedPath });
  });

  it("npm 不可用时返回 null", () => {
    const ctx = createCtx({
      execSync: () => {
        throw new Error("npm not found");
      },
    });
    expect(npmGlobal("@anthropic-ai/claude-code", "cli.js")(ctx)).toBeNull();
  });

  it("包未安装（cli.js 不存在）时返回 null", () => {
    const ctx = createCtx({
      execSync: (cmd: string) => {
        if (cmd === "npm root -g")
          return "/usr/local/lib/node_modules\n";
        throw new Error();
      },
      existsSync: () => false,
    });
    expect(npmGlobal("@anthropic-ai/claude-code", "cli.js")(ctx)).toBeNull();
  });

  it("npm root -g 返回空字符串时返回 null", () => {
    const ctx = createCtx({
      execSync: (cmd: string) => {
        if (cmd === "npm root -g") return "\n";
        throw new Error();
      },
    });
    expect(npmGlobal("@anthropic-ai/claude-code", "cli.js")(ctx)).toBeNull();
  });
});

// ============ knownPaths 策略 ============

describe("knownPaths - 已知路径策略", () => {
  it("返回第一个存在的路径", () => {
    const ctx = createCtx({
      existsSync: (p: string) => p === "/usr/local/bin/cloudflared",
    });
    const result = knownPaths([
      "/opt/homebrew/bin/cloudflared",
      "/usr/local/bin/cloudflared",
    ])(ctx);
    expect(result!.path).toBe("/usr/local/bin/cloudflared");
  });

  it("所有路径都不存在时返回 null", () => {
    const ctx = createCtx({ existsSync: () => false });
    const result = knownPaths(["/a", "/b", "/c"])(ctx);
    expect(result).toBeNull();
  });

  it("支持函数参数（惰性求值）", () => {
    const ctx = createCtx({
      platform: "darwin",
      existsSync: (p: string) => p === "/opt/homebrew/bin/cloudflared",
    });
    const result = knownPaths((c) => {
      // 根据平台动态生成路径
      if (c.platform === "darwin") {
        return ["/opt/homebrew/bin/cloudflared"];
      }
      return ["/usr/local/bin/cloudflared"];
    })(ctx);
    expect(result!.path).toBe("/opt/homebrew/bin/cloudflared");
  });

  it("指定 executable 选项", () => {
    const ctx = createCtx({
      existsSync: (p: string) =>
        p === "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    });
    const result = knownPaths(
      ["/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js"],
      { executable: "node" }
    )(ctx);
    expect(result).toEqual({
      executable: "node",
      path: "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    });
  });

  it("未指定 executable 时，.js 文件自动用 node", () => {
    const ctx = createCtx({
      existsSync: (p: string) => p === "/path/to/cli.js",
    });
    const result = knownPaths(["/path/to/cli.js"])(ctx);
    expect(result).toEqual({ executable: "node", path: "/path/to/cli.js" });
  });

  it("未指定 executable 时，非 .js 文件用路径本身", () => {
    const ctx = createCtx({
      existsSync: (p: string) => p === "/opt/homebrew/bin/cloudflared",
    });
    const result = knownPaths(["/opt/homebrew/bin/cloudflared"])(ctx);
    expect(result).toEqual({
      executable: "/opt/homebrew/bin/cloudflared",
      path: "/opt/homebrew/bin/cloudflared",
    });
  });

  it("空数组返回 null", () => {
    const ctx = createCtx();
    expect(knownPaths([])(ctx)).toBeNull();
  });

  it("函数参数抛异常时返回 null", () => {
    const ctx = createCtx();
    const result = knownPaths(() => {
      throw new Error("boom");
    })(ctx);
    expect(result).toBeNull();
  });
});

// ============ fallback 策略 ============

describe("fallback - 兜底策略", () => {
  it("始终返回 { executable: name, path: name }", () => {
    const ctx = createCtx();
    expect(fallback("claude")(ctx)).toEqual({
      executable: "claude",
      path: "claude",
    });
  });

  it("不受 context 影响", () => {
    const ctx = createCtx({ platform: "win32", env: { FOO: "bar" } });
    expect(fallback("cloudflared")(ctx)).toEqual({
      executable: "cloudflared",
      path: "cloudflared",
    });
  });
});

// ============ 集成：Claude CLI 路径解析链 ============

describe("Claude CLI 路径策略链（集成）", () => {
  // 模拟 getClaudeStrategies 的完整策略链
  // 顺序：envVar → npmGlobal → knownPaths(cli.js) → whichCommand → knownPaths(native) → fallback

  /** 构建 Claude 策略链（与 platform.ts 中一致） */
  function getClaudeStrategies() {
    return [
      envVar("CLAUDE_PATH"),
      npmGlobal("@anthropic-ai/claude-code", "cli.js"),
      knownPaths(
        (ctx) => {
          if (ctx.platform === "win32") return [];
          return [
            "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
            "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js",
          ];
        },
        { executable: "node" }
      ),
      whichCommand("claude"),
      knownPaths((ctx) => {
        if (ctx.platform !== "win32") return [];
        const home = ctx.env.USERPROFILE || "";
        const localAppData = ctx.env.LOCALAPPDATA || "";
        return [
          join(home, ".local", "bin", "claude.exe"),
          join(localAppData, "Programs", "Claude", "claude.exe"),
          join(
            localAppData,
            "Microsoft",
            "WinGet",
            "Links",
            "claude.exe"
          ),
        ];
      }, { executable: "claude" }),
      fallback("claude"),
    ];
  }

  it("Mac npm 安装：通过 npm root -g 找到 cli.js", () => {
    const ctx = createCtx({
      platform: "darwin",
      execSync: (cmd: string) => {
        if (cmd === "npm root -g")
          return "/usr/local/lib/node_modules\n";
        throw new Error();
      },
      existsSync: (p: string) =>
        p ===
        "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    });
    const result = resolveExecutable(getClaudeStrategies(), ctx);
    expect(result).toEqual({
      executable: "node",
      path: "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    });
  });

  it("Windows npm 安装：通过 npm root -g 找到 cli.js", () => {
    const home = "C:\\Users\\pc";
    const localAppData = join(home, "AppData", "Local");
    const npmRoot = join(home, "AppData", "Roaming", "npm", "node_modules");
    const cliPath = join(npmRoot, "@anthropic-ai", "claude-code", "cli.js");
    const ctx = createCtx({
      platform: "win32",
      env: { USERPROFILE: home, LOCALAPPDATA: localAppData },
      execSync: (cmd: string) => {
        if (cmd === "npm root -g") return npmRoot + "\r\n";
        throw new Error();
      },
      existsSync: (p: string) => p === cliPath,
    });
    const result = resolveExecutable(getClaudeStrategies(), ctx);
    expect(result).toEqual({ executable: "node", path: cliPath });
  });

  it("Windows .local/bin 安装（#9 修复）", () => {
    const home = "C:\\Users\\pc";
    const localAppData = join(home, "AppData", "Local");
    // 用 join() 构造路径，确保和策略链内部一致
    const claudePath = join(home, ".local", "bin", "claude.exe");
    const ctx = createCtx({
      platform: "win32",
      env: { USERPROFILE: home, LOCALAPPDATA: localAppData },
      execSync: () => {
        throw new Error("not found");
      },
      existsSync: (p: string) => p === claudePath,
    });
    const result = resolveExecutable(getClaudeStrategies(), ctx);
    expect(result).toEqual({ executable: "claude", path: claudePath });
  });

  it("Windows WinGet 安装", () => {
    const home = "C:\\Users\\pc";
    const localAppData = join(home, "AppData", "Local");
    const claudePath = join(
      localAppData, "Microsoft", "WinGet", "Links", "claude.exe"
    );
    const ctx = createCtx({
      platform: "win32",
      env: { USERPROFILE: home, LOCALAPPDATA: localAppData },
      execSync: () => {
        throw new Error("not found");
      },
      existsSync: (p: string) => p === claudePath,
    });
    const result = resolveExecutable(getClaudeStrategies(), ctx);
    expect(result).toEqual({ executable: "claude", path: claudePath });
  });

  it("环境变量覆盖一切", () => {
    const ctx = createCtx({
      env: { CLAUDE_PATH: "/my/custom/claude" },
      // npm 和 which 都能找到，但 envVar 优先
      execSync: (cmd: string) => {
        if (cmd === "npm root -g")
          return "/usr/local/lib/node_modules\n";
        if (cmd === "which claude") return "/usr/local/bin/claude\n";
        throw new Error();
      },
      existsSync: () => true,
    });
    const result = resolveExecutable(getClaudeStrategies(), ctx);
    expect(result).toEqual({
      executable: "/my/custom/claude",
      path: "/my/custom/claude",
    });
  });

  it("啥都找不到时 fallback 到 claude", () => {
    const ctx = createCtx({
      platform: "linux",
      execSync: () => {
        throw new Error("not found");
      },
      existsSync: () => false,
    });
    const result = resolveExecutable(getClaudeStrategies(), ctx);
    expect(result).toEqual({ executable: "claude", path: "claude" });
  });

  it("Mac: npm root -g 失败但已知路径存在，走 knownPaths", () => {
    const ctx = createCtx({
      platform: "darwin",
      execSync: (cmd: string) => {
        if (cmd === "npm root -g") throw new Error("npm not found");
        if (cmd === "which claude")
          return "/usr/local/bin/claude\n";
        throw new Error();
      },
      existsSync: (p: string) =>
        p ===
        "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    });
    const result = resolveExecutable(getClaudeStrategies(), ctx);
    expect(result).toEqual({
      executable: "node",
      path: "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    });
  });

  it("Mac: 只有 which 能找到（非 npm 安装）", () => {
    const ctx = createCtx({
      platform: "darwin",
      execSync: (cmd: string) => {
        if (cmd === "npm root -g") throw new Error();
        if (cmd === "which claude") return "/usr/local/bin/claude\n";
        throw new Error();
      },
      existsSync: () => false,
    });
    const result = resolveExecutable(getClaudeStrategies(), ctx);
    expect(result).toEqual({
      executable: "claude",
      path: "/usr/local/bin/claude",
    });
  });
});

// ============ 集成：Cloudflared 路径解析链 ============

describe("Cloudflared 路径策略链（集成）", () => {
  /** 构建 Cloudflared 策略链 */
  function getCloudflaredStrategies() {
    return [
      envVar("CLOUDFLARED_PATH"),
      knownPaths((ctx) => {
        if (ctx.platform === "win32") return [];
        return [
          "/opt/homebrew/bin/cloudflared",
          "/usr/local/bin/cloudflared",
        ];
      }),
      whichCommand("cloudflared"),
      fallback("cloudflared"),
    ];
  }

  it("Mac ARM homebrew 路径", () => {
    const ctx = createCtx({
      platform: "darwin",
      existsSync: (p: string) => p === "/opt/homebrew/bin/cloudflared",
    });
    const result = resolveExecutable(getCloudflaredStrategies(), ctx);
    expect(result!.path).toBe("/opt/homebrew/bin/cloudflared");
  });

  it("Mac Intel homebrew 路径", () => {
    const ctx = createCtx({
      platform: "darwin",
      existsSync: (p: string) => p === "/usr/local/bin/cloudflared",
    });
    const result = resolveExecutable(getCloudflaredStrategies(), ctx);
    expect(result!.path).toBe("/usr/local/bin/cloudflared");
  });

  it("环境变量覆盖", () => {
    const ctx = createCtx({
      env: { CLOUDFLARED_PATH: "/custom/cloudflared" },
    });
    const result = resolveExecutable(getCloudflaredStrategies(), ctx);
    expect(result).toEqual({
      executable: "/custom/cloudflared",
      path: "/custom/cloudflared",
    });
  });

  it("Windows 走 where", () => {
    const ctx = createCtx({
      platform: "win32",
      execSync: (cmd: string) => {
        if (cmd === "where cloudflared")
          return "C:\\Tools\\cloudflared.exe\r\n";
        throw new Error();
      },
    });
    const result = resolveExecutable(getCloudflaredStrategies(), ctx);
    expect(result).toEqual({
      executable: "cloudflared",
      path: "C:\\Tools\\cloudflared.exe",
    });
  });

  it("啥都找不到 fallback 到 cloudflared", () => {
    const ctx = createCtx({
      platform: "win32",
      execSync: () => {
        throw new Error();
      },
    });
    const result = resolveExecutable(getCloudflaredStrategies(), ctx);
    expect(result).toEqual({
      executable: "cloudflared",
      path: "cloudflared",
    });
  });
});
