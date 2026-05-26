/**
 * 工具函数
 */

import { randomBytes } from "crypto";

// 字符集：大写字母 + 数字，去掉易混淆的 I/O/0/1
const SAFE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// 小写字母 + 数字（用于 deviceId）
const DEVICE_ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * 生成指定长度的随机字符串（使用 crypto，跨平台兼容）
 */
function generateRandomString(chars: string, length: number): string {
  const bytes = randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

/** 生成 6 位配对码/连接码 */
export const generateCode = () => generateRandomString(SAFE_CHARS, 6);

/** 生成 6 位 token（同 generateCode） */
export const generateToken = generateCode;

/** 生成 12 位设备 ID */
export const generateDeviceId = () => generateRandomString(DEVICE_ID_CHARS, 12);

/**
 * 通用重试函数
 * @param fn 要执行的异步函数，返回 null/undefined 表示失败
 * @param options 重试配置
 * @returns 成功的结果或 null
 */
export interface RetryOptions {
  maxRetries: number;
  delayMs: number;
  onRetry?: (attempt: number, error?: string) => void;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T | null>,
  options: RetryOptions
): Promise<T | null> {
  const { maxRetries, delayMs, onRetry } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let lastError: string | undefined;

    try {
      const result = await fn();
      if (result !== null && result !== undefined) {
        return result;
      }
      // 返回 null，视为失败，继续重试
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    // 需要重试时，调用一次 onRetry
    if (attempt < maxRetries) {
      if (onRetry) {
        onRetry(attempt, lastError);
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return null;
}

/**
 * 等待某个条件就绪（主动探测）
 * @param checkFn 检查函数，返回 true 表示就绪
 * @param options 配置
 * @returns 是否就绪
 */
export interface WaitForReadyOptions {
  maxWaitMs: number;      // 最大等待时间
  intervalMs: number;     // 检查间隔
  onCheck?: (attempt: number) => void;  // 每次检查时的回调
}

export async function waitForReady(
  checkFn: () => Promise<boolean>,
  options: WaitForReadyOptions
): Promise<boolean> {
  const { maxWaitMs, intervalMs, onCheck } = options;
  const startTime = Date.now();
  let attempt = 0;

  while (Date.now() - startTime < maxWaitMs) {
    attempt++;
    if (onCheck) {
      onCheck(attempt);
    }

    try {
      const ready = await checkFn();
      if (ready) {
        return true;
      }
    } catch {
      // 检查失败，继续重试
    }

    // 等待下一次检查
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  return false;
}
