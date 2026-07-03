/**
 * 日程预约 API
 * 飞书日历打通：访客看空闲 → 预约 → 飞书自动创建日程
 *
 * 路由:
 *   GET  /api/schedule/token   — 获取一次性防伪 token
 *   GET  /api/schedule?start=&end=  — 查询忙闲时段
 *   GET  /api/schedule/events?start=&end=  — 已有预约列表
 *   POST /api/schedule/book    — 提交预约
 */

import { execSync } from "child_process";
import { IncomingMessage, ServerResponse } from "http";
import crypto from "crypto";

// ============================================================
// 类型
// ============================================================

interface BusySlot {
  start: string;
  end: string;
  status: "busy" | "tentative";
}

interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
  status: "busy" | "tentative" | "booked";
}

interface BookingRequest {
  start: string;
  end: string;
  name: string;
  email: string;
  topic?: string;
  notes?: string;
  token: string;
}

// ============================================================
// 配置
// ============================================================

const CONFIG = {
  userId: process.env.FEISHU_USER_ID || "",
  workStart: process.env.SCHEDULE_WORK_START || "09:00",
  workEnd: process.env.SCHEDULE_WORK_END || "18:00",
  durations: (process.env.SCHEDULE_DURATIONS || "30,60").split(",").map(Number),
  minAdvance: Number(process.env.SCHEDULE_MIN_ADVANCE) || 2,
  maxDays: Number(process.env.SCHEDULE_MAX_DAYS) || 30,
  rateLimit: Number(process.env.SCHEDULE_RATE_LIMIT) || 5,
  showBookerName: process.env.SHOW_BOOKER_NAME === "true",
};

// ============================================================
// Token 管理（一次性，30分钟过期）
// ============================================================

const tokens = new Map<string, number>();

function generateToken(): string {
  const token = crypto.randomBytes(16).toString("hex");
  tokens.set(token, Date.now() + 30 * 60 * 1000);
  return token;
}

function consumeToken(token: string): boolean {
  const expiresAt = tokens.get(token);
  if (!expiresAt || Date.now() > expiresAt) {
    tokens.delete(token);
    return false;
  }
  tokens.delete(token); // 一次性
  return true;
}

// 定期清理过期 token
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of tokens) {
    if (now > exp) tokens.delete(t);
  }
}, 5 * 60 * 1000).unref();

// ============================================================
// IP 频率限制
// ============================================================

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = rateLimitMap.get(ip);

  if (record && now > record.resetAt) {
    rateLimitMap.delete(ip);
  }

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 3600_000 });
    return true;
  }

  const current = rateLimitMap.get(ip)!;
  if (current.count >= CONFIG.rateLimit) return false;

  current.count++;
  return true;
}

// 定期清理过期限制记录
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of rateLimitMap) {
    if (now > rec.resetAt) rateLimitMap.delete(ip);
  }
}, 10 * 60 * 1000).unref();

// ============================================================
// lark-cli 调用封装
// ============================================================

/** 执行 lark-cli 命令，返回 JSON */
function larkCli(args: string, timeout = 15_000): any {
  // 所有日历操作以 user 身份
  const cmd = `lark-cli ${args} --as user --format json`;
  console.log(`[Schedule] lark-cli: ${args.substring(0, 120)}`);
  try {
    const output = execSync(cmd, { encoding: "utf-8", timeout });
    return JSON.parse(output);
  } catch (err: any) {
    const stderr = err.stderr || err.message || "";
    console.error(`[Schedule] lark-cli 失败: ${stderr.substring(0, 200)}`);
    throw err;
  }
}

/** 查询忙闲时段 */
function getFreeBusy(start: string, end: string): BusySlot[] {
  const result = larkCli(
    `calendar +freebusy --start "${start}" --end "${end}"`,
  );
  // +freebusy 返回: [{ start_time, end_time, rsvp_status }]
  const slots: BusySlot[] = [];
  const arr = Array.isArray(result) ? result : (result.data || result.busy || []);
  for (const s of arr) {
    const status = s.rsvp_status === "decline" ? null : // 拒绝 = 实际空闲
                   s.rsvp_status === "tentative" ? "tentative" as const : "busy" as const;
    if (!status) continue;
    slots.push({
      start: s.start_time || s.start,
      end: s.end_time || s.end,
      status,
    });
  }
  return slots;
}

/** 创建日程 */
function createEvent(summary: string, description: string, start: string, end: string): { eventId: string } {
  // 对 shell 参数转义（防止 summary/description 中的特殊字符）
  const esc = (s: string) => s.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');

  const cmd = [
    `calendar +create`,
    `--summary "${esc(summary)}"`,
    `--start "${start}"`,
    `--end "${end}"`,
    `--description "${esc(description)}"`,
  ].join(" ");

  const result = larkCli(cmd);
  // 返回格式取决于 lark-cli 版本，兼容处理
  const eventId = result.event_id || result.id || result.data?.event_id || "";
  return { eventId };
}

/** 查询日程列表（过滤只返回网站预约） */
function searchEvents(start: string, end: string): CalendarEvent[] {
  const result = larkCli(
    `calendar +agenda --start "${start}" --end "${end}"`,
  );
  const arr = Array.isArray(result) ? result : (result.data || []);
  return arr
    .filter((e: any) => {
      const title = e.summary || e.event_summary || "";
      return title.startsWith("[网站预约]");
    })
    .map((e: any) => ({
      summary: e.summary || e.event_summary || "",
      start: e.start_time || e.start || "",
      end: e.end_time || e.end || "",
      status: "booked" as const,
    }));
}

// ============================================================
// 路由处理器（公开，无需 mycc auth）
// ============================================================

export async function handleScheduleRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  // GET /api/schedule/token
  if (pathname === "/api/schedule/token" && req.method === "GET") {
    const token = generateToken();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ token, expiresIn: 1800 }));
    return true;
  }

  // GET /api/schedule
  if (pathname === "/api/schedule" && req.method === "GET") {
    await handleGetSchedule(req, res);
    return true;
  }

  // GET /api/schedule/events
  if (pathname === "/api/schedule/events" && req.method === "GET") {
    await handleGetEvents(req, res);
    return true;
  }

  // POST /api/schedule/book
  if (pathname === "/api/schedule/book" && req.method === "POST") {
    await handleBook(req, res);
    return true;
  }

  return false;
}

// ============================================================
// Handler: 查询忙闲
// ============================================================

async function handleGetSchedule(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "", `http://localhost`);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");

  if (!start || !end) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "start 和 end 参数必填" }));
    return;
  }

  try {
    const busy = getFreeBusy(start, end);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      busy,
      workingHours: { start: CONFIG.workStart, end: CONFIG.workEnd },
    }));
  } catch (err: any) {
    console.error("[Schedule] 查询忙闲失败:", err.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "查询失败" }));
  }
}

// ============================================================
// Handler: 已有预约
// ============================================================

async function handleGetEvents(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "", `http://localhost`);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");

  if (!start || !end) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "start 和 end 参数必填" }));
    return;
  }

  try {
    const events = searchEvents(start, end);
    const filtered = events.map((e) => {
      if (!CONFIG.showBookerName) {
        return { start: e.start, end: e.end, status: "booked" };
      }
      return e;
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ events: filtered }));
  } catch (err: any) {
    console.error("[Schedule] 查询日程失败:", err.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "查询失败" }));
  }
}

// ============================================================
// Handler: 预约
// ============================================================

async function handleBook(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: BookingRequest;
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "无效的 JSON" }));
    return;
  }

  const { start, end, name, email, topic, notes, token } = parsed;

  // 1. 必填校验
  if (!name || !email || !start || !end || !token) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "缺少必填字段（name, email, start, end, token）" }));
    return;
  }

  // 2. 邮箱格式
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "邮箱格式不正确" }));
    return;
  }

  // 3. token 校验
  if (!consumeToken(token)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "token 无效或已过期，请刷新页面重试" }));
    return;
  }

  // 4. 频率限制
  const ip =
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown";
  if (!checkRateLimit(ip)) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "请求过于频繁，请稍后再试" }));
    return;
  }

  // 5. 再次确认空闲（防并发冲突）
  try {
    const busy = getFreeBusy(start, end);
    if (busy.length > 0) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "time_conflict",
          message: "该时段已被预约，请选择其他时间",
        }),
      );
      return;
    }
  } catch (err: any) {
    console.error("[Schedule] 确认空闲失败:", err.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "预约失败，请稍后重试" }));
    return;
  }

  // 6. Honeypot 检测（前端隐藏字段 phone，填了就拒绝）
  if ((parsed as any).phone) {
    // 悄悄拒绝，不告诉 bot
    console.log(`[Schedule] Honeypot 触发，拒绝预约 (IP: ${ip})`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, event: { summary: "已记录" } }));
    return;
  }

  // 7. 创建飞书日程
  try {
    const summary = `[网站预约] ${name}${topic ? ` - ${topic}` : ""}`;
    const description = [
      `访客姓名：${name}`,
      `联系方式：${email}`,
      topic ? `事由：${topic}` : "",
      notes ? `备注：${notes}` : "",
      "",
      `⏰ 此日程来自个人网站预约`,
      `📅 预约时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
    ]
      .filter(Boolean)
      .join("\n");

    const { eventId } = createEvent(summary, description, start, end);

    console.log(`[Schedule] ✅ 预约成功: ${summary} (${start} - ${end})`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        event: {
          id: eventId,
          summary,
          start,
          end,
        },
      }),
    );
  } catch (err: any) {
    console.error("[Schedule] 创建日程失败:", err.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "创建日程失败，请稍后重试" }));
  }
}

// ============================================================
// 工具
// ============================================================

function readBody(req: IncomingMessage, maxBytes = 100 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
