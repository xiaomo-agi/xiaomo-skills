/**
 * 公网直连模式测试
 *
 * 测试范围：
 * 1. .env 文件解析（parseEnvFile）
 * 2. PUBLIC_URL 加载与验证（loadPublicUrl）
 * 3. 模式检测逻辑
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { parseEnvFile, loadPublicUrl } from "../src/env-loader.js";

// ============ parseEnvFile 测试 ============

describe("parseEnvFile() - .env 文件解析", () => {
  it("解析 key=value 对", () => {
    const result = parseEnvFile("FOO=bar\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("忽略注释行", () => {
    const result = parseEnvFile("# this is a comment\nFOO=bar");
    expect(result).toEqual({ FOO: "bar" });
  });

  it("忽略空行", () => {
    const result = parseEnvFile("\nFOO=bar\n\nBAZ=qux\n");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("去除值的双引号", () => {
    const result = parseEnvFile('FOO="bar"');
    expect(result).toEqual({ FOO: "bar" });
  });

  it("去除值的单引号", () => {
    const result = parseEnvFile("FOO='bar'");
    expect(result).toEqual({ FOO: "bar" });
  });

  it("保留值中的等号", () => {
    const result = parseEnvFile("URL=https://example.com?foo=bar&baz=1");
    expect(result).toEqual({ URL: "https://example.com?foo=bar&baz=1" });
  });

  it("去除首尾空格", () => {
    const result = parseEnvFile("  FOO  =  bar  ");
    expect(result).toEqual({ FOO: "bar" });
  });

  it("空内容返回空对象", () => {
    expect(parseEnvFile("")).toEqual({});
  });

  it("跳过没有等号的行", () => {
    const result = parseEnvFile("INVALID_LINE\nFOO=bar");
    expect(result).toEqual({ FOO: "bar" });
  });
});

// ============ loadPublicUrl 测试 ============

describe("loadPublicUrl() - 加载 PUBLIC_URL", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mycc-public-mode-"));
    delete process.env.PUBLIC_URL;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.PUBLIC_URL;
  });

  it("没有 .env 且没有环境变量时返回 null", () => {
    expect(loadPublicUrl(tempDir)).toBeNull();
  });

  it("从 .env 文件读取 PUBLIC_URL", () => {
    writeFileSync(join(tempDir, ".env"), "PUBLIC_URL=https://s1.mycc.dev\n");
    expect(loadPublicUrl(tempDir)).toBe("https://s1.mycc.dev");
  });

  it("环境变量优先于 .env 文件", () => {
    process.env.PUBLIC_URL = "https://env.mycc.dev";
    writeFileSync(join(tempDir, ".env"), "PUBLIC_URL=https://file.mycc.dev\n");
    expect(loadPublicUrl(tempDir)).toBe("https://env.mycc.dev");
  });

  it("拒绝非 https:// 的 URL", () => {
    writeFileSync(join(tempDir, ".env"), "PUBLIC_URL=http://s1.mycc.dev\n");
    expect(loadPublicUrl(tempDir)).toBeNull();
  });

  it("去除引号后正确返回", () => {
    writeFileSync(join(tempDir, ".env"), 'PUBLIC_URL="https://s1.mycc.dev"\n');
    expect(loadPublicUrl(tempDir)).toBe("https://s1.mycc.dev");
  });

  it("去除尾部空格", () => {
    writeFileSync(join(tempDir, ".env"), "PUBLIC_URL=https://s1.mycc.dev   \n");
    expect(loadPublicUrl(tempDir)).toBe("https://s1.mycc.dev");
  });

  it("去除尾部斜杠", () => {
    writeFileSync(join(tempDir, ".env"), "PUBLIC_URL=https://s1.mycc.dev/\n");
    expect(loadPublicUrl(tempDir)).toBe("https://s1.mycc.dev");
  });

  it(".env 中没有 PUBLIC_URL 时返回 null", () => {
    writeFileSync(join(tempDir, ".env"), "PORT=80\nSOME_VAR=hello\n");
    expect(loadPublicUrl(tempDir)).toBeNull();
  });

  it("支持多个搜索目录（按顺序查找）", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "mycc-public-mode-2-"));
    // tempDir 没有 .env，dir2 有
    writeFileSync(join(dir2, ".env"), "PUBLIC_URL=https://s2.mycc.dev\n");

    expect(loadPublicUrl(tempDir, dir2)).toBe("https://s2.mycc.dev");

    rmSync(dir2, { recursive: true, force: true });
  });

  it("第一个目录找到就不再搜索后续目录", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "mycc-public-mode-2-"));
    writeFileSync(join(tempDir, ".env"), "PUBLIC_URL=https://s1.mycc.dev\n");
    writeFileSync(join(dir2, ".env"), "PUBLIC_URL=https://s2.mycc.dev\n");

    expect(loadPublicUrl(tempDir, dir2)).toBe("https://s1.mycc.dev");

    rmSync(dir2, { recursive: true, force: true });
  });

  it("环境变量 PUBLIC_URL 也需要 https 验证", () => {
    process.env.PUBLIC_URL = "http://insecure.mycc.dev";
    expect(loadPublicUrl(tempDir)).toBeNull();
  });
});

// ============ 模式检测测试 ============

describe("模式检测", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mycc-mode-"));
    delete process.env.PUBLIC_URL;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.PUBLIC_URL;
  });

  it("有 PUBLIC_URL → 公网模式", () => {
    writeFileSync(join(tempDir, ".env"), "PUBLIC_URL=https://s1.mycc.dev\n");
    const publicUrl = loadPublicUrl(tempDir);
    expect(!!publicUrl).toBe(true);
  });

  it("没有 PUBLIC_URL → 内网模式", () => {
    const publicUrl = loadPublicUrl(tempDir);
    expect(!!publicUrl).toBe(false);
  });
});

// ============ TunnelManager 可选（公网模式不使用） ============

describe("tunnelManager 可选链", () => {
  it("null?.stop() 不抛异常（公网模式下 tunnelManager 为 null）", () => {
    const tunnelManager: { stop: () => void } | null = null;
    expect(() => tunnelManager?.stop()).not.toThrow();
  });

  it("null?.getStatus() 返回 undefined（不报错）", () => {
    const tunnelManager: { getStatus: () => unknown } | null = null;
    expect(tunnelManager?.getStatus()).toBeUndefined();
  });
});
