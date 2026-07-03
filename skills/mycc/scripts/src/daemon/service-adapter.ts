/**
 * OS 服务管理器（launchd / systemd / schtasks）的平台无关接口。
 * 所有方法尽力幂等——对已停止的服务调 stop() 返回 ok=true 或可安全忽略。
 */

import type { CommandResult } from "./exec.js";
import * as launchd from "./launchd.js";
import { launchAgentPlistPath, systemdUnitPath, WINDOWS_TASK_NAME } from "./paths.js";
import * as schtasks from "./schtasks.js";
import * as systemd from "./systemd.js";

export type ServiceResultLike = CommandResult | Promise<CommandResult>;

export interface ServiceAdapter {
  /** 状态/报错文案里显示的平台名 */
  readonly platformName: string;
  /** 服务定义（plist / unit / 计划任务）是否已注册 */
  fileExists(): boolean;
  /** 服务是否正在运行 */
  isRunning(): boolean;
  /** 服务定义的路径/名字（status 输出用） */
  servicePath(): string;
  /** 写入（或覆盖）服务定义 */
  install(workDir: string): void;
  /** 启动服务（同时启用开机自启） */
  start(): ServiceResultLike;
  /** 停止 + 取消开机自启（"停了就保持停"语义） */
  stopAndDisableAutostart(): ServiceResultLike;
  /** 原地重启运行中的服务 */
  restart(): ServiceResultLike;
  /** 轮询等服务真正停止（launchd bootout 是异步卸载） */
  waitUntilStopped(timeoutMs?: number): Promise<boolean>;
  /** 从 OS 移除服务定义 */
  deleteFile(): void;
  /** 底层工具的原始状态输出 */
  describeStatus(): string;
  /** 从 describeStatus() 文本提取 pid / 最近退出码（平台没有则 undefined） */
  parseStatus(text: string): { pid?: string; lastExit?: string };
}

function makeLaunchdAdapter(): ServiceAdapter {
  return {
    platformName: "launchd (macOS)",
    fileExists: () => launchd.plistExists(),
    isRunning: () => launchd.isLoaded(),
    servicePath: () => launchAgentPlistPath(),
    install: (workDir) => launchd.writePlist(workDir),
    start: () => launchd.bootstrap(),
    // launchd 没有独立的 disable——bootout 卸载即同时去掉 KeepAlive/RunAtLoad
    stopAndDisableAutostart: () => launchd.bootout(),
    restart: () => launchd.kickstart(),
    waitUntilStopped: (timeoutMs) => launchd.waitUntilUnloaded(timeoutMs),
    deleteFile: () => launchd.deletePlist(),
    describeStatus: () => launchd.describeService(),
    parseStatus: (text) => ({
      pid: text.match(/pid\s*=\s*(\d+)/)?.[1],
      lastExit: text.match(/last exit code\s*=\s*(-?\d+)/i)?.[1],
    }),
  };
}

function makeSystemdAdapter(): ServiceAdapter {
  return {
    platformName: "systemd (Linux 用户级)",
    fileExists: () => systemd.unitExists(),
    isRunning: () => systemd.isActive(),
    servicePath: () => systemdUnitPath(),
    install: (workDir) => {
      systemd.writeUnit(workDir);
      systemd.daemonReload();
    },
    start: () => systemd.enableAndStart(),
    stopAndDisableAutostart: () => systemd.disableAndStop(),
    restart: () => systemd.restart(),
    waitUntilStopped: (timeoutMs) => systemd.waitUntilInactive(timeoutMs),
    deleteFile: () => {
      systemd.deleteUnit();
      systemd.daemonReload();
    },
    describeStatus: () => systemd.describeService(),
    parseStatus: (text) => ({
      pid: text.match(/Main PID:\s*(\d+)/)?.[1],
      lastExit: text.match(/Process:\s+\d+\s+ExecStart=.*status=(\d+)/)?.[1],
    }),
  };
}

function makeSchtasksAdapter(): ServiceAdapter {
  return {
    platformName: "Task Scheduler (Windows)",
    fileExists: () => schtasks.isTaskRegistered(),
    isRunning: () => schtasks.isTaskRunning(),
    servicePath: () => WINDOWS_TASK_NAME,
    install: (workDir) => {
      const r = schtasks.installTasks(workDir);
      if (!r.ok) throw new Error(r.stderr || "schtasks /Create 失败");
    },
    start: () => schtasks.runTask(),
    stopAndDisableAutostart: () => schtasks.endAndDisable(),
    restart: () => schtasks.restartTask(),
    waitUntilStopped: (timeoutMs) => schtasks.waitUntilStopped(timeoutMs),
    deleteFile: () => {
      schtasks.deleteTasks();
    },
    describeStatus: () => schtasks.describeTask(),
    parseStatus: (text) => ({
      pid: text.match(/Process ID:\s*(\d+)/i)?.[1],
      lastExit: text.match(/Last Result:\s*(-?\d+)/i)?.[1],
    }),
  };
}

/** 按平台取 adapter；不支持的平台返回 null，调用方给友好报错 */
export function getServiceAdapter(platform: NodeJS.Platform = process.platform): ServiceAdapter | null {
  if (platform === "darwin") return makeLaunchdAdapter();
  if (platform === "linux") return makeSystemdAdapter();
  if (platform === "win32") return makeSchtasksAdapter();
  return null;
}
