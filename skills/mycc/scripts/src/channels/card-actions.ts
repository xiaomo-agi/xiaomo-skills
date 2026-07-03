/**
 * 飞书卡片交互按钮（Phase 5 步骤 1）
 *
 * 参考 zarazhangrui/lark-coding-agent-bridge 的 card/templates.ts + dispatcher.ts：
 * - 渲染：卡片 elements 里加 {tag:'action', actions:[{tag:'button', value:{cmd,arg}}]}
 *   （1.0 卡片格式，参考项目验证过 card.action.trigger 能原样带回 value）
 * - 接收：value.cmd 存在且在白名单内 → 拼回命令字符串，路由到
 *   feishu-commands.ts 现有的命令处理器（见 FeishuCommands.processCardAction）
 *
 * 普通文本回复仍走 feishu-streaming.ts 的 schema 2.0 markdown 卡片，
 * 两种格式在 interactive 消息里可以并存。
 */

/** 按钮点击回传的载荷：cmd 必须在白名单内，arg 是命令参数 */
export interface CardCommandValue {
  cmd: string;
  arg?: string;
}

/**
 * 允许通过卡片按钮触发的命令白名单。
 * 卡片可能长期留在聊天记录里被翻出来点，未识别命令默认会被转发给
 * Claude 当 skill 调用——旧卡片/伪造 value 绝不能走到那条路，
 * 所以这里只放行明确设计过按钮场景的命令。
 */
const ALLOWED_CARD_COMMANDS = new Set([
  "/model",
  "/agent",
  "/switch",
  "/sessions",
  "/new",
  "/rename",
  "/current",
  "/status",
  "/stop",
  "/stream",
  "/help",
  "/skills",
  "/agents",
  "/device",
  // CC 原生透传命令：processMessage 会原样转发给 Claude，点击=手敲
  "/context",
  "/usage",
  "/compact",
  "/noop", // 确认卡片的"取消"按钮
  // 注意：/clear（清空对话）刻意不放行——旧卡片被翻出来误点的代价太高，保持打字触发
]);

/** 解析按钮 value：不是对象 / 无 cmd / 不在白名单 → null（调用方提示按钮失效） */
export function parseCardCommandValue(value: unknown): CardCommandValue | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.cmd !== "string") return null;
  const cmd = raw.cmd.toLowerCase();
  if (!ALLOWED_CARD_COMMANDS.has(cmd)) return null;
  const arg = typeof raw.arg === "string" && raw.arg ? raw.arg : undefined;
  return { cmd, arg };
}

// ==================== 卡片构建（1.0 格式） ====================

interface ButtonSpec {
  text: string;
  /** 命令按钮是 {cmd,arg}，选项按钮是 {cb: token}（见 option-buttons.ts），原样带回 */
  value: CardCommandValue | Record<string, unknown>;
  style?: "primary" | "danger" | "default";
}

function button(spec: ButtonSpec): Record<string, unknown> {
  return {
    tag: "button",
    text: { tag: "plain_text", content: spec.text },
    type: spec.style ?? "default",
    value: spec.value,
  };
}

function divMd(content: string): Record<string, unknown> {
  return { tag: "div", text: { tag: "lark_md", content } };
}

function actionsRow(buttons: ButtonSpec[]): Record<string, unknown> {
  return { tag: "action", actions: buttons.map(button) };
}

const HR: Record<string, unknown> = { tag: "hr" };

function cardShell(title: string, elements: Record<string, unknown>[]): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: "plain_text", content: title } },
    elements,
  };
}

/** /model 无参：当前模型 + 可选模型按钮（点击等价于 /model <别名>） */
export function modelPickerCard(currentModel: string | null): Record<string, unknown> {
  const current = currentModel || "claude-fable-5（默认）";
  const models: Array<{ label: string; arg: string }> = [
    { label: "Fable 5", arg: "fable5" },
    { label: "Opus", arg: "opus" },
    { label: "Sonnet", arg: "sonnet" },
    { label: "Haiku", arg: "haiku" },
  ];
  return cardShell("🧠 切换模型", [
    divMd(`当前模型: \`${current}\`\n\n点击按钮切换（下一条消息起生效），也可以发 \`/model <完整模型 ID>\``),
    HR,
    actionsRow(
      models.map((m) => ({
        text: m.label,
        value: { cmd: "/model", arg: m.arg },
        style: "primary" as const,
      }))
    ),
  ]);
}

/** /agent 无参：当前供应商 + 可切换按钮（未接入的只在文案里说明，不出按钮） */
export function agentPickerCard(
  current: string,
  providers: Array<{ name: string; registered: boolean }>
): Record<string, unknown> {
  const lines = providers
    .map((p) => `• ${p.name}${p.name === current ? "  ← 当前" : ""}${p.registered ? "" : "（尚未接入）"}`)
    .join("\n");
  const buttons: ButtonSpec[] = providers
    .filter((p) => p.registered && p.name !== current)
    .map((p) => ({
      text: `切换到 ${p.name}`,
      value: { cmd: "/agent", arg: p.name },
      style: "primary" as const,
    }));
  const elements: Record<string, unknown>[] = [
    divMd(`当前 agent: \`${current}\`（只作用于当前群/话题）\n\n${lines}`),
  ];
  if (buttons.length > 0) {
    elements.push(HR, actionsRow(buttons));
  }
  return cardShell("🤖 切换 Agent 供应商", elements);
}

export interface SessionEntry {
  /** /switch 使用的 1-based 序号 */
  index: number;
  title: string;
  timeAgo: string;
  current: boolean;
}

/** /sessions：会话列表，每条带"切换到此会话"按钮（点击等价于 /switch <序号>） */
export function sessionPickerCard(entries: SessionEntry[], total: number): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [
    divMd(`历史会话（共 ${total} 个，显示最近 ${entries.length} 个）`),
    HR,
  ];
  entries.forEach((e, i) => {
    const marker = e.current ? "  ← 当前" : "";
    elements.push(divMd(`**${e.index}. ${escapeMd(e.title)}**${marker}\n${e.timeAgo}`));
    elements.push(
      actionsRow([
        {
          text: e.current ? "已是当前会话" : "▸ 切换到此会话",
          value: { cmd: "/switch", arg: String(e.index) },
          style: e.current ? "default" : "primary",
        },
      ])
    );
    if (i < entries.length - 1) elements.push(HR);
  });
  return cardShell("🗂 历史会话", elements);
}

/**
 * "正在处理中"提示卡片：带红色终止按钮。/stop 和 /status 都走锁前拦截路径，
 * 正在干活时点击也能立即响应。text 由调用方拼好（含 describeProgress 的耗时/工具片段）。
 */
export function processingNoticeCard(text: string): Record<string, unknown> {
  return cardShell("⏳ 正在处理", [
    divMd(text),
    HR,
    actionsRow([
      { text: "🛑 终止当前任务", value: { cmd: "/stop" }, style: "danger" },
      { text: "查看进度", value: { cmd: "/status" }, style: "default" },
    ]),
  ]);
}

/**
 * /stream 无参：当前流式输出状态 + 一键切换按钮（按群/话题生效并持久化）。
 * 只出"切到另一侧"的按钮，避免点当前状态产生无意义的往返。
 */
export function streamToggleCard(current: boolean): Record<string, unknown> {
  return cardShell("📡 流式输出", [
    divMd(
      `当前状态: **${current ? "开启" : "关闭"}**（只作用于当前群/话题，重启后仍生效）\n\n` +
        "开启：回复边生成边更新到卡片，能看到工具调用过程\n" +
        "关闭：处理期间保持安静，完成后一次性发送完整回复"
    ),
    HR,
    actionsRow([
      current
        ? { text: "🔕 关闭流式输出", value: { cmd: "/stream", arg: "off" }, style: "primary" as const }
        : { text: "📡 开启流式输出", value: { cmd: "/stream", arg: "on" }, style: "primary" as const },
    ]),
  ]);
}

/**
 * 危险操作双按钮确认卡片（基础设施，供后续危险命令复用）。
 * confirmValue 必须是白名单内的命令；取消走 /noop（只回一句"已取消"）。
 */
export function confirmActionCard(
  question: string,
  confirmText: string,
  confirmValue: CardCommandValue
): Record<string, unknown> {
  return cardShell("⚠️ 请确认", [
    divMd(question),
    HR,
    actionsRow([
      { text: confirmText, value: confirmValue, style: "danger" },
      { text: "取消", value: { cmd: "/noop" }, style: "default" },
    ]),
  ]);
}

/** 按钮文字最长 30 字，超出截断加省略号（完整选项文本在签名 token 里，不受影响） */
const OPTION_LABEL_MAX = 30;

/**
 * agent 主动出选择题的选项卡片（Phase 5 步骤 2）。
 * 每个按钮 value = {cb: 签名 token}，点击走 option-buttons.ts 的验票路径，
 * 通过后选项文本被当成用户消息转回当前会话。
 * 布局：短标签（全部 ≤10 字）排一行，出现长标签则每个按钮独占一行，避免挤压换行。
 */
export function optionPickerCard(
  question: string,
  options: Array<{ label: string; token: string }>
): Record<string, unknown> {
  const specs: ButtonSpec[] = options.map((o, i) => ({
    text: o.label.length > OPTION_LABEL_MAX ? `${o.label.slice(0, OPTION_LABEL_MAX - 1)}…` : o.label,
    value: { cb: o.token },
    style: i === 0 ? ("primary" as const) : ("default" as const),
  }));
  const oneRow = specs.every((s) => s.text.length <= 10);
  const elements: Record<string, unknown>[] = [
    divMd(`${escapeMd(question)}\n\n点击按钮回答，也可以直接打字回复`),
    HR,
  ];
  if (oneRow) {
    elements.push(actionsRow(specs));
  } else {
    for (const s of specs) elements.push(actionsRow([s]));
  }
  return cardShell("🔘 请选择", elements);
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, "\\$1");
}

// ==================== 重命名会话（输入框表单卡片） ====================

/** 重命名表单里输入框的 name，回调事件的 form_value 用它取新标题 */
export const RENAME_INPUT_NAME = "rename_title";

/**
 * /rename 无参时发的输入卡片：卡片 2.0 表单容器（输入框+提交按钮必须内嵌
 * form，1.0 没有输入组件）。提交按钮同时带 behaviors callback value
 * {cmd:"/rename"}——点击事件里 action.value 走现有白名单路径识别命令，
 * action.form_value[RENAME_INPUT_NAME] 带回新标题。
 */
export function renameInputCard(currentTitle?: string): Record<string, unknown> {
  const hint = currentTitle
    ? `当前标题：**${escapeMd(currentTitle)}**\n输入新标题后提交，只改当前群/话题正在使用的会话。`
    : "输入新标题后提交，只改当前群/话题正在使用的会话。";
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: "✏️ 重命名会话" } },
    body: {
      elements: [
        { tag: "markdown", content: hint },
        {
          tag: "form",
          name: "rename_form",
          elements: [
            {
              tag: "input",
              name: RENAME_INPUT_NAME,
              placeholder: { tag: "plain_text", content: "新标题" },
              width: "fill",
            },
            {
              tag: "button",
              name: "rename_submit",
              form_action_type: "submit",
              type: "primary",
              text: { tag: "plain_text", content: "提交" },
              behaviors: [{ type: "callback", value: { cmd: "/rename" } }],
            },
          ],
        },
      ],
    },
  };
}

// ==================== 命令菜单 + 语境快捷按钮（Phase 5 步骤 3） ====================

/** /help 命令菜单：无参命令全部一键可点，需要参数的在尾部文案里说明 */
export function helpMenuCard(): Record<string, unknown> {
  const group = (title: string, cmds: Array<{ cmd: string; label: string }>) => [
    divMd(`**${title}**`),
    actionsRow(
      cmds.map((c) => ({
        text: `${c.cmd} ${c.label}`,
        value: { cmd: c.cmd },
      }))
    ),
  ];
  return cardShell("📖 命令菜单", [
    divMd("点按钮 = 直接执行对应命令。每个私聊/群/话题是独立会话。"),
    HR,
    ...group("会话（作用于当前群/话题）", [
      { cmd: "/new", label: "新会话" },
      { cmd: "/sessions", label: "历史会话" },
      { cmd: "/rename", label: "重命名会话" },
      { cmd: "/current", label: "当前会话" },
      { cmd: "/status", label: "运行状态" },
      { cmd: "/stop", label: "终止任务" },
    ]),
    ...group("模型 / Agent / 输出（点开再选）", [
      { cmd: "/model", label: "切换模型" },
      { cmd: "/agent", label: "切换供应商" },
      { cmd: "/stream", label: "流式开关" },
    ]),
    ...group("信息查询", [
      { cmd: "/skills", label: "Skill 列表" },
      { cmd: "/agents", label: "在线小工" },
      { cmd: "/device", label: "设备信息" },
    ]),
    ...group("Claude 原生", [
      { cmd: "/context", label: "上下文占用" },
      { cmd: "/usage", label: "Token 用量" },
      { cmd: "/compact", label: "压缩历史" },
    ]),
    HR,
    divMd(
      "需要参数的命令直接打字：\n" +
        "`/switch <序号>` 切历史会话 · `/new <标题>` 带标题建会话 · `/rename <新标题>` 重命名当前会话\n" +
        "`/model <完整ID>` 切任意模型 · `/skill名称` 调用 skill · `/clear` 清空当前对话（无按钮，防误点）"
    ),
  ]);
}

/**
 * 语境快捷按钮的可建议命令：只放无参数即可执行、且点错也无害的命令。
 * /switch 要序号、/clear 和 /stop 点错代价高（清对话/杀任务），都不进这个集合。
 */
const SUGGESTIBLE_COMMANDS = [
  "/new",
  "/rename",
  "/sessions",
  "/current",
  "/status",
  "/model",
  "/agent",
  "/stream",
  "/skills",
  "/agents",
  "/device",
  "/help",
  "/context",
  "/usage",
  "/compact",
] as const;

const SUGGEST_PATTERN = new RegExp(
  // 前后都不能是路径/标识符字符：排掉 src/status、/model/foo、/status.ts、/context-manager 这类误配
  `(^|[^\\w/.\\-])(${SUGGESTIBLE_COMMANDS.join("|")})(?![\\w/.\\-])`,
  "gi"
);

/** 建议按钮最多出这么多个：更多通常意味着回复在罗列命令清单（如帮助文本），出按钮反而是噪音 */
const SUGGEST_MAX = 4;

/**
 * 从 AI 回复文本里检测被提到的命令（Phase 5 步骤 3：AI 说"可以发 /context 查看"
 * → 自动追发快捷按钮）。保守规则：
 * - 只认 SUGGESTIBLE_COMMANDS 白名单，前后不能是路径/标识符字符
 * - 去重保序；0 个或超过 SUGGEST_MAX 个（像在罗列命令清单）→ null
 */
export function detectSuggestedCommands(text: string): string[] | null {
  if (!text) return null;
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(SUGGEST_PATTERN)) {
    const cmd = match[2].toLowerCase();
    if (!seen.has(cmd)) {
      seen.add(cmd);
      found.push(cmd);
    }
  }
  if (found.length === 0 || found.length > SUGGEST_MAX) return null;
  return found;
}

/** 回复尾部追发的快捷命令卡片：按钮 value 走命令白名单主路径，点击=手敲 */
export function commandSuggestionCard(cmds: string[]): Record<string, unknown> {
  return cardShell("⚡ 快捷命令", [
    divMd("上面提到了这些命令，点按钮直接执行："),
    actionsRow(
      cmds.map((cmd, i) => ({
        text: cmd,
        value: { cmd },
        style: i === 0 ? ("primary" as const) : ("default" as const),
      }))
    ),
  ]);
}
