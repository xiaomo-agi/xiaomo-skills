/**
 * ensurePatchedCli 单元测试
 *
 * 测试策略：用 tmpdir 隔离文件系统操作，不 mock fs 模块（保留真实 IO 语义）。
 * 四个核心场景：
 *   1. 系统 CLI 包含 LP_ORIGINAL  → 写入 patched 副本，返回 patched 路径
 *   2. 系统 CLI 已包含 LP_PATCHED  → 视为上游已修复，返回系统路径
 *   3. 系统 CLI 不包含任何匹配模式 → 视为大版本重构，返回系统路径
 *   4. 系统 CLI 文件不存在          → 捕获异常，fallback 系统路径
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ensurePatchedCli, LP_ORIGINAL, LP_PATCHED } from "../src/cli-patch";

// ============ 测试辅助 ============

/** 每个测试用独立 tmpdir，完全隔离 */
let tmp: string;
let systemCliPath: string;
let patchedPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cli-patch-test-"));
  systemCliPath = join(tmp, "system-cli.js");
  patchedPath = join(tmp, "cli-patched.js");
});

// ============ 场景 1：需要 patch ============

describe("场景 1：系统 CLI 包含 LP_ORIGINAL（需要 patch）", () => {
  it("返回 patched 路径（不是系统路径）", () => {
    // 模拟真实 CLI：在大量内容中嵌入 LP_ORIGINAL
    const fakeCliContent = `// fake cli preamble\n${LP_ORIGINAL}\n// rest of file`;
    writeFileSync(systemCliPath, fakeCliContent, "utf-8");

    const result = ensurePatchedCli(systemCliPath, patchedPath);

    expect(result).toBe(patchedPath);
    expect(result).not.toBe(systemCliPath);
  });

  it("patched 副本确实存在于磁盘", () => {
    const fakeCliContent = `prefix\n${LP_ORIGINAL}\nsuffix`;
    writeFileSync(systemCliPath, fakeCliContent, "utf-8");

    ensurePatchedCli(systemCliPath, patchedPath);

    expect(existsSync(patchedPath)).toBe(true);
  });

  it("patched 副本内容包含 LP_PATCHED", () => {
    const fakeCliContent = `prefix\n${LP_ORIGINAL}\nsuffix`;
    writeFileSync(systemCliPath, fakeCliContent, "utf-8");

    ensurePatchedCli(systemCliPath, patchedPath);

    const patched = readFileSync(patchedPath, "utf-8");
    expect(patched).toContain(LP_PATCHED);
  });

  it("patched 副本不再含有 LP_ORIGINAL", () => {
    const fakeCliContent = `prefix\n${LP_ORIGINAL}\nsuffix`;
    writeFileSync(systemCliPath, fakeCliContent, "utf-8");

    ensurePatchedCli(systemCliPath, patchedPath);

    const patched = readFileSync(patchedPath, "utf-8");
    expect(patched).not.toContain(LP_ORIGINAL);
  });

  it("patched 副本保留了 LP_ORIGINAL 以外的内容", () => {
    const fakeCliContent = `// header comment\n${LP_ORIGINAL}\n// footer comment`;
    writeFileSync(systemCliPath, fakeCliContent, "utf-8");

    ensurePatchedCli(systemCliPath, patchedPath);

    const patched = readFileSync(patchedPath, "utf-8");
    expect(patched).toContain("// header comment");
    expect(patched).toContain("// footer comment");
  });
});

// ============ 场景 2：上游已修复（含 LP_PATCHED，不含 LP_ORIGINAL）============

describe("场景 2：系统 CLI 已包含 LP_PATCHED（上游修复）", () => {
  it("返回系统路径", () => {
    const fakeCliContent = `prefix\n${LP_PATCHED}\nsuffix`;
    writeFileSync(systemCliPath, fakeCliContent, "utf-8");

    const result = ensurePatchedCli(systemCliPath, patchedPath);

    expect(result).toBe(systemCliPath);
  });

  it("不写入 patched 副本", () => {
    const fakeCliContent = `prefix\n${LP_PATCHED}\nsuffix`;
    writeFileSync(systemCliPath, fakeCliContent, "utf-8");

    ensurePatchedCli(systemCliPath, patchedPath);

    expect(existsSync(patchedPath)).toBe(false);
  });
});

// ============ 场景 3：大版本重构（两种模式都不匹配）============

describe("场景 3：系统 CLI 不含任何匹配模式（大版本重构）", () => {
  it("返回系统路径", () => {
    const fakeCliContent = `// totally different cli v3\nfunction newFn() { return true; }`;
    writeFileSync(systemCliPath, fakeCliContent, "utf-8");

    const result = ensurePatchedCli(systemCliPath, patchedPath);

    expect(result).toBe(systemCliPath);
  });

  it("不写入 patched 副本", () => {
    const fakeCliContent = `// totally different cli v3\nfunction newFn() { return true; }`;
    writeFileSync(systemCliPath, fakeCliContent, "utf-8");

    ensurePatchedCli(systemCliPath, patchedPath);

    expect(existsSync(patchedPath)).toBe(false);
  });
});

// ============ 场景 4：系统 CLI 文件不存在 ============

describe("场景 4：系统 CLI 文件不存在（readFileSync 异常）", () => {
  it("返回系统路径（fallback）", () => {
    // 不创建 systemCliPath，直接调用
    const nonExistentPath = join(tmp, "nonexistent-cli.js");

    const result = ensurePatchedCli(nonExistentPath, patchedPath);

    expect(result).toBe(nonExistentPath);
  });

  it("不写入 patched 副本", () => {
    const nonExistentPath = join(tmp, "nonexistent-cli.js");

    ensurePatchedCli(nonExistentPath, patchedPath);

    expect(existsSync(patchedPath)).toBe(false);
  });
});

// ============ 导出常量完整性验证 ============

describe("LP_ORIGINAL / LP_PATCHED 常量", () => {
  it("LP_ORIGINAL 包含原始 lP 函数签名", () => {
    expect(LP_ORIGINAL).toContain("function lP(A)");
    // 不含 isIdle 检查
    expect(LP_ORIGINAL).not.toContain("isIdle");
  });

  it("LP_PATCHED 在 LP_ORIGINAL 基础上加了 isIdle 检查", () => {
    expect(LP_PATCHED).toContain("function lP(A)");
    expect(LP_PATCHED).toContain("isIdle");
  });

  it("LP_PATCHED 比 LP_ORIGINAL 多出 isIdle 那一句，其余相同前缀", () => {
    // patched 版是在 return!0 前插入 isIdle 检查，所以 LP_ORIGINAL 是 LP_PATCHED 的前缀子集
    const patchedWithoutIsIdle = LP_PATCHED.replace("if(A.isIdle)return!1;", "");
    expect(patchedWithoutIsIdle).toBe(LP_ORIGINAL);
  });
});
