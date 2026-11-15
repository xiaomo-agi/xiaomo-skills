#!/usr/bin/env node
/**
 * Patch SDK: 修复已知的 CLI bug
 *
 * Patch: cli.js — lP 函数不检查 isIdle（Agent Teams 死锁）
 *   问题：do-while 主循环用 lP 判断 task 是否活跃，不检查 isIdle
 *         → idle 的 teammate 被当成活跃 → 循环永不退出 → inbox 轮询永不执行
 *   修复：在 lP 返回 true 前加 if(A.isIdle)return!1
 *
 * 历史：曾有 Patch 1 改写 sdk.mjs 的 settingSources:[] 硬编码（否则 v2 Session
 * 不加载 CLAUDE.md / Skills）。SDK 0.2.141 起提供官方 settingSources 字段，
 * 改由 official.ts buildSessionOptions 显式传入 ["user","project"]，
 * sdk.mjs 补丁移除（2026-07-07，审查 H2 闭环）。
 *
 * 用法：node scripts/patch-sdk.mjs
 *       或通过 npm postinstall 自动执行
 */

import { readFileSync, writeFileSync } from "fs";

// ============ Patch: cli.js — lP 函数 isIdle 检查 ============
// CLI 2.1.63 的 lP 不检查 isIdle，导致 Agent Teams do-while 死锁

import { execSync } from "child_process";

function findCliPath() {
  // 优先用 CLAUDE_PATH 环境变量
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;
  try {
    const which = execSync("which claude", { encoding: "utf-8" }).trim();
    // 解析 symlink
    const resolved = execSync(`readlink -f "${which}" 2>/dev/null || realpath "${which}" 2>/dev/null || echo "${which}"`, { encoding: "utf-8" }).trim();
    return resolved;
  } catch {
    return null;
  }
}

const LP_ORIGINAL = 'function lP(A){if(A.status!=="running"&&A.status!=="pending")return!1;if("isBackgrounded"in A&&A.isBackgrounded===!1)return!1;return!0}';
const LP_PATCHED  = 'function lP(A){if(A.status!=="running"&&A.status!=="pending")return!1;if("isBackgrounded"in A&&A.isBackgrounded===!1)return!1;if(A.isIdle)return!1;return!0}';

const cliPath = findCliPath();
if (cliPath) {
  try {
    const cliSource = readFileSync(cliPath, "utf-8");
    if (cliSource.includes(LP_PATCHED)) {
      console.log("[patch-sdk] cli.js: lP already patched.");
    } else if (!cliSource.includes(LP_ORIGINAL)) {
      console.warn("[patch-sdk] cli.js: lP pattern not found (CLI may have fixed it or function renamed).");
    } else {
      const patched = cliSource.replace(LP_ORIGINAL, LP_PATCHED);
      writeFileSync(cliPath, patched, "utf-8");
      console.log("[patch-sdk] cli.js: patched lP → added isIdle check for Agent Teams.");
    }
  } catch (err) {
    // CLI 文件可能需要 sudo 权限
    console.warn(`[patch-sdk] cli.js patch failed (may need sudo): ${err.message}`);
  }
} else {
  console.warn("[patch-sdk] cli.js: claude CLI not found, skipping lP patch.");
}

console.log("[patch-sdk] Done.");
