/**
 * daemon 层所有 OS 命令（launchctl / systemctl / schtasks）的统一出口。
 * 收口成一个可注入的 runner，测试里用 fake 断言调用序列，不真跑系统命令。
 */

import { spawnSync } from "child_process";

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (cmd: string, args: string[]) => CommandResult;

const realRunner: CommandRunner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? (r.error ? String(r.error.message) : ""),
  };
};

let runner: CommandRunner = realRunner;

export function runCommand(cmd: string, args: string[]): CommandResult {
  return runner(cmd, args);
}

/** 测试注入；传 null 恢复真实 runner */
export function setCommandRunnerForTest(fake: CommandRunner | null): void {
  runner = fake ?? realRunner;
}
