/**
 * utils.ts 测试
 */

import { describe, it, expect, vi } from "vitest";
import { retryWithBackoff, waitForReady, type RetryOptions } from "../src/utils";

describe("retryWithBackoff", () => {
  describe("成功场景", () => {
    it("第一次就成功，直接返回结果", async () => {
      const fn = vi.fn().mockResolvedValue("success");
      const options: RetryOptions = { maxRetries: 3, delayMs: 100 };

      const result = await retryWithBackoff(fn, options);

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("第二次成功，返回结果", async () => {
      const fn = vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce("success");
      const options: RetryOptions = { maxRetries: 3, delayMs: 10 };

      const result = await retryWithBackoff(fn, options);

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("最后一次成功，返回结果", async () => {
      const fn = vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce("success");
      const options: RetryOptions = { maxRetries: 3, delayMs: 10 };

      const result = await retryWithBackoff(fn, options);

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe("失败场景", () => {
    it("全部返回 null，最终返回 null", async () => {
      const fn = vi.fn().mockResolvedValue(null);
      const options: RetryOptions = { maxRetries: 3, delayMs: 10 };

      const result = await retryWithBackoff(fn, options);

      expect(result).toBeNull();
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("全部抛异常，最终返回 null", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("network error"));
      const options: RetryOptions = { maxRetries: 3, delayMs: 10 };

      const result = await retryWithBackoff(fn, options);

      expect(result).toBeNull();
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("抛异常后重试成功", async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValueOnce("recovered");
      const options: RetryOptions = { maxRetries: 3, delayMs: 10 };

      const result = await retryWithBackoff(fn, options);

      expect(result).toBe("recovered");
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe("onRetry 回调", () => {
    it("重试时调用 onRetry（返回 null 场景）", async () => {
      const fn = vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce("success");
      const onRetry = vi.fn();
      const options: RetryOptions = { maxRetries: 3, delayMs: 10, onRetry };

      await retryWithBackoff(fn, options);

      // 第一次失败后调用 onRetry，无错误信息
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(1, undefined);
    });

    it("异常时调用 onRetry 并传递错误信息", async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error("connection refused"))
        .mockResolvedValueOnce("success");
      const onRetry = vi.fn();
      const options: RetryOptions = { maxRetries: 3, delayMs: 10, onRetry };

      await retryWithBackoff(fn, options);

      // 异常时调用两次：一次带错误信息，一次不带
      expect(onRetry).toHaveBeenCalledWith(1, "connection refused");
    });
  });

  describe("边界情况", () => {
    it("maxRetries=1，只执行一次", async () => {
      const fn = vi.fn().mockResolvedValue(null);
      const options: RetryOptions = { maxRetries: 1, delayMs: 10 };

      const result = await retryWithBackoff(fn, options);

      expect(result).toBeNull();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("返回 undefined 也视为失败，继续重试", async () => {
      const fn = vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce("success");
      const options: RetryOptions = { maxRetries: 3, delayMs: 10 };

      const result = await retryWithBackoff(fn, options);

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("返回 0 视为成功", async () => {
      const fn = vi.fn().mockResolvedValue(0);
      const options: RetryOptions = { maxRetries: 3, delayMs: 10 };

      const result = await retryWithBackoff(fn, options);

      expect(result).toBe(0);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("返回空字符串视为成功", async () => {
      const fn = vi.fn().mockResolvedValue("");
      const options: RetryOptions = { maxRetries: 3, delayMs: 10 };

      const result = await retryWithBackoff(fn, options);

      expect(result).toBe("");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("返回 false 视为成功", async () => {
      const fn = vi.fn().mockResolvedValue(false);
      const options: RetryOptions = { maxRetries: 3, delayMs: 10 };

      const result = await retryWithBackoff(fn, options);

      expect(result).toBe(false);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});

describe("waitForReady", () => {
  it("第一次就成功，立即返回 true", async () => {
    const checkFn = vi.fn().mockResolvedValue(true);

    const result = await waitForReady(checkFn, { maxWaitMs: 5000, intervalMs: 100 });

    expect(result).toBe(true);
    expect(checkFn).toHaveBeenCalledTimes(1);
  });

  it("第三次成功，返回 true", async () => {
    const checkFn = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const result = await waitForReady(checkFn, { maxWaitMs: 5000, intervalMs: 10 });

    expect(result).toBe(true);
    expect(checkFn).toHaveBeenCalledTimes(3);
  });

  it("超时返回 false", async () => {
    const checkFn = vi.fn().mockResolvedValue(false);

    const result = await waitForReady(checkFn, { maxWaitMs: 50, intervalMs: 10 });

    expect(result).toBe(false);
    // 50ms / 10ms = 最多 5 次检查
    expect(checkFn.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("checkFn 抛异常视为失败，继续重试", async () => {
    const checkFn = vi.fn()
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce(true);

    const result = await waitForReady(checkFn, { maxWaitMs: 5000, intervalMs: 10 });

    expect(result).toBe(true);
    expect(checkFn).toHaveBeenCalledTimes(2);
  });

  it("调用 onCheck 回调", async () => {
    const checkFn = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const onCheck = vi.fn();

    await waitForReady(checkFn, { maxWaitMs: 5000, intervalMs: 10, onCheck });

    expect(onCheck).toHaveBeenCalled();
  });
});
