/**
 * Codex argv 构造测试（覆盖面对齐参考项目 codex-argv.test.ts）
 */
import { describe, it, expect } from "vitest";
import { buildCodexArgs } from "../src/adapters/codex.js";

describe("buildCodexArgs", () => {
  it("新会话：exec --json + 全局旗标 + stdin 占位符", () => {
    const args = buildCodexArgs({ cwd: "/repo" });
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "-c",
      'approval_policy="never"',
      "-c",
      'shell_environment_policy.inherit="all"',
      "--skip-git-repo-check",
      "-C",
      "/repo",
      "-",
    ]);
  });

  it("续会话：resume 子命令 + thread id 在 stdin 占位符前", () => {
    const args = buildCodexArgs({ cwd: "/repo", resumeSessionId: "thread-42" });
    expect(args[0]).toBe("exec");
    const resumeIdx = args.indexOf("resume");
    expect(resumeIdx).toBeGreaterThan(0);
    // resume 后紧跟 --json
    expect(args[resumeIdx + 1]).toBe("--json");
    // thread id 是倒数第二个参数，最后是 stdin 占位符
    expect(args[args.length - 2]).toBe("thread-42");
    expect(args[args.length - 1]).toBe("-");
    // 全局旗标仍然齐全
    expect(args).toContain("--sandbox");
    expect(args).toContain('approval_policy="never"');
    expect(args).toContain("--skip-git-repo-check");
  });

  it("图片：每张一个 --image 旗标，新会话末尾加 -- 分隔", () => {
    const args = buildCodexArgs({ cwd: "/repo", images: ["/tmp/a.png", "/tmp/b.jpg"] });
    expect(args).toContain("--image");
    const first = args.indexOf("--image");
    expect(args[first + 1]).toBe("/tmp/a.png");
    const second = args.indexOf("--image", first + 1);
    expect(args[second + 1]).toBe("/tmp/b.jpg");
    // 有图片时 -- 分隔符在 - 之前
    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toBe("-");
  });

  it("resume + 图片：--image 在 thread id 之前，无 -- 分隔", () => {
    const args = buildCodexArgs({
      cwd: "/repo",
      resumeSessionId: "thread-1",
      images: ["/tmp/a.png"],
    });
    expect(args.indexOf("--image")).toBeLessThan(args.indexOf("thread-1"));
    expect(args).not.toContain("--");
  });

  it("sandbox 可指定为 read-only / danger-full-access", () => {
    expect(buildCodexArgs({ cwd: "/r", sandbox: "read-only" })).toContain("read-only");
    expect(buildCodexArgs({ cwd: "/r", sandbox: "danger-full-access" })).toContain(
      "danger-full-access"
    );
  });

  it("非法 sandbox 模式抛错", () => {
    expect(() =>
      buildCodexArgs({ cwd: "/r", sandbox: "yolo" as unknown as "read-only" })
    ).toThrow(/不安全的 codex sandbox 模式/);
  });
});
