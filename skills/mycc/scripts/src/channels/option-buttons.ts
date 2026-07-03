/**
 * 飞书卡片交互按钮——agent 主动出选择题（Phase 5 步骤 2）
 *
 * 两部分：
 * 1. 选项检测：Claude 回复文本尾部的编号选项块（保守启发式，宁可漏检不可误报），
 *    以及 AskUserQuestion tool_use 事件的 input.questions 结构化解析。
 * 2. 回调签名：参考 zarazhangrui/lark-coding-agent-bridge 的 callback-auth.ts，
 *    HMAC-SHA256 token 绑定 scope / 提问对象 / 会话 / 选项文本 / 卡片组，
 *    防旧卡片、防他人误触、防重放（同一张卡答过一次即失效）。
 *
 * 命令按钮（card-actions.ts 的 {cmd,arg} 白名单）和选项按钮（{cb: token}）
 * 是两条独立的分发路径：选项文本最终会被当成用户消息转回当前会话，
 * 所以必须靠签名保证它只能是"这个 scope 这轮回复里 Claude 自己列出的选项"。
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ==================== 选项检测 ====================

export interface DetectedOptions {
  question: string;
  options: string[];
}

/** 选项行：`1. xxx` / `2) xxx` / `3、xxx`，允许 `- 1. xxx` 这类列表前缀 */
const NUMBERED_LINE = /^\s*(?:[-•*]\s+)?(\d{1,2})[.)、．]\s*(.+?)\s*$/;
/** 字母选项行：`A. xxx` / `B) xxx` */
const LETTERED_LINE = /^\s*(?:[-•*]\s+)?([A-Fa-f])[.)、．]\s*(.+?)\s*$/;
/**
 * 问句特征：问号结尾，或包含明确的"让你选"措辞。
 * 故意不收"是否/选择/你想"这类在陈述句里也常见的词——
 * "检查是否安装依赖，然后：1. …"是步骤清单，不是选择题。
 */
const QUESTION_HINT = /[?？]\s*$|请选|选一个|选哪|哪个|哪种|哪一个|要不要|还是/;

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
/** 单个选项去掉 markdown 修饰后的最大长度：超过说明更像段落列表而不是选择题 */
const MAX_OPTION_LEN = 60;

/** 去掉行内 markdown 修饰（加粗/斜体/行内代码），选项文本转回会话时不要带格式符号 */
function stripInlineMd(s: string): string {
  return s.replace(/[*_`]/g, "").trim();
}

/**
 * 检测回复文本"尾部"的选项块。规则（全部满足才算）：
 * - 结尾（忽略尾部空行）是一段连续的编号/字母选项行，序号从 1（或 A）起且递增
 * - 选项 2~6 个，每个去掉 markdown 后 1~60 字
 * - 选项块上方最近 3 个非空行里有一行像问句（问号结尾或含"选择/哪个/是否"等措辞）
 *
 * 故意保守：正文中间的编号列表、步骤清单（无问句引导）、超长条目都不触发。
 */
export function detectTrailingOptions(text: string): DetectedOptions | null {
  if (!text) return null;
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  // 跳过尾部空行
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  if (end < 0) return null;

  // 从尾部向上收集连续选项行（编号或字母，两种不混用）
  const collect = (re: RegExp): { items: string[]; startLine: number } | null => {
    const items: string[] = [];
    let i = end;
    for (; i >= 0; i--) {
      const m = lines[i].match(re);
      if (!m) break;
      items.unshift(stripInlineMd(m[2]));
    }
    if (items.length === 0) return null;
    return { items, startLine: i };
  };

  const numbered = collect(NUMBERED_LINE);
  const lettered = numbered ? null : collect(LETTERED_LINE);
  const block = numbered ?? lettered;
  if (!block) return null;

  const { items, startLine } = block;
  if (items.length < MIN_OPTIONS || items.length > MAX_OPTIONS) return null;
  if (items.some((s) => !s || s.length > MAX_OPTION_LEN)) return null;

  // 序号必须从头连续递增（1,2,3… 或 A,B,C…），排除"正文里随机一段 3. 4. 5."
  const seqOk = (lines
    .slice(startLine + 1, end + 1)
    .filter((l) => l.trim())
  ).every((l, idx) => {
    const m = l.match(numbered ? NUMBERED_LINE : LETTERED_LINE);
    if (!m) return false;
    const seq = numbered ? parseInt(m[1], 10) - 1 : m[1].toUpperCase().charCodeAt(0) - 65;
    return seq === idx;
  });
  if (!seqOk) return null;

  // 选项块上方最近 3 个非空行里找问句
  let question: string | null = null;
  let seen = 0;
  for (let i = startLine; i >= 0 && seen < 3; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    seen++;
    if (QUESTION_HINT.test(line)) {
      question = stripInlineMd(line.replace(/^#+\s*/, ""));
      break;
    }
  }
  if (!question) return null;

  return { question, options: items };
}

/**
 * 解析 AskUserQuestion tool_use 的 input（{questions:[{question, options:[{label}]}]}）。
 * headless SDK 下这个工具大概率不出现（出现时工具调用本身也会失败、Claude 会改用文本追问），
 * 这里只是顺手兜住：真出现时直接用结构化选项，比文本启发式可靠。
 * 只取第一个 question（卡片一次只出一道题）。
 */
export function extractAskUserQuestionOptions(input: unknown): DetectedOptions | null {
  if (!input || typeof input !== "object") return null;
  const questions = (input as any).questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const q = questions[0];
  if (!q || typeof q.question !== "string" || !Array.isArray(q.options)) return null;
  const options = q.options
    .map((o: any) => (typeof o === "string" ? o : typeof o?.label === "string" ? o.label : null))
    .filter((s: string | null): s is string => !!s && s.length <= MAX_OPTION_LEN)
    .slice(0, MAX_OPTIONS);
  if (options.length < MIN_OPTIONS) return null;
  return { question: q.question, options };
}

// ==================== 回调签名 ====================

const TOKEN_PREFIX = "mycc_cb.v1";

/** 选项按钮有效期：过期后点按钮只会得到"已过期"提示 */
export const OPTION_CALLBACK_TTL_MS = 2 * 60 * 60 * 1000;

export interface OptionTokenInput {
  /** 卡片所属 scope（群/话题/私聊） */
  scope: string;
  /** 提问对象（触发这轮回复的用户 open_id），空串 = 不限制点击者 */
  senderId: string;
  /** 出题时绑定的会话，点击时会话已切换则拒绝 */
  sessionId: string;
  /** 选项文本（点击后原样转回会话） */
  option: string;
  /** 卡片组 id：同一张卡的所有按钮共享，答过一次整卡失效 */
  groupId: string;
}

interface OptionTokenPayload {
  s: string; // scope
  u: string; // senderId
  d: string; // sessionId
  o: string; // option
  g: string; // groupId
  exp: number;
}

export type OptionVerifyFailReason =
  | "malformed"
  | "bad-signature"
  | "expired"
  | "scope-mismatch"
  | "operator-mismatch"
  | "session-changed"
  | "already-answered";

export type OptionVerifyResult =
  | { ok: true; option: string }
  | { ok: false; reason: OptionVerifyFailReason };

export interface OptionVerifyExpected {
  scope: string;
  /** 点击者 open_id（卡片事件的 operator） */
  operatorId: string;
  /** 该 scope 当前绑定的会话 */
  sessionId: string;
}

/**
 * 选项按钮回调签名器。
 *
 * secret 默认每次进程启动随机生成、只存内存：服务重启后旧卡片的按钮
 * 全部自然失效（bad-signature → 提示重新提问），换来零持久化状态——
 * 选项卡片本来就是回合内的临时交互，不值得为它维护密钥/nonce 落盘。
 * 已答卡片组同样只记内存（groupId → exp），verify 时惰性清理过期项。
 */
export class OptionCallbackAuth {
  private readonly secret: Buffer;
  private readonly now: () => number;
  private readonly answeredGroups = new Map<string, number>();

  constructor(opts?: { secret?: Buffer; now?: () => number }) {
    this.secret = opts?.secret ?? randomBytes(32);
    this.now = opts?.now ?? Date.now;
  }

  sign(input: OptionTokenInput, ttlMs: number = OPTION_CALLBACK_TTL_MS): string {
    const payload: OptionTokenPayload = {
      s: input.scope,
      u: input.senderId,
      d: input.sessionId,
      o: input.option,
      g: input.groupId,
      exp: this.now() + ttlMs,
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return `${TOKEN_PREFIX}.${encoded}.${this.hmac(encoded)}`;
  }

  verify(token: string, expected: OptionVerifyExpected): OptionVerifyResult {
    const parts = token.split(".");
    if (parts.length !== 4 || `${parts[0]}.${parts[1]}` !== TOKEN_PREFIX) {
      return { ok: false, reason: "malformed" };
    }
    const [, , encoded, signature] = parts;
    if (!encoded || !signature) return { ok: false, reason: "malformed" };
    if (!safeEqual(signature, this.hmac(encoded))) {
      return { ok: false, reason: "bad-signature" };
    }
    const payload = decodePayload(encoded);
    if (!payload) return { ok: false, reason: "malformed" };

    if (payload.exp <= this.now()) return { ok: false, reason: "expired" };
    if (payload.s !== expected.scope) return { ok: false, reason: "scope-mismatch" };
    if (payload.u && payload.u !== expected.operatorId) {
      return { ok: false, reason: "operator-mismatch" };
    }
    if (payload.d && payload.d !== expected.sessionId) {
      return { ok: false, reason: "session-changed" };
    }

    this.purgeAnswered();
    if (this.answeredGroups.has(payload.g)) {
      return { ok: false, reason: "already-answered" };
    }
    this.answeredGroups.set(payload.g, payload.exp);
    return { ok: true, option: payload.o };
  }

  private hmac(encoded: string): string {
    return createHmac("sha256", this.secret).update(encoded).digest("base64url");
  }

  private purgeAnswered(): void {
    const now = this.now();
    for (const [g, exp] of this.answeredGroups) {
      if (exp <= now) this.answeredGroups.delete(g);
    }
  }
}

/** 进程级单例：feishu-commands 出题和验票用同一份 secret */
export const optionCallbackAuth = new OptionCallbackAuth();

export function newOptionGroupId(): string {
  return randomBytes(8).toString("base64url");
}

/** 按钮 value 是选项回调（{cb: token}）时返回 token，否则 null */
export function extractOptionCallbackToken(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const cb = (value as Record<string, unknown>).cb;
  return typeof cb === "string" && cb ? cb : null;
}

/** verify 失败原因 → 给用户的提示文案 */
export const OPTION_FAIL_MESSAGES: Record<OptionVerifyFailReason, string> = {
  "malformed": "这个按钮已失效，请直接打字回复。",
  "bad-signature": "服务重启过，旧卡片的按钮已失效，请直接打字回复。",
  "expired": "这张卡片已过期，请直接打字回复。",
  "scope-mismatch": "这个按钮不属于当前会话，请直接打字回复。",
  "operator-mismatch": "这道题是问提问者本人的，其他人点无效。",
  "session-changed": "出题后会话已切换，按钮已失效，请直接打字回复。",
  "already-answered": "这道题已经答过了，如需修改请直接打字回复。",
};

function decodePayload(encoded: string): OptionTokenPayload | null {
  try {
    const raw = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (
      typeof raw?.s !== "string" ||
      typeof raw?.u !== "string" ||
      typeof raw?.d !== "string" ||
      typeof raw?.o !== "string" ||
      typeof raw?.g !== "string" ||
      typeof raw?.exp !== "number"
    ) {
      return null;
    }
    return raw as OptionTokenPayload;
  } catch {
    return null;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
