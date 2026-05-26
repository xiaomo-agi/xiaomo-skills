/**
 * SessionStats 单元测试
 *
 * 验证从 HttpServer 提取的会话统计模块：
 * - 工具调用分类统计（Write/Read/Bash）
 * - 消息计数
 * - session 生命周期（cleanup / getActiveCount）
 * - 边界情况（undefined sessionId、未知工具名）
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SessionStats } from "../src/session-stats.js";

describe("SessionStats", () => {
  let stats: SessionStats;

  beforeEach(() => {
    stats = new SessionStats();
  });

  // ============ incrementToolStat ============

  describe("incrementToolStat", () => {
    it("Write/Edit/NotebookEdit 归类为 Write", () => {
      const sid = "sess-1";
      stats.incrementToolStat(sid, "Write");
      stats.incrementToolStat(sid, "Edit");
      stats.incrementToolStat(sid, "NotebookEdit");

      const result = stats.getToolStats(sid);
      expect(result.Write).toBe(3);
      expect(result.Read).toBe(0);
      expect(result.Bash).toBe(0);
    });

    it("Read/Glob/Grep 归类为 Read", () => {
      const sid = "sess-2";
      stats.incrementToolStat(sid, "Read");
      stats.incrementToolStat(sid, "Glob");
      stats.incrementToolStat(sid, "Grep");

      const result = stats.getToolStats(sid);
      expect(result.Read).toBe(3);
      expect(result.Write).toBe(0);
      expect(result.Bash).toBe(0);
    });

    it("Bash 归类为 Bash", () => {
      const sid = "sess-3";
      stats.incrementToolStat(sid, "Bash");
      stats.incrementToolStat(sid, "Bash");

      const result = stats.getToolStats(sid);
      expect(result.Bash).toBe(2);
    });

    it("未知工具名不计入任何分类", () => {
      const sid = "sess-4";
      stats.incrementToolStat(sid, "UnknownTool");
      stats.incrementToolStat(sid, "WebSearch");
      stats.incrementToolStat(sid, "SendMessage");

      const result = stats.getToolStats(sid);
      expect(result.Write).toBe(0);
      expect(result.Read).toBe(0);
      expect(result.Bash).toBe(0);
    });

    it("undefined sessionId 时不报错、不记录", () => {
      stats.incrementToolStat(undefined, "Write");
      expect(stats.getAllSessionIds()).toHaveLength(0);
    });

    it("多 session 独立计数", () => {
      stats.incrementToolStat("a", "Write");
      stats.incrementToolStat("a", "Write");
      stats.incrementToolStat("b", "Read");

      expect(stats.getToolStats("a").Write).toBe(2);
      expect(stats.getToolStats("b").Read).toBe(1);
      expect(stats.getToolStats("a").Read).toBe(0);
    });
  });

  // ============ incrementMessageCount ============

  describe("incrementMessageCount", () => {
    it("正常累加", () => {
      stats.incrementMessageCount("sess-1");
      stats.incrementMessageCount("sess-1");
      stats.incrementMessageCount("sess-1");

      expect(stats.getMessageCount("sess-1")).toBe(3);
    });

    it("undefined sessionId 时不报错、不记录", () => {
      stats.incrementMessageCount(undefined);
      expect(stats.getAllSessionIds()).toHaveLength(0);
    });

    it("不同 session 独立计数", () => {
      stats.incrementMessageCount("a");
      stats.incrementMessageCount("a");
      stats.incrementMessageCount("b");

      expect(stats.getMessageCount("a")).toBe(2);
      expect(stats.getMessageCount("b")).toBe(1);
    });
  });

  // ============ getToolStats ============

  describe("getToolStats", () => {
    it("不存在的 session 返回全零", () => {
      const result = stats.getToolStats("nonexistent");
      expect(result).toEqual({ Write: 0, Read: 0, Bash: 0 });
    });
  });

  // ============ getMessageCount ============

  describe("getMessageCount", () => {
    it("不存在的 session 返回 0", () => {
      expect(stats.getMessageCount("nonexistent")).toBe(0);
    });
  });

  // ============ getAllSessionIds ============

  describe("getAllSessionIds", () => {
    it("空状态返回空数组", () => {
      expect(stats.getAllSessionIds()).toEqual([]);
    });

    it("合并 toolStats 和 messageCount 的 key", () => {
      stats.incrementToolStat("sess-tool", "Bash");
      stats.incrementMessageCount("sess-msg");
      stats.incrementToolStat("sess-both", "Read");
      stats.incrementMessageCount("sess-both");

      const ids = stats.getAllSessionIds();
      expect(ids).toContain("sess-tool");
      expect(ids).toContain("sess-msg");
      expect(ids).toContain("sess-both");
      expect(ids).toHaveLength(3);
    });

    it("不返回重复 ID", () => {
      // 同一 session 在两个 map 都有
      stats.incrementToolStat("same", "Write");
      stats.incrementMessageCount("same");

      const ids = stats.getAllSessionIds();
      expect(ids.filter(id => id === "same")).toHaveLength(1);
    });
  });

  // ============ cleanup ============

  describe("cleanup", () => {
    it("删除指定 session 的所有统计", () => {
      stats.incrementToolStat("sess-1", "Write");
      stats.incrementMessageCount("sess-1");

      stats.cleanup("sess-1");

      expect(stats.getToolStats("sess-1")).toEqual({ Write: 0, Read: 0, Bash: 0 });
      expect(stats.getMessageCount("sess-1")).toBe(0);
      expect(stats.getAllSessionIds()).not.toContain("sess-1");
    });

    it("清理不存在的 session 不报错", () => {
      expect(() => stats.cleanup("nonexistent")).not.toThrow();
    });

    it("清理一个 session 不影响其他 session", () => {
      stats.incrementToolStat("keep", "Bash");
      stats.incrementMessageCount("keep");
      stats.incrementToolStat("remove", "Write");
      stats.incrementMessageCount("remove");

      stats.cleanup("remove");

      expect(stats.getToolStats("keep").Bash).toBe(1);
      expect(stats.getMessageCount("keep")).toBe(1);
      expect(stats.getAllSessionIds()).toContain("keep");
      expect(stats.getAllSessionIds()).not.toContain("remove");
    });
  });

  // ============ getActiveCount ============

  describe("getActiveCount", () => {
    it("空状态返回 0", () => {
      expect(stats.getActiveCount()).toBe(0);
    });

    it("等于 toolStats 的 key 数量（与 HttpServer 心跳行为一致）", () => {
      stats.incrementToolStat("a", "Write");
      stats.incrementToolStat("b", "Read");

      expect(stats.getActiveCount()).toBe(2);
    });

    it("只在 messageCount 中的 session 不计入 activeCount", () => {
      // 模拟：只收到消息但还没用工具
      stats.incrementMessageCount("msg-only");

      expect(stats.getActiveCount()).toBe(0);
    });

    it("cleanup 后 activeCount 减少", () => {
      stats.incrementToolStat("a", "Write");
      stats.incrementToolStat("b", "Read");
      expect(stats.getActiveCount()).toBe(2);

      stats.cleanup("a");
      expect(stats.getActiveCount()).toBe(1);
    });
  });
});
