/**
 * 配置管理
 */

import { existsSync, readFileSync, unlinkSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { DeviceConfig } from "./types.js";
import { getRoot } from "./platform.js";

/**
 * 获取配置目录（统一逻辑）
 * 优先级：MYCC_SKILL_DIR > cwd/.claude/skills/mycc > ~/.mycc/
 */
export function getConfigDir(cwd: string): string {
  const envSkillDir = process.env.MYCC_SKILL_DIR;
  const cwdSkillDir = join(cwd, ".claude", "skills", "mycc");
  const homeDir = join(homedir(), ".mycc");

  if (envSkillDir && existsSync(envSkillDir)) {
    return envSkillDir;
  } else if (existsSync(cwdSkillDir)) {
    return cwdSkillDir;
  } else {
    return homeDir;
  }
}

/**
 * 加载设备配置（从 current.json）
 */
export function loadConfig(cwd: string): DeviceConfig | null {
  const configPath = join(getConfigDir(cwd), "current.json");
  try {
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, "utf-8");
      const data = JSON.parse(content);
      // 只要有 deviceId 和 pairCode 就算有效配置
      if (data.deviceId && data.pairCode) {
        return data as DeviceConfig;
      }
    }
  } catch (err) {
    console.error("警告: 读取配置文件失败，将创建新配置");
  }
  return null;
}

/**
 * 删除设备配置（用于 --reset）
 */
export function deleteConfig(cwd: string): void {
  const configPath = join(getConfigDir(cwd), "current.json");
  try {
    if (existsSync(configPath)) {
      unlinkSync(configPath);
      console.log("已删除旧配置，将重新生成");
    }
  } catch {
    // 忽略
  }
}

/**
 * 自动查找项目根目录
 * 从当前目录向上查找，直到找到包含 .claude/ 或 claude.md (不区分大小写) 的目录
 */
export function findProjectRoot(startDir: string): string | null {
  let current = startDir;
  const root = getRoot(startDir);

  while (current !== root) {
    // 检查是否包含 .claude 目录
    if (existsSync(join(current, ".claude"))) {
      return current;
    }

    // 检查是否包含 claude.md（不区分大小写）
    try {
      const files = readdirSync(current);
      const hasClaudeMd = files.some(f => f.toLowerCase() === "claude.md");
      if (hasClaudeMd) {
        return current;
      }
    } catch {
      // 读取目录失败，跳过
    }

    // 向上一级
    const parent = join(current, "..");
    if (parent === current) break;
    current = parent;
  }

  return null;
}
