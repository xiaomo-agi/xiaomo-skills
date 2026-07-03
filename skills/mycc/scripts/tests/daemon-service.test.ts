/**
 * daemon 服务层测试：纯函数（plist/unit/cmd 生成、路径规约）直接断言文本，
 * OS 命令流用 fake runner 断言调用序列，不真跑 launchctl/systemctl/schtasks。
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setCommandRunnerForTest, type CommandResult } from "../src/daemon/exec.js";
import { buildPlist } from "../src/daemon/launchd.js";
import {
  SYSTEMD_UNIT_NAME,
  WINDOWS_TASK_NAME,
  WINDOWS_WATCHDOG_TASK_NAME,
  serviceCommand,
  systemdUnitPath,
} from "../src/daemon/paths.js";
import { buildLauncherCmd, buildWatchdogCmd, endAndDisable, installTasks } from "../src/daemon/schtasks.js";
import { getServiceAdapter } from "../src/daemon/service-adapter.js";
import { buildUnit, writeUnit, enableAndStart, disableAndStop, isActive } from "../src/daemon/systemd.js";

const ok: CommandResult = { ok: true, stdout: "", stderr: "" };

let calls: string[][];
function fakeRunner(result: CommandResult = ok) {
  calls = [];
  setCommandRunnerForTest((cmd, args) => {
    calls.push([cmd, ...args]);
    return result;
  });
}

afterEach(() => setCommandRunnerForTest(null));

describe("paths 规约", () => {
  it("serviceCommand 用 node + tsx cli.mjs + src/index.ts start --cwd", () => {
    const cmd = serviceCommand("/work/dir");
    expect(cmd.nodePath).toBe(process.execPath);
    expect(cmd.args[0]).toMatch(/node_modules[/\\]tsx[/\\]dist[/\\]cli\.mjs$/);
    expect(cmd.args[1]).toMatch(/src[/\\]index\.ts$/);
    expect(cmd.args.slice(2)).toEqual(["start", "--cwd", "/work/dir"]);
  });

  it("systemdUnitPath 尊重 XDG_CONFIG_HOME", () => {
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = "/tmp/xdg-test";
    try {
      expect(systemdUnitPath()).toBe(join("/tmp/xdg-test", "systemd", "user", SYSTEMD_UNIT_NAME));
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
    }
  });
});

describe("launchd plist 生成", () => {
  const inputs = {
    nodePath: "/usr/bin/node",
    args: ["/a/cli.mjs", "/a/index.ts", "start", "--cwd", "/work"],
    workDir: "/work",
    env: { PATH: "/usr/bin:/bin", NODE_NO_WARNINGS: "1" },
    logPath: "/logs/mycc.log",
  };

  it("包含崩溃重启和自启的关键 key", () => {
    const plist = buildPlist(inputs);
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<string>dev.mycc.backend</string>");
    expect(plist).toContain("<key>WorkingDirectory</key>");
    expect(plist).toContain("<string>/work</string>");
    // stdout/stderr 同一个日志文件
    expect(plist.match(/<string>\/logs\/mycc\.log<\/string>/g)).toHaveLength(2);
  });

  it("ProgramArguments 按顺序完整、XML 特殊字符转义", () => {
    const plist = buildPlist({ ...inputs, workDir: '/work/<a> & "b"' });
    const nodeIdx = plist.indexOf("<string>/usr/bin/node</string>");
    const startIdx = plist.indexOf("<string>start</string>");
    expect(nodeIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeGreaterThan(nodeIdx);
    expect(plist).toContain("&lt;a&gt; &amp; &quot;b&quot;");
  });
});

describe("systemd unit 生成", () => {
  const inputs = {
    nodePath: "/usr/bin/node",
    args: ["/a/cli.mjs", "/a/index.ts", "start", "--cwd", "/work"],
    workDir: "/work",
    env: { PATH: "/usr/bin:/bin", MYCC_DATA_DIR: "/data" },
    logPath: "/logs/mycc.log",
  };

  it("包含崩溃重启、工作目录、日志追加、环境变量", () => {
    const unit = buildUnit(inputs);
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("RestartSec=5");
    expect(unit).toContain("WorkingDirectory=/work");
    expect(unit).toContain("StandardOutput=append:/logs/mycc.log");
    expect(unit).toContain("StandardError=append:/logs/mycc.log");
    expect(unit).toContain('Environment="PATH=/usr/bin:/bin"');
    expect(unit).toContain('Environment="MYCC_DATA_DIR=/data"');
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain('ExecStart="/usr/bin/node" "/a/cli.mjs" "/a/index.ts" "start" "--cwd" "/work"');
  });
});

describe("systemd 命令流（fake runner）", () => {
  let xdgTmp: string;
  let prevXdg: string | undefined;

  beforeEach(() => {
    xdgTmp = mkdtempSync(join(tmpdir(), "mycc-xdg-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdgTmp;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    rmSync(xdgTmp, { recursive: true, force: true });
  });

  it("writeUnit 真实落盘到 XDG 路径", () => {
    writeUnit("/work");
    const unitFile = join(xdgTmp, "systemd", "user", SYSTEMD_UNIT_NAME);
    expect(existsSync(unitFile)).toBe(true);
    expect(readFileSync(unitFile, "utf8")).toContain("Restart=always");
  });

  it("enableAndStart / disableAndStop / isActive 走 systemctl --user", () => {
    fakeRunner();
    enableAndStart();
    disableAndStop();
    isActive();
    expect(calls).toEqual([
      ["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT_NAME],
      ["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT_NAME],
      ["systemctl", "--user", "is-active", SYSTEMD_UNIT_NAME],
    ]);
  });
});

describe("Windows .cmd 生成", () => {
  it("launcher.cmd 切工作目录、带环境变量、日志追加", () => {
    const cmd = buildLauncherCmd({
      nodePath: "C:\\node\\node.exe",
      args: ["C:\\a\\cli.mjs", "C:\\a\\index.ts", "start", "--cwd", "C:\\work"],
      workDir: "C:\\work",
      env: { PATH: "C:\\bin", NODE_NO_WARNINGS: "1" },
      logPath: "C:\\logs\\mycc.log",
    });
    expect(cmd).toContain('cd /d "C:\\work"');
    expect(cmd).toContain('set "PATH=C:\\bin"');
    expect(cmd).toContain('>> "C:\\logs\\mycc.log" 2>&1');
    expect(cmd).toContain('"C:\\node\\node.exe" "C:\\a\\cli.mjs" "C:\\a\\index.ts" "start" "--cwd" "C:\\work"');
    expect(cmd).toContain("\r\n"); // Windows 换行
  });

  it("watchdog.cmd health 通过即退出，失败才 /Run 主任务", () => {
    const cmd = buildWatchdogCmd("18080", "C:\\logs\\mycc.log");
    expect(cmd).toContain("http://127.0.0.1:18080/health");
    expect(cmd).toContain("if %errorlevel% equ 0 exit /b 0");
    expect(cmd).toContain(`schtasks /Run /TN "${WINDOWS_TASK_NAME}"`);
  });
});

describe("schtasks 命令流（fake runner）", () => {
  it("installTasks 注册主任务(ONLOGON) + watchdog(每2分钟)", () => {
    fakeRunner();
    installTasks(process.cwd());
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(expect.arrayContaining(["/Create", "/SC", "ONLOGON", "/TN", WINDOWS_TASK_NAME]));
    expect(calls[1]).toEqual(
      expect.arrayContaining(["/Create", "/SC", "MINUTE", "/MO", "2", "/TN", WINDOWS_WATCHDOG_TASK_NAME])
    );
  });

  it("endAndDisable 先禁 watchdog 再停主任务（防 2 分钟内被拉回）", () => {
    fakeRunner();
    endAndDisable();
    expect(calls[0]).toEqual(["schtasks", "/Change", "/TN", WINDOWS_WATCHDOG_TASK_NAME, "/Disable"]);
    expect(calls[1]).toEqual(["schtasks", "/End", "/TN", WINDOWS_TASK_NAME]);
    expect(calls[2]).toEqual(["schtasks", "/Change", "/TN", WINDOWS_TASK_NAME, "/Disable"]);
  });
});

describe("平台分发", () => {
  it("darwin/linux/win32 各取对应 adapter，其它平台 null", () => {
    expect(getServiceAdapter("darwin")?.platformName).toContain("launchd");
    expect(getServiceAdapter("linux")?.platformName).toContain("systemd");
    expect(getServiceAdapter("win32")?.platformName).toContain("Task Scheduler");
    expect(getServiceAdapter("freebsd" as NodeJS.Platform)).toBeNull();
  });

  it("parseStatus 提取各平台 pid / 退出码", () => {
    const mac = getServiceAdapter("darwin")!;
    expect(mac.parseStatus("... pid = 1234\n last exit code = -15 ...")).toEqual({ pid: "1234", lastExit: "-15" });
    const linux = getServiceAdapter("linux")!;
    expect(linux.parseStatus("   Main PID: 4321 (node)")).toEqual({ pid: "4321", lastExit: undefined });
    const win = getServiceAdapter("win32")!;
    expect(win.parseStatus("Process ID:    999\nLast Result:   0")).toEqual({ pid: "999", lastExit: "0" });
  });
});
