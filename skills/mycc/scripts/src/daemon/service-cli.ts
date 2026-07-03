/**
 * `mycc service <sub>` 命令实现——OS 托管的服务级生命周期。
 * 与进程级的 mycc start/stop/restart 并存：装了服务就用 service 命令，
 * 否则进程级命令照旧（服务在跑时 mycc stop 杀掉的进程会被 OS 自动拉起）。
 */

import chalk from "chalk";
import { killEntry, listProcesses } from "../process-registry.js";
import { getServiceAdapter, type ServiceAdapter } from "./service-adapter.js";
import { daemonLogPath } from "./paths.js";

export async function serviceCommand(sub: string | undefined, args: string[]): Promise<void> {
  const adapter = getServiceAdapter();
  if (!adapter) {
    console.error(chalk.red(`当前平台 ${process.platform} 不支持服务管理（支持 macOS/Linux/Windows）`));
    process.exitCode = 1;
    return;
  }
  switch (sub) {
    case "install":
      await install(adapter, args);
      break;
    case "start":
      await start(adapter, args);
      break;
    case "stop":
      await stop(adapter);
      break;
    case "restart":
      await restart(adapter);
      break;
    case "status":
      showServiceStatus(adapter);
      break;
    case "uninstall":
      await uninstall(adapter);
      break;
    default:
      showServiceHelp();
      if (sub) process.exitCode = 1;
  }
}

function resolveWorkDir(args: string[]): string {
  const i = args.indexOf("--cwd");
  return i >= 0 && args[i + 1] ? args[i + 1] : process.cwd();
}

async function install(adapter: ServiceAdapter, args: string[]): Promise<void> {
  const workDir = resolveWorkDir(args);
  adapter.install(workDir);
  console.log(chalk.green(`✓ 服务已注册: ${adapter.servicePath()}`));
  console.log(chalk.gray(`  平台: ${adapter.platformName}`));
  console.log(chalk.gray(`  工作目录: ${workDir}`));
  console.log(chalk.gray(`  日志: ${daemonLogPath()}`));
  printPlatformHints();
}

async function start(adapter: ServiceAdapter, args: string[]): Promise<void> {
  // 总是先重装服务定义，刷新 node 路径 / PATH / 工作目录
  adapter.install(resolveWorkDir(args));
  const r = await adapter.start();
  if (!r.ok && adapter.isRunning()) {
    // launchd bootstrap 对已加载的服务报错，但服务本来就在跑——视为成功
    console.log(chalk.green("✓ 服务已在运行"));
    return;
  }
  if (!r.ok) {
    console.error(chalk.red(`✗ 服务启动失败: ${r.stderr.trim() || "未知错误"}`));
    process.exitCode = 1;
    return;
  }
  console.log(chalk.green(`✓ 服务已启动（${adapter.platformName}，崩溃自动重启 + 开机自启）`));
  console.log(chalk.gray(`  状态: mycc service status / mycc status`));
  printPlatformHints();
}

async function stop(adapter: ServiceAdapter): Promise<void> {
  const r = await adapter.stopAndDisableAutostart();
  const stopped = await adapter.waitUntilStopped();
  if (!stopped && !r.ok) {
    console.error(chalk.red(`✗ 服务停止失败: ${r.stderr.trim() || "未知错误"}`));
    process.exitCode = 1;
    return;
  }
  console.log(chalk.green("✓ 服务已停止，开机自启已取消"));
  await sweepOrphans();
}

async function restart(adapter: ServiceAdapter): Promise<void> {
  if (!adapter.fileExists()) {
    console.error(chalk.red("✗ 服务未注册，先跑 mycc service start"));
    process.exitCode = 1;
    return;
  }
  const r = await adapter.restart();
  if (!r.ok) {
    console.error(chalk.red(`✗ 服务重启失败: ${r.stderr.trim() || "未知错误"}`));
    process.exitCode = 1;
    return;
  }
  console.log(chalk.green("✓ 服务已重启"));
}

function showServiceStatus(adapter: ServiceAdapter): void {
  if (!adapter.fileExists()) {
    console.log(`服务未注册（${adapter.platformName}）。注册: mycc service start`);
    process.exitCode = 1;
    return;
  }
  const running = adapter.isRunning();
  const { pid, lastExit } = adapter.parseStatus(adapter.describeStatus());
  console.log(`${running ? chalk.green("✓ 服务运行中") : chalk.yellow("○ 服务已注册但未运行")}`);
  console.log(`  平台: ${adapter.platformName}`);
  console.log(`  定义: ${adapter.servicePath()}`);
  if (pid) console.log(`  PID: ${pid}`);
  if (lastExit !== undefined) console.log(`  最近退出码: ${lastExit}`);
  if (!running) process.exitCode = 1;
}

async function uninstall(adapter: ServiceAdapter): Promise<void> {
  if (!adapter.fileExists()) {
    console.log("服务本来就未注册。");
    return;
  }
  await adapter.stopAndDisableAutostart();
  await adapter.waitUntilStopped();
  adapter.deleteFile();
  console.log(chalk.green("✓ 服务已卸载"));
  await sweepOrphans();
}

/**
 * OS 层停服务后清扫注册表里的幸存进程（schtasks /End 可能只杀 cmd.exe
 * 留下 node 孤儿；launchd/systemd 一般杀干净，这里是双保险）。
 */
async function sweepOrphans(): Promise<void> {
  for (const entry of listProcesses()) {
    const outcome = await killEntry(entry);
    if (outcome !== "gone") {
      console.log(chalk.gray(`  清理残留进程 ${entry.id}(pid ${entry.pid})`));
    }
  }
}

function printPlatformHints(): void {
  if (process.platform === "linux") {
    console.log(chalk.gray("  提示: 要在 logout 后继续运行需 loginctl enable-linger $USER"));
    console.log(chalk.gray("  提示: 本机若还有 cron watchdog（crontab -l），两者会抢着拉起，建议二选一"));
  }
  if (process.platform === "win32") {
    console.log(chalk.gray("  提示: 已同时注册 MyccBackend.Watchdog 巡检任务（每 2 分钟，崩溃自动拉起）"));
  }
}

export function showServiceHelp(): void {
  console.log(`
${chalk.cyan("mycc service —— OS 托管的服务管理（开机自启 + 崩溃自动重启）")}

${chalk.yellow("用法:")}
  mycc service start [--cwd <目录>]   注册（或刷新）并启动服务
  mycc service stop                   停止服务并取消开机自启
  mycc service restart                原地重启服务
  mycc service status                 查看服务注册/运行状态
  mycc service install [--cwd <目录>] 只注册不启动
  mycc service uninstall              停止并移除服务定义

${chalk.yellow("平台实现:")}
  macOS    launchd LaunchAgent（KeepAlive 崩溃重启）
  Linux    systemd 用户级 unit（Restart=always）
  Windows  计划任务 ONLOGON 自启 + 每 2 分钟 watchdog 巡检拉起
`);
}
