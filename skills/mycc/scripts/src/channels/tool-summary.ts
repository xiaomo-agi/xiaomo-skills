/**
 * 工具调用摘要：按工具类型选取最有信息量的输入字段，生成卡片上的一行展示
 * （参考 lark-coding-agent-bridge 的 tool-render.ts 分字段思路，按 mycc
 * 卡片的承载量裁剪为单行摘要）。
 *
 * 此前三处渲染各自为政：feishu-commands 用固定优先级瞎猜字段（Grep 会显示
 * 目录而不是搜索词）、feishu.ts 裸 JSON.stringify 截 100 字符、降级模式
 * dump 整个 input JSON。统一收口到这里。
 */

const SUMMARY_MAX = 60;

function pickString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  return typeof v === "string" ? v : "";
}

/** 按工具类型选字段，返回压成单行、截断后的摘要（可能为空串） */
export function summarizeToolInput(
  name: string,
  input: unknown,
  max = SUMMARY_MAX
): string {
  if (!input || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = pickString(rec, k);
      if (v) return v;
    }
    return "";
  };

  let raw: string;
  switch (name) {
    case "Bash":
      raw = pick("command", "description");
      break;
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
      raw = pick("file_path", "notebook_path");
      break;
    case "Grep": {
      const pattern = pick("pattern");
      const path = pick("path");
      raw = pattern && path ? `${pattern} in ${path}` : pattern || path;
      break;
    }
    case "Glob":
      raw = pick("pattern");
      break;
    case "WebFetch":
      raw = pick("url");
      break;
    case "WebSearch":
      raw = pick("query");
      break;
    case "Agent":
    case "Task":
      raw = pick("description", "subagent_type", "prompt");
      break;
    case "Skill":
      raw = pick("skill", "args");
      break;
    case "TodoWrite":
      raw = "更新任务列表";
      break;
    default:
      raw = pick("description", "command", "file_path", "path", "pattern", "query", "url", "prompt");
  }

  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** 流式卡片里的工具调用展示行（前后带换行，嵌进正文） */
export function toolUseLine(name: string, input: unknown): string {
  const summary = summarizeToolInput(name, input);
  return `\n🔧 ${name}${summary ? `：${summary}` : ""}\n`;
}
