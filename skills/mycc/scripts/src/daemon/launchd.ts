/**
 * macOS launchd 用户级 LaunchAgent。
 * 崩溃自动重启靠 KeepAlive=true，开机自启靠 RunAtLoad=true。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { userInfo } from "os";
import { dirname } from "path";
import { runCommand, type CommandResult } from "./exec.js";
import {
  daemonLogPath,
  LAUNCH_AGENT_LABEL,
  launchAgentPlistPath,
  serviceCommand,
  serviceEnv,
} from "./paths.js";

export interface PlistInputs {
  nodePath: string;
  args: string[];
  workDir: string;
  env: Record<string, string>;
  logPath: string;
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildPlist(inputs: PlistInputs): string {
  const programArgs = [inputs.nodePath, ...inputs.args]
    .map((a) => `        <string>${xmlEscape(a)}</string>`)
    .join("\n");
  const envEntries = Object.entries(inputs.env)
    .map(([k, v]) => `        <key>${xmlEscape(k)}</key>\n        <string>${xmlEscape(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${programArgs}
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(inputs.workDir)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xmlEscape(inputs.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(inputs.logPath)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
</dict>
</plist>
`;
}

export function writePlist(workDir: string): void {
  const cmd = serviceCommand(workDir);
  const content = buildPlist({
    nodePath: cmd.nodePath,
    args: cmd.args,
    workDir,
    env: serviceEnv(),
    logPath: daemonLogPath(),
  });
  const plistPath = launchAgentPlistPath();
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, content, "utf8");
}

export function plistExists(): boolean {
  return existsSync(launchAgentPlistPath());
}

function userTarget(): string {
  return `gui/${userInfo().uid}`;
}

function serviceTarget(): string {
  return `${userTarget()}/${LAUNCH_AGENT_LABEL}`;
}

export function bootstrap(): CommandResult {
  return runCommand("launchctl", ["bootstrap", userTarget(), launchAgentPlistPath()]);
}

export function bootout(): CommandResult {
  return runCommand("launchctl", ["bootout", serviceTarget()]);
}

/** kickstart -k：杀掉运行中的实例并立即重启（服务须已 bootstrap） */
export function kickstart(): CommandResult {
  return runCommand("launchctl", ["kickstart", "-k", serviceTarget()]);
}

/** launchctl print 返回 0 当且仅当服务已加载 */
export function isLoaded(): boolean {
  return runCommand("launchctl", ["print", serviceTarget()]).ok;
}

/**
 * bootout 同步返回但卸载是异步的——期间 bootstrap 会报
 * `Bootstrap failed: 5: Input/output error`，必须轮询等真正卸载完。
 */
export async function waitUntilUnloaded(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isLoaded()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export function describeService(): string {
  const r = runCommand("launchctl", ["print", serviceTarget()]);
  return r.stdout || r.stderr || "";
}

export function deletePlist(): void {
  rmSync(launchAgentPlistPath(), { force: true });
}
