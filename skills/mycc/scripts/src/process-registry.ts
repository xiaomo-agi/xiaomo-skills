/**
 * 后端进程注册表：跟踪 `mycc start` 启动的后端进程，支撑 ps/kill/stop/restart
 * 命令层，取代"lsof 找端口 + kill -9"的裸操作（参考 lark-coding-agent-bridge
 * 的 registry 设计，按 mycc 单机单后端的规模裁剪）。
 *
 * 单机本地 JSON 文件，写入走原子替换；读取时用 kill(pid, 0) 探活，
 * 死条目在下一次写入时剔除。不加文件锁——同机同时执行两个注册类命令
 * 的窗口是毫秒级，出错的代价也只是列表短暂多/少一行。
 */
import { randomBytes } from "crypto";
import path from "path";
import { readJsonFile, writeJsonFileAtomic } from "./json-store.js";

export interface ProcessEntry {
  /** 4 位十六进制短 id，便于 `mycc kill <id>` 手敲 */
  id: string;
  pid: number;
  port: number;
  cwd: string;
  startedAt: string;
}

const DATA_DIR = process.env.MYCC_DATA_DIR || path.resolve(import.meta.dirname, "data");
export const REGISTRY_FILE = path.join(DATA_DIR, "processes.json");

/** pid 是否存活（EPERM 说明进程在但无权限，也算活着） */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readEntries(file: string): ProcessEntry[] {
  const data = readJsonFile<{ entries?: unknown }>(file);
  if (!data || !Array.isArray(data.entries)) return [];
  return data.entries.filter(
    (e): e is ProcessEntry =>
      !!e &&
      typeof e === "object" &&
      typeof (e as ProcessEntry).id === "string" &&
      typeof (e as ProcessEntry).pid === "number"
  );
}

/** 当前存活的注册进程（只读视图，不回写文件） */
export function listProcesses(file: string = REGISTRY_FILE): ProcessEntry[] {
  return readEntries(file).filter((e) => isAlive(e.pid));
}

/**
 * 把当前进程登记进注册表（顺带剔除死条目）。
 * 返回本进程的条目，调用方负责在退出钩子里调 unregisterSelf。
 */
export function registerSelf(port: number, cwd: string, file: string = REGISTRY_FILE): ProcessEntry {
  const entry: ProcessEntry = {
    id: randomBytes(2).toString("hex"),
    pid: process.pid,
    port,
    cwd,
    startedAt: new Date().toISOString(),
  };
  const live = readEntries(file).filter((e) => isAlive(e.pid) && e.pid !== process.pid);
  writeJsonFileAtomic(file, { entries: [...live, entry] });
  return entry;
}

/** 退出钩子用：同步、绝不抛异常 */
export function unregisterSelf(id: string, file: string = REGISTRY_FILE): void {
  try {
    const rest = readEntries(file).filter((e) => e.id !== id);
    writeJsonFileAtomic(file, { entries: rest });
  } catch {
    // exit 钩子里不能抛
  }
}

/** 把 `mycc kill <target>` 的目标解析成条目：短 id、pid、或 ps 视图里的 1 起序号 */
export function resolveTarget(target: string, file: string = REGISTRY_FILE): ProcessEntry | undefined {
  const live = listProcesses(file);
  const byId = live.find((e) => e.id === target);
  if (byId) return byId;
  const n = Number.parseInt(target, 10);
  if (!Number.isFinite(n)) return undefined;
  const byPid = live.find((e) => e.pid === n);
  if (byPid) return byPid;
  if (n >= 1 && n <= live.length) return live[n - 1];
  return undefined;
}

/**
 * 优雅地干掉一个注册进程：先 SIGTERM（后端有清理钩子），等它退出；
 * 超时还活着再 SIGKILL 兜底。返回实际结局。
 */
export async function killEntry(
  entry: ProcessEntry,
  timeoutMs = 5000,
  file: string = REGISTRY_FILE
): Promise<"terminated" | "killed" | "gone"> {
  let outcome: "terminated" | "killed" | "gone";
  if (!isAlive(entry.pid)) {
    outcome = "gone";
  } else {
    try {
      process.kill(entry.pid, "SIGTERM");
    } catch {
      /* 进程恰好刚退出 */
    }
    const deadline = Date.now() + timeoutMs;
    while (isAlive(entry.pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (isAlive(entry.pid)) {
      try {
        process.kill(entry.pid, "SIGKILL");
      } catch {
        /* ignore */
      }
      outcome = "killed";
    } else {
      outcome = "terminated";
    }
  }
  // 无论结局如何，条目都从注册表移除（进程的 exit 钩子可能没机会跑）
  const rest = readEntries(file).filter((e) => e.id !== entry.id);
  writeJsonFileAtomic(file, { entries: rest });
  return outcome;
}
