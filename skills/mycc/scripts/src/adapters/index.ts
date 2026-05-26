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
