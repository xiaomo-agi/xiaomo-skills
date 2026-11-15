/**
 * 飞书流式卡片 + 工具函数
 *
 * 集成自 clawdbot-feishu（MIT License）
 * 来源: https://github.com/m1heng/clawdbot-feishu
 *
 * 主要功能：
 * - FeishuStreamingSession: 流式卡片，AI 回复实时更新到单个卡片
 * - buildMarkdownCard: 构建 schema 2.0 markdown 卡片（完整 markdown 支持）
 * - normalizeFeishuMarkdownLinks: 规范化 URL，避免飞书截断
 */

import {
  MATCHA_CONFIG_STYLE,
  matchaHeaderBar,
  matchaKpiRow,
  formatDurationShort,
  textToElements,
  sanitizeFeishuCardImages,
} from "./card-style.js";

// ==================== normalizeFeishuMarkdownLinks ====================

const FENCED_CODE_BLOCK_RE = /(```[\s\S]*?```)/g;
const INLINE_CODE_RE = /(`[^`\n]*`)/g;
const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
const TRAILING_PUNCT_RE = /[.,;!?\u3002\uff0c\uff1b\uff01\uff1f\u3001]/u;
const AUTO_LINK_RE = /<\s*(https?:\/\/[^>\s]+)\s*>/g;

function normalizeUrlForFeishu(url: string): string {
  return url.replace(/_/g, "%5F").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function buildMarkdownLink(url: string): string {
  const label = url.replace(/[\[\]]/g, "\\$&");
  return `[${label}](${url})`;
}

function countParens(text: string): { open: number; close: number } {
  let open = 0,
    close = 0;
  for (const c of text) {
    if (c === "(") open++;
    else if (c === ")") close++;
  }
  return { open, close };
}

function splitTrailingPunctuation(rawUrl: string): { url: string; trailing: string } {
  let url = rawUrl,
    trailing = "";
  let { open, close } = countParens(rawUrl);
  while (url.length > 0) {
    const tail = url.slice(-1);
    const closeParenOverflow = tail === ")" && close > open;
    if (!TRAILING_PUNCT_RE.test(tail) && !closeParenOverflow) break;
    if (tail === ")") close--;
    trailing = tail + trailing;
    url = url.slice(0, -1);
  }
  return { url, trailing };
}

function wrapBareUrls(text: string): string {
  const converted = text.replace(AUTO_LINK_RE, (_full, rawUrl: string) => {
    const { url, trailing } = splitTrailingPunctuation(rawUrl);
    if (!url) return _full;
    return `${buildMarkdownLink(normalizeUrlForFeishu(url))}${trailing}`;
  });
  return converted.replace(URL_RE, (raw, offset, input) => {
    const { url, trailing } = splitTrailingPunctuation(raw);
    if (!url) return raw;
    const isMarkdownDestination = offset >= 2 && input.slice(offset - 2, offset) === "](";
    const normalizedUrl = normalizeUrlForFeishu(url);
    if (isMarkdownDestination) return `${normalizedUrl}${trailing}`;
    return `${buildMarkdownLink(normalizedUrl)}${trailing}`;
  });
}

function normalizeNonCodeSegments(text: string): string {
  return text
    .split(INLINE_CODE_RE)
    .map((seg, idx) => (idx % 2 === 1 && seg.startsWith("`") ? seg : wrapBareUrls(seg)))
    .join("");
}

/**
 * 规范化飞书 markdown 中的 URL
 * 将裸 URL 和自动链接转换为标准 markdown 链接格式，避免飞书截断
 */
export function normalizeFeishuMarkdownLinks(text: string): string {
  if (!text || (!text.includes("http://") && !text.includes("https://"))) return text;
  return text
    .split(FENCED_CODE_BLOCK_RE)
    .map((block, idx) =>
      idx % 2 === 1 && block.startsWith("```") ? block : normalizeNonCodeSegments(block)
    )
    .join("");
}

// ==================== 卡片超长截断 ====================

// 飞书卡片整体上限约 30KB（按 JSON 序列化后算），预留结构字段开销取 28KB
export const FEISHU_CARD_MAX_BYTES = 28 * 1024;

const CARD_TRUNCATE_NOTICE =
  "\n\n---\n⚠️ **内容过长，卡片已截断**。可以让我把完整内容写入文件，或分段重发。";

// 卡片内容最终以 JSON 字符串发送，字节数要按转义后算（换行/引号都会翻倍）
function jsonByteLength(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8");
}

/**
 * 把文本截断到飞书卡片能承载的大小。
 * 超限时优先在换行处断开，不拆散 emoji 代理对，补全未闭合的代码块围栏，
 * 并在结尾追加截断提示——替代之前超限静默 400 吞掉整条回复的行为。
 */
export function truncateForFeishuCard(
  text: string,
  maxBytes = FEISHU_CARD_MAX_BYTES
): { text: string; truncated: boolean } {
  if (jsonByteLength(text) <= maxBytes) return { text, truncated: false };

  const budget = maxBytes - jsonByteLength(CARD_TRUNCATE_NOTICE) - jsonByteLength("\n```");
  // 二分找满足字节预算的最大字符前缀
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (jsonByteLength(text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  let cut = lo;
  const tail = text.charCodeAt(cut - 1);
  if (tail >= 0xd800 && tail <= 0xdbff) cut -= 1;
  const nl = text.lastIndexOf("\n", cut);
  if (nl > 0 && cut - nl <= 300) cut = nl;

  let head = text.slice(0, cut);
  const fences = head.match(/```/g)?.length ?? 0;
  if (fences % 2 === 1) head += "\n```";
  return { text: head + CARD_TRUNCATE_NOTICE, truncated: true };
}

// ==================== 卡片翻页切分 ====================

// 翻页标记：上一张卡片尾部 / 续卡开头（都占卡片字节预算）
const CARD_CONT_TAIL = "\n\n---\n⬇️ **内容较长，接下一张卡片**";
const CARD_CONT_HEAD = "⬆️ *接上一张卡片*\n\n";

/**
 * 为卡片翻页切分文本：找出当前卡片能装下的最大前缀。
 * 与 truncateForFeishuCard 同源的切分规则（换行优先、不拆代理对、补代码围栏），
 * 区别是剩余部分不丢弃——由调用方放进下一张卡片继续显示。
 * headSuffix/restPrefix 用于跨卡片保持代码块围栏闭合。
 */
export function splitForCardRollover(
  text: string,
  maxBytes = FEISHU_CARD_MAX_BYTES,
  prefixBytes = 0
): { cut: number; headSuffix: string; restPrefix: string } {
  const budget =
    maxBytes - prefixBytes - jsonByteLength(CARD_CONT_TAIL) - jsonByteLength("\n```");
  if (budget <= 0) return { cut: 0, headSuffix: "", restPrefix: "" };

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (jsonByteLength(text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  let cut = lo;
  const tail = text.charCodeAt(cut - 1);
  if (tail >= 0xd800 && tail <= 0xdbff) cut -= 1;
  const nl = text.lastIndexOf("\n", cut);
  if (nl > 0 && cut - nl <= 300) cut = nl;
  if (cut <= 0) return { cut: 0, headSuffix: "", restPrefix: "" };

  const fences = text.slice(0, cut).match(/```/g)?.length ?? 0;
  if (fences % 2 === 1) {
    return { cut, headSuffix: "\n```", restPrefix: "```\n" };
  }
  return { cut, headSuffix: "", restPrefix: "" };
}

// ==================== buildMarkdownCard ====================

/** 静态卡片内容块（方案A）：正文段或工具调用（后者渲染为 collapsible_panel 折叠面板） */
export type MarkdownCardBlock =
  | { type: "text"; content: string }
  | { type: "tool"; name: string; line: string; detail: string };

/** blocks 拍平成纯文本版式（超限回退、非飞书通道兜底共用；与 assistant 文本拼接同格式） */
export function markdownCardBlocksToText(blocks: MarkdownCardBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text") parts.push(b.content);
    else parts.push(`\n${b.line}\n`);
  }
  return parts.join("\n");
}

/**
 * 单个工具调用的折叠面板（方案A 静态卡 / 方案B 收尾重渲染共用）。
 * 收起态只显示「🔧 工具名（点开看详情）」短条，命令长摘要放面板内容里。
 * 2026-10-30 对真卡实测出的合法结构：样式属性(background_style/border_radius/padding/
 * vertical_spacing/expanded_state)一律不认（300315 unknown property），header.title 只认
 * plain_text。改面板结构前必须先用真卡试，别照飞书文档抄。
 */
export function buildToolPanel(
  t: { name: string; line: string; detail: string },
  index = 1
): Record<string, unknown> {
  const piece = `${t.line}\n${t.detail}`.slice(0, 1500);
  const toolName = t.name || `工具 ${index}`;
  return {
    tag: "collapsible_panel",
    header: {
      title: {
        tag: "plain_text",
        content: `🔧 ${toolName}（点开看详情）`.slice(0, 60),
      },
      vertical_align: "middle",
      width: "default",
    },
    elements: [{ tag: "markdown", content: piece }],
  };
}

// 整卡 200 元素上限留余量（与流式收尾重渲染 finalizeRerender 同口径）
const CARD_ELEMENTS_LIMIT = 195;

/**
 * 构建飞书 schema 2.0 markdown 卡片
 * 完整支持代码块、表格、链接、加粗等 markdown 语法
 * 超长内容在这里统一截断（sendMarkdownCardMessage / sendMarkdownReply 都走这个入口）
 *
 * 入参两种（方案A）：纯文本（旧版式不变）；blocks——正文段→markdown 容器、
 * 工具调用→collapsible_panel 折叠面板。blocks 版式超 28KB（JSON 转义后）或
 * 元素数超限时整体回退纯文本版式（拍平+统一截断，内容不丢）。
 */
export function buildMarkdownCard(input: string | MarkdownCardBlock[]): Record<string, unknown> {
  if (typeof input !== "string") {
    const elements: Array<Record<string, unknown>> = [matchaHeaderBar()];
    for (const b of input) {
      if (b.type === "tool") {
        elements.push({ ...buildToolPanel(b), margin: "0px 12px 10px 12px" });
      } else {
        elements.push(...textToElements(b.content));
      }
    }
    const card = {
      schema: "2.0",
      config: { wide_screen_mode: true, ...MATCHA_CONFIG_STYLE },
      body: { padding: "0px 0px 0px 0px", elements },
    };
    if (
      elements.length <= CARD_ELEMENTS_LIMIT &&
      jsonByteLength(JSON.stringify(card)) <= FEISHU_CARD_MAX_BYTES
    ) {
      return card;
    }
    // 超限回退：拍平成现有纯文本版式，走下面的统一截断
  }
  const text = typeof input === "string" ? input : markdownCardBlocksToText(input);
  return {
    schema: "2.0",
    config: { wide_screen_mode: true, ...MATCHA_CONFIG_STYLE },
    body: {
      padding: "0px 0px 0px 0px",
      elements: [matchaHeaderBar(), ...textToElements(truncateForFeishuCard(text).text)],
    },
  };
}

// ==================== FeishuStreamingSession ====================

const API_BASE = "https://open.feishu.cn/open-apis";

type Credentials = { appId: string; appSecret: string };
type CardState = { cardId: string; messageId: string; sequence: number };
type CardTarget = {
  receiveId: string;
  receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id";
  replyToMessageId?: string;
};

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function getFeishuToken(creds: Credentials): Promise<string> {
  const key = creds.appId;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;

  const res = await fetch(`${API_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
  });
  const data = (await res.json()) as {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  };
  if (data.code !== 0 || !data.tenant_access_token)
    throw new Error(`Token error: ${data.msg}`);
  tokenCache.set(key, {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
  });
  return data.tenant_access_token;
}

function truncateSummary(text: string, max = 50): string {
  const clean = text.replace(/\n/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 3) + "...";
}

/**
 * 飞书流式卡片会话
 *
 * 用法：
 * 1. session.start(receiveId, receiveIdType, replyToMessageId?)
 * 2. session.update(text)  // 传"到目前为止的全量文本快照"，后写覆盖
 * 3. session.close(finalText?)
 *
 * update/close 的入参一律是全量快照：按事件类型累积文本是调用方的职责
 * （feishu.ts / feishu-commands.ts 都各自维护累积文本）。这里不做
 * 增量/全量的启发式猜测——之前用 includes() 猜，新片段恰好是已有
 * 文本子串时（如 AI 说了重复的话）会被当成旧内容静默丢掉。
 *
 * 内容超过单卡片上限（约 30KB）时自动翻页：当前卡片收尾并标注
 * "接下一张卡片"，开一张新的流式卡片续写剩余内容——长回复不再被截断。
 *
 * 如果 CardKit API 不可用（权限不足等），会抛出错误，
 * 调用方应降级到普通消息发送。
 */
export class FeishuStreamingSession {
  private creds: Credentials;
  private state: CardState | null = null;
  private target: CardTarget | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private lastUpdateTime = 0;
  private pendingText: string | null = null;
  private readonly updateThrottleMs = 100;
  private log?: (msg: string) => void;
  // 最新的全量文本快照（跨卡片）；每张卡片只显示 baseOffset 之后的部分
  private fullText = "";
  // 已翻页进历史卡片的字符数
  private baseOffset = 0;
  // 当前卡片的显示前缀（"接上一张卡片" + 可能的代码围栏重开）
  private contPrefix = "";
  // 实际发到当前卡片上的文本（可能是截断版）
  private lastDisplayedText = "";
  private truncateLogged = false;
  // 本次回合的工具调用记录（方案B：close 收尾时追加折叠面板，流式期间不展示）
  private toolCalls: Array<{ name: string; line: string; detail: string }> = [];
  // 回合起点（抬头/收尾 KPI 的耗时来源）
  private readonly startedAt = Date.now();

  constructor(creds: Credentials, log?: (msg: string) => void) {
    this.creds = creds;
    this.log = log;
  }

  async start(
    receiveId: string,
    receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id",
    replyToMessageId?: string
  ): Promise<void> {
    if (this.state) return;
    this.target = { receiveId, receiveIdType, replyToMessageId };
    this.state = await this.createCard();
    this.log?.(
      `[Streaming] 已启动: cardId=${this.state.cardId}, messageId=${this.state.messageId}`
    );
  }

  /** 创建一张流式卡片并发送到目标（start 和翻页共用）
   *  headerRight：抬头右侧状态文案。当前页="⏳ 处理中"；翻页卡="接下一页"（该卡收尾不再重渲染，避免停在⏳）。 */
  private async createCard(
    headerRight: string = "⏳ 处理中"
  ): Promise<CardState> {
    if (!this.target) throw new Error("createCard called before start");
    const { receiveId, receiveIdType, replyToMessageId } = this.target;
    const token = await getFeishuToken(this.creds);

    // 创建流式卡片（streaming_mode: true）。抹茶抬头条在建卡时静态注入，
    // 流式更新只打 element_id:"content"，互不干扰（2026-10-31 CardKit 实测通过）
    const cardJson = {
      schema: "2.0",
      config: {
        streaming_mode: true,
        summary: { content: "[生成中...]" },
        streaming_config: {
          print_frequency_ms: { default: 50 },
          print_step: { default: 2 },
        },
        ...MATCHA_CONFIG_STYLE,
      },
      body: {
        padding: "0px 0px 0px 0px",
        elements: [
          matchaHeaderBar(undefined, headerRight),
          {
            tag: "markdown",
            content: "思考中...",
            element_id: "content",
            margin: "0px 12px 12px 12px",
          },
        ],
      },
    };

    const createRes = await fetch(`${API_BASE}/cardkit/v1/cards`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ type: "card_json", data: JSON.stringify(cardJson) }),
    });
    const createData = (await createRes.json()) as {
      code: number;
      msg: string;
      data?: { card_id: string };
    };
    if (createData.code !== 0 || !createData.data?.card_id) {
      throw new Error(
        `CardKit 创建卡片失败 (code ${createData.code}): ${createData.msg}`
      );
    }
    const cardId = createData.data.card_id;

    // 发送卡片（或回复消息）
    const cardContent = JSON.stringify({ type: "card", data: { card_id: cardId } });
    const sendUrl = replyToMessageId
      ? `${API_BASE}/im/v1/messages/${replyToMessageId}/reply`
      : `${API_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`;
    const sendBody = replyToMessageId
      ? { msg_type: "interactive", content: cardContent }
      : { receive_id: receiveId, msg_type: "interactive", content: cardContent };

    const sendRes = await fetch(sendUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(sendBody),
    });
    const sendData = (await sendRes.json()) as {
      code: number;
      msg: string;
      data?: { message_id: string };
    };
    if (sendData.code !== 0 || !sendData.data?.message_id) {
      throw new Error(
        `发送卡片失败 (code ${sendData.code}): ${sendData.msg}`
      );
    }

    return { cardId, messageId: sendData.data.message_id, sequence: 1 };
  }

  async update(text: string): Promise<void> {
    if (!this.state || this.closed) return;
    if (!text || text === this.fullText) return;
    // 记为待发快照；节流窗口内的多次调用只保留最新一份
    this.pendingText = text;

    const now = Date.now();
    if (now - this.lastUpdateTime < this.updateThrottleMs) return;
    this.lastUpdateTime = now;

    this.queue = this.queue.then(async () => {
      if (!this.state || this.closed) return;
      const snapshot = this.pendingText;
      if (!snapshot || snapshot === this.fullText) return;
      this.pendingText = null;
      this.fullText = snapshot;
      await this.syncContent(snapshot, "更新");
    });
    await this.queue;
  }

  /**
   * 把全量快照同步到卡片：当前卡片装得下就 PUT，装不下就翻页——
   * 收尾当前卡片（尾部标注"接下一张卡片"）、开新卡片续写，循环直到装下。
   * 翻页失败（建新卡报错等）回退为旧的截断行为，正文至少不静默丢失。
   */
  private async syncContent(fullText: string, action: string): Promise<void> {
    // 单次同步最多翻这么多页，防御异常输入下的死循环（正常一次增量至多翻 1~2 页）
    for (let page = 0; page < 50; page++) {
      if (!this.state) return;
      const display = this.contPrefix + fullText.slice(this.baseOffset);
      if (jsonByteLength(display) <= FEISHU_CARD_MAX_BYTES) {
        if (display === this.lastDisplayedText) return;
        this.state.sequence += 1;
        // 只有真正更新成功才记录已显示内容，否则收尾更新会误判"已是最新"而跳过
        if (await this.putCardContent(display, action)) {
          this.lastDisplayedText = display;
        }
        return;
      }
      if (!(await this.rolloverCard(fullText))) {
        // 翻页失败：回退截断显示（与旧行为一致，尾部有提示不静默）
        const { text: displayText } = truncateForFeishuCard(display);
        if (!this.truncateLogged) {
          this.truncateLogged = true;
          this.log?.(
            `[Streaming] 翻页不可用，内容截断显示（全量 ${fullText.length} 字符）: cardId=${this.state.cardId}`
          );
        }
        if (displayText === this.lastDisplayedText) return;
        this.state.sequence += 1;
        if (await this.putCardContent(displayText, action)) {
          this.lastDisplayedText = displayText;
        }
        return;
      }
    }
    this.log?.(`[Streaming] ⚠ 翻页次数达到上限，停止本次同步`);
  }

  /** 卡片翻页：收尾当前卡片 → 开新卡片。成功返回 true 并把 state 指向新卡片 */
  private async rolloverCard(fullText: string): Promise<boolean> {
    if (!this.state || !this.target) return false;
    const remaining = fullText.slice(this.baseOffset);
    const { cut, headSuffix, restPrefix } = splitForCardRollover(
      remaining,
      FEISHU_CARD_MAX_BYTES,
      jsonByteLength(this.contPrefix)
    );
    if (cut <= 0) return false;

    // 先开好新卡片：建卡失败时当前卡片保持原样，走截断回退
    let nextState: CardState;
    try {
      nextState = await this.createCard("接下一页");
    } catch (e) {
      this.log?.(`[Streaming] 翻页建新卡失败: ${String(e)}`);
      return false;
    }

    // 收尾当前卡片：定格本页内容 + 翻页标记，关闭流式模式
    const headDisplay = this.contPrefix + remaining.slice(0, cut) + headSuffix + CARD_CONT_TAIL;
    this.state.sequence += 1;
    if (await this.putCardContent(headDisplay, "翻页收尾")) {
      this.lastDisplayedText = headDisplay;
    }
    await this.patchStreamingSettings(this.state, {
      streaming_mode: false,
      summary: { content: truncateSummary(remaining.slice(0, cut)) },
    });

    this.baseOffset += cut;
    this.contPrefix = CARD_CONT_HEAD + restPrefix;
    this.state = nextState;
    this.lastDisplayedText = "";
    this.truncateLogged = false;
    this.log?.(
      `[Streaming] 已翻页到新卡片: cardId=${nextState.cardId}（已定格 ${this.baseOffset} 字符）`
    );
    return true;
  }

  /** PUT 卡片内容并检查业务码——失败要出现在日志里，不再静默吞掉。
   *  飞书会在长回合无更新时自动关闭流式模式：300309（流被关）/200850（流式超时），
   *  两者都立即重开流式再重试一次——否则卡僵到下一次有内容才"被动续上"（2026-10-31 owner 遇到）。 */
  private async putCardContent(content: string, action: string): Promise<boolean> {
    if (!this.state) return false;
    // cardkit content PUT 不经过 textToElements，外链图在这里统一降级（200570 会报废整张进度卡）
    content = sanitizeFeishuCardImages(content);
    let data = await this.putContentOnce(content, action);
    if (data?.code === 300309 || data?.code === 200850) {
      this.log?.(`[Streaming] 流式模式已被服务端关闭(${data.code})，重开后重试: cardId=${this.state.cardId}`);
      if (await this.reopenStreaming()) {
        this.state.sequence += 1;
        data = await this.putContentOnce(content, action);
      }
    }
    if (!data) return false;
    if (data.code !== 0) {
      this.log?.(`[Streaming] ${action}失败 (code ${data.code}): ${data.msg}`);
      return false;
    }
    return true;
  }

  private async putContentOnce(
    content: string,
    action: string
  ): Promise<{ code?: number; msg?: string } | null> {
    if (!this.state) return null;
    try {
      const res = await fetch(
        `${API_BASE}/cardkit/v1/cards/${this.state.cardId}/elements/content/content`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${await getFeishuToken(this.creds)}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            content,
            sequence: this.state.sequence,
            uuid: `s_${this.state.cardId}_${this.state.sequence}`,
          }),
        }
      );
      return (await res.json().catch(() => null)) as { code?: number; msg?: string } | null;
    } catch (e) {
      this.log?.(`[Streaming] ${action}失败: ${String(e)}`);
      return null;
    }
  }

  private async reopenStreaming(): Promise<boolean> {
    if (!this.state) return false;
    this.state.sequence += 1;
    try {
      const res = await fetch(`${API_BASE}/cardkit/v1/cards/${this.state.cardId}/settings`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${await getFeishuToken(this.creds)}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          settings: JSON.stringify({ config: { streaming_mode: true } }),
          sequence: this.state.sequence,
          uuid: `r_${this.state.cardId}_${this.state.sequence}`,
        }),
      });
      const data = (await res.json().catch(() => null)) as { code?: number; msg?: string } | null;
      if (!data || data.code !== 0) {
        this.log?.(`[Streaming] 重开流式失败 (code ${data?.code}): ${data?.msg}`);
        return false;
      }
      return true;
    } catch (e) {
      this.log?.(`[Streaming] 重开流式失败: ${String(e)}`);
      return false;
    }
  }

  /** PATCH 卡片 settings（翻页收尾和 close 共用），失败只记日志 */
  private async patchStreamingSettings(
    state: CardState,
    config: Record<string, unknown>
  ): Promise<void> {
    state.sequence += 1;
    try {
      const res = await fetch(`${API_BASE}/cardkit/v1/cards/${state.cardId}/settings`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${await getFeishuToken(this.creds)}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          settings: JSON.stringify({ config }),
          sequence: state.sequence,
          uuid: `c_${state.cardId}_${state.sequence}`,
        }),
      });
      const data = (await res.json().catch(() => null)) as { code?: number; msg?: string } | null;
      if (data && data.code !== 0) {
        this.log?.(`[Streaming] settings 更新失败 (code ${data.code}): ${data.msg}`);
      }
    } catch (e) {
      this.log?.(`[Streaming] settings 更新失败: ${String(e)}`);
    }
  }

  /**
   * 记录一次工具调用（方案B，2026-10-30）：流式期间正文保持现状（🔧 单行文本），
   * close() 收尾时把记录渲染成 collapsible_panel 折叠面板追加到卡片底部。
   */
  addToolCall(name: string, line: string, detail: string): void {
    if (this.toolCalls.length >= 40) return; // 200 元素/30KB 上限，兜个底
    this.toolCalls.push({ name, line, detail });
  }

  /** 组装工具折叠面板（默认收起，点开看每次调用的参数）
   *  2026-10-30 对真卡实测出的合法结构：样式属性(background_style/border_radius/padding/
   *  vertical_spacing)一律不认（300315 unknown property），header.title 只认 plain_text。
   *  改面板样式前必须先用真卡试，别照飞书文档抄。 */
  private buildToolsPanel(): Record<string, unknown> | null {
    if (!this.toolCalls.length) return null;
    const sections: string[] = [];
    let used = 0;
    for (const t of this.toolCalls) {
      const piece = `${t.line}\n${t.detail}`.slice(0, 1200);
      if (used + piece.length > 18000) {
        sections.push("…（工具较多，详情已截断）");
        break;
      }
      sections.push(piece);
      used += piece.length;
    }
    return {
      tag: "collapsible_panel",
      header: {
        title: {
          tag: "plain_text",
          content: `🔧 工具调用 × ${this.toolCalls.length}（点开看详情）`,
        },
        vertical_align: "middle",
        width: "default",
      },
      elements: [{ tag: "markdown", content: sections.join("\n\n") }],
    };
  }

  /** 收尾整卡重渲染（№9 形态）：✅抬头条(耗时) + 正文/工具折叠框交替 + KPI 行。
   *  前提：工具行数量与 toolCalls 一一对应才做交替；否则正文 + 单面板。
   *  2026-10-31 CardKit 全链路实测通过（建卡抬头条/流式互不干扰/整卡PUT）。
   *  失败返回 false，由 close() 走 appendToolsPanel 兜底。 */
  private async finalizeRerender(
    elapsedMs: number,
    outcome: "done" | "stopped" | "error" = "done"
  ): Promise<boolean> {
    if (!this.state || !this.target || !this.fullText) {
      return false;
    }
    const display = this.contPrefix + this.fullText.slice(this.baseOffset);
    if (!display.trim()) return false;

    const dur = formatDurationShort(elapsedMs);
    const mark = outcome === "done" ? "✅" : outcome === "stopped" ? "🛑" : "❌";
    const elements: Array<Record<string, unknown>> = [
      matchaHeaderBar(undefined, `${mark} ${dur}`),
    ];

    // 工具行与记录一一对应时做正文/折叠框交替；对不上就整段正文 + 单面板
    const lines = display.split("\n");
    const toolIdx: number[] = [];
    lines.forEach((l, i) => {
      if (l.trimStart().startsWith("🔧")) toolIdx.push(i);
    });
    const alternating =
      toolIdx.length > 0 && toolIdx.length === this.toolCalls.length;

    if (alternating) {
      let seg: string[] = [];
      let ti = 0;
      const flush = () => {
        const text = seg.join("\n").trim();
        seg = [];
        if (text) elements.push(...textToElements(text));
      };
      for (let i = 0; i < lines.length; i++) {
        if (toolIdx.includes(i)) {
          flush();
          const t = this.toolCalls[ti++] || null;
          if (!t) return false;
          elements.push({ ...buildToolPanel(t, ti), margin: "0px 12px 10px 12px" });
        } else {
          seg.push(lines[i]);
        }
      }
      flush();
    } else {
      elements.push(...textToElements(display));
      if (this.toolCalls.length) {
        const sections: string[] = [];
        let used = 0;
        for (const t of this.toolCalls) {
          const piece = `${t.line}\n${t.detail}`.slice(0, 1200);
          if (used + piece.length > 18000) {
            sections.push("…（工具较多，详情已截断）");
            break;
          }
          sections.push(piece);
          used += piece.length;
        }
        elements.push({
          ...buildToolPanel(
            this.toolCalls[0] || { name: "工具", line: `🔧 ${this.toolCalls.length} 项工具调用`, detail: sections.join("\n\n") },
            1
          ),
          margin: "0px 12px 10px 12px",
        });
      }
    }

    // KPI 行（№9）：仅在有过工具调用时出现；元素/字节超限先砍 KPI 再放弃
    if (this.toolCalls.length > 0 && outcome === "done") {
      elements.push({
        ...matchaKpiRow([
          { value: String(this.toolCalls.length), label: "工具调用" },
          { value: dur, label: "总用时" },
        ]),
        margin: "0px 12px 0px 12px",
      });
    }
    if (elements.length > 195) return false;

    const cardJson = {
      schema: "2.0",
      config: { wide_screen_mode: true, ...MATCHA_CONFIG_STYLE },
      body: { padding: "0px 0px 4px 0px", elements },
    };
    if (jsonByteLength(JSON.stringify(cardJson)) > FEISHU_CARD_MAX_BYTES) {
      // 砍 KPI 再试一次（KPI 是锦上添花，正文不能丢）
      cardJson.body.elements = elements.filter(
        (e) => (e as { tag?: string }).tag !== "column_set" || e === elements[0]
      );
      if (jsonByteLength(JSON.stringify(cardJson)) > FEISHU_CARD_MAX_BYTES) {
        return false;
      }
    }
    try {
      this.state.sequence += 1;
      const res = await fetch(
        `${API_BASE}/cardkit/v1/cards/${this.state.cardId}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${await getFeishuToken(this.creds)}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            card: {
              type: "card_json",
              data: JSON.stringify(cardJson),
            },
            uuid: `rr_${this.state.cardId}_${this.state.sequence}`,
            sequence: this.state.sequence,
          }),
        }
      );
      const data = (await res.json().catch(() => null)) as {
        code?: number;
        msg?: string;
      } | null;
      if (data && data.code !== 0) {
        this.log?.(
          `[Streaming] 整卡重渲染失败 (code ${data.code}): ${data.msg}`
        );
        return false;
      }
      this.log?.(
        `[Streaming] 整卡已重渲染为抹茶版式 (工具 ${this.toolCalls.length}, 用时 ${dur})`
      );
      return true;
    } catch (e) {
      this.log?.(`[Streaming] 整卡重渲染失败: ${String(e)}`);
      return false;
    }
  }

  /** 收尾时把工具折叠面板追加到卡片（CardKit 增元素接口；失败只记日志，不影响正文）
   *  2026-10-30 对真卡实测的请求口径：type=append 必填、sequence 必填（与流式更新同序列）、
   *  elements 必须是 JSON 序列化后的【字符串】不是数组——差一个就 99992402 field validation failed。 */
  private async appendToolsPanel(): Promise<void> {
    const panel = this.buildToolsPanel();
    if (!panel || !this.state) return;
    try {
      this.state.sequence += 1;
      const res = await fetch(
        `${API_BASE}/cardkit/v1/cards/${this.state.cardId}/elements`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${await getFeishuToken(this.creds)}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            type: "append",
            sequence: this.state.sequence,
            uuid: `tp_${this.state.cardId}_${this.state.sequence}`,
            elements: JSON.stringify([panel]),
          }),
        }
      );
      const data = (await res.json().catch(() => null)) as {
        code?: number;
        msg?: string;
      } | null;
      if (data && data.code !== 0) {
        this.log?.(
          `[Streaming] 工具面板追加失败 (code ${data.code}): ${data.msg}`
        );
      } else {
        this.log?.(
          `[Streaming] 工具面板已追加 (${this.toolCalls.length} 项工具)`
        );
      }
    } catch (e) {
      this.log?.(`[Streaming] 工具面板追加失败: ${String(e)}`);
    }
  }

  async close(
    finalText?: string,
    outcome: "done" | "stopped" | "error" = "done"
  ): Promise<void> {
    if (!this.state || this.closed) return;
    this.closed = true;
    await this.queue;

    // 快照优先级：显式收尾文本 > 节流窗口里没来得及发的最新快照 > 已发内容
    const text = finalText || this.pendingText || this.fullText;

    // 最终文本同步（超长时同样走翻页，保证收尾不丢内容）
    if (text) {
      this.fullText = text;
      await this.syncContent(text, "收尾更新");
    }

    // 关闭最后一张卡片的流式模式
    const summary = text ? truncateSummary(text) : "";
    await this.patchStreamingSettings(this.state, {
      streaming_mode: false,
      summary: { content: summary },
    });

    // 收尾重渲染：抬头条按 outcome 显示 ✅/🛑/❌ + 正文/工具折叠框交替 + KPI 行（№9 形态）；
    // 任何一步失败逐级回退：无面板整卡 → 底部追加面板（抬头停在⏳ 的旧 wart 仅在此极端路径出现）
    const rerendered = await this.finalizeRerender(Date.now() - this.startedAt, outcome);
    if (!rerendered) {
      await this.appendToolsPanel();
    }

    // PATCH(xiaoc 2026-07-11): 指定群里补发纯文本副本(机器可读),不设环境变量时行为完全不变
    await this.sendPlainTextCopy(text);

    this.log?.(`[Streaming] 已完成: cardId=${this.state.cardId}`);
  }

  /**
   * PATCH(xiaoc 2026-07-11): 回答收尾后往群里补发一条同内容的纯文本消息。
   * 背景:流式卡片是 CardKit 实体,消息体里只有卡片 ID 引用,别的机器人
   * (如某个自定义 AI 助手)通过 API 读群历史只能看到降级占位符,
   * 读不到回答正文。纯文本消息则谁都能读。
   * 开关:环境变量 MYCC_TEXT_COPY_CHATS = 逗号分隔的群 chat_id 列表,
   * "*" 表示所有群聊;不设置(默认)完全不补发,行为与原版一致。私聊永不补发。
   */
  private async sendPlainTextCopy(text: string): Promise<void> {
    const conf = (process.env.MYCC_TEXT_COPY_CHATS || "").trim();
    if (!conf || !text || !this.target) return;
    try {
      const token = await getFeishuToken(this.creds);
      let chatId: string | null = null;
      if (this.target.receiveIdType === "chat_id") {
        chatId = this.target.receiveId;
      } else if (this.target.replyToMessageId) {
        // 群里被 @ 时走的是"回复某条消息",要查一次原消息拿它所在的群
        const res = await fetch(`${API_BASE}/im/v1/messages/${this.target.replyToMessageId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await res.json().catch(() => null)) as {
          data?: { items?: Array<{ chat_id?: string }> };
        } | null;
        chatId = data?.data?.items?.[0]?.chat_id || null;
      }
      if (!chatId) return; // 拿不到群 ID(如 open_id 直发的私聊)不补发
      const allowed = conf.split(",").map((s) => s.trim()).filter(Boolean);
      if (!allowed.includes("*") && !allowed.includes(chatId)) return;
      const MAX = 4000;
      const cut = text.length > MAX ? text.slice(0, MAX) + "…(纯文本副本截断,全文见上方卡片)" : text;
      const sendRes = await fetch(`${API_BASE}/im/v1/messages?receive_id_type=chat_id`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text: cut }),
        }),
      });
      const sendData = (await sendRes.json().catch(() => null)) as { code?: number; msg?: string } | null;
      if (sendData?.code === 0) this.log?.(`[Streaming] 已补发纯文本副本到 ${chatId}`);
      else this.log?.(`[Streaming] 纯文本副本发送失败: ${sendData?.msg}`);
    } catch (e) {
      this.log?.(`[Streaming] 纯文本副本发送失败: ${String(e)}`);
    }
  }

  isActive(): boolean {
    return this.state !== null && !this.closed;
  }
}
