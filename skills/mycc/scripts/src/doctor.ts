/**
 * doctor 自查子命令：新机器部署前一键体检。
 *
 * 查什么：Node 版本 / Claude Code 可执行 / trash 命令 / 飞书凭证 / patch-sdk 提示 / 端口占用。
 * 设计原则：只报「有无」，绝不回显凭证值；除 Node 版本不达标外全部是 warn 不挡路。
 */

import { execFileSync } from "node:child_process";
import * as net from "node:net";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./env-loader.js";

export interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

/** Node 版本：>=18 pass，<18 fail（engines 硬要求），解析失败 warn */
export function checkNodeVersion(version = process.version): CheckResult {
  const m = /^v(\d+)\./.exec(version);
  const major = m ? Number(m[1]) : NaN;
  if (Number.isNaN(major)) {
    return { name: "Node.js", status: "warn", detail: `无法解析版本号 ${version}` };
  }
  if (major < 18) {
    return { name: "Node.js", status: "fail", detail: `${version} 低于要求（>=18，engines 硬要求）` };
  }
  return { name: "Node.js", status: "pass", detail: version };
}

/** 在 PATH 上探测命令（跨平台：Windows 走 where，其余走 which）。探测不到返回 null。 */
export function findOnPath(cmd: string, platform = process.platform): string | null {
  try {
    const out = execFileSync(platform === "win32" ? "where" : "which", [cmd], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = out.split(/\r?\n/).find((l) => l.trim() !== "");
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

/** 凭证检查：只回显「已配置/缺失」，绝不回显值。
 *  后缀与 http-server 装配一致：默认通道无后缀，B 起为 _B…_F（FEISHU_B_APP_ID）。 */
export function checkFeishuCredentials(env: Record<string, string | undefined>): CheckResult[] {
  const channels: Array<{ suffix: string; label: string }> = [
    { suffix: "", label: "默认" },
    { suffix: "_B", label: "B" },
    { suffix: "_C", label: "C" },
    { suffix: "_D", label: "D" },
    { suffix: "_E", label: "E" },
    { suffix: "_F", label: "F" },
  ];
  const results: CheckResult[] = [];
  let anyConfigured = false;
  for (const { suffix, label } of channels) {
    const key = `FEISHU${suffix}_APP_ID`;
    const secretKey = `FEISHU${suffix}_APP_SECRET`;
    const id = env[key];
    const secret = env[secretKey];
    if (id && secret) {
      anyConfigured = true;
      results.push({ name: `飞书凭证 ${label}`, status: "pass", detail: "已配置（值不回显）" });
    } else if (id || secret) {
      results.push({
        name: `飞书凭证 ${label}`,
        status: "warn",
        detail: `${key} / ${secretKey} 只配了一个，两个都填才算配好`,
      });
    }
  }
  if (!anyConfigured) {
    results.push({
      name: "飞书凭证",
      status: "warn",
      detail: "未发现任何通道凭证——复制 .env.example 为 .env 并填入 App ID/Secret",
    });
  }
  return results;
}

/** patch-sdk 提示：脚本存在即提醒首启前跑一次（幂等）。
 *  scriptsDir 缺省按本模块位置推导（src/ 的上级），不受调用方 cwd 影响。 */
export function checkPatchSdk(scriptsDir?: string): CheckResult {
  const base = scriptsDir ?? join(dirname(fileURLToPath(import.meta.url)), "..");
  const p = join(base, "scripts", "patch-sdk.mjs");
  if (existsSync(p)) {
    return { name: "patch-sdk", status: "pass", detail: "scripts/patch-sdk.mjs 就绪——首次启动前建议跑一次（幂等，修 Agent Teams 死锁）" };
  }
  return { name: "patch-sdk", status: "warn", detail: "未找到 scripts/patch-sdk.mjs（不影响基础功能）" };
}

/** 端口探测：能监听=空闲，失败=占用。立即释放。 */
export function probePort(port: number, host = "127.0.0.1"): Promise<CheckResult> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve({ name: `端口 ${port}`, status: "warn", detail: "已被占用（可能后端已在跑，先 mycc status 看看）" }));
    srv.once("listening", () => srv.close(() => resolve({ name: `端口 ${port}`, status: "pass", detail: "空闲" })));
    srv.listen(port, host);
  });
}

/** 全套体检；opts 仅注入测试用，默认现场探测。 */
export async function runDoctor(opts?: {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  scriptsDir?: string;
  port?: number;
}): Promise<CheckResult[]> {
  const env = opts?.env ?? process.env;
  const platform = opts?.platform ?? process.platform;

  // 把 .env 装载进 env 再查凭证（缺 .env 文件静默跳过，凭证检查会给出指引）
  if (!opts?.env) {
    try {
      loadEnvFile(process.cwd(), join(dirname(fileURLToPath(import.meta.url)), ".."));
    } catch {
      /* 没有 .env 属预期，凭证检查会提示 */
    }
  }

  const results: CheckResult[] = [checkNodeVersion()];

  const claude = findOnPath("claude", platform);
  results.push(
    claude
      ? { name: "Claude Code", status: "pass", detail: claude }
      : { name: "Claude Code", status: "warn", detail: "PATH 上找不到 claude——确认已装官方原版 CLI（第三方 fork 不保证兼容）" },
  );

  if (platform === "win32") {
    results.push({ name: "trash 回收站", status: "warn", detail: "Windows 未内置 trash，删除类操作将走审批卡（其余功能不受影响）" });
  } else {
    const trash = findOnPath("trash", platform);
    results.push(
      trash
        ? { name: "trash 回收站", status: "pass", detail: trash }
        : {
            name: "trash 回收站",
            status: "warn",
            detail: platform === "darwin" ? "未安装（brew install trash）——删除免审不可用，删除将走审批卡" : "未安装（Linux: trash-cli）——删除免审不可用，删除将走审批卡",
          },
    );
  }

  results.push(...checkFeishuCredentials(env));
  results.push(checkPatchSdk(opts?.scriptsDir));
  results.push(await probePort(Number(env.PORT) || opts?.port || 18080));

  return results;
}

/** 终端渲染；fail 计数非零时退出码置 1。 */
export function renderDoctor(results: CheckResult[]): { text: string; failCount: number } {
  const icon = { pass: "✅", warn: "⚠️ ", fail: "❌" } as const;
  const lines = results.map((r) => `${icon[r.status]} ${r.name} — ${r.detail}`);
  const failCount = results.filter((r) => r.status === "fail").length;
  const warnCount = results.filter((r) => r.status === "warn").length;
  const summary = `\n体检完成：${results.length - failCount - warnCount} pass / ${warnCount} warn / ${failCount} fail`;
  if (failCount > 0) process.exitCode = 1;
  return { text: `${chalkCyan("mycc doctor — 新机器自查")}\n${lines.join("\n")}${chalkYellow(summary)}`, failCount };
}

// 轻量取色：避免为了两行颜色引入 chalk 依赖差异，直接 ANSI。
function chalkCyan(s: string): string {
  return `\x1b[36m${s}\x1b[0m`;
}
function chalkYellow(s: string): string {
  return `\x1b[33m${s}\x1b[0m`;
}
