/**
 * 进程注册表测试（Phase 2：mycc ps/kill/stop/restart 命令层的数据源）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import {
  isAlive,
  listProcesses,
  registerSelf,
  unregisterSelf,
  resolveTarget,
  killEntry,
  type ProcessEntry,
} from "../src/process-registry.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "proc-reg-test-"));
  file = path.join(dir, "processes.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 造一个已经死掉的 pid：起一个立刻退出的进程并等它结束 */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  return r.pid!;
}

function fakeEntry(pid: number, id = "dead"): ProcessEntry {
  return { id, pid, port: 18080, cwd: "/tmp", startedAt: new Date().toISOString() };
}

describe("process-registry", () => {
  it("registerSelf 登记自己，listProcesses 能看到", () => {
    const entry = registerSelf(18080, "/work", file);
    expect(entry.pid).toBe(process.pid);
    const list = listProcesses(file);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(entry.id);
    expect(list[0].cwd).toBe("/work");
  });

  it("registerSelf 顺带剔除死条目", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ entries: [fakeEntry(deadPid())] }));
    registerSelf(18080, "/work", file);
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(raw.entries).toHaveLength(1);
    expect(raw.entries[0].pid).toBe(process.pid);
  });

  it("listProcesses 过滤死进程", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ entries: [fakeEntry(deadPid()), { ...fakeEntry(process.pid), id: "self" }] })
    );
    const list = listProcesses(file);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("self");
  });

  it("unregisterSelf 移除条目，文件损坏也不抛", () => {
    const entry = registerSelf(18080, "/work", file);
    unregisterSelf(entry.id, file);
    expect(listProcesses(file)).toHaveLength(0);

    fs.writeFileSync(file, "{broken");
    expect(() => unregisterSelf("whatever", file)).not.toThrow();
  });

  it("resolveTarget 支持短 id / pid / 序号", () => {
    const entry = registerSelf(18080, "/work", file);
    expect(resolveTarget(entry.id, file)?.pid).toBe(process.pid);
    expect(resolveTarget(String(process.pid), file)?.id).toBe(entry.id);
    expect(resolveTarget("1", file)?.id).toBe(entry.id);
    expect(resolveTarget("999", file)).toBeUndefined();
    expect(resolveTarget("nope", file)).toBeUndefined();
  });

  it("killEntry 对已死进程返回 gone 并清掉条目", async () => {
    const entry = fakeEntry(deadPid());
    fs.writeFileSync(file, JSON.stringify({ entries: [entry] }));
    expect(await killEntry(entry, 1000, file)).toBe("gone");
    expect(JSON.parse(fs.readFileSync(file, "utf-8")).entries).toHaveLength(0);
  });

  it("killEntry 用 SIGTERM 优雅干掉活进程", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    await new Promise((r) => setTimeout(r, 200)); // 等子进程起来
    const entry = fakeEntry(child.pid!, "live");
    fs.writeFileSync(file, JSON.stringify({ entries: [entry] }));

    const outcome = await killEntry(entry, 5000, file);
    expect(outcome).toBe("terminated");
    expect(isAlive(child.pid!)).toBe(false);
    expect(listProcesses(file)).toHaveLength(0);
  });
});
