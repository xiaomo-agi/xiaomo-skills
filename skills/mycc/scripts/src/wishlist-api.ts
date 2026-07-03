/**
 * 愿望清单 API
 * 公开端点（无需 mycc auth）：GET /api/wishlist, GET /api/wishlist/token, POST /api/wishlist/claim
 * 保护端点（需 Bearer token）：POST /api/wishlist/confirm
 */

import http from "http";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { writeJsonFileAtomic } from "./json-store.js";

const DATA_DIR = join(process.env.HOME || process.env.USERPROFILE || "", ".mycc");
const DATA_FILE = join(DATA_DIR, "wishlist-data.json");

// IP 限流：每 IP 每小时最多 3 次认领
const ipLimits = new Map<string, { count: number; resetAt: number }>();

// 一次性 token：30 分钟过期
const claimTokens = new Map<string, number>();

// 每 10 分钟清理过期数据
setInterval(() => {
  const now = Date.now();
  for (const [ip, v] of ipLimits) {
    if (now > v.resetAt) ipLimits.delete(ip);
  }
  for (const [t, expires] of claimTokens) {
    if (now > expires) claimTokens.delete(t);
  }
}, 10 * 60 * 1000);

// ========== 数据读写 ==========

interface WishlistItem {
  id: string;
  name: string;
  emoji: string;
  price: number;
  quantity: number;
  link: string;
  platform: string;
  status: "available" | "claimed" | "fulfilled";
  claimer: { wechatName: string; wechatId: string; claimedAt: string } | null;
  confirmedAt: string | null;
}

interface ClaimRecord {
  id: string;
  itemId: string;
  wechatName: string;
  wechatId: string;
  claimedAt: string;
  confirmed: boolean;
  confirmedAt: string | null;
  points: number;
}

interface WishlistData {
  items: WishlistItem[];
  claims: ClaimRecord[];
}

const DEFAULT_DATA: WishlistData = {
  items: [
    { id: "1", name: "贵妃椅", emoji: "🛋️", price: 3000, quantity: 1, link: "https://search.jd.com/Search?keyword=贵妃椅", platform: "京东", status: "available", claimer: null, confirmedAt: null },
    { id: "2", name: "OSIM 智能按摩椅 贵妃款", emoji: "👑", price: 10000, quantity: 1, link: "https://search.jd.com/Search?keyword=OSIM 按摩椅 贵妃", platform: "京东/线下", status: "available", claimer: null, confirmedAt: null },
    { id: "3", name: "API 额度充值", emoji: "💰", price: 250, quantity: 99, link: "#", platform: "微信转账代充", status: "available", claimer: null, confirmedAt: null },
    { id: "4", name: "Mac Mini 顶配", emoji: "🖥️", price: 15000, quantity: 1, link: "https://www.apple.com.cn/mac-mini/", platform: "Apple", status: "available", claimer: null, confirmedAt: null },
    { id: "5", name: "DJI Action 5 Pro 续航套装", emoji: "📸", price: 3299, quantity: 1, link: "https://store.dji.com/cn", platform: "大疆", status: "available", claimer: null, confirmedAt: null },
    { id: "6", name: "AI 音箱（小爱同学优先）", emoji: "🔊", price: 500, quantity: 1, link: "https://search.jd.com/Search?keyword=小爱音箱", platform: "京东", status: "available", claimer: null, confirmedAt: null },
  ],
  claims: [],
};

function readData(): WishlistData {
  try {
    if (!existsSync(DATA_FILE)) {
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      writeJsonFileAtomic(DATA_FILE, DEFAULT_DATA);
      return JSON.parse(JSON.stringify(DEFAULT_DATA));
    }
    return JSON.parse(readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
}

function writeData(data: WishlistData): void {
  writeJsonFileAtomic(DATA_FILE, data);
}

// ========== 辅助 ==========

function json(res: http.ServerResponse, code: number, data: any): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}

function getIP(req: http.IncomingMessage): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "127.0.0.1";
}

function generateToken(): string {
  return Array.from({ length: 32 }, () => Math.random().toString(36)[2]).join("");
}

function validateWechatId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{5,40}$/.test(id);
}

// ========== 排行榜 ==========

function getLeaderboard(data: WishlistData) {
  const map = new Map<string, { name: string; points: number; count: number; wechatId: string }>();
  for (const c of data.claims.filter((c) => c.confirmed)) {
    const existing = map.get(c.wechatId) || { name: c.wechatName, points: 0, count: 0, wechatId: c.wechatId };
    existing.points += c.points;
    existing.count += 1;
    map.set(c.wechatId, existing);
  }
  return Array.from(map.values()).sort((a, b) => b.points - a.points);
}

// ========== 路由处理 ==========

export async function handleWishlistRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  authToken: string | null
): Promise<boolean> {
  const method = req.method || "GET";

  // GET /api/wishlist — 获取全部数据（物品 + 榜单）
  if (pathname === "/api/wishlist" && method === "GET") {
    const data = readData();
    const leaderboard = getLeaderboard(data);
    json(res, 200, { ok: true, items: data.items, leaderboard });
    return true;
  }

  // GET /api/wishlist/token — 获取一次性认领 token
  if (pathname === "/api/wishlist/token" && method === "GET") {
    const token = generateToken();
    claimTokens.set(token, Date.now() + 30 * 60 * 1000);
    json(res, 200, { ok: true, token });
    return true;
  }

  // POST /api/wishlist/claim — 认领物品
  if (pathname === "/api/wishlist/claim" && method === "POST") {
    const ip = getIP(req);
    const now = Date.now();

    // IP 限流
    const limit = ipLimits.get(ip);
    if (limit && now < limit.resetAt) {
      if (limit.count >= 3) {
        json(res, 429, { ok: false, error: "操作太频繁，请稍后再试" });
        return true;
      }
      limit.count++;
    } else {
      ipLimits.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
    }

    const body = await readBody(req);
    let parsed: any;
    try { parsed = JSON.parse(body); } catch {
      json(res, 400, { ok: false, error: "JSON 解析失败" });
      return true;
    }

    const { itemId, wechatName, wechatId, token, phone } = parsed;

    // Honeypot
    if (phone) {
      json(res, 200, { ok: true, message: "认领成功（系统处理中）" });
      return true;
    }

    // Token 校验
    if (!token || !claimTokens.has(token)) {
      json(res, 400, { ok: false, error: "token 无效或已过期，请刷新页面重试" });
      return true;
    }
    claimTokens.delete(token);

    // 字段校验
    if (!itemId || !wechatName || !wechatId) {
      json(res, 400, { ok: false, error: "请填写完整信息" });
      return true;
    }
    if (wechatName.length > 20) {
      json(res, 400, { ok: false, error: "微信昵称太长" });
      return true;
    }
    if (!validateWechatId(wechatId)) {
      json(res, 400, { ok: false, error: "微信号格式不对" });
      return true;
    }

    const data = readData();
    const item = data.items.find((i) => i.id === itemId);
    if (!item) {
      json(res, 404, { ok: false, error: "物品不存在" });
      return true;
    }
    if (item.status !== "available") {
      json(res, 409, { ok: false, error: "该物品已被认领" });
      return true;
    }

    // 原子更新
    item.status = "claimed";
    item.claimer = { wechatName, wechatId, claimedAt: new Date().toISOString() };

    const claimId = "c_" + generateToken().substring(0, 12);
    data.claims.push({
      id: claimId,
      itemId,
      wechatName,
      wechatId,
      claimedAt: new Date().toISOString(),
      confirmed: false,
      confirmedAt: null,
      points: item.price,
    });

    writeData(data);

    json(res, 200, { ok: true, claimId, message: "认领成功！小mo确认收货后你会出现在榜单上 ✨" });
    return true;
  }

  // POST /api/wishlist/confirm — 确认收货（需 Bearer token）
  if (pathname === "/api/wishlist/confirm" && method === "POST") {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace("Bearer ", "");
    if (!authToken || token !== authToken) {
      json(res, 401, { ok: false, error: "未授权" });
      return true;
    }

    const body = await readBody(req);
    let parsed: any;
    try { parsed = JSON.parse(body); } catch {
      json(res, 400, { ok: false, error: "JSON 解析失败" });
      return true;
    }
    const { claimId } = parsed;
    if (!claimId) {
      json(res, 400, { ok: false, error: "缺少 claimId" });
      return true;
    }

    const data = readData();
    const claim = data.claims.find((c) => c.id === claimId);
    if (!claim) {
      json(res, 404, { ok: false, error: "认领记录不存在" });
      return true;
    }
    if (claim.confirmed) {
      json(res, 409, { ok: false, error: "已经确认过了" });
      return true;
    }

    claim.confirmed = true;
    claim.confirmedAt = new Date().toISOString();

    const item = data.items.find((i) => i.id === claim.itemId);
    if (item) {
      item.status = "fulfilled";
      item.confirmedAt = new Date().toISOString();
    }

    writeData(data);

    const lb = getLeaderboard(data);
    const rank = lb.findIndex((l) => l.wechatId === claim.wechatId) + 1;

    json(res, 200, {
      ok: true,
      message: `已确认！${claim.wechatName} 当前排名第 ${rank}，累计 ${lb[rank - 1]?.points || claim.points} 积分`,
    });
    return true;
  }

  return false;
}
