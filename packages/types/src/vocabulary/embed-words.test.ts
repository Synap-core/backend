import { describe, expect, it } from "vitest";
import { chartGeometry, describeEmbed } from "../renderables/index.js";
import {
  CHART_SPOKEN_VALUES,
  resolveChartSpokenLabel,
  resolveChartTableHead,
  resolveEmbedWords,
} from "./index.js";

const words = (kind: string, attrs: Record<string, string>, props?: Record<string, unknown>) =>
  resolveEmbedWords(describeEmbed({ kind, attrs, props }));

describe("resolveEmbedWords — every embed is named, never blank, never a raw key", () => {
  it("charts: the catalog name, or the authored label", () => {
    expect(words("cell", { cellKey: "chart-bar" })).toEqual({
      noun: "Chart",
      label: "Bar Chart",
    });
    expect(
      words("cell", { cellKey: "chart-bar" }, { label: "Tasks", data: "oops" })
    ).toEqual({ noun: "Chart", label: "Tasks" });
  });

  it("a sandboxed cell is named by its key's own name, not its namespace", () => {
    expect(words("cell", { cellKey: "generated:weekly-pulse" })).toEqual({
      noun: "Card",
      label: "Weekly pulse",
    });
    expect(words("cell", { cellKey: "cell:acme.pack:deal_board" }).label).toBe(
      "Deal board"
    );
    expect(words("cell", { instanceId: "i-1" })).toEqual({
      noun: "Card",
      label: "Card",
    });
  });

  it("a view is named by its type; an entity by its authored label or noun", () => {
    expect(words("view", { viewId: "v", viewType: "kanban" })).toEqual({
      noun: "View",
      label: "Kanban view",
    });
    expect(words("view", { viewId: "v" }).label).toBe("View");
    expect(words("entity", { id: "e" })).toEqual({
      noun: "Entity",
      label: "Entity",
    });
    expect(words("entity", { id: "e", label: "Ana" }).label).toBe("Ana");
  });

  it("unknown keys and kinds humanize; broken ones say their noun", () => {
    expect(words("cell", { cellKey: "mystery-widget" })).toEqual({
      noun: "Card",
      label: "Mystery widget",
    });
    expect(words("instance", {})).toEqual({ noun: "Instance", label: "Instance" });
    expect(words("entity", {})).toEqual({ noun: "Entity", label: "Entity" });
  });
});

describe("resolveChartSpokenLabel / resolveChartTableHead — a drawn chart's words", () => {
  const drawn = (cellKey: string, data: unknown, props: Record<string, unknown> = {}) => {
    const model = describeEmbed({ kind: "cell", attrs: { cellKey }, props: { data, ...props } });
    if (model.kind !== "chart-snapshot") throw new Error(model.kind);
    return chartGeometry(model);
  };

  it("bars name each value; an unlabelled one is said as such", () => {
    expect(
      resolveChartSpokenLabel(
        "Tasks",
        drawn("chart-bar", [
          { label: "Open", value: 3 },
          { label: "", value: 1200 },
        ])
      )
    ).toBe(`Tasks: Open 3, (no label) ${(1200).toLocaleString()}`);
  });

  it("past the cap, the rest is counted, not dropped silently", () => {
    const data = Array.from({ length: CHART_SPOKEN_VALUES + 3 }, (_, i) => ({ label: `L${i}`, value: i }));
    const label = resolveChartSpokenLabel("Many", drawn("chart-bar", data))!;
    expect(label.endsWith(", and 3 more")).toBe(true);
    expect(label).toContain(`L${CHART_SPOKEN_VALUES - 1} `);
    expect(label).not.toContain(`L${CHART_SPOKEN_VALUES} `);
  });

  it("a series names each point by its x; a ring says the number and the percent", () => {
    expect(
      resolveChartSpokenLabel("Trend", drawn("chart-line", [{ x: 1, y: 2 }, { x: 2, y: 4 }]))
    ).toBe("Trend: 1 2, 2 4");
    expect(
      resolveChartSpokenLabel("Done", drawn("chart-ring", 30, { aggregation: "count", max: 40 }))
    ).toBe("Done: 30 (75%)");
  });

  it("a table and an empty snapshot have no spoken label (their cells / sentence speak)", () => {
    expect(resolveChartSpokenLabel("T", drawn("chart-choropleth", { FR: 1 }))).toBeNull();
    expect(resolveChartSpokenLabel("T", drawn("chart-bar", []))).toBeNull();
  });

  it("every table shape has a heading per column", () => {
    for (const [cellKey, data] of [
      ["chart-composed", [{ x: "W1", bar: 1, line: 2 }]],
      ["chart-scatter", [{ x: 1, y: 2 }]],
      ["chart-sankey", { nodes: [{ id: "a", label: "A" }], links: [{ source: "a", target: "a", value: 1 }] }],
      ["chart-choropleth", { FR: 1 }],
    ] as const) {
      const g = drawn(cellKey, data);
      if (g.kind !== "table") throw new Error(g.kind);
      expect(resolveChartTableHead(g.shape)).toHaveLength(g.rows[0]!.length);
    }
  });
});
