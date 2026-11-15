import { describe, expect, it } from "vitest";
import {
  MATCHA_COLOR,
  formatDurationShort,
  matchaHeaderBar,
  matchaKpiRow,
  textToElements,
} from "../src/channels/card-style.js";

describe("MATCHA_COLOR 色板", () => {
  it("每个 token 都带 light/dark 双值（深色模式防糊，实测坑 #6）", () => {
    for (const [name, v] of Object.entries(MATCHA_COLOR)) {
      expect(v.light_mode, `${name} 缺 light_mode`).toBeTruthy();
      expect(v.dark_mode, `${name} 缺 dark_mode`).toBeTruthy();
    }
  });
});

describe("matchaHeaderBar 抬头条", () => {
  // 2026-10-31 v2：两列拼接实测有白缝且调用方传重名，改单容器整行
  it("单容器整行，名字只出现一次", () => {
    const bar = matchaHeaderBar(undefined, "✅ 45s") as any;
    expect(bar.tag).toBe("interactive_container");
    expect(bar.background_style).toBe("matcha");
    const content = bar.elements[0].content;
    expect(content).toContain("**CC 小工**");
    expect(content).toContain("✅ 45s");
    expect(content.match(/CC 小工/g)).toHaveLength(1);
  });

  it("无任何后缀时只渲染名字", () => {
    const bar = matchaHeaderBar() as any;
    expect(bar.elements[0].content).toContain("**CC 小工**");
  });

  it("内容里的尖括号被转义（防破坏 font 标签）", () => {
    const bar = matchaHeaderBar("<script>x</script>") as any;
    expect(bar.elements[0].content).not.toContain("<script>");
  });
});

describe("matchaKpiRow 指标行", () => {
  it("N 项出 N 列，底色 matcha-bg，数值 matcha-deep", () => {
    const row = matchaKpiRow([
      { value: "12", label: "工具调用" },
      { value: "45s", label: "总用时" },
    ]) as any;
    expect(row.tag).toBe("column_set");
    expect(row.columns).toHaveLength(2);
    for (const col of row.columns) {
      expect(col.background_style).toBe("matcha-bg");
      expect(col.elements[0].content).toContain("matcha-deep");
      expect(col.elements[1].content).toContain("grey");
    }
  });
});

describe("formatDurationShort", () => {
  it("秒与分钟两档", () => {
    expect(formatDurationShort(45_000)).toBe("45s");
    expect(formatDurationShort(90_000)).toBe("1m30s");
    expect(formatDurationShort(0)).toBe("0s");
  });
});

describe("textToElements 表格转换", () => {
  it("markdown 表格 → 原生 table 组件（自带分页/横屏查看）", () => {
    const md = "前置说明\n\n| Skill | Source | Tokens |\n|---|---|---|\n| dbs | User | 1.1k |\n| ima | Project | 800 |\n\n后置文字";
    const els = textToElements(md) as any[];
    const table = els.find((e) => e.tag === "table");
    expect(table).toBeDefined();
    expect(table.columns).toHaveLength(3);
    expect(table.columns[0].display_name).toBe("Skill");
    expect(table.rows[0]).toEqual({ c0: "dbs", c1: "User", c2: "1.1k" });
    // 非表格文字仍在抹茶容器里
    const containers = els.filter((e) => e.tag === "interactive_container");
    expect(containers.some((c) => c.elements[0].content.includes("前置说明"))).toBe(true);
    expect(containers.some((c) => c.elements[0].content.includes("后置文字"))).toBe(true);
  });

  it("代码围栏里的竖线不当作表格", () => {
    const md = "```bash\necho \"a | b\"\n```";
    const els = textToElements(md) as any[];
    expect(els.find((e) => e.tag === "table")).toBeUndefined();
  });

  it("分隔行(---)不算数据行", () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |";
    const els = textToElements(md) as any[];
    const table = els.find((e) => e.tag === "table");
    expect(table.rows).toHaveLength(1);
  });

  it("无表格的纯文字 → 单个抹茶容器", () => {
    const els = textToElements("普通回复") as any[];
    expect(els).toHaveLength(1);
    expect(els[0].tag).toBe("interactive_container");
    expect(els[0].background_style).toBe("matcha-bg");
  });
});
