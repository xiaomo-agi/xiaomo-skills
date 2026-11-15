#!/usr/bin/env node

/**
 * CC 小程序本地后端
 *
 * 用法:
 *   cc-mp start [--cwd <工作目录>]
 *   cc-mp status
 */

import { execSync, spawn } from "child_process";
import { mkdirSync, writeFileSync, existsSync, appendFileSync, openSync, closeSync } from "fs";
import { homedir } from "os";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { join } from "path";

// 从新模块导入
import type { DeviceConfig, RegisterResult } from "./types.js";
import { generateCode, generateDeviceId, retryWithBackoff, waitForReady } from "./utils.js";
import { getConfigDir, loadConfig, deleteConfig, findProjectRoot } from "./config.js";
import {
  killPortProcess,
  checkCloudflared,
  checkCCAvailable,
  checkCodexAvailable,
  decideStartupMode,
  getCloudflaredInstallHint,
} from "./platform.js";
import qrcode from "qrcode-terminal";
import chalk from "chalk";
import { HttpServer } from "./http-server.js";
import { startScheduler, stopScheduler, type Task } from "./scheduler.js";
import { adapter } from "./adapters/index.js";
import { CloudflareProvider } from "./tunnel-provider.js";
import { TunnelManager } from "./tunnel-manager.js";
import { loadPublicUrl, loadEnvFile, loadClaudeSettingsEnv } from "./env-loader.js";
import { listProcesses, registerSelf, unregisterSelf, resolveTarget, killEntry } from "./process-registry.js";
import { serviceCommand } from "./daemon/service-cli.js";
import { forbiddenWorkdirReason } from "./workdir-guard.js";

const PORT = process.env.PORT || 18080;
const WORKER_URL = process.env.WORKER_URL || "https://api.mycc.dev";
const PACKAGE_NAME = "mycc-backend";

// 日志时间戳前缀（2026-10-26 P2-1）：所有 console 输出统一加 [HH:MM:SS]，
// 此前 mycc.log 无任何时间信息，排查延迟/重复/回合时长只能靠行号猜。
// 在入口处劫持一次全局生效，各模块的 console 调用点零改动；
// 已带时间戳的行（理论不会有）防重复加前缀。
{
  const stamp = () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]`;
  };
  const isStamped = (firstArg: unknown) =>
    typeof firstArg === "string" && firstArg.startsWith("[") && /^\[\d{2}:\d{2}:\d{2}\]/.test(firstArg);
  for (const method of ["log", "warn", "error"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      if (args.length > 0 && !isStamped(args[0])) original(stamp(), ...args);
      else original(...args);
    };
  }
}


// 检测版本更新
async function checkVersionUpdate(): Promise<void> {
  try {
    // 获取本地版本
    const packageJson = await import("../package.json", { with: { type: "json" } });
    const localVersion = packageJson.default.version;

    // 获取最新版本（静默失败，不阻塞启动）
    const latestVersion = execSync(`npm show ${PACKAGE_NAME} version 2>/dev/null`, { timeout: 5000 })
      .toString()
      .trim();

    if (latestVersion && latestVersion !== localVersion) {
      console.log(chalk.yellow(`\n⚠️  发现新版本 ${latestVersion}（当前 ${localVersion}）`));
      console.log(chalk.yellow(`   运行 npm update -g ${PACKAGE_NAME} 更新\n`));
    }
  } catch {
    // 版本检测失败，静默忽略（可能未发布到 npm 或网络问题）
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "start";

  switch (command) {
    case "start":
      if (args.includes("-d") || args.includes("--daemon")) {
        startDetached(args.slice(1));
        exitCli();
      } else {
        await startServer(args);
      }
      break;
    case "status":
      await showStatus();
      exitCli();
      break;
    case "ps":
      showProcesses();
      exitCli();
      break;
    case "kill":
      await killCommand(args[1]);
      exitCli();
      break;
    case "stop":
      await stopAll();
      exitCli();
      break;
    case "restart":
      await stopAll();
      startDetached(args.slice(1));
      exitCli();
      break;
    case "service":
      await serviceCommand(args[1], args.slice(2));
      exitCli();
      break;
    case "doctor": {
      const { runDoctor, renderDoctor } = await import("./doctor.js");
      const results = await runDoctor();
      console.log(renderDoctor(results).text);
      exitCli();
      break;
    }
    case "help":
    default:
      showHelp();
      exitCli();
  }
}

/**
 * CLI 短命令跑完必须显式退出：模块级 import 的 adapter 在构造时就起了
 * 清理定时器（setInterval），不退出的话事件循环永远不空，命令会挂死。
 */
function exitCli(): void {
  process.exit(process.exitCode ?? 0);
}

/**
 * status 子命令：探测本机后端的 /health 接口（无需配对 token）。
 * 后端运行中 → 打印端口/主机名/web 配对状态，退出码 0；
 * 无响应 → 提示未运行，退出码 1（脚本/watchdog 可以直接用退出码判断）。
 */
async function showStatus(): Promise<void> {
  const url = `http://127.0.0.1:${PORT}/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const data = (await res.json()) as { status?: string; paired?: boolean; hostname?: string };
    if (data.status !== "ok") throw new Error(`health 返回异常: ${JSON.stringify(data)}`);
    console.log(chalk.green(`✓ 后端运行中 (端口 ${PORT})`));
    console.log(`  主机: ${data.hostname ?? "未知"}`);
    console.log(`  web 配对: ${data.paired ? "已配对" : "未配对"}`);
    const entries = listProcesses();
    if (entries.length > 0) {
      console.log(`  进程: ${entries.map((e) => `${e.id}(pid ${e.pid})`).join(", ")}`);
    }
  } catch {
    console.log(chalk.red(`✗ 后端未运行（${url} 无响应）`));
    process.exitCode = 1;
  }
}

/** ps 子命令：列出注册表里存活的后端进程 */
function showProcesses(): void {
  const entries = listProcesses();
  if (entries.length === 0) {
    console.log("没有正在运行的 mycc 后端进程。");
    return;
  }
  console.log(`${"序号".padEnd(4)} ${"ID".padEnd(6)} ${"PID".padEnd(8)} ${"端口".padEnd(6)} ${"启动时间".padEnd(26)} 工作目录`);
  entries.forEach((e, i) => {
    const uptimeMin = Math.round((Date.now() - Date.parse(e.startedAt)) / 60000);
    console.log(
      `${String(i + 1).padEnd(4)} ${e.id.padEnd(6)} ${String(e.pid).padEnd(8)} ${String(e.port).padEnd(6)} ${`${e.startedAt}（${uptimeMin} 分钟前）`.padEnd(26)} ${e.cwd}`
    );
  });
}

/** kill 子命令：按短 id / pid / ps 序号干掉指定后端进程 */
async function killCommand(target?: string): Promise<void> {
  if (!target) {
    console.log("用法: mycc kill <id|pid|序号>（先用 mycc ps 查看）");
    process.exitCode = 1;
    return;
  }
  const entry = resolveTarget(target);
  if (!entry) {
    console.log(chalk.red(`找不到目标 "${target}"，用 mycc ps 查看正在运行的进程。`));
    process.exitCode = 1;
    return;
  }
  const outcome = await killEntry(entry);
  const desc = { terminated: "已优雅退出", killed: "超时后已强制终止", gone: "本来就已退出" }[outcome];
  console.log(chalk.green(`✓ 进程 ${entry.id}(pid ${entry.pid}) ${desc}`));
}

/** stop 子命令：停掉所有注册的后端进程；注册表为空时兜底清理端口 */
async function stopAll(): Promise<void> {
  const entries = listProcesses();
  if (entries.length === 0) {
    console.log("注册表中没有运行中的后端，按端口兜底清理...");
    await killPortProcess(Number(PORT));
    console.log(chalk.green(`✓ 端口 ${PORT} 已清理`));
    return;
  }
  for (const entry of entries) {
    const outcome = await killEntry(entry);
    const desc = { terminated: "已优雅退出", killed: "超时后已强制终止", gone: "本来就已退出" }[outcome];
    console.log(chalk.green(`✓ 进程 ${entry.id}(pid ${entry.pid}) ${desc}`));
  }
}

/**
 * start -d / restart：以守护方式启动——spawn 一个脱离进程树的子进程跑
 * `start`，日志追加到 .claude/skills/mycc/mycc.log，父进程立即返回。
 * 取代 SKILL.md 里手拼的 `nohup ... & disown`。
 */
function startDetached(passThroughArgs: string[]): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const scriptsDir = dirname(__dirname);
  const logFile = join(dirname(scriptsDir), "mycc.log");
  const tsxBin = join(scriptsDir, "node_modules", ".bin", "tsx");
  const cleanArgs = passThroughArgs.filter((a) => a !== "-d" && a !== "--daemon");

  appendFileSync(logFile, `\n=== ${new Date().toISOString()} mycc start（守护模式） ===\n`);
  const out = openSync(logFile, "a");
  const child = spawn(tsxBin, [join(scriptsDir, "src", "index.ts"), "start", ...cleanArgs], {
    detached: true,
    stdio: ["ignore", out, out],
    cwd: process.cwd(),
  });
  child.unref();
  closeSync(out);
  console.log(chalk.green(`✓ 后端已在后台启动 (pid ${child.pid})`));
  console.log(chalk.gray(`  日志: ${logFile}`));
  console.log(chalk.gray(`  状态: mycc status / mycc ps`));
}

async function startServer(args: string[]) {
  loadClaudeSettingsEnv();
  console.log(chalk.cyan("\n=== CC 小程序本地后端 ===\n"));

  // 检测版本更新（静默，不阻塞）
  await checkVersionUpdate();

  // 杀掉旧进程，确保端口可用
  console.log(chalk.gray("检查端口占用..."));
  await killPortProcess(Number(PORT));

  // 登记进程注册表（mycc ps/kill/stop 的数据源），退出时注销
  const registryEntry = registerSelf(Number(PORT), process.cwd());
  process.on("exit", () => unregisterSelf(registryEntry.id));

  // 检查 CC / Codex 是否可用：两者都不可用才拒绝启动
  console.log("检查 Claude Code CLI...");
  const ccAvailable = await checkCCAvailable();
  const codexAvailable = ccAvailable ? false : await checkCodexAvailable();
  const startupMode = decideStartupMode(ccAvailable, codexAvailable);
  if (!startupMode.ok) {
    console.error(chalk.red("错误: Claude Code CLI 与 Codex CLI 均未安装或不可用"));
    console.error("请至少安装其一:");
    console.error("  Claude Code: npm install -g @anthropic-ai/claude-code");
    console.error("  Codex:       npm install -g @openai/codex");
    process.exit(1);
  }
  if (startupMode.mode === "codex-only") {
    console.warn(chalk.yellow("⚠ Claude Code CLI 不可用，仅 codex 模式启动"));
    console.warn(chalk.yellow("  /chat 请求需显式传 provider=\"codex\"，默认 claude 通道将报错\n"));
  } else {
    console.log(chalk.green("✓ Claude Code CLI 可用\n"));
  }

  // 获取 scripts 目录的父目录（跨平台兼容）
  // 使用 fileURLToPath 确保 Windows/Linux/macOS 都能正确解析
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const scriptsDir = dirname(__dirname); // scripts/ (不包含 src)

  // 第一次加载 .env 文件（搜索可能的位置）
  // 注意：此时可能还不知道项目根目录，所以搜索多个位置
  loadEnvFile(process.cwd(), scriptsDir);

  // 检测公网模式（读取 .env 中的 PUBLIC_URL）
  const publicUrl = loadPublicUrl(process.cwd(), scriptsDir);
  const isPublicMode = !!publicUrl;

  if (isPublicMode) {
    console.log(chalk.cyan(`\n公网模式: ${publicUrl}`));
    console.log(chalk.gray("  跳过 cloudflared（不需要内网穿透）\n"));
  } else {
    // 只有内网模式才需要 cloudflared
    console.log("检查 cloudflared...");
    const cloudflaredAvailable = await checkCloudflared();
    if (!cloudflaredAvailable) {
      console.error(chalk.red("错误: cloudflared 未安装"));
      console.error(getCloudflaredInstallHint());
      process.exit(1);
    }
    console.log(chalk.green("✓ cloudflared 可用\n"));
  }

  // 解析工作目录
  const cwdIndex = args.indexOf("--cwd");
  let cwd: string;

  if (cwdIndex !== -1 && args[cwdIndex + 1]) {
    // 用户显式指定了 --cwd
    cwd = args[cwdIndex + 1];
  } else {
    // 自动检测：从当前目录向上查找项目根目录
    const detected = findProjectRoot(process.cwd());
    if (detected) {
      cwd = detected;
      if (detected !== process.cwd()) {
        console.log(chalk.cyan(`自动检测到项目根目录: ${detected}`));
      }
    } else {
      // 没找到，使用当前目录，但给出警告
      cwd = process.cwd();
      console.log(chalk.yellow("⚠️  未检测到 .claude/ 或 CLAUDE.md，使用当前目录"));
      console.log(chalk.yellow("   如果 hooks 不生效，请用 --cwd 指定项目根目录\n"));
    }
  }
  // 工作目录红线：根目录/Home 根/系统目录直接拒绝启动，防止 Agent 文件操作裸奔
  const forbidden = forbiddenWorkdirReason(cwd);
  if (forbidden) {
    console.error(chalk.red(`错误: ${forbidden}`));
    console.error("请用 --cwd 指定具体的项目目录。");
    process.exit(1);
  }
  console.log(`工作目录: ${cwd}\n`);

  // 检查是否需要重置
  const resetFlag = args.includes("--reset");
  if (resetFlag) {
    deleteConfig(cwd);
  }

  // 加载或创建设备配置
  let config = loadConfig(cwd);
  let isFirstRun = false;

  if (config) {
    console.log(chalk.green("✓ 已加载设备配置"));
    console.log(chalk.gray(`  设备 ID: ${config.deviceId}`));
    console.log(chalk.gray(`  配对码: ${config.pairCode}`));
    if (config.routeToken) {
      console.log(chalk.gray(`  连接码: ${config.routeToken}\n`));
    }
  } else {
    // 首次运行，生成新配置
    isFirstRun = true;
    config = {
      deviceId: generateDeviceId(),
      pairCode: generateCode(),
      createdAt: new Date().toISOString()
    };
    console.log(chalk.yellow("首次运行，生成新设备配置"));
    console.log(chalk.gray(`  设备 ID: ${config.deviceId}`));
    console.log(chalk.gray(`  配对码: ${config.pairCode}\n`));
  }

  const { deviceId, pairCode, authToken } = config;

  // 启动 HTTP/HTTPS 服务器（公网模式下检测 Origin Certificate）
  const certPath = join(scriptsDir, "origin-cert.pem");
  const keyPath = join(scriptsDir, "origin-key.pem");
  const tlsConfig = existsSync(certPath) && existsSync(keyPath)
    ? { certPath, keyPath }
    : undefined;

  if (tlsConfig) {
    console.log(chalk.green("✓ 检测到 Origin Certificate，使用 HTTPS\n"));
  }

  // 再次加载 .env 文件（使用确定的项目根目录）
  loadEnvFile(cwd);

  const server = new HttpServer(pairCode, cwd, authToken, tlsConfig);

  // 如果之前已配对，显示状态
  if (authToken) {
    console.log(chalk.green("✓ 已恢复配对状态\n"));
  }

  // 启动 HTTP 服务器
  try {
    await server.start();
  } catch (error: any) {
    if (error.code === 'EADDRINUSE') {
      console.error(chalk.red(`错误: 端口 ${PORT} 已被占用`));
      console.error(chalk.yellow('请检查是否有其他 mycc 实例正在运行'));
      console.error(chalk.yellow(`提示: lsof -i :${PORT}`));
      process.exit(1);
    }
    throw error;
  }

  // 记录任务执行历史到 history.md
  const recordHistory = (taskCwd: string, taskName: string, status: string) => {
    const historyPath = join(taskCwd, ".claude", "skills", "scheduler", "history.md");

    // 如果 history.md 不存在，自动创建
    if (!existsSync(historyPath)) {
      const header = `# 定时任务执行记录

> 每次执行任务都会记录在这里

---

| 时间 | 任务 | 状态 |
|------|------|------|
`;
      try {
        writeFileSync(historyPath, header);
      } catch {
        return; // 创建失败则跳过
      }
    }

    const now = new Date();
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const record = `| ${timestamp} | ${taskName} | ${status} |\n`;

    try {
      appendFileSync(historyPath, record);
    } catch {
      // 静默失败，不影响任务执行
    }
  };

  // 启动定时任务调度器
  const executeTask = async (task: Task, taskCwd: string) => {
    // 获取当前时间戳
    const now = new Date();
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    // 构造带上下文的消息
    const skillLine = task.skill && task.skill !== "-"
      ? `1. 执行技能：${task.skill}（位置：.claude/skills/${task.skill.replace("/", "")}）`
      : "1. 无需执行特定技能，直接完成任务";

    const message = `[定时任务] ${task.name}

时间：${timestamp}
任务：${task.desc}

---
执行要求：
${skillLine}
2. 完成后用 /tell-me 发飞书通知（位置：.claude/skills/tell-me）
3. 通知标题格式：【定时任务】${task.name}
4. 卡片底部 note 填写时间戳：${timestamp}
5. 任务定义位置：.claude/skills/scheduler/tasks.md`;

    // 记录开始执行
    recordHistory(taskCwd, task.name, "执行中...");

    try {
      for await (const _event of adapter.chat({ message, cwd: taskCwd, sessionId: task.sessionId })) {
        // 忽略输出，只需要执行
      }
      console.log(chalk.green(`[Scheduler] 任务完成: ${task.name}`));
      recordHistory(taskCwd, task.name, "✅ 成功");
    } catch (error) {
      console.error(chalk.red(`[Scheduler] 任务失败: ${task.name}`), error);
      recordHistory(taskCwd, task.name, "❌ 失败");
    }
  };
  startScheduler(cwd, executeTask);

  // tunnelUrl 需要可变，因为重启时会更新
  let tunnelUrl: string;
  let tunnelManager: TunnelManager | null = null;

  if (isPublicMode) {
    // 公网模式：直接用 PUBLIC_URL，不启动 tunnel
    tunnelUrl = publicUrl!;
    console.log(chalk.green(`✓ 使用公网地址: ${tunnelUrl}\n`));
  } else {
    // 内网模式：启动 cloudflared tunnel（使用 TunnelManager 保活）
    console.log(chalk.yellow("启动 tunnel...\n"));

    const tunnelProvider = new CloudflareProvider(120000);

    tunnelManager = new TunnelManager({
      localPort: Number(PORT),
      onRestartSuccess: async (newUrl: string) => {
        console.log(chalk.cyan(`[TunnelManager] 更新 tunnelUrl: ${newUrl}`));
        tunnelUrl = newUrl;

        console.log(chalk.gray("重新注册到中转服务器..."));
        const newRegisterResult = await registerToWorker(newUrl, pairCode, deviceId);
        if (newRegisterResult?.token) {
          console.log(chalk.green("✓ 重新注册成功"));
          saveConnectionInfo();
        } else {
          console.warn(chalk.yellow("⚠️ 重新注册失败，小程序可能无法访问"));
        }
      },
      onGiveUp: () => {
        console.error(chalk.red("╔════════════════════════════════════════╗"));
        console.error(chalk.red("║  Tunnel 重连失败次数过多，已放弃       ║"));
        console.error(chalk.red("║  请手动重启: /mycc                     ║"));
        console.error(chalk.red("╚════════════════════════════════════════╝"));
      },
    });

    try {
      tunnelUrl = await tunnelManager.start(tunnelProvider);
      console.log(chalk.green(`✓ Tunnel 已启动: ${tunnelUrl}`));
      console.log(chalk.gray(`  保活监控已开启（心跳间隔 60s，失败阈值 3 次）\n`));
    } catch (error) {
      console.error(chalk.red("警告: 无法启动 tunnel"), error);
      console.warn(chalk.yellow("  Web 通道将不可用，但飞书通道仍可正常工作\n"));
      // 使用占位 URL，避免后续代码崩溃
      tunnelUrl = "http://localhost disabled";
      tunnelManager = null; // 标记 tunnel 不可用
    }
  }

  // 向 Worker 注册，获取 token（带 deviceId）
  // 只有当 Tunnel 可用时才尝试注册
  let token: string | null = null;
  let mpUrl: string;

  if (tunnelManager === null && !isPublicMode) {
    // Tunnel 不可用，跳过 Worker 注册
    console.warn(chalk.yellow("Tunnel 不可用，跳过 Worker 注册"));
    console.warn(chalk.yellow("Web 通道不可用，仅飞书通道可用\n"));
    mpUrl = "http://localhost disabled";
  } else {
    console.log(chalk.yellow("向中转服务器注册...\n"));
    const registerResult = await registerToWorker(tunnelUrl, pairCode, deviceId);
    token = registerResult?.token ?? null;

    if (!token) {
      console.error(chalk.red("警告: 无法注册到中转服务器，小程序可能无法使用"));
      console.log(chalk.gray("（直接访问 tunnel URL 仍可用于测试）\n"));
      mpUrl = tunnelUrl; // fallback
    } else {
      // 注册成功，更新并保存配置
      if (registerResult?.isNewDevice) {
        console.log(chalk.green("✓ 新设备注册成功\n"));
      } else {
        console.log(chalk.green("✓ 设备已识别，连接码保持不变\n"));
      }

      // 验证 Worker 是否真的更新了 tunnelUrl
      console.log(chalk.gray("验证 Worker 映射..."));
      const verified = await verifyWorkerMapping(token, tunnelUrl);
      if (verified) {
        console.log(chalk.green("✓ Worker 映射验证成功\n"));
      } else {
        console.error(chalk.red("Worker 映射验证失败"));
        console.error(chalk.yellow("   建议：请重新启动后端\n"));
      }

      mpUrl = `${WORKER_URL}/${token}`;
    }
  }

  // 保存连接信息到文件（统一保存，包含持久化配置）
  // 优先级：MYCC_SKILL_DIR 环境变量 > cwd/.claude/skills/mycc > ~/.mycc/
  const saveConnectionInfo = (newAuthToken?: string) => {
    let myccDir: string;

    const envSkillDir = process.env.MYCC_SKILL_DIR;
    const cwdSkillDir = join(cwd, ".claude", "skills", "mycc");
    const homeDir = join(homedir(), ".mycc");

    if (envSkillDir && existsSync(envSkillDir)) {
      myccDir = envSkillDir;
    } else if (existsSync(join(cwd, ".claude", "skills", "mycc"))) {
      myccDir = cwdSkillDir;
    } else {
      myccDir = homeDir;
    }

    const infoPath = join(myccDir, "current.json");
    try {
      mkdirSync(myccDir, { recursive: true });
      // 获取当前 authToken（优先用新传入的，否则用服务器当前的）
      const currentAuthToken = newAuthToken || server.getAuthToken() || authToken;
      writeFileSync(
        infoPath,
        JSON.stringify({
          // 持久化配置（重启后复用）
          deviceId,
          pairCode,
          routeToken: token,
          authToken: currentAuthToken,  // 保存 authToken
          // 运行时信息（每次启动更新）
          tunnelUrl,
          mpUrl,
          cwd,
          startedAt: new Date().toISOString(),
        }, null, 2)
      );
      console.log(chalk.gray(`连接信息已保存到: ${infoPath}`));
    } catch (err) {
      console.error(chalk.yellow("警告: 无法保存连接信息到文件"), err);
    }
  };

  // 设置配对成功回调，保存 authToken
  server.setOnPaired((newToken) => {
    console.log(chalk.gray("正在保存配对信息..."));
    saveConnectionInfo(newToken);
  });

  // 保存到文件（包含持久化配置，下次启动会读取）
  saveConnectionInfo();

  // 打印连接信息的函数
  const printConnectionInfo = () => {
    console.log(chalk.yellow("\n========== 连接信息 ==========\n"));
    qrcode.generate(mpUrl, { small: true });
    console.log(`\n小程序 URL: ${chalk.cyan(mpUrl)}`);
    if (token) {
      console.log(`连接码: ${chalk.cyan(token)}`);
    }
    console.log(`配对码: ${chalk.cyan(pairCode)}`);
    console.log(chalk.gray(`\nTunnel: ${tunnelUrl}`));
    console.log(chalk.yellow("\n==============================\n"));
  };

  // 显示配对信息
  printConnectionInfo();

  if (authToken) {
    console.log(chalk.green("✓ 服务已就绪\n"));
  } else {
    console.log(chalk.green("✓ 服务已就绪，扫码配对后即可使用\n"));
  }
  console.log(chalk.gray("按回车键重新显示连接信息"));
  console.log(chalk.gray("按 Ctrl+C 退出\n"));

  // 监听键盘输入，按回车重新打印连接信息
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (key) => {
      // Ctrl+C
      if (key[0] === 3) {
        console.log(chalk.yellow("\n正在退出..."));
        adapter.closeAllSessions();
        tunnelManager?.stop();
        stopScheduler();
        server.stop();
        process.exit(0);
      }
      // Enter
      if (key[0] === 13) {
        printConnectionInfo();
      }
    });
  }

  // 处理退出
  process.on("SIGINT", () => {
    console.log(chalk.yellow("\n正在退出..."));
    adapter.closeAllSessions();
    tunnelManager?.stop();
    stopScheduler();
    server.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    adapter.closeAllSessions();
    tunnelManager?.stop();
    stopScheduler();
    server.stop();
    process.exit(0);
  });
}

// 向 Worker 注册 tunnel URL，返回 { token, isNewDevice }
async function registerToWorker(
  tunnelUrl: string,
  pairCode: string,
  deviceId?: string
): Promise<RegisterResult | null> {
  let attemptCount = 0;

  const result = await retryWithBackoff(
    async () => {
      attemptCount++;
      console.log(chalk.gray(`注册尝试 ${attemptCount}/5...`));

      // 构造请求数据，新版带 deviceId
      const requestData: Record<string, string> = { tunnelUrl, pairCode };
      if (deviceId) {
        requestData.deviceId = deviceId;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);
      const response = await fetch(`${WORKER_URL}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestData),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const text = await response.text();
      if (!text || text.trim() === "") {
        throw new Error("空响应");
      }

      const parsed = JSON.parse(text) as { token?: string; isNewDevice?: boolean; error?: string };

      if (parsed.token) {
        console.log(chalk.green(`✓ 注册成功 (第 ${attemptCount} 次尝试)`));
        return {
          token: parsed.token,
          isNewDevice: parsed.isNewDevice ?? true
        };
      }

      throw new Error(parsed.error || "未知错误");
    },
    {
      maxRetries: 5,
      delayMs: 3000,
      onRetry: (attempt, error) => {
        if (error) {
          console.error(chalk.yellow(`注册尝试 ${attempt} 失败: ${error}`));
        }
        console.log(chalk.gray(`等待 3 秒后重试...`));
      }
    }
  );

  if (!result) {
    // 所有重试都失败
    console.error(chalk.red("\n========================================"));
    console.error(chalk.red("错误: Worker 注册失败（已重试 5 次）"));
    console.error(chalk.red("========================================"));
    console.error(chalk.yellow("\n可能的原因:"));
    console.error("  1. 网络连接问题");
    console.error("  2. 代理服务器不稳定");
    console.error("  3. Worker 服务暂时不可用");
    console.error(chalk.yellow("\n解决方法:"));
    console.error("  1. 检查网络连接");
    console.error("  2. 稍后重启后端重试");
    console.error("  3. 可以直接使用 tunnel URL 测试（不经过 Worker）\n");
  }

  return result;
}

// 验证 Worker 是否真的更新了 tunnelUrl
// 调用 /info/{token} 接口，对比返回的 tunnelUrl 和本地的是否一致
async function verifyWorkerMapping(token: string, expectedTunnelUrl: string): Promise<boolean> {
  const result = await retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(`${WORKER_URL}/info/${token}`, { signal: controller.signal });
      clearTimeout(timeoutId);

      const text = await response.text();
      if (!text || text.trim() === "") {
        return null; // 空响应，重试
      }

      const parsed = JSON.parse(text) as { tunnelUrl?: string; error?: string };

      if (parsed.error) {
        console.log(chalk.gray(`  Worker 返回错误: ${parsed.error}`));
        return null;
      }

      if (parsed.tunnelUrl === expectedTunnelUrl) {
        return true; // 验证成功
      }

      // tunnelUrl 不匹配，可能是 KV 同步延迟
      console.log(chalk.yellow(`  Worker 返回的 tunnelUrl 不匹配:`));
      console.log(chalk.gray(`    期望: ${expectedTunnelUrl}`));
      console.log(chalk.gray(`    实际: ${parsed.tunnelUrl}`));
      return null; // 继续重试
    },
    {
      maxRetries: 3,
      delayMs: 2000,
      onRetry: (attempt, error) => {
        if (error) {
          console.log(chalk.gray(`  验证尝试 ${attempt} 失败: ${error}`));
        }
      }
    }
  );

  return result === true;
}

function showHelp() {
  console.log(`
${chalk.cyan("CC 小程序本地后端")}

${chalk.yellow("用法:")}
  mycc start [选项]     前台启动后端服务
  mycc start -d         后台启动（守护模式，日志写 mycc.log）
  mycc stop             停止所有后端进程（优雅退出，超时强杀）
  mycc restart          停止后以守护模式重新启动
  mycc status           探测 /health 查看运行状态
  mycc ps               列出注册的后端进程
  mycc kill <id|pid|序号>  干掉指定进程（先用 ps 查看）
  mycc service <子命令>  OS 托管服务（开机自启+崩溃自动重启，mycc service help 看详情）
  mycc doctor           新机器自查（Node/Claude Code/trash/凭证/端口一键体检）
  mycc help             显示帮助

${chalk.yellow("选项:")}
  -d, --daemon          后台启动（脱离当前进程树）
  --cwd <目录>          指定工作目录 (默认: 当前目录)
  --reset               重置设备配置，重新生成连接码和配对码

${chalk.yellow("环境变量:")}
  PORT                  HTTP 服务端口 (默认: 18080)
  MYCC_DATA_DIR         运行时状态目录（默认跟随代码位置）

${chalk.yellow("示例:")}
  mycc start -d
  mycc start --cwd /path/to/project
  mycc start --reset    # 重置配置，需要重新配对
`);
}

// === 全局异常兜底：防止 SDK 子进程崩溃杀死整个 Node 进程 ===
process.on("unhandledRejection", (reason) => {
  console.error("[全局] unhandledRejection，清理所有 session:", reason);
  try {
    adapter.closeAllSessions();
  } catch {
    // 静默处理
  }
  // 不 process.exit —— 让 HTTP 服务继续运行
});

process.on("uncaughtException", (err) => {
  console.error("[全局] uncaughtException，清理所有 session:", err);
  try {
    adapter.closeAllSessions();
  } catch {
    // 静默处理
  }
  // 不 process.exit —— 让 HTTP 服务继续运行
});

main().catch((error) => {
  console.error(chalk.red("启动失败:"), error);
  process.exit(1);
});
