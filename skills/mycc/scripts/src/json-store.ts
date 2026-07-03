/**
 * JSON 运行时状态文件的统一读写。
 *
 * 写入走"临时文件 + rename"：rename 在同一文件系统上是原子操作，
 * 进程崩溃或 watchdog 拉起的新旧进程重叠写入时，读方永远只会看到
 * 完整的旧版本或完整的新版本，不会读到写了一半的 JSON。
 * （此前各处直接 writeFileSync 正式文件，崩溃可能留下损坏文件，
 * 损坏后所有持久化状态静默丢失——读取方 catch 后从空开始。）
 */
import fs from "fs";
import path from "path";

/** 读 JSON 文件；不存在或损坏时返回 null，由调用方决定兜底值 */
export function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** 原子写 JSON 文件（自动建目录；tmp 带 pid 防多进程互踩） */
export function writeJsonFileAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
