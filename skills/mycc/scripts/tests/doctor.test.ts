import { describe, it, expect } from "vitest";
import {
  checkNodeVersion,
  checkFeishuCredentials,
  checkPatchSdk,
  findOnPath,
  renderDoctor,
} from "../src/doctor.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("checkNodeVersion", () => {
  it.each(["v18.0.0", "v20.11.1", "v22.3.0"])("%s → pass", (v) => {
    expect(checkNodeVersion(v)).toMatchObject({ status: "pass" });
  });
  it.each(["v16.20.2", "v12.22.0"])("%s → fail（<18）", (v) => {
    expect(checkNodeVersion(v)).toMatchObject({ status: "fail" });
  });
  it("解析失败 → warn 不崩", () => {
    expect(checkNodeVersion("weird")).toMatchObject({ status: "warn" });
  });
});

describe("checkFeishuCredentials（只报有无，不回显值）", () => {
  it("默认通道配齐 → pass", () => {
    const r = checkFeishuCredentials({ FEISHU_APP_ID: "cli_secret_value", FEISHU_APP_SECRET: "topsecret" });
    expect(r.some((x) => x.status === "pass")).toBe(true);
    const text = JSON.stringify(r);
    expect(text).not.toContain("cli_secret_value");
    expect(text).not.toContain("topsecret");
  });
  it("只配一半 → warn 并点名缺哪个", () => {
    const r = checkFeishuCredentials({ FEISHU_B_APP_ID: "cli_x" });
    expect(r[0]).toMatchObject({ status: "warn" });
    expect(r[0].detail).toContain("FEISHU_B_APP_SECRET");
  });
  it("全空 → warn 提示从 .env.example 开始", () => {
    const r = checkFeishuCredentials({});
    expect(r[0]).toMatchObject({ status: "warn" });
    expect(r[0].detail).toContain(".env.example");
  });
  it("多通道只对配齐的报 pass", () => {
    const r = checkFeishuCredentials({
      FEISHU_APP_ID: "cli_a",
      FEISHU_APP_SECRET: "s",
      FEISHU_B_APP_ID: "cli_b",
      FEISHU_B_APP_SECRET: "s2",
    });
    expect(r.filter((x) => x.status === "pass")).toHaveLength(2);
  });
});

describe("checkPatchSdk", () => {
  it("脚本存在 → pass", () => {
    const dir = mkdtempSync(join(tmpdir(), "mycc-doc-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "patch-sdk.mjs"), "// patched");
    expect(checkPatchSdk(dir)).toMatchObject({ status: "pass" });
  });
  it("缺失 → warn", () => {
    const dir = mkdtempSync(join(tmpdir(), "mycc-doc2-"));
    expect(checkPatchSdk(dir)).toMatchObject({ status: "warn" });
  });
});

describe("findOnPath", () => {
  it("node 一定在 PATH 上", () => {
    expect(findOnPath(process.platform === "win32" ? "node.exe" : "node")).not.toBeNull();
  });
  it("不存在的命令 → null 不抛", () => {
    expect(findOnPath("definitely-not-a-real-cmd-xyz")).toBeNull();
  });
});

describe("renderDoctor", () => {
  it("fail 计数进汇总，退出码置 1", () => {
    const { text, failCount } = renderDoctor([
      { name: "A", status: "pass", detail: "ok" },
      { name: "B", status: "warn", detail: "meh" },
      { name: "C", status: "fail", detail: "bad" },
    ]);
    expect(failCount).toBe(1);
    expect(text).toContain("1 pass / 1 warn / 1 fail");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0; // 还原，别污染其他用例
  });
  it("全 pass 退出码不动", () => {
    const before = process.exitCode;
    renderDoctor([{ name: "A", status: "pass", detail: "ok" }]);
    expect(process.exitCode).toBe(before ?? 0);
  });
});
