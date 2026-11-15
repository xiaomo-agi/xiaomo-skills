/**
 * 抹茶卡片构件（Card 2.0）—— 2026-10-31 owner 样卡验收冻结（№9/№12b，主色 #6BA36A）
 *
 * 职责边界：
 * - 本文件只放【无回调】的 2.0 展示构件（抬头条/KPI 行/色板），供流式回复卡与静态卡使用
 * - 带按钮的卡（选项/审批/命令建议）是 1.0 回调结构（tag:action + value，生产验证过），
 *   留在 card-actions.ts / approval.ts，仅换 header.template——1.0 无自定义色，
 *   抹茶精确色只在 2.0 可用（2026-10-31 探针实测）
 *
 * 实测口径（勿凭文档写，详见 docs/20261031_mycc卡片样式抹茶化方案.md）：
 * - column_set 不认 background_style → 抬头条底色刷在 column 上，两列 horizontal_spacing:0px 无缝拼接
 * - column 不认 corner_radius；button 不认自定义色（11246 parse err）
 * - 自定义色必须 light_mode/dark_mode 双值，否则深色模式下糊
 */

// ==================== 色板 ====================

/** 抹茶色板：浅色/深色模式双值。改主色只动这里。 */
export const MATCHA_COLOR = {
  "matcha-bg": {
    light_mode: "rgba(107,163,106,0.12)",
    dark_mode: "rgba(107,163,106,0.20)",
  },
  "matcha-line": {
    light_mode: "rgba(107,163,106,0.60)",
    dark_mode: "rgba(107,163,106,0.60)",
  },
  matcha: { light_mode: "rgb(107,163,106)", dark_mode: "rgb(130,182,128)" },
  "matcha-deep": {
    light_mode: "rgb(74,115,74)",
    dark_mode: "rgb(130,182,128)",
  },
} as const;

/** 卡片 config 的 style 片段（spread 进 config） */
export const MATCHA_CONFIG_STYLE = { style: { color: MATCHA_COLOR } };

// ==================== 抬头条 ====================

/**
 * 抹茶抬头条：单容器整行（2026-10-31 v2——两列拼接实测有白缝，且调用方传重名字
 * 会渲染成"CC 小工 · CC 小工"）。渲染为「CC 小工 · <left> · <right>」单行白字。
 * 2.0 专用；流式卡在建卡时静态注入，流式更新只打 content 元素，互不干扰。
 */
export function matchaHeaderBar(
  left?: string,
  right?: string
): Record<string, unknown> {
  const parts = ["**CC 小工**"];
  if (left) parts.push(esc(left));
  if (right) parts.push(esc(right));
  return {
    tag: "interactive_container",
    width: "fill",
    background_style: "matcha",
    padding: "10px 14px",
    elements: [
      {
        tag: "markdown",
        content: `<font color='white'>${parts.join(" · ")}</font>`,
      },
    ],
  };
}

// ==================== KPI 行 ====================

/**
 * KPI 指标行（№9 底部）：matcha-bg 圆角列 × N。
 * column 不支持 corner_radius，圆角感靠底色浅 + 留白；数值用 matcha-deep 放大。
 */
export function matchaKpiRow(
  items: Array<{ value: string; label: string }>
): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "8px",
    columns: items.map((it) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      background_style: "matcha-bg",
      has_border: true,
      border_color: "matcha-line",
      corner_radius: "8px",
      padding: "10px",
      vertical_spacing: "2px",
      elements: [
        {
          tag: "markdown",
          content: `### <font color='matcha-deep'>${esc(it.value)}</font>`,
          text_align: "center",
        },
        {
          tag: "markdown",
          content: `<font color='grey'>${esc(it.label)}</font>`,
          text_align: "center",
          text_size: "notation",
        },
      ],
    })),
  };
}

// ==================== 工具 ====================


// ==================== 外链图片消毒 ====================

/**
 * 外链图片转普通链接：飞书卡片 markdown 只认飞书图床的 image_key，
 * AI 回复里贴的外站图片（![alt](https://…)）会让整张卡片更新被拒
 * （200570 card contains invalid image keys），进度卡当场报废。
 * 这里把外链图降级成普通链接（飞书链接不受限），image_key 引用原样保留；
 * 代码围栏/行内代码内不处理。
 */
export function sanitizeFeishuCardImages(text: string): string {
  if (!text || !text.includes("[")) return text;

  // 按代码围栏切开，围栏内原样保留
  const fenceRe = /```[\s\S]*?```/g;
  const segments: Array<{ code: boolean; text: string }> = [];
  let last = 0;
  for (const m of text.matchAll(fenceRe)) {
    if (m.index! > last) segments.push({ code: false, text: text.slice(last, m.index) });
    segments.push({ code: true, text: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) segments.push({ code: false, text: text.slice(last) });

  const IMAGE_MD_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const convert = (seg: string): string =>
    seg
      .split(/(`[^`\n]*`)/g)
      .map((p, i) => {
        if (i % 2 === 1) return p; // 行内代码不动
        return p.replace(IMAGE_MD_RE, (raw, alt: string, url: string) => {
          if (!url.includes("://")) return raw; // image_key 引用，保留
          const label = alt.replace(/\s+/g, " ").trim().slice(0, 60) || "图片";
          return `[🖼 ${label}](${url})`;
        });
      })
      .join("");

  return segments.map((s) => (s.code ? s.text : convert(s.text))).join("");
}

// ==================== 表格转换（2026-10-31） ====================

/**
 * 文本段 → 卡片元素数组：普通文字装抹茶容器；markdown 表格转飞书原生 table 组件。
 * 原生 table 自带分页和点开横屏查看（对齐 Hermes 体验），且不会把容器底色
 * 透进表格首列（绿泛白的根因）。表格必须放 body 根——本函数返回的就是根级元素数组。
 * 代码围栏内的 | 竖线不参与表格解析。
 */
export function textToElements(
  rawText: string,
  maxTables = 5
): Record<string, unknown>[] {
  // 外链图先降级成普通链接，否则整卡更新会被飞书拒收（200570）
  const text = sanitizeFeishuCardImages(rawText);
  const out: Record<string, unknown>[] = [];
  const chunks: Array<{ code: boolean; text: string }> = [];
  // 按代码围栏切开，围栏内不解析表格
  const fenceRe = /```[\s\S]*?```/g;
  let last = 0;
  for (const m of text.matchAll(fenceRe)) {
    if (m.index! > last) chunks.push({ code: false, text: text.slice(last, m.index) });
    chunks.push({ code: true, text: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) chunks.push({ code: false, text: text.slice(last) });

  let tableCount = 0;
  const pushText = (seg: string) => {
    if (!seg.trim()) return; // 纯空白段跳过；其余保真不裁剪（翻页重组按原文拼回，差一个换行都不行）
    out.push({
      tag: "interactive_container",
      width: "fill",
      has_border: true,
      border_color: "matcha-line",
      corner_radius: "8px",
      background_style: "matcha-bg",
      padding: "12px",
      margin: "0px 12px 10px 12px",
      elements: [{ tag: "markdown", content: seg }],
    });
  };

  const pushTable = (block: string) => {
    if (tableCount >= maxTables) {
      pushText(block);
      return;
    }
    const rows = block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("|"));
    if (rows.length < 2) {
      pushText(block);
      return;
    }
    const cells = rows.map((r) =>
      r
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim())
    );
    const header = cells[0];
    const dataRows = cells.slice(1).filter((c) => !c.every((x) => /^:?-{2,}:?$/.test(x)));
    if (!header.length || header.length < 2 || !dataRows.length) {
      pushText(block);
      return;
    }
    tableCount += 1;
    const columns = header.map((h, i) => ({
      name: `c${i}`,
      display_name: h,
      data_type: "text",
      width: "auto",
    }));
    const tableRows = dataRows.map((r) => {
      const row: Record<string, string> = {};
      columns.forEach((c, i) => {
        row[c.name] = r[i] ?? "";
      });
      return row;
    });
    out.push({
      tag: "table",
      columns,
      rows: tableRows,
      page_size: 8,
      row_height: "low",
      header_style: { bold: true },
      margin: "0px 12px 10px 12px",
    });
  };

  for (const chunk of chunks) {
    if (chunk.code) {
      pushText(chunk.text);
      continue;
    }
    // 切出连续 | 开头的行块
    const lines = chunk.text.split("\n");
    let buf: string[] = [];
    let plain: string[] = [];
    const flushPlain = () => {
      if (plain.length) {
        pushText(plain.join("\n"));
        plain = [];
      }
    };
    for (const line of lines) {
      if (line.trim().startsWith("|")) buf.push(line);
      else {
        if (buf.length) {
          pushTable(buf.join("\n"));
          buf = [];
        }
        plain.push(line);
      }
    }
    if (buf.length) pushTable(buf.join("\n"));
    flushPlain();
  }
  return out;
}

/** 秒数 → 紧凑展示："45s" / "1m30s"（抬头右侧与 KPI 共用） */
export function formatDurationShort(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

/** 抬头条/KPI 文本转义（防内容里带 <> 破坏 font 标签） */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
