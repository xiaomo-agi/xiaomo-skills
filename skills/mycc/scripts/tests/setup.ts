/**
 * 全局测试 setup：把运行时状态目录（MYCC_DATA_DIR）重定向到每个测试文件独立的临时目录。
 *
 * 背景（2026-07-02 事故）：feishu-commands.test.ts 等测试文件的 cleanPersistedState()
 * 之前直接操作 src/data/（生产环境实际在用的目录），每次跑测试都会删掉正在运行的 bot
 * 的 channel-models.json / channel-sessions.json —— 导致用户 /model fable5 切换的模型
 * 在下一次 `npm test` 后静默丢失，重启后回落到默认模型且没有任何报错。
 */
import os from "os";
import path from "path";
import fs from "fs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mycc-test-data-"));
process.env.MYCC_DATA_DIR = dir;
