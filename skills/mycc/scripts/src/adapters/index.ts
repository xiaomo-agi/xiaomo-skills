/**
 * Adapter 导出
 * 
 * 默认使用官方 Claude Code SDK 实现
 * 魔改版可以替换为自己的实现
 */

import { OfficialAdapter } from "./official.js";
import type { CCAdapter } from "./interface.js";

// 导出类型
export type { CCAdapter, SSEEvent } from "./interface.js";

// 导出默认 adapter 实例
export const adapter: CCAdapter = new OfficialAdapter();

// 也导出类，方便需要自定义配置的场景
export { OfficialAdapter };

// ---------- 多供应商注册表（Phase 3） ----------

/** 支持的 Agent 供应商 */
export type AgentProvider = "claude" | "codex";

const ALL_PROVIDERS: AgentProvider[] = ["claude", "codex"];

const registry = new Map<AgentProvider, CCAdapter>([["claude", adapter]]);

/** 注册一个供应商的 adapter 实现（codex.ts 在模块加载时调用） */
export function registerAdapter(provider: AgentProvider, impl: CCAdapter): void {
  registry.set(provider, impl);
}

/** 校验字符串是否为已知供应商名（不代表已注册可用） */
export function isValidProvider(value: string): value is AgentProvider {
  return (ALL_PROVIDERS as string[]).includes(value);
}

/** 已注册（可用）的供应商列表 */
export function listRegisteredProviders(): AgentProvider[] {
  return [...registry.keys()];
}

/**
 * 按供应商取 adapter。
 * - 不传或传 "claude" → 默认 Claude adapter（向后兼容）
 * - 已知但未注册的供应商 → 抛错，提示未接入
 */
export function getAdapter(provider?: string): CCAdapter {
  if (!provider || provider === "claude") return adapter;
  if (!isValidProvider(provider)) {
    throw new Error(`未知的 agent 供应商: ${provider}（支持: ${ALL_PROVIDERS.join("、")}）`);
  }
  const found = registry.get(provider);
  if (!found) {
    throw new Error(`agent 供应商 ${provider} 尚未接入`);
  }
  return found;
}

// ---------- Codex adapter 注册（构造无副作用：不 spawn、不起定时器） ----------
import { CodexAdapter } from "./codex.js";

registerAdapter("codex", new CodexAdapter());

export { CodexAdapter };
