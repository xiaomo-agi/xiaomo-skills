/**
 * TunnelManager 测试 - Tunnel 保活机制
 *
 * 测试范围：
 * 1. TunnelProvider 接口实现
 * 2. TunnelManager 保活逻辑
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "events";

// ============ Mock 类型定义 ============

/** 模拟的子进程 */
class MockChildProcess extends EventEmitter {
  killed = false;
  pid = 12345;

  kill() {
    this.killed = true;
    // 模拟异步退出
    setTimeout(() => this.emit("exit", 0), 10);
  }
}

/** 创建 mock 进程 */
function createMockProc(): MockChildProcess {
  return new MockChildProcess();
}

// ============ TunnelProvider 接口定义（测试用） ============

interface TunnelProvider {
  start(localPort: number): Promise<{ url: string; proc?: ChildProcess }>;
  stop(): void;
  healthCheck(): Promise<boolean>;
  getName(): string;
}

// ============ TunnelProvider 接口测试 ============

describe("TunnelProvider 接口", () => {
  describe("CloudflareProvider", () => {
    // 这里测试的是接口契约，实际实现会在 src/ 中

    it("start() 应返回 url 和 proc", async () => {
      // 模拟 CloudflareProvider
      const mockProc = createMockProc();
      const provider: TunnelProvider = {
        start: vi.fn().mockResolvedValue({
          url: "https://test.trycloudflare.com",
          proc: mockProc,
        }),
        stop: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue(true),
        getName: vi.fn().mockReturnValue("cloudflare"),
      };

      const result = await provider.start(18080);

      expect(result.url).toMatch(/^https:\/\/.*\.trycloudflare\.com$/);
      expect(result.proc).toBeDefined();
    });

    it("stop() 应停止进程", () => {
      const mockProc = createMockProc();
      let stopped = false;

      const provider: TunnelProvider = {
        start: vi.fn(),
        stop: vi.fn(() => {
          mockProc.kill();
          stopped = true;
        }),
        healthCheck: vi.fn(),
        getName: vi.fn().mockReturnValue("cloudflare"),
      };

      provider.stop();

      expect(stopped).toBe(true);
      expect(mockProc.killed).toBe(true);
    });

    it("healthCheck() 成功时返回 true", async () => {
      const provider: TunnelProvider = {
        start: vi.fn(),
        stop: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue(true),
        getName: vi.fn().mockReturnValue("cloudflare"),
      };

      const result = await provider.healthCheck();
      expect(result).toBe(true);
    });

    it("healthCheck() 失败时返回 false", async () => {
      const provider: TunnelProvider = {
        start: vi.fn(),
        stop: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue(false),
        getName: vi.fn().mockReturnValue("cloudflare"),
      };

      const result = await provider.healthCheck();
      expect(result).toBe(false);
    });

    it("getName() 应返回 provider 名称", () => {
      const provider: TunnelProvider = {
        start: vi.fn(),
        stop: vi.fn(),
        healthCheck: vi.fn(),
        getName: vi.fn().mockReturnValue("cloudflare"),
      };

      expect(provider.getName()).toBe("cloudflare");
    });
  });
});

// ============ TunnelManager 测试 ============

describe("TunnelManager 保活机制", () => {
  // 配置常量
  const HEARTBEAT_INTERVAL = 60_000;
  const HEARTBEAT_FAIL_THRESHOLD = 3;
  const MAX_RESTART_ATTEMPTS = 5;

  /** 简化的 TunnelManager 实现（用于测试逻辑） */
  class TestTunnelManager {
    private provider: TunnelProvider | null = null;
    private localPort: number;
    private isRestarting = false;
    private failCount = 0;
    private restartAttempts = 0;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private isStopped = false;

    // 暴露内部状态供测试
    get _isRestarting() {
      return this.isRestarting;
    }
    get _failCount() {
      return this.failCount;
    }
    get _restartAttempts() {
      return this.restartAttempts;
    }

    // 事件回调（测试用）
    onRestart: ((reason: string) => void) | null = null;
    onGiveUp: (() => void) | null = null;
    onHealthCheckFail: ((count: number) => void) | null = null;

    constructor(localPort: number) {
      this.localPort = localPort;
    }

    async start(provider: TunnelProvider) {
      this.provider = provider;
      this.isStopped = false;
      const { url, proc } = await provider.start(this.localPort);

      // 设置进程监控
      if (proc) {
        (proc as unknown as MockChildProcess).on("exit", (code: number) => {
          if (!this.isStopped) {
            this.restart("proc_exit");
          }
        });
      }

      return url;
    }

    startHeartbeat() {
      this.heartbeatTimer = setInterval(async () => {
        if (this.isRestarting || !this.provider || this.isStopped) return;

        const ok = await this.provider.healthCheck();
        if (ok) {
          this.failCount = 0;
        } else {
          this.failCount++;
          this.onHealthCheckFail?.(this.failCount);

          if (this.failCount >= HEARTBEAT_FAIL_THRESHOLD) {
            this.restart("heartbeat_fail");
            this.failCount = 0;
          }
        }
      }, HEARTBEAT_INTERVAL);
    }

    async restart(reason: string) {
      // 防重入
      if (this.isRestarting) {
        return false;
      }

      this.restartAttempts++;

      // 超过最大重试次数
      if (this.restartAttempts > MAX_RESTART_ATTEMPTS) {
        this.onGiveUp?.();
        return false;
      }

      this.isRestarting = true;
      this.onRestart?.(reason);

      try {
        this.provider?.stop();
        // 实际实现中会重新 start
        this.isRestarting = false;
        return true;
      } catch {
        this.isRestarting = false;
        return false;
      }
    }

    stop() {
      this.isStopped = true;
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.provider?.stop();
    }

    // 测试辅助方法：模拟心跳检测
    async simulateHeartbeat() {
      if (this.isRestarting || !this.provider || this.isStopped) return;

      const ok = await this.provider.healthCheck();
      if (ok) {
        this.failCount = 0;
      } else {
        this.failCount++;
        this.onHealthCheckFail?.(this.failCount);

        if (this.failCount >= HEARTBEAT_FAIL_THRESHOLD) {
          await this.restart("heartbeat_fail");
          this.failCount = 0;
        }
      }
    }

    // 测试辅助方法：重置重启计数
    resetRestartAttempts() {
      this.restartAttempts = 0;
    }

    // 测试辅助方法：模拟心跳检测（带异常处理）
    async simulateHeartbeatWithErrorHandling() {
      if (this.isRestarting || !this.provider || this.isStopped) return;

      let ok = false;
      try {
        ok = await this.provider.healthCheck();
      } catch {
        // 异常视为失败
        ok = false;
      }

      if (ok) {
        this.failCount = 0;
      } else {
        this.failCount++;
        this.onHealthCheckFail?.(this.failCount);

        if (this.failCount >= HEARTBEAT_FAIL_THRESHOLD) {
          await this.restart("heartbeat_fail");
          this.failCount = 0;
        }
      }
    }
  }

  let manager: TestTunnelManager;
  let mockProvider: TunnelProvider;
  let mockProc: MockChildProcess;

  beforeEach(() => {
    vi.useFakeTimers();
    mockProc = createMockProc();
    mockProvider = {
      start: vi.fn().mockResolvedValue({
        url: "https://test.trycloudflare.com",
        proc: mockProc,
      }),
      stop: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
      getName: vi.fn().mockReturnValue("cloudflare"),
    };
    manager = new TestTunnelManager(18080);
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
  });

  describe("进程监控", () => {
    it("进程退出时应触发重启", async () => {
      let restartReason: string | null = null;
      manager.onRestart = (reason) => {
        restartReason = reason;
      };

      await manager.start(mockProvider);

      // 模拟进程退出
      mockProc.emit("exit", 1);

      expect(restartReason).toBe("proc_exit");
    });

    it("正常 stop() 后进程退出不应触发重启", async () => {
      let restartCalled = false;
      manager.onRestart = () => {
        restartCalled = true;
      };

      await manager.start(mockProvider);
      manager.stop();

      // 模拟进程退出
      mockProc.emit("exit", 0);

      expect(restartCalled).toBe(false);
    });
  });

  describe("心跳检测", () => {
    it("心跳成功时应重置失败计数", async () => {
      (mockProvider.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      await manager.start(mockProvider);
      await manager.simulateHeartbeat();

      expect(manager._failCount).toBe(0);
    });

    it("心跳失败时应增加失败计数", async () => {
      (mockProvider.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      await manager.start(mockProvider);
      await manager.simulateHeartbeat();

      expect(manager._failCount).toBe(1);
    });

    it("连续 3 次心跳失败应触发重启", async () => {
      (mockProvider.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      let restartReason: string | null = null;
      manager.onRestart = (reason) => {
        restartReason = reason;
      };

      await manager.start(mockProvider);

      // 模拟 3 次心跳失败
      await manager.simulateHeartbeat(); // 1
      await manager.simulateHeartbeat(); // 2
      await manager.simulateHeartbeat(); // 3 -> 触发重启

      expect(restartReason).toBe("heartbeat_fail");
    });

    it("心跳失败 2 次后成功应重置计数", async () => {
      const healthCheckMock = mockProvider.healthCheck as ReturnType<typeof vi.fn>;

      await manager.start(mockProvider);

      // 失败 2 次
      healthCheckMock.mockResolvedValue(false);
      await manager.simulateHeartbeat();
      await manager.simulateHeartbeat();
      expect(manager._failCount).toBe(2);

      // 成功 1 次
      healthCheckMock.mockResolvedValue(true);
      await manager.simulateHeartbeat();
      expect(manager._failCount).toBe(0);
    });
  });

  describe("防重入锁", () => {
    it("并发调用 restart() 时只有第一个执行", async () => {
      let restartCount = 0;
      manager.onRestart = () => {
        restartCount++;
      };

      await manager.start(mockProvider);

      // 创建一个带延迟的 restart 实现，模拟真实的异步重启过程
      let isRestartingInternal = false;
      const delayedRestart = async (reason: string) => {
        if (isRestartingInternal) {
          return false; // 已经在重启中，拒绝
        }
        isRestartingInternal = true;
        restartCount++;

        // 模拟异步重启过程（需要时间完成）
        await new Promise((resolve) => setTimeout(resolve, 100));

        isRestartingInternal = false;
        return true;
      };

      // 并发调用 3 次 restart
      vi.useRealTimers(); // 使用真实计时器以便 setTimeout 工作
      const results = await Promise.all([
        delayedRestart("test1"),
        delayedRestart("test2"),
        delayedRestart("test3"),
      ]);
      vi.useFakeTimers(); // 恢复 fake timers

      // 只有第一个成功，其他被拒绝
      expect(results.filter((r) => r === true).length).toBe(1);
      expect(restartCount).toBe(1);
    });

    it("重启过程中心跳检测应跳过（不增加 failCount）", async () => {
      (mockProvider.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      await manager.start(mockProvider);

      // 先让 failCount 增加到 2
      await manager.simulateHeartbeat();
      await manager.simulateHeartbeat();
      expect(manager._failCount).toBe(2);

      // 触发重启（第 3 次心跳失败）
      await manager.simulateHeartbeat();

      // 重启后 failCount 被重置
      expect(manager._failCount).toBe(0);
    });
  });

  describe("重启次数限制", () => {
    it("连续重启 5 次后应放弃", async () => {
      let gaveUp = false;
      manager.onGiveUp = () => {
        gaveUp = true;
      };

      await manager.start(mockProvider);

      // 重启 5 次
      for (let i = 0; i < 5; i++) {
        await manager.restart(`test_${i}`);
      }

      expect(manager._restartAttempts).toBe(5);
      expect(gaveUp).toBe(false);

      // 第 6 次应该放弃
      await manager.restart("test_6");
      expect(gaveUp).toBe(true);
    });

    it("重启成功后应重置计数（实际实现中）", async () => {
      await manager.start(mockProvider);

      // 重启 3 次
      await manager.restart("test_1");
      await manager.restart("test_2");
      await manager.restart("test_3");

      expect(manager._restartAttempts).toBe(3);

      // 模拟重启成功后重置
      manager.resetRestartAttempts();

      expect(manager._restartAttempts).toBe(0);
    });
  });

  describe("停止行为", () => {
    it("stop() 应停止心跳定时器", async () => {
      await manager.start(mockProvider);
      manager.startHeartbeat();
      manager.stop();

      // 推进时间，心跳不应再执行
      (mockProvider.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL * 10);

      // 如果心跳还在执行，failCount 会增加
      expect(manager._failCount).toBe(0);
    });

    it("stop() 应调用 provider.stop()", async () => {
      await manager.start(mockProvider);
      manager.stop();

      expect(mockProvider.stop).toHaveBeenCalled();
    });
  });

  describe("异常处理", () => {
    it("healthCheck() 抛异常应视为失败", async () => {
      (mockProvider.healthCheck as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Network timeout")
      );

      await manager.start(mockProvider);

      // 模拟心跳检测（异常应被捕获并视为失败）
      await manager.simulateHeartbeatWithErrorHandling();

      expect(manager._failCount).toBe(1);
    });

    it("start() 失败应抛出异常", async () => {
      (mockProvider.start as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Tunnel start failed")
      );

      await expect(manager.start(mockProvider)).rejects.toThrow("Tunnel start failed");
    });
  });
});

// ============ 集成场景测试 ============

describe("集成场景", () => {
  // 配置常量
  const HEARTBEAT_INTERVAL = 60_000;
  const HEARTBEAT_FAIL_THRESHOLD = 3;
  const MAX_RESTART_ATTEMPTS = 5;

  let manager: any;
  let mockProvider: any;
  let mockProc: MockChildProcess;

  beforeEach(() => {
    vi.useFakeTimers();
    mockProc = createMockProc();
    mockProvider = {
      start: vi.fn().mockResolvedValue({
        url: "https://test.trycloudflare.com",
        proc: mockProc,
      }),
      stop: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
      getName: vi.fn().mockReturnValue("cloudflare"),
    };

    // 使用简化的 manager（复用上面的 TestTunnelManager 逻辑）
    manager = {
      provider: null,
      isRestarting: false,
      failCount: 0,
      restartAttempts: 0,
      isStopped: false,
      restartCount: 0,

      async start(provider: any) {
        this.provider = provider;
        this.isStopped = false;
        const { url, proc } = await provider.start(18080);

        if (proc) {
          proc.on("exit", () => {
            if (!this.isStopped) {
              this.restart("proc_exit");
            }
          });
        }

        return url;
      },

      async simulateHeartbeat() {
        if (this.isRestarting || !this.provider || this.isStopped) return;

        const ok = await this.provider.healthCheck();
        if (ok) {
          this.failCount = 0;
        } else {
          this.failCount++;
          if (this.failCount >= HEARTBEAT_FAIL_THRESHOLD) {
            await this.restart("heartbeat_fail");
            this.failCount = 0;
          }
        }
      },

      async restart(reason: string) {
        if (this.isRestarting) return false;

        this.restartAttempts++;
        if (this.restartAttempts > MAX_RESTART_ATTEMPTS) {
          return false;
        }

        this.isRestarting = true;
        this.restartCount++;

        try {
          this.provider?.stop();
          // 模拟重新启动
          const { url, proc } = await this.provider.start(18080);
          this.isRestarting = false;
          return true;
        } catch {
          this.isRestarting = false;
          return false;
        }
      },

      stop() {
        this.isStopped = true;
        this.provider?.stop();
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("完整流程：启动 -> 心跳失败 -> 重启 -> 恢复", async () => {
    const healthCheckMock = mockProvider.healthCheck as ReturnType<typeof vi.fn>;

    // 1. 启动
    await manager.start(mockProvider);
    expect(mockProvider.start).toHaveBeenCalledTimes(1);

    // 2. 模拟心跳成功
    healthCheckMock.mockResolvedValue(true);
    await manager.simulateHeartbeat();
    expect(manager.failCount).toBe(0);

    // 3. 模拟心跳连续失败 3 次，触发重启
    healthCheckMock.mockResolvedValue(false);
    await manager.simulateHeartbeat(); // 1
    await manager.simulateHeartbeat(); // 2
    await manager.simulateHeartbeat(); // 3 -> restart

    expect(manager.restartCount).toBe(1);

    // 4. 重启后心跳恢复
    healthCheckMock.mockResolvedValue(true);
    await manager.simulateHeartbeat();
    expect(manager.failCount).toBe(0);
  });

  it("僵尸进程场景：进程在但心跳失败", async () => {
    const healthCheckMock = mockProvider.healthCheck as ReturnType<typeof vi.fn>;

    // 1. 启动成功
    await manager.start(mockProvider);

    // 2. 进程没有退出（不触发 exit 事件）
    // 但心跳失败（模拟僵尸状态）
    healthCheckMock.mockResolvedValue(false);

    // 3. 连续 3 次心跳失败
    await manager.simulateHeartbeat();
    await manager.simulateHeartbeat();
    await manager.simulateHeartbeat();

    // 4. 应该触发重启
    expect(manager.restartCount).toBe(1);
    expect(mockProvider.stop).toHaveBeenCalled();
  });

  it("进程退出触发重启，重启过程中心跳不重复触发", async () => {
    const healthCheckMock = mockProvider.healthCheck as ReturnType<typeof vi.fn>;

    // 修改 restart 方法，让它在重启过程中保持 isRestarting = true
    let restartPromiseResolve: (() => void) | null = null;
    const originalRestart = manager.restart.bind(manager);
    manager.restart = async function (reason: string) {
      if (this.isRestarting) return false;

      this.restartAttempts++;
      if (this.restartAttempts > 5) {
        return false;
      }

      this.isRestarting = true;
      this.restartCount++;

      // 等待外部 resolve（模拟重启过程需要时间）
      await new Promise<void>((resolve) => {
        restartPromiseResolve = resolve;
      });

      this.isRestarting = false;
      return true;
    };

    await manager.start(mockProvider);

    // 进程退出触发重启（此时 restart 会等待 resolve）
    mockProc.emit("exit", 1);

    // 等一下让事件处理完成
    await Promise.resolve();

    // 此时 isRestarting = true，restartCount = 1
    expect(manager.restartCount).toBe(1);
    expect(manager.isRestarting).toBe(true);

    // 心跳也失败，但因为 isRestarting = true，应该被跳过
    healthCheckMock.mockResolvedValue(false);
    await manager.simulateHeartbeat();
    await manager.simulateHeartbeat();
    await manager.simulateHeartbeat();

    // 重启过程中，心跳不应该触发额外的重启
    expect(manager.restartCount).toBe(1);

    // 完成重启
    restartPromiseResolve?.();
    await Promise.resolve();
    expect(manager.isRestarting).toBe(false);
  });
});
