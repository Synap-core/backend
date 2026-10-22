import { describe, expect, it } from "vitest";
import {
  CHART_DATA_EXAMPLES,
  CHART_DATA_SHAPE_BY_KEY,
  CHART_LABEL_COLUMN_PERCENT,
  CHART_LINE_PAD,
  chartGeometry,
  describeEmbed,
  type ChartGeometry,
  type ChartSnapshotModel,
} from "./index.js";

/** A snapshot through the REAL embed model — never a hand-built model. */
function snapshot(cellKey: string, data: unknown): ChartSnapshotModel {
  const model = describeEmbed({ kind: "cell", attrs: { cellKey }, props: { data } });
  if (model.kind !== "chart-snapshot") {
    throw new Error(`${cellKey}: expected a snapshot, got ${model.kind}`);
  }
  return model;
}

function geometry<K extends ChartGeometry["kind"]>(
  cellKey: string,
  data: unknown,
  kind: K,
  opts?: Parameters<typeof chartGeometry>[1]
): Extract<ChartGeometry, { kind: K }> {
  const g = chartGeometry(snapshot(cellKey, data), opts);
  expect(g.kind).toBe(kind);
  return g as Extract<ChartGeometry, { kind: K }>;
}

const EPS = 1e-9;
/** The phone width the plan names; a glyph at 11.5px is ≤ 7px wide on average. */
const PHONE = 320;
const CHAR_PX = 7;

describe("chartGeometry — every snapshot shape has marks", () => {
  it("each chart key's example data draws (derived from the catalog map)", () => {
    const keys = Object.keys(CHART_DATA_SHAPE_BY_KEY).filter(
      (k) => k !== "chart-live-line"
    );
    expect(keys.length).toBeGreaterThan(10);
    const kinds = new Set<string>();
    for (const key of keys) {
      const shape =
        CHART_DATA_SHAPE_BY_KEY[key as keyof typeof CHART_DATA_SHAPE_BY_KEY];
      const g = chartGeometry(snapshot(key, CHART_DATA_EXAMPLES[shape]));
      expect(g.kind).not.toBe("empty");
      kinds.add(g.kind);
    }
    expect([...kinds].sort()).toEqual(["bars", "line", "ring", "table"]);
  });
});

describe("chartGeometry — bars", () => {
  const data = [
    { label: "Open", value: 12 },
    { label: "Review", value: 30 },
    { label: "", value: -6 },
  ];

  it("draws every bar on ONE scale that holds zero", () => {
    const g = geometry("chart-bar", data, "bars");
    expect(g.scale).toEqual({ lo: -6, hi: 30, span: 36 });
    // Length is proportional to |value| on the same scale for every bar.
    for (const bar of g.bars) {
      expect(bar.w).toBeCloseTo((Math.abs(bar.value) / g.scale.span) * 100, 9);
    }
    // Positive bars start at the zero line; the negative one ends there.
    const zero = (6 / 36) * 100;
    expect(g.bars[0]!.x).toBeCloseTo(zero, 9);
    expect(g.bars[2]!.x + g.bars[2]!.w).toBeCloseTo(zero, 9);
    expect(g.bars.map((b) => b.negative)).toEqual([false, false, true]);
    // The largest value reaches the end of the track.
    expect(g.bars[1]!.x + g.bars[1]!.w).toBeCloseTo(100, 9);
  });

  it("keeps every bar inside its track", () => {
    const g = geometry(
      "chart-bar",
      [-50, -1, 0, 3, 7, 1e6].map((value, i) => ({ label: `L${i}`, value })),
      "bars"
    );
    for (const bar of g.bars) {
      expect(bar.x).toBeGreaterThanOrEqual(-EPS);
      expect(bar.w).toBeGreaterThanOrEqual(0);
      expect(bar.x + bar.w).toBeLessThanOrEqual(g.track.width + EPS);
      expect(bar.y).toBe(0);
      expect(bar.h).toBe(g.track.height);
    }
  });

  it("gives every label its own row in its own column, so none overlaps at 320px", () => {
    const long = "A category label long enough to wrap twice on a phone";
    const g = geometry(
      "chart-bar",
      [long, long, "Done"].map((label, i) => ({ label, value: i + 1 })),
      "bars"
    );
    // One row per value, in order: two labels never share a row.
    expect(g.bars.map((b) => b.labelText)).toEqual([long, long, "Done"]);
    // The label column is a bounded share of the row; the track keeps the rest.
    expect(g.labelColumnPercent).toBe(CHART_LABEL_COLUMN_PERCENT);
    const labelPx = (g.labelColumnPercent / 100) * PHONE;
    expect(labelPx).toBeLessThan(PHONE / 2);
    expect(labelPx).toBeGreaterThan(CHAR_PX * 10);
  });

  it("an unlabelled value prints a dash and is named as such for the summary", () => {
    const g = geometry("chart-bar", data, "bars");
    expect(g.bars[2]!.labelText).toBe("—");
    expect(g.values[2]).toEqual({ name: null, value: (-6).toLocaleString() });
  });

  it("all-zero data is safe: finite, zero-length bars", () => {
    const g = geometry("chart-bar", [{ label: "a", value: 0 }, { label: "b", value: 0 }], "bars");
    expect(g.scale).toEqual({ lo: 0, hi: 0, span: 1 });
    for (const bar of g.bars) {
      expect(Number.isFinite(bar.x) && Number.isFinite(bar.w)).toBe(true);
      expect(bar.w).toBe(0);
    }
  });

  it("no values is an EMPTY geometry, never an empty drawing", () => {
    expect(chartGeometry(snapshot("chart-bar", []))).toEqual({
      kind: "empty",
      shape: "categories",
    });
  });
});

describe("chartGeometry — series", () => {
  it("draws the web console's exact path in its 300 × 120 box", () => {
    const g = geometry(
      "chart-line",
      [
        { x: 0, y: 0 },
        { x: 1, y: 10 },
      ],
      "line"
    );
    expect([g.width, g.height, g.pad]).toEqual([300, 120, CHART_LINE_PAD]);
    expect(g.path).toBe("M6.00,114.00 L294.00,6.00");
    expect(g.baseline).toBe(114);
    expect(g.areaPath).toBeNull();
    expect(g.yTicks).toEqual({ top: "10", bottom: "0" });
  });

  it("an area chart closes its path to the baseline", () => {
    const g = geometry("chart-area", [{ x: 0, y: 2 }, { x: 4, y: 6 }], "line");
    expect(g.areaPath).toBe(`${g.path} L294.00,114.00 L6.00,114.00 Z`);
  });

  it("keeps every dot inside the padded box, at any width", () => {
    const data = [-40, 5, 0, 99, -3, 12].map((y, i) => ({
      x: `2026-10-0${i + 1}T00:00:00Z`,
      y,
    }));
    for (const width of [PHONE, 300, 1200]) {
      const g = geometry("chart-line", data, "line", { width });
      expect(g.width).toBe(width);
      for (const p of g.points) {
        expect(p.cx).toBeGreaterThanOrEqual(g.pad - EPS);
        expect(p.cx).toBeLessThanOrEqual(width - g.pad + EPS);
        expect(p.cy).toBeGreaterThanOrEqual(g.pad - EPS);
        expect(p.cy).toBeLessThanOrEqual(g.height - g.pad + EPS);
      }
      // Time runs left to right.
      const xs = g.points.map((p) => p.cx);
      expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    }
  });

  it("x runs on TIME when every point has a date, not on the point's index", () => {
    const g = geometry(
      "chart-line",
      [
        { x: "2026-10-01T00:00:00Z", y: 1 },
        { x: "2026-10-02T00:00:00Z", y: 2 },
        { x: "2026-10-11T00:00:00Z", y: 3 },
      ],
      "line"
    );
    // Day 1 of 10 sits a tenth of the way along the plot, not halfway.
    const plot = g.width - 2 * g.pad;
    expect(g.points[1]!.cx).toBeCloseTo(g.pad + plot / 10, 9);
  });

  it("x ticks are the first and last point at opposite edges, and fit side by side at 320px", () => {
    const g = geometry(
      "chart-line",
      [
        { x: "2026-01-01T00:00:00Z", y: 1 },
        { x: "2026-06-01T00:00:00Z", y: 2 },
        { x: "2026-12-31T00:00:00Z", y: 3 },
      ],
      "line",
      { width: PHONE }
    );
    expect(g.xTicks.map((t) => t.align)).toEqual(["start", "end"]);
    const used = g.xTicks.reduce((n, t) => n + t.text.length * CHAR_PX, 0);
    expect(used).toBeLessThan(PHONE);
  });

  it("one point sits in the middle; a flat zero series stays finite", () => {
    const one = geometry("chart-line", [{ x: 3, y: 5 }], "line", { width: PHONE });
    expect(one.points[0]!.cx).toBe(PHONE / 2);
    expect(one.xTicks).toHaveLength(1);
    const flat = geometry("chart-line", [{ x: 0, y: 0 }, { x: 1, y: 0 }], "line");
    expect(flat.scale.span).toBe(1);
    for (const p of flat.points) expect(Number.isFinite(p.cy)).toBe(true);
  });

  it("dates read through the injected formatter (the surface's date door)", () => {
    const g = geometry("chart-line", [{ x: "2026-10-22T00:00:00Z", y: 1 }], "line", {
      formatDate: () => "22 Oct",
    });
    expect(g.xTicks[0]!.text).toBe("22 Oct");
    expect(g.values[0]).toEqual({ name: "22 Oct", value: "1" });
  });
});

describe("chartGeometry — scalar", () => {
  it("the ring's dash is the percent over a circumference of 100", () => {
    const g = geometry("chart-gauge", 72, "ring");
    expect(g.ring.r * 2 * Math.PI).toBeCloseTo(100, 3);
    expect(g.dash).toBe("72 100");
    expect(g.showPercent).toBe(false);
  });

  it("shows the percent only when it differs from the number", () => {
    const model = describeEmbed({
      kind: "cell",
      attrs: { cellKey: "chart-ring" },
      props: { data: 30, aggregation: "count", max: 40 },
    }) as ChartSnapshotModel;
    const g = chartGeometry(model);
    expect(g).toMatchObject({ kind: "ring", percentRounded: 75, showPercent: true });
  });
});

describe("chartGeometry — tables", () => {
  it("flow rows name nodes by label and format numbers", () => {
    const g = geometry(
      "chart-sankey",
      {
        nodes: [
          { id: "a", label: "Leads" },
          { id: "b", label: "Won" },
        ],
        links: [{ source: "a", target: "b", value: 1200 }],
      },
      "table"
    );
    expect(g.rows).toEqual([
      [
        { text: "Leads", numeric: false },
        { text: "Won", numeric: false },
        { text: (1200).toLocaleString(), numeric: true },
      ],
    ]);
  });

  it("no links / no regions is empty", () => {
    expect(chartGeometry(snapshot("chart-sankey", { nodes: [], links: [] })).kind).toBe("empty");
    expect(chartGeometry(snapshot("chart-choropleth", {})).kind).toBe("empty");
  });
});
