/**
 * daemon 层的路径/命名规约（平台无关，纯函数）。
 *
 * 服务名规约（单实例）：
 * - macOS launchd label:  dev.mycc.backend
 * - Linux systemd unit:   mycc-backend.service（用户级 unit）
 * - Windows 计划任务:      MyccBackend（+ 崩溃巡检任务 MyccBackend.Watchdog）
 *
 * 日志沿用现有约定：.claude/skills/mycc/mycc.log（与 start -d 同一个文件）。
 */

import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export const SERVICE_NAME = "mycc-backend";

/** scripts/ 目录（src/daemon/paths.ts 往上三级） */
export function scriptsDir(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

/** 守护进程 stdout/stderr 落盘位置——沿用 start -d 的 mycc.log */
export function daemonLogPath(): string {
  return join(dirname(scriptsDir()), "mycc.log");
}

// === macOS launchd ===

export const LAUNCH_AGENT_LABEL = "dev.mycc.backend";

export function launchAgentPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

// === Linux systemd（用户级 unit）===

export const SYSTEMD_UNIT_NAME = `${SERVICE_NAME}.service`;

export function systemdUnitPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "systemd", "user", SYSTEMD_UNIT_NAME);
}

// === Windows Task Scheduler ===

export const WINDOWS_TASK_NAME = "MyccBackend";
/** 每 2 分钟巡检的看门狗任务——补上 schtasks 没有原生崩溃重启的缺口 */
export const WINDOWS_WATCHDOG_TASK_NAME = "MyccBackend.Watchdog";

/** .cmd wrapper 的存放目录——跟随 MYCC_DATA_DIR（测试隔离靠它），默认 ~/.mycc */
function windowsDaemonDir(): string {
  return join(process.env.MYCC_DATA_DIR ?? join(homedir(), ".mycc"), "daemon");
}

/** schtasks /TR 不支持重定向和环境变量，需要 .cmd wrapper */
export function windowsLauncherCmdPath(): string {
  return join(windowsDaemonDir(), "launcher.cmd");
}

export function windowsWatchdogCmdPath(): string {
  return join(windowsDaemonDir(), "watchdog.cmd");
}

/**
 * 三平台统一的服务执行行：node + tsx cli.mjs + src/index.ts start [--cwd ...]。
 * 不走 node_modules/.bin/tsx（Windows 上是 .cmd shim，launchd/systemd 里也
 * 不如直接 node 稳），老 Windows 脚本已长期验证这条链可行。
 */
export interface ServiceCommand {
  nodePath: string;
  args: string[];
}

export function serviceCommand(workDir: string): ServiceCommand {
  const scripts = scriptsDir();
  return {
    nodePath: process.execPath,
    args: [
      join(scripts, "node_modules", "tsx", "dist", "cli.mjs"),
      join(scripts, "src", "index.ts"),
      "start",
      "--cwd",
      workDir,
    ],
  };
}

/** 服务进程需要带上的环境变量（PATH 必带；MYCC_DATA_DIR/PORT 有则透传） */
export function serviceEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    NODE_NO_WARNINGS: "1",
  };
  if (process.env.MYCC_DATA_DIR) env.MYCC_DATA_DIR = process.env.MYCC_DATA_DIR;
  if (process.env.PORT) env.PORT = process.env.PORT;
  return env;
}
