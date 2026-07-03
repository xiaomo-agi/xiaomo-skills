/**
 * 工作目录红线检查（Phase 2，参考 lark-coding-agent-bridge 的 workdir 防护）。
 *
 * 后端把 cwd 直接交给 Claude Code 会话当工作目录——如果落在文件系统根、
 * Home 根或系统目录上，Agent 的文件操作（尤其批量写/删）就是在裸奔。
 * 这里只挡"明确危险"的目录，不做白名单：合法项目路径千奇百怪
 * （/tmp/xxx、/opt/myapp、/var/www 都可能是正经项目），误杀比漏杀代价更高。
 */
import os from "os";
import path from "path";

/** 系统目录本身不能当工作目录（子目录不拦，/var/www 这类是合法项目路径） */
const UNIX_SYSTEM_DIRS = [
  "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot",
  "/var", "/opt", "/root", "/tmp", "/srv",
  "/System", "/Library", "/Applications", "/private", // macOS
];

/** 虚拟/设备文件系统：本身和整棵子树都不行 */
const UNIX_FORBIDDEN_TREES = ["/dev", "/proc", "/sys"];

/**
 * 检查 cwd 是否踩红线。返回踩线原因（用于报错文案），安全时返回 null。
 */
export function forbiddenWorkdirReason(cwd: string): string | null {
  const resolved = path.resolve(cwd);
  const root = path.parse(resolved).root;

  if (resolved === root) {
    return `工作目录不能是文件系统根目录（${resolved}）`;
  }

  const home = os.homedir();
  if (home && resolved === path.resolve(home)) {
    return `工作目录不能是 Home 根目录（${resolved}），请指定具体项目目录`;
  }

  if (process.platform === "win32") {
    const winDir = path.resolve(process.env.SystemRoot || "C:\\Windows");
    if (resolved.toLowerCase() === winDir.toLowerCase() ||
        resolved.toLowerCase().startsWith(winDir.toLowerCase() + path.sep)) {
      return `工作目录不能在 Windows 系统目录里（${resolved}）`;
    }
    return null;
  }

  for (const tree of UNIX_FORBIDDEN_TREES) {
    if (resolved === tree || resolved.startsWith(tree + "/")) {
      return `工作目录不能在虚拟/设备文件系统里（${resolved}）`;
    }
  }

  for (const dir of UNIX_SYSTEM_DIRS) {
    if (resolved === dir) {
      return `工作目录不能是系统目录本身（${resolved}），请用它下面的具体项目子目录`;
    }
  }
  return null;
}
