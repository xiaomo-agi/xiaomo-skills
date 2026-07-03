/**
 * json-store：运行时状态 JSON 的原子读写
 *
 * 背景：channel-sessions.json / channel-models.json / wishlist 数据之前直接
 * writeFileSync 正式文件，进程崩溃或新旧进程重叠写入可能留下写一半的 JSON，
 * 读取方 catch 后从空开始 → 持久化状态静默全丢。改为 tmp + rename 原子替换。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { readJsonFile, writeJsonFileAtomic } from "../src/json-store.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "json-store-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("json-store", () => {
  it("写入后能原样读回", () => {
    const file = path.join(dir, "a.json");
    writeJsonFileAtomic(file, { x: 1, nested: { y: ["中文", 2] } });
    expect(readJsonFile(file)).toEqual({ x: 1, nested: { y: ["中文", 2] } });
  });

  it("目录不存在时自动创建", () => {
    const file = path.join(dir, "deep/er/b.json");
    writeJsonFileAtomic(file, [1, 2, 3]);
    expect(readJsonFile(file)).toEqual([1, 2, 3]);
  });

  it("写入不留下临时文件", () => {
    const file = path.join(dir, "c.json");
    writeJsonFileAtomic(file, { ok: true });
    writeJsonFileAtomic(file, { ok: false });
    expect(fs.readdirSync(dir)).toEqual(["c.json"]);
  });

  it("文件不存在返回 null", () => {
    expect(readJsonFile(path.join(dir, "missing.json"))).toBeNull();
  });

  it("文件损坏返回 null 而不是抛异常", () => {
    const file = path.join(dir, "broken.json");
    fs.writeFileSync(file, '{"x": 1, "y":'); // 模拟写了一半的旧式落盘
    expect(readJsonFile(file)).toBeNull();
  });
});
