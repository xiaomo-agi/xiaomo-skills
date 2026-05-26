/**
 * Scheduler 模块测试用例
 *
 * 测试范围：
 * 1. 任务解析（parseTasks）
 * 2. 时间匹配（matchTime）
 * 3. 防重复执行
 * 4. startScheduler 集成
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseTasks, matchTime, TaskLock, startScheduler, stopScheduler } from "../src/scheduler.js";
import fs from "fs";

// Mock fs 模块
vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  },
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

describe("Scheduler 模块", () => {
  // ============================================
  // 1. 任务解析
  // ============================================
  describe("parseTasks - 任务解析", () => {
    it("应该解析每日任务（HH:MM 格式）", () => {
      const content = `
## 每日任务

| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 08:00 | 每日初始化 | /morning | 更新日期 |
| 18:30 | 吃饭提醒 | /tell-me | 飞书通知 |
`;
      const tasks = parseTasks(content);
      expect(tasks).toHaveLength(2);
      expect(tasks[0]).toEqual({
        time: "08:00",
        name: "每日初始化",
        skill: "/morning",
        desc: "更新日期",
        type: "daily",
      });
    });

    it("应该解析每周任务（周X HH:MM 格式）", () => {
      const content = `
## 每周任务

| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 周日 20:00 | 周复盘提醒 | /tell-me | 提醒做周复盘 |
| 周一 09:00 | 周计划 | /tell-me | 新的一周 |
`;
      const tasks = parseTasks(content);
      expect(tasks).toHaveLength(2);
      expect(tasks[0]).toEqual({
        time: "周日 20:00",
        name: "周复盘提醒",
        skill: "/tell-me",
        desc: "提醒做周复盘",
        type: "weekly",
      });
    });

    it("应该解析一次性任务（YYYY-MM-DD HH:MM 格式）", () => {
      const content = `
## 一次性任务

| 日期时间 | 任务 | Skill | 说明 |
|----------|------|-------|------|
| 2026-02-01 10:00 | 提醒转钱 | /tell-me | 执行后删除 |
`;
      const tasks = parseTasks(content);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toEqual({
        time: "2026-02-01 10:00",
        name: "提醒转钱",
        skill: "/tell-me",
        desc: "执行后删除",
        type: "once",
      });
    });

    it("应该跳过无效时间格式", () => {
      const content = `
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| - | 无效任务 | /test | 时间是 - |
| invalid | 无效任务2 | /test | 时间无效 |
| 08:00 | 有效任务 | /test | 正常 |
`;
      const tasks = parseTasks(content);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].name).toBe("有效任务");
    });

    it("应该跳过表头和分隔行", () => {
      const content = `
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 08:00 | 测试任务 | /test | 正常 |
`;
      const tasks = parseTasks(content);
      expect(tasks).toHaveLength(1);
    });

    it("空内容应该返回空数组", () => {
      const tasks = parseTasks("");
      expect(tasks).toEqual([]);
    });

    it("null/undefined 输入返回空数组", () => {
      expect(parseTasks(null as any)).toEqual([]);
      expect(parseTasks(undefined as any)).toEqual([]);
    });

    it("08:00 和 09:30 能正确解析（不当作八进制）", () => {
      const content = `
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 08:00 | 早起任务 | /test | 八点整 |
| 09:30 | 九点半 | /test | 九点半 |
`;
      const tasks = parseTasks(content);
      expect(tasks).toHaveLength(2);
      expect(tasks[0].time).toBe("08:00");
      expect(tasks[1].time).toBe("09:30");
    });

    it("任务名包含特殊字符能正确解析", () => {
      const content = `
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 18:30 | 提醒吃饭🍚 | /tell-me | 带 emoji |
| 19:00 | 任务(重要) | /test | 带括号 |
`;
      const tasks = parseTasks(content);
      expect(tasks).toHaveLength(2);
      expect(tasks[0].name).toBe("提醒吃饭🍚");
      expect(tasks[1].name).toBe("任务(重要)");
    });

    // ========== 间隔任务解析 ==========
    it("应该解析间隔任务（每X分钟 格式）", () => {
      const content = `
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 每30分钟 | 热点采集 | /fetch-trends | 间隔执行 |
| 每15分钟 | 健康提醒 | /tell-me | 喝水 |
`;
      const tasks = parseTasks(content);
      expect(tasks).toHaveLength(2);
      expect(tasks[0]).toEqual({
        time: "每30分钟",
        name: "热点采集",
        skill: "/fetch-trends",
        desc: "间隔执行",
        type: "interval",
      });
      expect(tasks[1].type).toBe("interval");
    });

    it("应该解析间隔任务（每X小时 格式）", () => {
      const content = `
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 每2小时 | 定时检查 | /test | 每两小时 |
`;
      const tasks = parseTasks(content);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toEqual({
        time: "每2小时",
        name: "定时检查",
        skill: "/test",
        desc: "每两小时",
        type: "interval",
      });
    });

    it("应该解析简写格式（每Xm / 每Xh）", () => {
      const content = `
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 每30m | 任务A | /test | 分钟简写 |
| 每2h | 任务B | /test | 小时简写 |
`;
      const tasks = parseTasks(content);
      expect(tasks).toHaveLength(2);
      expect(tasks[0].type).toBe("interval");
      expect(tasks[1].type).toBe("interval");
    });

    it("无效间隔格式应该被跳过", () => {
      const content = `
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 每0分钟 | 无效A | /test | 间隔为0 |
| 每-1小时 | 无效B | /test | 负数 |
| 每abc分钟 | 无效C | /test | 非数字 |
| 每30分钟 | 有效任务 | /test | 正常 |
`;
      const tasks = parseTasks(content);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].name).toBe("有效任务");
    });
  });

  // ============================================
  // 2. 时间匹配
  // ============================================
  describe("matchTime - 时间匹配", () => {
    describe("每日任务", () => {
      it("精确匹配当前时间", () => {
        const now = new Date("2026-01-30T18:30:00");
        expect(matchTime("18:30", now)).toBe(true);
      });

      it("允许 +2 分钟误差", () => {
        const now = new Date("2026-01-30T18:32:00");
        expect(matchTime("18:30", now)).toBe(true);
      });

      it("允许 -2 分钟误差", () => {
        const now = new Date("2026-01-30T18:28:00");
        expect(matchTime("18:30", now)).toBe(true);
      });

      it("超过 2 分钟误差不匹配", () => {
        const now = new Date("2026-01-30T18:33:00");
        expect(matchTime("18:30", now)).toBe(false);
      });

      it("不同小时不匹配", () => {
        const now = new Date("2026-01-30T19:30:00");
        expect(matchTime("18:30", now)).toBe(false);
      });
    });

    describe("每周任务", () => {
      it("周日任务在周日匹配", () => {
        // 2026-02-01 是周日
        const sunday = new Date("2026-02-01T20:00:00");
        expect(matchTime("周日 20:00", sunday)).toBe(true);
      });

      it("周日任务在周一不匹配", () => {
        // 2026-02-02 是周一
        const monday = new Date("2026-02-02T20:00:00");
        expect(matchTime("周日 20:00", monday)).toBe(false);
      });

      it("周一任务在周一匹配", () => {
        const monday = new Date("2026-02-02T09:00:00");
        expect(matchTime("周一 09:00", monday)).toBe(true);
      });

      it("每周任务也允许 ±2 分钟误差", () => {
        const sunday = new Date("2026-02-01T20:02:00");
        expect(matchTime("周日 20:00", sunday)).toBe(true);
      });
    });

    describe("一次性任务", () => {
      it("精确匹配日期和时间", () => {
        const now = new Date("2026-02-01T10:00:00");
        expect(matchTime("2026-02-01 10:00", now)).toBe(true);
      });

      it("日期不同不匹配", () => {
        const now = new Date("2026-02-02T10:00:00");
        expect(matchTime("2026-02-01 10:00", now)).toBe(false);
      });

      it("时间不同不匹配", () => {
        const now = new Date("2026-02-01T11:00:00");
        expect(matchTime("2026-02-01 10:00", now)).toBe(false);
      });

      it("一次性任务也允许 ±2 分钟误差", () => {
        const now = new Date("2026-02-01T10:02:00");
        expect(matchTime("2026-02-01 10:00", now)).toBe(true);
      });

      it("过去的一次性任务不应匹配", () => {
        // 任务时间是 2026-01-30，但现在是 2026-02-01
        const now = new Date("2026-02-01T10:00:00");
        expect(matchTime("2026-01-30 10:00", now)).toBe(false);
      });
    });

    describe("跨年边界", () => {
      it("跨年任务正确匹配（12月31日）", () => {
        const dec31 = new Date("2026-12-31T23:59:00");
        expect(matchTime("23:59", dec31)).toBe(true);
      });

      it("跨年任务正确匹配（1月1日）", () => {
        const jan1 = new Date("2027-01-01T00:00:00");
        expect(matchTime("00:00", jan1)).toBe(true);
      });

      it("跨年一次性任务", () => {
        const newYear = new Date("2027-01-01T00:00:00");
        expect(matchTime("2027-01-01 00:00", newYear)).toBe(true);
      });
    });

    describe("无效格式", () => {
      it("无效格式返回 false", () => {
        const now = new Date();
        expect(matchTime("-", now)).toBe(false);
        expect(matchTime("invalid", now)).toBe(false);
        expect(matchTime("", now)).toBe(false);
      });
    });

    // ========== 间隔任务匹配 ==========
    describe("间隔任务", () => {
      describe("每X分钟", () => {
        it("每30分钟 - 整点匹配", () => {
          const t0 = new Date("2026-01-30T10:00:00");
          expect(matchTime("每30分钟", t0)).toBe(true);
        });

        it("每30分钟 - 半点匹配", () => {
          const t30 = new Date("2026-01-30T10:30:00");
          expect(matchTime("每30分钟", t30)).toBe(true);
        });

        it("每30分钟 - 非整点不匹配", () => {
          const t15 = new Date("2026-01-30T10:15:00");
          expect(matchTime("每30分钟", t15)).toBe(false);
        });

        it("每15分钟 - 0/15/30/45 分钟匹配", () => {
          expect(matchTime("每15分钟", new Date("2026-01-30T10:00:00"))).toBe(true);
          expect(matchTime("每15分钟", new Date("2026-01-30T10:15:00"))).toBe(true);
          expect(matchTime("每15分钟", new Date("2026-01-30T10:30:00"))).toBe(true);
          expect(matchTime("每15分钟", new Date("2026-01-30T10:45:00"))).toBe(true);
        });

        it("每15分钟 - 其他分钟不匹配", () => {
          expect(matchTime("每15分钟", new Date("2026-01-30T10:10:00"))).toBe(false);
          expect(matchTime("每15分钟", new Date("2026-01-30T10:25:00"))).toBe(false);
        });

        it("每1分钟 - 每分钟都匹配", () => {
          expect(matchTime("每1分钟", new Date("2026-01-30T10:00:00"))).toBe(true);
          expect(matchTime("每1分钟", new Date("2026-01-30T10:17:00"))).toBe(true);
          expect(matchTime("每1分钟", new Date("2026-01-30T10:59:00"))).toBe(true);
        });

        it("每60分钟 - 只在整点匹配", () => {
          expect(matchTime("每60分钟", new Date("2026-01-30T10:00:00"))).toBe(true);
          expect(matchTime("每60分钟", new Date("2026-01-30T11:00:00"))).toBe(true);
          expect(matchTime("每60分钟", new Date("2026-01-30T10:30:00"))).toBe(false);
        });

        it("简写格式 每30m", () => {
          expect(matchTime("每30m", new Date("2026-01-30T10:00:00"))).toBe(true);
          expect(matchTime("每30m", new Date("2026-01-30T10:30:00"))).toBe(true);
          expect(matchTime("每30m", new Date("2026-01-30T10:15:00"))).toBe(false);
        });
      });

      describe("每X小时", () => {
        it("每2小时 - 偶数小时整点匹配", () => {
          expect(matchTime("每2小时", new Date("2026-01-30T00:00:00"))).toBe(true);
          expect(matchTime("每2小时", new Date("2026-01-30T02:00:00"))).toBe(true);
          expect(matchTime("每2小时", new Date("2026-01-30T04:00:00"))).toBe(true);
          expect(matchTime("每2小时", new Date("2026-01-30T22:00:00"))).toBe(true);
        });

        it("每2小时 - 奇数小时不匹配", () => {
          expect(matchTime("每2小时", new Date("2026-01-30T01:00:00"))).toBe(false);
          expect(matchTime("每2小时", new Date("2026-01-30T03:00:00"))).toBe(false);
          expect(matchTime("每2小时", new Date("2026-01-30T23:00:00"))).toBe(false);
        });

        it("每2小时 - 非整点不匹配", () => {
          expect(matchTime("每2小时", new Date("2026-01-30T02:30:00"))).toBe(false);
          expect(matchTime("每2小时", new Date("2026-01-30T04:15:00"))).toBe(false);
        });

        it("每1小时 - 每个整点都匹配", () => {
          expect(matchTime("每1小时", new Date("2026-01-30T00:00:00"))).toBe(true);
          expect(matchTime("每1小时", new Date("2026-01-30T13:00:00"))).toBe(true);
          expect(matchTime("每1小时", new Date("2026-01-30T23:00:00"))).toBe(true);
        });

        it("每1小时 - 非整点不匹配", () => {
          expect(matchTime("每1小时", new Date("2026-01-30T13:30:00"))).toBe(false);
        });

        it("每3小时 - 0/3/6/9/12/15/18/21 点匹配", () => {
          expect(matchTime("每3小时", new Date("2026-01-30T00:00:00"))).toBe(true);
          expect(matchTime("每3小时", new Date("2026-01-30T03:00:00"))).toBe(true);
          expect(matchTime("每3小时", new Date("2026-01-30T21:00:00"))).toBe(true);
        });

        it("每3小时 - 其他小时不匹配", () => {
          expect(matchTime("每3小时", new Date("2026-01-30T01:00:00"))).toBe(false);
          expect(matchTime("每3小时", new Date("2026-01-30T22:00:00"))).toBe(false);
        });

        it("简写格式 每2h", () => {
          expect(matchTime("每2h", new Date("2026-01-30T00:00:00"))).toBe(true);
          expect(matchTime("每2h", new Date("2026-01-30T02:00:00"))).toBe(true);
          expect(matchTime("每2h", new Date("2026-01-30T01:00:00"))).toBe(false);
        });
      });

      describe("边界情况", () => {
        it("间隔任务允许 ±2 分钟误差", () => {
          // 10:30 的任务，在 10:31 和 10:32 也应该匹配
          expect(matchTime("每30分钟", new Date("2026-01-30T10:31:00"))).toBe(true);
          expect(matchTime("每30分钟", new Date("2026-01-30T10:32:00"))).toBe(true);
          // 但 10:33 不匹配
          expect(matchTime("每30分钟", new Date("2026-01-30T10:33:00"))).toBe(false);
        });

        it("跨小时边界 - 每30分钟", () => {
          // 09:30 和 10:00 都应该匹配
          expect(matchTime("每30分钟", new Date("2026-01-30T09:30:00"))).toBe(true);
          expect(matchTime("每30分钟", new Date("2026-01-30T10:00:00"))).toBe(true);
        });

        it("午夜边界 - 每2小时", () => {
          expect(matchTime("每2小时", new Date("2026-01-30T00:00:00"))).toBe(true);
          expect(matchTime("每2小时", new Date("2026-01-30T22:00:00"))).toBe(true);
        });

        it("无效间隔值不匹配", () => {
          const now = new Date("2026-01-30T10:00:00");
          expect(matchTime("每0分钟", now)).toBe(false);
          expect(matchTime("每-1小时", now)).toBe(false);
          expect(matchTime("每abc分钟", now)).toBe(false);
        });

        it("极端边界值", () => {
          // 每59分钟 - 只在 0 和 59 分钟匹配（因为 0 % 59 = 0, 59 % 59 = 0）
          expect(matchTime("每59分钟", new Date("2026-01-30T10:00:00"))).toBe(true);
          expect(matchTime("每59分钟", new Date("2026-01-30T10:59:00"))).toBe(true);
          expect(matchTime("每59分钟", new Date("2026-01-30T10:30:00"))).toBe(false);

          // 每24小时 - 只在 0 点匹配
          expect(matchTime("每24小时", new Date("2026-01-30T00:00:00"))).toBe(true);
          expect(matchTime("每24小时", new Date("2026-01-30T12:00:00"))).toBe(false);
        });
      });
    });
  });

  // ============================================
  // 3. 防重复执行
  // ============================================
  describe("TaskLock - 防重复执行", () => {
    let lock: TaskLock;

    beforeEach(() => {
      lock = new TaskLock();
    });

    it("首次执行返回 true", () => {
      const now = new Date("2026-01-30T18:30:00");
      expect(lock.tryAcquire("吃饭提醒", "18:30", now)).toBe(true);
    });

    it("同一分钟内重复执行返回 false", () => {
      const now = new Date("2026-01-30T18:30:00");
      lock.tryAcquire("吃饭提醒", "18:30", now);
      expect(lock.tryAcquire("吃饭提醒", "18:30", now)).toBe(false);
    });

    it("不同任务可以同时执行", () => {
      const now = new Date("2026-01-30T18:30:00");
      expect(lock.tryAcquire("任务A", "18:30", now)).toBe(true);
      expect(lock.tryAcquire("任务B", "18:30", now)).toBe(true);
    });

    it("同一任务隔天可以重新执行", () => {
      const day1 = new Date("2026-01-30T18:30:00");
      const day2 = new Date("2026-01-31T18:30:00");
      lock.tryAcquire("吃饭提醒", "18:30", day1);
      expect(lock.tryAcquire("吃饭提醒", "18:30", day2)).toBe(true);
    });

    it("时间窗口内（±2分钟）算同一次", () => {
      const t1 = new Date("2026-01-30T18:30:00");
      const t2 = new Date("2026-01-30T18:31:00");
      lock.tryAcquire("吃饭提醒", "18:30", t1);
      expect(lock.tryAcquire("吃饭提醒", "18:30", t2)).toBe(false);
    });

    // ========== 间隔任务防重复 ==========
    it("间隔任务 - 同一触发点不重复执行", () => {
      const t1 = new Date("2026-01-30T10:00:00");
      const t2 = new Date("2026-01-30T10:01:00");
      lock.tryAcquire("热点采集", "每30分钟", t1);
      expect(lock.tryAcquire("热点采集", "每30分钟", t2)).toBe(false);
    });

    it("间隔任务 - 下一个触发点可以执行", () => {
      const t1 = new Date("2026-01-30T10:00:00");
      const t2 = new Date("2026-01-30T10:30:00");
      lock.tryAcquire("热点采集", "每30分钟", t1);
      expect(lock.tryAcquire("热点采集", "每30分钟", t2)).toBe(true);
    });
  });

  // ============================================
  // 4. startScheduler 集成测试
  // ============================================
  describe("startScheduler - 调度器启动", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      stopScheduler(); // 确保每次测试前停止之前的调度器
    });

    afterEach(() => {
      stopScheduler();
      vi.useRealTimers();
      vi.clearAllMocks();
    });

    it("tasks.md 不存在时静默跳过", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const executeTaskMock = vi.fn();
      startScheduler("/test/cwd", executeTaskMock);

      // 推进 1 分钟
      vi.advanceTimersByTime(60 * 1000);

      // 不应执行任何任务
      expect(executeTaskMock).not.toHaveBeenCalled();
    });

    it("匹配的任务应该被执行", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 18:30 | 吃饭提醒 | /tell-me | 飞书通知 |
`);

      // 设置当前时间为 18:30
      vi.setSystemTime(new Date("2026-01-30T18:30:00"));

      const executeTaskMock = vi.fn();
      startScheduler("/test/cwd", executeTaskMock);

      // 推进 1 分钟触发检查
      vi.advanceTimersByTime(60 * 1000);

      // 应该执行任务
      expect(executeTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "吃饭提醒",
          skill: "/tell-me",
        }),
        "/test/cwd"
      );
    });

    it("不匹配的任务不应被执行", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 08:00 | 早起任务 | /morning | 早安 |
`);

      // 设置当前时间为 18:30（不匹配 08:00）
      vi.setSystemTime(new Date("2026-01-30T18:30:00"));

      const executeTaskMock = vi.fn();
      startScheduler("/test/cwd", executeTaskMock);

      vi.advanceTimersByTime(60 * 1000);

      expect(executeTaskMock).not.toHaveBeenCalled();
    });

    it("同一任务在同一时间窗口内不重复执行", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 18:30 | 吃饭提醒 | /tell-me | 飞书通知 |
`);

      vi.setSystemTime(new Date("2026-01-30T18:30:00"));

      const executeTaskMock = vi.fn();
      startScheduler("/test/cwd", executeTaskMock);

      // 第一次检查
      vi.advanceTimersByTime(60 * 1000);
      expect(executeTaskMock).toHaveBeenCalledTimes(1);

      // 第二次检查（还在 18:31，仍在时间窗口内）
      vi.advanceTimersByTime(60 * 1000);
      expect(executeTaskMock).toHaveBeenCalledTimes(1); // 仍然是 1 次
    });

    it("stopScheduler 应该停止定时器", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 18:30 | 吃饭提醒 | /tell-me | 飞书通知 |
`);

      vi.setSystemTime(new Date("2026-01-30T18:30:00"));

      const executeTaskMock = vi.fn();
      startScheduler("/test/cwd", executeTaskMock);
      stopScheduler();

      // 推进时间后不应再执行
      vi.advanceTimersByTime(60 * 1000);
      expect(executeTaskMock).not.toHaveBeenCalled();
    });

    // ========== 间隔任务集成测试 ==========
    it("间隔任务应该在匹配时间执行", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 每30分钟 | 热点采集 | /fetch-trends | 间隔执行 |
`);

      // 设置当前时间为整点
      vi.setSystemTime(new Date("2026-01-30T10:00:00"));

      const executeTaskMock = vi.fn();
      startScheduler("/test/cwd", executeTaskMock);

      // 推进 1 分钟触发检查
      vi.advanceTimersByTime(60 * 1000);

      // 应该执行任务
      expect(executeTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "热点采集",
          skill: "/fetch-trends",
          type: "interval",
        }),
        "/test/cwd"
      );
    });

    it("间隔任务在非匹配时间不执行", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 每30分钟 | 热点采集 | /fetch-trends | 间隔执行 |
`);

      // 设置当前时间为 10:15（不匹配 每30分钟）
      vi.setSystemTime(new Date("2026-01-30T10:15:00"));

      const executeTaskMock = vi.fn();
      startScheduler("/test/cwd", executeTaskMock);

      vi.advanceTimersByTime(60 * 1000);

      expect(executeTaskMock).not.toHaveBeenCalled();
    });

    it("间隔任务在下一个触发点再次执行", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 每30分钟 | 热点采集 | /fetch-trends | 间隔执行 |
`);

      // 从 10:00 开始
      vi.setSystemTime(new Date("2026-01-30T10:00:00"));

      const executeTaskMock = vi.fn();
      startScheduler("/test/cwd", executeTaskMock);

      // 第一次触发 10:01
      vi.advanceTimersByTime(60 * 1000);
      expect(executeTaskMock).toHaveBeenCalledTimes(1);

      // 推进到 10:30（下一个触发点）
      vi.advanceTimersByTime(29 * 60 * 1000);
      expect(executeTaskMock).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================
  // 5. 活跃时段测试
  // ============================================
  describe("活跃时段判断", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      stopScheduler(); // 确保每次测试前停止之前的调度器
    });

    afterEach(() => {
      stopScheduler();
      vi.useRealTimers();
      vi.clearAllMocks();
    });

    it("应该解析活跃时段（09:00-24:00）", () => {
      const content = `
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 每4小时 | 主动思考 | /auto-think | 活跃时段 09:00-24:00，读取状态并思考 |
`;
      const tasks = parseTasks(content);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].activeHours).toEqual({ start: 9, end: 24 });
    });

    it("应该解析活跃时段（跨天情况 22:00-02:00）", () => {
      const content = `
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 每2小时 | 夜间监控 | /monitor | 活跃时段 22:00-02:00，夜间执行 |
`;
      const tasks = parseTasks(content);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].activeHours).toEqual({ start: 22, end: 2 });
    });

    it("活跃时段内应该执行任务", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 每4小时 | 主动思考 | /auto-think | 活跃时段 09:00-24:00，读取状态并思考 |
`);

      // 设置时间为 12:00（活跃时段内）
      vi.setSystemTime(new Date("2026-02-02T12:00:00"));

      const executeTaskMock = vi.fn();
      startScheduler("/test/cwd", executeTaskMock);

      vi.advanceTimersByTime(60 * 1000);

      expect(executeTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "主动思考",
          activeHours: { start: 9, end: 24 },
        }),
        "/test/cwd"
      );
    });

    it("非活跃时段应该跳过任务", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 每4小时 | 主动思考 | /auto-think | 活跃时段 09:00-24:00，读取状态并思考 |
`);

      // 设置时间为 04:00（非活跃时段）
      vi.setSystemTime(new Date("2026-02-02T04:00:00"));

      const executeTaskMock = vi.fn();
      startScheduler("/test/cwd", executeTaskMock);

      vi.advanceTimersByTime(60 * 1000);

      // 不应该执行任务
      expect(executeTaskMock).not.toHaveBeenCalled();
    });

    it("活跃时段边界测试 - 起始时间应该执行", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 每3小时 | 喝水提醒 | /tell-me | 活跃时段 09:00-24:00，提醒喝水 |
`);

      // 设置时间为 09:00（边界时间，且匹配每3小时：0/3/6/9/12/15/18/21）
      vi.setSystemTime(new Date("2026-02-02T09:00:00"));

      const executeTaskMock = vi.fn();
      startScheduler("/test/cwd", executeTaskMock);

      vi.advanceTimersByTime(60 * 1000);

      expect(executeTaskMock).toHaveBeenCalled();
    });

    it("活跃时段边界测试 - 结束时间不应该执行", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 每4小时 | 主动思考 | /auto-think | 活跃时段 09:00-24:00，读取状态并思考 |
`);

      // 设置时间为 00:00（24:00 = 次日 00:00，超出活跃时段）
      vi.setSystemTime(new Date("2026-02-02T00:00:00"));

      const executeTaskMock = vi.fn();
      startScheduler("/test/cwd", executeTaskMock);

      vi.advanceTimersByTime(60 * 1000);

      expect(executeTaskMock).not.toHaveBeenCalled();
    });

    it("跨天活跃时段测试 - 夜间应该执行", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 每2小时 | 夜间监控 | /monitor | 活跃时段 22:00-02:00，夜间执行 |
`);

      // 设置时间为 00:00（跨天活跃时段内）
      vi.setSystemTime(new Date("2026-02-02T00:00:00"));

      const executeTaskMock = vi.fn();
      startScheduler("/test/cwd", executeTaskMock);

      vi.advanceTimersByTime(60 * 1000);

      expect(executeTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "夜间监控",
          activeHours: { start: 22, end: 2 },
        }),
        "/test/cwd"
      );
    });

    it("没有活跃时段限制的任务应该全天执行", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 08:00 | 每日初始化 | /morning | 更新日期、清理昨日 |
`);

      // 设置时间为任意时间 08:00
      vi.setSystemTime(new Date("2026-02-02T08:00:00"));

      const executeTaskMock = vi.fn();
      startScheduler("/test/cwd", executeTaskMock);

      vi.advanceTimersByTime(60 * 1000);

      expect(executeTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "每日初始化",
          activeHours: undefined, // 没有活跃时段限制
        }),
        "/test/cwd"
      );
    });

    // ========== 边界情况精确测试 ==========
    it("边界测试 - 08:59 起始前1分钟不应该执行", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 每2小时 | 喝水提醒 | /tell-me | 活跃时段 09:00-24:00，提醒喝水 |
`);

      // 08:00 - 在活跃时段起始前（且匹配每2小时：0/2/4/6/8/10...）
      vi.setSystemTime(new Date("2026-02-02T08:00:00"));

      const executeTaskMock = vi.fn();
      startScheduler("/test/cwd", executeTaskMock);

      vi.advanceTimersByTime(60 * 1000);

      expect(executeTaskMock).not.toHaveBeenCalled();
    });

    it("边界测试 - 23:59 结束前1分钟应该执行", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 每3小时 | 喝水提醒 | /tell-me | 活跃时段 09:00-24:00，提醒喝水 |
`);

      // 23:59 - 还在活跃时段内，且匹配每3小时（21点）
      vi.setSystemTime(new Date("2026-02-02T21:00:00"));

      const executeTaskMock = vi.fn();
      startScheduler("/test/cwd", executeTaskMock);

      vi.advanceTimersByTime(60 * 1000);

      expect(executeTaskMock).toHaveBeenCalled();
    });

    it("边界测试 - 跨天时段的20:00不应该执行", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 每2小时 | 夜间监控 | /monitor | 活跃时段 22:00-02:00，夜间执行 |
`);

      // 20:00 - 在跨天活跃时段起始前（且匹配每2小时：0/2/4.../18/20/22）
      vi.setSystemTime(new Date("2026-02-02T20:00:00"));

      const executeTaskMock = vi.fn();
      startScheduler("/test/cwd", executeTaskMock);

      vi.advanceTimersByTime(60 * 1000);

      expect(executeTaskMock).not.toHaveBeenCalled();
    });

    it("边界测试 - 跨天时段的02:01不应该执行", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 每2小时 | 夜间监控 | /monitor | 活跃时段 22:00-02:00，夜间执行 |
`);

      // 02:01 - 刚好超出跨天活跃时段结束时间
      vi.setSystemTime(new Date("2026-02-02T02:01:00"));

      const executeTaskMock = vi.fn();
      startScheduler("/test/cwd", executeTaskMock);

      vi.advanceTimersByTime(60 * 1000);

      expect(executeTaskMock).not.toHaveBeenCalled();
    });

    it("边界测试 - 格式错误时activeHours应该为undefined", () => {
      const content = `
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 每4小时 | 任务1 | /test | 活跃时段 错误格式 |
| 每4小时 | 任务2 | /test | 活跃时段 25:00-30:00 |
| 每4小时 | 任务3 | /test | 没有活跃时段 |
`;
      const tasks = parseTasks(content);
      expect(tasks).toHaveLength(3);
      expect(tasks[0].activeHours).toBeUndefined();
      expect(tasks[1].activeHours).toBeUndefined(); // 格式虽然匹配但数值无效
      expect(tasks[2].activeHours).toBeUndefined();
    });

    it("边界测试 - 活跃时段00:00-24:00应该全天执行", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 每3小时 | 全天任务 | /test | 活跃时段 00:00-24:00，全天运行 |
`);

      // 测试凌晨2点
      vi.setSystemTime(new Date("2026-02-02T03:00:00"));

      const executeTaskMock = vi.fn();
      startScheduler("/test/cwd", executeTaskMock);

      vi.advanceTimersByTime(60 * 1000);

      expect(executeTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "全天任务",
          activeHours: { start: 0, end: 24 },
        }),
        "/test/cwd"
      );
    });
  });
});
