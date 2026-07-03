/**
 * Linux systemd 用户级 unit（systemctl --user）。
 * 崩溃自动重启靠 Restart=always + RestartSec=5（5 秒退避防 crash-loop）。
 *
 * 注意：用户级 service 要在 logout 后继续存活需要
 * `loginctl enable-linger <user>`——install 成功提示里会提醒，代码不代设。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname } from "path";
import { runCommand, type CommandResult } from "./exec.js";
import { daemonLogPath, serviceCommand, serviceEnv, SYSTEMD_UNIT_NAME, systemdUnitPath } from "./paths.js";

export interface UnitInputs {
  nodePath: string;
  args: string[];
  workDir: string;
  env: Record<string, string>;
  logPath: string;
}

const escape = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");

export function buildUnit(inputs: UnitInputs): string {
  const execStart = [inputs.nodePath, ...inputs.args].map((a) => `"${escape(a)}"`).join(" ");
  const envLines = Object.entries(inputs.env)
    .map(([k, v]) => `Environment="${k}=${escape(v)}"`)
    .join("\n");
  return `[Unit]
Description=mycc backend (Claude Code Feishu/web bridge)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${inputs.workDir}
ExecStart=${execStart}
Restart=always
RestartSec=5
StandardOutput=append:${inputs.logPath}
StandardError=append:${inputs.logPath}
${envLines}

[Install]
WantedBy=default.target
`;
}

export function writeUnit(workDir: string): void {
  const cmd = serviceCommand(workDir);
  const content = buildUnit({
    nodePath: cmd.nodePath,
    args: cmd.args,
    workDir,
    env: serviceEnv(),
    logPath: daemonLogPath(),
  });
  const unitPath = systemdUnitPath();
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, content, "utf8");
}

export function unitExists(): boolean {
  return existsSync(systemdUnitPath());
}

function systemctl(args: string[]): CommandResult {
  return runCommand("systemctl", ["--user", ...args]);
}

/** unit 文件增删改后必须 daemon-reload */
export function daemonReload(): CommandResult {
  return systemctl(["daemon-reload"]);
}

/** 启动 + 开机自启（等价 launchd bootstrap） */
export function enableAndStart(): CommandResult {
  return systemctl(["enable", "--now", SYSTEMD_UNIT_NAME]);
}

export function stop(): CommandResult {
  return systemctl(["stop", SYSTEMD_UNIT_NAME]);
}

/** 停止 + 取消自启 */
export function disableAndStop(): CommandResult {
  return systemctl(["disable", "--now", SYSTEMD_UNIT_NAME]);
}

export function restart(): CommandResult {
  return systemctl(["restart", SYSTEMD_UNIT_NAME]);
}

/** is-active 返回 0 当且仅当 active */
export function isActive(): boolean {
  return systemctl(["is-active", SYSTEMD_UNIT_NAME]).ok;
}

export function describeService(): string {
  const r = systemctl(["status", SYSTEMD_UNIT_NAME, "--no-pager"]);
  return r.stdout || r.stderr || "";
}

export async function waitUntilInactive(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isActive()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export function deleteUnit(): void {
  rmSync(systemdUnitPath(), { force: true });
}
