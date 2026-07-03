/**
 * 多供应商 adapter 注册表（Phase 3 契约）
 */
import { describe, it, expect } from "vitest";
import {
  adapter,
  getAdapter,
  registerAdapter,
  isValidProvider,
  listRegisteredProviders,
  type CCAdapter,
} from "../src/adapters/index.js";

describe("adapter registry", () => {
  it("默认（不传 provider）返回 Claude adapter，向后兼容", () => {
    expect(getAdapter()).toBe(adapter);
    expect(getAdapter("claude")).toBe(adapter);
  });

  it("未知供应商名抛错并列出支持项", () => {
    expect(() => getAdapter("gpt5")).toThrow(/未知的 agent 供应商: gpt5/);
  });

  it("已知但未注册的供应商抛'尚未接入'", () => {
    // codex 在 codex.ts 落地前未注册
    if (!listRegisteredProviders().includes("codex")) {
      expect(() => getAdapter("codex")).toThrow(/尚未接入/);
    }
  });

  it("registerAdapter 后 getAdapter 返回注册的实现", () => {
    const fake = { chat: async function* () {} } as unknown as CCAdapter;
    registerAdapter("codex", fake);
    expect(getAdapter("codex")).toBe(fake);
    expect(listRegisteredProviders()).toContain("codex");
  });

  it("isValidProvider 只认 claude/codex", () => {
    expect(isValidProvider("claude")).toBe(true);
    expect(isValidProvider("codex")).toBe(true);
    expect(isValidProvider("sonnet")).toBe(false);
    expect(isValidProvider("")).toBe(false);
  });
});
