/**
 * Scheduler 模块 - 定时任务核心逻辑
 *
 * 功能：
 * 1. parseTasks - 解析 tasks.md 中的任务配置
 * 2. matchTime - 判断当前时间是否匹配任务时间
 * 3. TaskLock - 防止同一任务重复执行
 * 4. startScheduler - 启动定时检查
 * 5. stopScheduler - 停止定时检查
 */

import fs from "fs";
import path from "path";

// ============================================
// 类型定义
// ============================================

export interface Task {
  time: string;
  name: string;
  skill: string;
  desc: string;
  type: "daily" | "weekly" | "once" | "interval";
  activeHours?: { start: number; end: number }; // 活跃时段（小时），如 {start: 9, end: 24}
  sessionId?: string; // 指定 sessionId 可唤起已有对话
}

// ============================================
// 任务解析
// ============================================

/**
 * 解析 tasks.md 内容，提取任务列表
 */
export function parseTasks(content: string | null | undefined): Task[] {
  if (!content) {
    return [];
  }

  const tasks: Task[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    // 跳过非表格行
    if (!line.startsWith("|")) continue;

    // 跳过表头和分隔行（只检查第一列是否是表头关键词，避免误杀数据行）
    const firstCell = line.split("|")[1]?.trim();
    if (!firstCell || firstCell === "时间" || firstCell === "日期时间" || line.includes("---")) continue;

    // 解析表格行：| 时间 | 任务 | Skill | 说明 |
    const cells = line
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    if (cells.length < 4) continue;

    const [time, name, skill, desc] = cells;

    // 跳过无效时间格式
    if (!isValidTimeFormat(time)) continue;

    // 判断任务类型
    const type = detectTaskType(time);

    // 解析活跃时段（从说明中提取"活跃时段 HH:MM-HH:MM"）
    const activeHours = parseActiveHours(desc);

    // 解析 sessionId（从说明中提取"session:xxx"）
    const sessionId = parseSessionId(desc);

    tasks.push({ time, name, skill, desc, type, activeHours, sessionId });
  }

  return tasks;
}

/**
 * 从说明中解析 sessionId
 * 格式：session:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 */
function parseSessionId(desc: string): string | undefined {
  const match = desc.match(/session:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match ? match[1] : undefined;
}

/**
 * 从说明中解析活跃时段
 * 格式：活跃时段 09:00-24:00
 */
function parseActiveHours(desc: string): { start: number; end: number } | undefined {
  const match = desc.match(/活跃时段\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/);
  if (!match) return undefined;

  const startHour = parseInt(match[1], 10);
  const endHour = parseInt(match[3], 10);

  // 验证小时数有效性（0-24，24表示次日00:00）
  if (startHour < 0 || startHour > 24 || endHour < 0 || endHour > 24) {
    return undefined;
  }

  return { start: startHour, end: endHour };
}

/**
 * 检查时间格式是否有效
 */
function isValidTimeFormat(time: string): boolean {
  // 每日任务：HH:MM
  if (/^\d{1,2}:\d{2}$/.test(time)) return true;

  // 每周任务：周X HH:MM
  if (/^周[一二三四五六日]\s+\d{1,2}:\d{2}$/.test(time)) return true;

  // 一次性任务：YYYY-MM-DD HH:MM
  if (/^\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}$/.test(time)) return true;

  // 间隔任务：每X分钟 / 每Xm / 每X小时 / 每Xh
  const intervalMatch = time.match(/^每(\d+)(分钟|m|小时|h)$/);
  if (intervalMatch) {
    const interval = parseInt(intervalMatch[1], 10);
    return interval > 0; // 间隔必须大于 0
  }

  return false;
}

/**
 * 检测任务类型
 */
function detectTaskType(time: string): "daily" | "weekly" | "once" | "interval" {
  if (/^每\d+(分钟|m|小时|h)$/.test(time)) return "interval";
  if (/^周[一二三四五六日]/.test(time)) return "weekly";
  if (/^\d{4}-\d{2}-\d{2}/.test(time)) return "once";
  return "daily";
}

// ============================================
// 时间匹配
// ============================================

const TOLERANCE_MINUTES = 2; // 允许 ±2 分钟误差

/**
 * 判断当前时间是否匹配任务时间
 */
export function matchTime(taskTime: string, now: Date): boolean {
  if (!isValidTimeFormat(taskTime)) {
    return false;
  }

  const type = detectTaskType(taskTime);

  switch (type) {
    case "daily":
      return matchDailyTime(taskTime, now);
    case "weekly":
      return matchWeeklyTime(taskTime, now);
    case "once":
      return matchOnceTime(taskTime, now);
    case "interval":
      return matchIntervalTime(taskTime, now);
    default:
      return false;
  }
}

/**
 * 匹配每日任务
 */
function matchDailyTime(taskTime: string, now: Date): boolean {
  const [taskHour, taskMinute] = parseHourMinute(taskTime);
  const nowHour = now.getHours();
  const nowMinute = now.getMinutes();

  return isWithinTolerance(taskHour, taskMinute, nowHour, nowMinute);
}

/**
 * 匹配每周任务
 */
function matchWeeklyTime(taskTime: string, now: Date): boolean {
  // 解析：周X HH:MM
  const match = taskTime.match(/^周([一二三四五六日])\s+(\d{1,2}):(\d{2})$/);
  if (!match) return false;

  const [, dayChar, hourStr, minuteStr] = match;

  // 周几映射：周日=0, 周一=1, ..., 周六=6
  const dayMap: Record<string, number> = {
    日: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
  };

  const taskDay = dayMap[dayChar];
  const nowDay = now.getDay();

  // 先检查星期是否匹配
  if (taskDay !== nowDay) return false;

  // 再检查时间
  const taskHour = parseInt(hourStr, 10);
  const taskMinute = parseInt(minuteStr, 10);
  const nowHour = now.getHours();
  const nowMinute = now.getMinutes();

  return isWithinTolerance(taskHour, taskMinute, nowHour, nowMinute);
}

/**
 * 匹配一次性任务
 */
function matchOnceTime(taskTime: string, now: Date): boolean {
  // 解析：YYYY-MM-DD HH:MM
  const match = taskTime.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return false;

  const [, yearStr, monthStr, dayStr, hourStr, minuteStr] = match;

  const taskYear = parseInt(yearStr, 10);
  const taskMonth = parseInt(monthStr, 10) - 1; // JS 月份从 0 开始
  const taskDay = parseInt(dayStr, 10);
  const taskHour = parseInt(hourStr, 10);
  const taskMinute = parseInt(minuteStr, 10);

  const nowYear = now.getFullYear();
  const nowMonth = now.getMonth();
  const nowDay = now.getDate();
  const nowHour = now.getHours();
  const nowMinute = now.getMinutes();

  // 检查日期是否匹配
  if (taskYear !== nowYear || taskMonth !== nowMonth || taskDay !== nowDay) {
    return false;
  }

  // 检查时间（带误差）
  return isWithinTolerance(taskHour, taskMinute, nowHour, nowMinute);
}

/**
 * 匹配间隔任务
 * 格式：每X分钟 / 每Xm / 每X小时 / 每Xh
 */
function matchIntervalTime(taskTime: string, now: Date): boolean {
  const match = taskTime.match(/^每(\d+)(分钟|m|小时|h)$/);
  if (!match) return false;

  const interval = parseInt(match[1], 10);
  const unit = match[2];

  if (interval <= 0) return false;

  const nowMinute = now.getMinutes();
  const nowHour = now.getHours();

  if (unit === "分钟" || unit === "m") {
    // 分钟间隔：检查当前分钟是否是间隔的倍数
    // 允许 ±2 分钟误差
    for (let offset = -TOLERANCE_MINUTES; offset <= TOLERANCE_MINUTES; offset++) {
      const checkMinute = (nowMinute - offset + 60) % 60;
      if (checkMinute % interval === 0) {
        return true;
      }
    }
    return false;
  } else {
    // 小时间隔：检查当前小时是否是间隔的倍数，且分钟为 0（允许误差）
    if (nowHour % interval !== 0) return false;
    // 检查分钟是否接近 0（允许 ±2 分钟误差）
    return nowMinute <= TOLERANCE_MINUTES || nowMinute >= 60 - TOLERANCE_MINUTES;
  }
}

/**
 * 解析 HH:MM 格式
 */
function parseHourMinute(time: string): [number, number] {
  const match = time.match(/(\d{1,2}):(\d{2})/);
  if (!match) return [0, 0];

  // 使用 parseInt 的第二个参数 10，强制十进制解析
  // 避免 "08" 被当作八进制
  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);

  return [hour, minute];
}

/**
 * 检查时间是否在误差范围内
 */
function isWithinTolerance(
  taskHour: number,
  taskMinute: number,
  nowHour: number,
  nowMinute: number
): boolean {
  // 转换为分钟数进行比较
  const taskTotalMinutes = taskHour * 60 + taskMinute;
  const nowTotalMinutes = nowHour * 60 + nowMinute;

  const diff = Math.abs(taskTotalMinutes - nowTotalMinutes);

  return diff <= TOLERANCE_MINUTES;
}

// ============================================
// 防重复执行
// ============================================

/**
 * 任务锁 - 防止同一任务在同一时间窗口内重复执行
 *
 * key 格式：`${taskName}|${taskTime}|${dateStr}`
 */
export class TaskLock {
  private executed: Set<string> = new Set();

  /**
   * 尝试获取锁
   * @returns true 表示可以执行，false 表示已执行过
   */
  tryAcquire(taskName: string, taskTime: string, now: Date): boolean {
    const key = this.buildKey(taskName, taskTime, now);

    if (this.executed.has(key)) {
      return false;
    }

    this.executed.add(key);
    return true;
  }

  /**
   * 构建锁的 key
   * 使用任务时间（而非当前时间）+ 日期，确保同一时间窗口内只执行一次
   */
  private buildKey(taskName: string, taskTime: string, now: Date): string {
    // 日期部分
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    // 间隔任务需要计算触发点
    const intervalMatch = taskTime.match(/^每(\d+)(分钟|m|小时|h)$/);
    if (intervalMatch) {
      const interval = parseInt(intervalMatch[1], 10);
      const unit = intervalMatch[2];

      if (unit === "分钟" || unit === "m") {
        // 计算当前所在的触发点（分钟）
        const nowMinute = now.getMinutes();
        const triggerMinute = Math.floor(nowMinute / interval) * interval;
        return `${taskName}|interval-${interval}m-${triggerMinute}|${dateStr}|${now.getHours()}`;
      } else {
        // 计算当前所在的触发点（小时）
        const nowHour = now.getHours();
        const triggerHour = Math.floor(nowHour / interval) * interval;
        return `${taskName}|interval-${interval}h-${triggerHour}|${dateStr}`;
      }
    }

    // 其他任务：提取任务时间中的 HH:MM 部分
    const timeMatch = taskTime.match(/(\d{1,2}:\d{2})/);
    const timeKey = timeMatch ? timeMatch[1] : taskTime;

    return `${taskName}|${timeKey}|${dateStr}`;
  }

  /**
   * 清空所有锁（用于测试）
   */
  clear(): void {
    this.executed.clear();
  }
}

// ============================================
// 调度器
// ============================================

const CHECK_INTERVAL = 60 * 1000; // 1 分钟

let intervalId: ReturnType<typeof setInterval> | null = null;
let taskLock: TaskLock | null = null;

export type ExecuteTaskFn = (task: Task, cwd: string) => void | Promise<void>;

/**
 * 启动定时任务调度器
 *
 * @param cwd 项目根目录
 * @param executeTask 任务执行函数（可注入，便于测试）
 */
export function startScheduler(cwd: string, executeTask: ExecuteTaskFn): void {
  if (intervalId) {
    console.log("[Scheduler] 已在运行中");
    return;
  }

  taskLock = new TaskLock();
  const tasksPath = path.join(cwd, ".claude/skills/scheduler/tasks.md");

  console.log("[Scheduler] 定时任务模块已启动");

  intervalId = setInterval(() => {
    checkAndExecuteTasks(tasksPath, cwd, executeTask);
  }, CHECK_INTERVAL);
}

/**
 * 停止定时任务调度器
 */
export function stopScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    taskLock = null;
    console.log("[Scheduler] 定时任务模块已停止");
  }
}

/**
 * 检查并执行匹配的任务
 */
function checkAndExecuteTasks(
  tasksPath: string,
  cwd: string,
  executeTask: ExecuteTaskFn
): void {
  // 检查文件是否存在
  if (!fs.existsSync(tasksPath)) {
    return; // 静默跳过
  }

  // 读取并解析任务
  let content: string;
  try {
    content = fs.readFileSync(tasksPath, "utf-8");
  } catch (error) {
    console.error("[Scheduler] 读取 tasks.md 失败:", error);
    return;
  }

  const tasks = parseTasks(content);
  const now = new Date();

  // 检查每个任务
  for (const task of tasks) {
    // 1. 检查时间是否匹配
    if (!matchTime(task.time, now)) continue;

    // 2. 检查是否在活跃时段
    if (task.activeHours && !isInActiveHours(now, task.activeHours)) {
      // console.log(`[Scheduler] 跳过任务（非活跃时段）: ${task.name}`);
      continue;
    }

    // 3. 检查是否已执行过
    if (!taskLock?.tryAcquire(task.name, task.time, now)) continue;

    // 4. 执行任务
    console.log(`[Scheduler] 执行任务: ${task.name}`);
    try {
      executeTask(task, cwd);
    } catch (error) {
      console.error(`[Scheduler] 任务执行失败: ${task.name}`, error);
    }
  }
}

/**
 * 检查当前时间是否在活跃时段内
 */
function isInActiveHours(now: Date, activeHours: { start: number; end: number }): boolean {
  const currentHour = now.getHours();

  // 处理跨天情况（如 22:00-02:00）
  if (activeHours.start <= activeHours.end) {
    // 正常情况：09:00-24:00
    return currentHour >= activeHours.start && currentHour < activeHours.end;
  } else {
    // 跨天情况：22:00-02:00
    return currentHour >= activeHours.start || currentHour < activeHours.end;
  }
}
