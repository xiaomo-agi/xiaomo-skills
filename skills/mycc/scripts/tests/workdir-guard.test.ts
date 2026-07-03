/**
 * 工作目录红线检查（Phase 2）
 * 危险目录（根/Home 根/系统目录/虚拟文件系统）拒绝，合法项目路径放行。
 */
import { describe, it, expect } from "vitest";
import os from "os";
import { forbiddenWorkdirReason } from "../src/workdir-guard.js";

const unixOnly = process.platform === "win32" ? describe.skip : describe;

unixOnly("forbiddenWorkdirReason (unix)", () => {
  it("文件系统根目录被拒", () => {
    expect(forbiddenWorkdirReason("/")).toMatch(/根目录/);
  });

  it("Home 根目录被拒，Home 下的项目放行", () => {
    expect(forbiddenWorkdirReason(os.homedir())).toMatch(/Home/);
    expect(forbiddenWorkdirReason(`${os.homedir()}/my-project`)).toBeNull();
  });

  it("系统目录本身被拒，其下的项目子目录放行", () => {
    expect(forbiddenWorkdirReason("/etc")).toMatch(/系统目录/);
    expect(forbiddenWorkdirReason("/usr")).toMatch(/系统目录/);
    expect(forbiddenWorkdirReason("/tmp")).toMatch(/系统目录/);
    // 合法项目路径不误杀
    expect(forbiddenWorkdirReason("/tmp/scratch-project")).toBeNull();
    expect(forbiddenWorkdirReason("/var/www/mysite")).toBeNull();
    expect(forbiddenWorkdirReason("/opt/myapp")).toBeNull();
  });

  it("虚拟/设备文件系统整棵子树被拒", () => {
    expect(forbiddenWorkdirReason("/proc")).toMatch(/虚拟/);
    expect(forbiddenWorkdirReason("/proc/1234")).toMatch(/虚拟/);
    expect(forbiddenWorkdirReason("/sys/kernel")).toMatch(/虚拟/);
    expect(forbiddenWorkdirReason("/dev/shm")).toMatch(/虚拟/);
  });

  it("相对路径先解析再判断", () => {
    // 从任何 cwd 出发，"../../.." 逐级上行最终可能落到根——用显式的等价写法验证
    expect(forbiddenWorkdirReason("/etc/../")).toMatch(/根目录/);
    expect(forbiddenWorkdirReason("/home/user/../../etc")).toMatch(/系统目录/);
  });

  it("正常项目目录放行", () => {
    expect(forbiddenWorkdirReason("/home/user/my-project")).toBeNull();
    expect(forbiddenWorkdirReason(process.cwd())).toBeNull();
  });
});
