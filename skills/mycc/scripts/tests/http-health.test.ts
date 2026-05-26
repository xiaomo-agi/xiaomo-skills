/**
 * Health 接口测试 - hostname 字段
 *
 * 验证 health 接口返回 hostname（多设备管理需要）
 */

import { describe, it, expect } from "vitest";
import http from "http";
import os from "os";

describe("health 接口", () => {
  it("os.hostname() 能正常返回字符串", () => {
    const hostname = os.hostname();
    expect(typeof hostname).toBe("string");
    expect(hostname.length).toBeGreaterThan(0);
  });

  it("health 响应应包含 status, paired, hostname 三个字段", async () => {
    // 设置随机端口，必须在 import 之前（PORT 在模块加载时读取）
    const originalPort = process.env.PORT;
    process.env.PORT = "0";

    try {
      // 动态 import，确保读到 PORT=0
      const { HttpServer } = await import("../src/http-server.js");
      const server = new HttpServer("ABC123", process.cwd());

      await server.start();

      // start() 返回 Number(PORT)=0，需要从 server 获取实际端口
      const address = (server as any).server.address();
      const port = address.port;

      try {
        const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
          http.get(`http://localhost:${port}/health`, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
              try {
                resolve(JSON.parse(data));
              } catch (e) {
                reject(e);
              }
            });
          }).on("error", reject);
        });

        expect(response.status).toBe("ok");
        expect(response).toHaveProperty("paired");
        expect(response).toHaveProperty("hostname");
        expect(typeof response.hostname).toBe("string");
        expect(response.hostname).toBe(os.hostname());
      } finally {
        server.stop();
      }
    } finally {
      if (originalPort !== undefined) {
        process.env.PORT = originalPort;
      } else {
        delete process.env.PORT;
      }
    }
  });
});
