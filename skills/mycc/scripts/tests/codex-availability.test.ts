/**
 * Codex CLI 可用性探测 + 启动期双可用性决策测试（Phase 3）
 *
 * 本机没装 codex CLI，用 PATH 里的假可执行脚本测探测逻辑。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "fs";
import { join } from "path";
import os from "os";
import {
  checkCodexAvailable,
  detectCodexPath,
  decideStartupMode,
} from "../src/platform.js";

const isWin = process.platform === "win32";

describe("checkCodexAvailable / detectCodexPath", () => {
  let tmpDir: string;
  const origPath = process.env.PATH;
  const origCodexPath = process.env.CODEX_PATH;

  /** 造一个可执行的假 codex 脚本，返回其绝对路径 */
  function makeFakeCodex(name = "codex"): string {
    const fake = join(tmpDir, name);
    writeFileSync(fake, "#!/bin/sh\necho codex-cli 0.1.0\nexit 0\n");
    chmodSync(fake, 0o755);
    return fake;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "fake-codex-"));
    delete process.env.CODEX_PATH;
  });

  afterEach(() => {
    process.env.PATH = origPath;
    if (origCodexPath !== undefined) {
      process.env.CODEX_PATH = origCodexPath;
    } else {
      delete process.env.CODEX_PATH;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("PATH 里有可执行的 codex → true", async () => {
    if (isWin) return;
    makeFakeCodex();
    process.env.PATH = `${tmpDir}:${origPath}`;
    expect(await checkCodexAvailable()).toBe(true);
  });

  it("CODEX_PATH 环境变量指向可执行脚本 → true（最高优先级）", async () => {
    if (isWin) return;
    const fake = makeFakeCodex("my-codex");
    process.env.CODEX_PATH = fake;
    expect(detectCodexPath()).toBe(fake);
    expect(await checkCodexAvailable()).toBe(true);
  });

  it("codex 不存在（PATH 里找不到）→ false 且不抛异常", async () => {
    if (isWin) return;
    process.env.PATH = tmpDir; // 空目录，which/codex 都找不到
    await expect(checkCodexAvailable()).resolves.toBe(false);
  });

  it("CODEX_PATH 指向不存在的文件 → false 且不抛异常", async () => {
    process.env.CODEX_PATH = join(tmpDir, "no-such-codex");
    await expect(checkCodexAvailable()).resolves.toBe(false);
  });

  it("detectCodexPath 兜底返回裸命令名 codex", () => {
    if (isWin) return;
    process.env.PATH = tmpDir; // which 失败 → fallback
    expect(detectCodexPath()).toBe("codex");
  });
});

describe("decideStartupMode - 启动期双可用性分支", () => {
  it("Claude 可用（无论 codex）→ claude 模式，与现状零变化", () => {
    expect(decideStartupMode(true, false)).toEqual({ ok: true, mode: "claude" });
    expect(decideStartupMode(true, true)).toEqual({ ok: true, mode: "claude" });
  });

  it("只有 Codex 可用 → codex-only 模式，允许启动", () => {
    expect(decideStartupMode(false, true)).toEqual({ ok: true, mode: "codex-only" });
  });

  it("两者都不可用 → 拒绝启动", () => {
    expect(decideStartupMode(false, false)).toEqual({ ok: false });
  });
});
