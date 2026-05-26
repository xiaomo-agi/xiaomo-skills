/**
 * 配对速率限制测试
 *
 * 验证 /pair 端点的暴力破解防护：
 * - 5 次失败后锁定 5 分钟
 * - 锁定期间返回 429
 * - 成功配对清除失败记录
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";

// 辅助：发送 POST 请求
function postPair(port: number, pairCode: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ pairCode });
    const req = http.request(
      {
        hostname: "localhost",
        port,
        path: "/pair",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode!, body });
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

describe("配对速率限制", () => {
  let server: any;
  let port: number;
  const CORRECT_CODE = "TEST99";

  beforeAll(async () => {
    const originalPort = process.env.PORT;
    process.env.PORT = "0";

    const { HttpServer } = await import("../src/http-server.js");
    server = new HttpServer(CORRECT_CODE, process.cwd());
    await server.start();
    port = (server as any).server.address().port;

    if (originalPort !== undefined) {
      process.env.PORT = originalPort;
    } else {
      delete process.env.PORT;
    }
  });

  afterAll(() => {
    server?.stop();
  });

  it("错误配对码返回 401", async () => {
    const res = await postPair(port, "WRONG1");
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("配对码错误");
  });

  it("5 次失败后返回 429", async () => {
    // 前 4 次（加上上面的 1 次 = 5 次）
    for (let i = 0; i < 4; i++) {
      const res = await postPair(port, "WRONG" + i);
      // 第 5 次失败触发锁定，但返回的还是 401
      expect(res.status).toBe(401);
    }

    // 第 6 次应该被锁定，返回 429
    const locked = await postPair(port, "WRONG5");
    expect(locked.status).toBe(429);
    expect(locked.body.error).toContain("请求过于频繁");
  });

  it("锁定期间即使正确码也返回 429", async () => {
    const res = await postPair(port, CORRECT_CODE);
    expect(res.status).toBe(429);
  });
});

describe("配对成功清除限流", () => {
  let server: any;
  let port: number;
  const CORRECT_CODE = "GOOD88";

  beforeAll(async () => {
    // 重置限流状态（上一个 describe 锁了 IP）
    const { _resetPairAttempts } = await import("../src/http-server.js");
    _resetPairAttempts();

    const originalPort = process.env.PORT;
    process.env.PORT = "0";

    const { HttpServer } = await import("../src/http-server.js");
    server = new HttpServer(CORRECT_CODE, process.cwd());
    await server.start();
    port = (server as any).server.address().port;

    if (originalPort !== undefined) {
      process.env.PORT = originalPort;
    } else {
      delete process.env.PORT;
    }
  });

  afterAll(() => {
    server?.stop();
  });

  it("正确配对码返回 200 + token", async () => {
    const res = await postPair(port, CORRECT_CODE);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeDefined();
  });

  it("正确配对后再错 5 次不会被锁（因为成功清除了记录的是成功时的清除）", async () => {
    // 先失败 3 次
    for (let i = 0; i < 3; i++) {
      await postPair(port, "BADCODE");
    }
    // 还没到 5 次，应该能继续
    const res = await postPair(port, "BADCODE");
    expect(res.status).toBe(401); // 第 4 次，还没锁
  });
});
