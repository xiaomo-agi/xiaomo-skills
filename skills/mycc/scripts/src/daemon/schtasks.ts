/**
 * Windows Task Scheduler（schtasks）。
 *
 * 两个任务：
 * - MyccBackend：ONLOGON 触发的主任务，跑 launcher.cmd（开机自启）
 * - MyccBackend.Watchdog：每 2 分钟跑 watchdog.cmd——health 探测失败才拉起
 *   主任务。schtasks 没有 launchd KeepAlive / systemd Restart=always 的原生
 *   崩溃重启，这个巡检任务补上缺口（与 Linux cron watchdog 同构）。
 *
 * schtasks /TR 不支持重定向和环境变量，所以真正的命令行都在 .cmd wrapper 里。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname } from "path";
import { runCommand, type CommandResult } from "./exec.js";
import {
  daemonLogPath,
  serviceCommand,
  serviceEnv,
  WINDOWS_TASK_NAME,
  WINDOWS_WATCHDOG_TASK_NAME,
  windowsLauncherCmdPath,
  windowsWatchdogCmdPath,
} from "./paths.js";

export interface LauncherInputs {
  nodePath: string;
  args: string[];
  workDir: string;
  env: Record<string, string>;
  logPath: string;
}

export function buildLauncherCmd(inputs: LauncherInputs): string {
  const envLines = Object.entries(inputs.env).map(([k, v]) => `set "${k}=${v}"`);
  const argv = inputs.args.map((a) => `"${a}"`).join(" ");
  return [
    "@echo off",
    ...envLines,
    `cd /d "${inputs.workDir}"`,
    `"${inputs.nodePath}" ${argv} >> "${inputs.logPath}" 2>&1`,
    "",
  ].join("\r\n");
}

/**
 * watchdog.cmd：health 探测（Windows 10+ 自带 curl.exe），失败才 /Run 主任务。
 * 主任务的 launcher 启动时自己会清理端口残留（startServer 的 killPortProcess）。
 */
export function buildWatchdogCmd(port: string, logPath: string): string {
  return [
    "@echo off",
    `curl -sf -m 10 http://127.0.0.1:${port}/health >nul 2>&1`,
    "if %errorlevel% equ 0 exit /b 0",
    `echo [watchdog] %date% %time% health check failed, restarting backend >> "${logPath}"`,
    `schtasks /Run /TN "${WINDOWS_TASK_NAME}" >nul 2>&1`,
    "",
  ].join("\r\n");
}

function writeCmdScripts(workDir: string): void {
  const cmd = serviceCommand(workDir);
  const logPath = daemonLogPath();
  const launcherPath = windowsLauncherCmdPath();
  mkdirSync(dirname(launcherPath), { recursive: true });
  writeFileSync(
    launcherPath,
    buildLauncherCmd({ nodePath: cmd.nodePath, args: cmd.args, workDir, env: serviceEnv(), logPath }),
    "utf8"
  );
  writeFileSync(
    windowsWatchdogCmdPath(),
    buildWatchdogCmd(process.env.PORT || "18080", logPath),
    "utf8"
  );
}

/**
 * 注册两个任务：主任务 ONLOGON、watchdog 每 2 分钟。
 * /RL LIMITED 当前用户免提权，/F 覆盖已有同名任务。
 */
export function installTasks(workDir: string): CommandResult {
  writeCmdScripts(workDir);
  const main = runCommand("schtasks", [
    "/Create", "/F",
    "/SC", "ONLOGON",
    "/RL", "LIMITED",
    "/TN", WINDOWS_TASK_NAME,
    "/TR", `"${windowsLauncherCmdPath()}"`,
  ]);
  if (!main.ok) return main;
  return runCommand("schtasks", [
    "/Create", "/F",
    "/SC", "MINUTE", "/MO", "2",
    "/RL", "LIMITED",
    "/TN", WINDOWS_WATCHDOG_TASK_NAME,
    "/TR", `"${windowsWatchdogCmdPath()}"`,
  ]);
}

/** 立即启动主任务（不等触发器） */
export function runTask(): CommandResult {
  return runCommand("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME]);
}

export function endTask(): CommandResult {
  return runCommand("schtasks", ["/End", "/TN", WINDOWS_TASK_NAME]);
}

function changeTask(name: string, flag: "/Disable" | "/Enable"): CommandResult {
  return runCommand("schtasks", ["/Change", "/TN", name, flag]);
}

/**
 * 停止并保持停止：先禁用 watchdog（否则 2 分钟内又被拉起），再 /End 主任务
 * 并禁用其 ONLOGON 触发器。任务没在跑时 /End 会失败，属预期，disable 结果优先。
 */
export function endAndDisable(): CommandResult {
  changeTask(WINDOWS_WATCHDOG_TASK_NAME, "/Disable");
  const ended = endTask();
  const disabled = changeTask(WINDOWS_TASK_NAME, "/Disable");
  return disabled.ok ? disabled : ended;
}

/** schtasks 没有原生 restart：end → 等停 → run（watchdog 保持启用） */
export async function restartTask(): Promise<CommandResult> {
  endTask();
  await waitUntilStopped();
  return runTask();
}

/** /Query 返回 0 当且仅当任务已注册 */
export function isTaskRegistered(): boolean {
  return runCommand("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME]).ok;
}

export function isTaskRunning(): boolean {
  const r = runCommand("schtasks", ["/Query", "/V", "/FO", "LIST", "/TN", WINDOWS_TASK_NAME]);
  if (!r.ok) return false;
  return /Status:\s+Running/i.test(r.stdout);
}

export function describeTask(): string {
  const r = runCommand("schtasks", ["/Query", "/V", "/FO", "LIST", "/TN", WINDOWS_TASK_NAME]);
  return r.stdout || r.stderr || "";
}

export async function waitUntilStopped(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isTaskRunning()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export function deleteTasks(): CommandResult {
  runCommand("schtasks", ["/Delete", "/F", "/TN", WINDOWS_WATCHDOG_TASK_NAME]);
  const r = runCommand("schtasks", ["/Delete", "/F", "/TN", WINDOWS_TASK_NAME]);
  for (const p of [windowsLauncherCmdPath(), windowsWatchdogCmdPath()]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
  return r;
}
