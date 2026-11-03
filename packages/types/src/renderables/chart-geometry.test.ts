import { describe, expect, it } from "vitest";
import {
  CHART_COMPOSED_BAR_SHARE,
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
function snapshot(
  cellKey: string,
  data: unknown,
  props: Record<string, unknown> = {}
): ChartSnapshotModel {
  const model = describeEmbed({
    kind: "cell",
    attrs: { cellKey },
    props: { ...props, data },
  });
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
    expect([...kinds].sort()).toEqual([
      "bars",
      "composed",
      "line",
      "pie",
      "ring",
      "table",
    ]);
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
    const g = geometry(
      "chart-bar",
      [
        { label: "a", value: 0 },
        { label: "b", value: 0 },
      ],
      "bars"
    );
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
    const g = geometry(
      "chart-area",
      [
        { x: 0, y: 2 },
        { x: 4, y: 6 },
      ],
      "line"
    );
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
    const one = geometry("chart-line", [{ x: 3, y: 5 }], "line", {
      width: PHONE,
    });
    expect(one.points[0]!.cx).toBe(PHONE / 2);
    expect(one.xTicks).toHaveLength(1);
    const flat = geometry(
      "chart-line",
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      "line"
    );
    expect(flat.scale.span).toBe(1);
    for (const p of flat.points) expect(Number.isFinite(p.cy)).toBe(true);
  });

  it("dates read through the injected formatter (the surface's date door)", () => {
    const g = geometry(
      "chart-line",
      [{ x: "2026-10-22T00:00:00Z", y: 1 }],
      "line",
      {
        formatDate: () => "22 Oct",
      }
    );
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
    expect(g).toMatchObject({
      kind: "ring",
      percentRounded: 75,
      showPercent: true,
    });
  });
});

// The founder's report (document dad7e3cb, 3 Nov 2026): two composed charts
// and a pie that pod admin drew as a table and as bars.
const FOUNDER_COMPOSED_DAYS = {
  label: "Jobs run per day vs minutes over the wait target (light queue)",
  barLabel: "Jobs run",
  lineLabel: "Minutes over target",
  data: [
    { x: "30 Oct", bar: 567, line: 44 },
    { x: "31 Oct", bar: 468, line: 18 },
    { x: "1 Nov", bar: 367, line: 37 },
    { x: "2 Nov", bar: 616, line: 294 },
  ],
  capturedAt: "2026-11-03T00:05:00Z",
};
const FOUNDER_COMPOSED_HOURS = {
  label: "2 Nov, light queue: jobs waiting and longest wait",
  barLabel: "Jobs waiting (average)",
  lineLabel: "Longest wait (min)",
  data: [
    { x: "12:00", bar: 0, line: 0 },
    { x: "13:00", bar: 2, line: 7 },
    { x: "14:00", bar: 8, line: 20 },
    { x: "15:00", bar: 11, line: 31 },
    { x: "16:00", bar: 9, line: 19 },
    { x: "17:00", bar: 14, line: 29 },
    { x: "18:00", bar: 11, line: 23 },
    { x: "19:00", bar: 24, line: 33 },
    { x: "19:30", bar: 26, line: 54 },
    { x: "20:00", bar: 18, line: 69 },
    { x: "20:30", bar: 18, line: 83 },
    { x: "21:00", bar: 16, line: 73 },
    { x: "22:00", bar: 23, line: 63 },
    { x: "22:30", bar: 30, line: 83 },
    { x: "23:00", bar: 28, line: 91 },
    { x: "23:30", bar: 23, line: 83 },
    { x: "00:00", bar: 22, line: 87 },
  ],
  capturedAt: "2026-11-03T00:05:00Z",
};
const FOUNDER_PIE = {
  label: "How the account moves happened (all moves on record)",
  groupBy: "trigger",
  data: [
    { label: "After a crash (failed turn)", value: 347 },
    { label: "Cleanly, at the end of a turn", value: 7 },
  ],
  capturedAt: "2026-11-03T00:05:00Z",
};

function composedOf(
  fixture: { data: unknown } & Record<string, unknown>,
  opts?: Parameters<typeof chartGeometry>[1]
) {
  const { data, ...props } = fixture;
  const g = chartGeometry(snapshot("chart-composed", data, props), opts);
  expect(g.kind).toBe("composed");
  return g as Extract<ChartGeometry, { kind: "composed" }>;
}

describe("chartGeometry — composed (bars and a line on one x axis)", () => {
  it("the founder's two composed charts draw bars and a line, never a table", () => {
    for (const fixture of [FOUNDER_COMPOSED_DAYS, FOUNDER_COMPOSED_HOURS]) {
      const g = composedOf(fixture);
      expect(g.bars).toHaveLength(fixture.data.length);
      expect(g.points).toHaveLength(fixture.data.length);
      expect(g.path.startsWith("M")).toBe(true);
      expect(g.path.split(" L")).toHaveLength(fixture.data.length);
      // The authored series names reach the geometry (the legend's words).
      expect([g.barLabel, g.lineLabel]).toEqual([
        fixture.barLabel,
        fixture.lineLabel,
      ]);
    }
  });

  it("bars and line each have their OWN scale, and each holds zero", () => {
    const g = composedOf(FOUNDER_COMPOSED_DAYS);
    expect(g.barScale).toEqual({ lo: 0, hi: 616, span: 616 });
    expect(g.lineScale).toEqual({ lo: 0, hi: 294, span: 294 });
    // The tallest bar and the highest point both reach the top of the plot.
    const top = g.pad;
    expect(g.bars[3]!.y).toBeCloseTo(top, 9);
    expect(g.points[3]!.cy).toBeCloseTo(top, 9);
    // Bar height is proportional to its value on the bars' scale.
    const plot = g.height - 2 * g.pad;
    for (const bar of g.bars) {
      expect(bar.h).toBeCloseTo((bar.value / 616) * plot, 9);
      expect(bar.y + bar.h).toBeCloseTo(g.baseline, 9);
    }
    // The line reads its own scale: 44 of 294, not 44 of 616.
    expect(g.points[0]!.cy).toBeCloseTo(
      g.height - g.pad - (44 / 294) * plot,
      9
    );
    expect(g.barTicks).toEqual({ top: (616).toLocaleString(), bottom: "0" });
    expect(g.lineTicks).toEqual({ top: "294", bottom: "0" });
  });

  it("each dot sits above the centre of its bucket's bar, buckets left to right", () => {
    const g = composedOf(FOUNDER_COMPOSED_HOURS, { width: PHONE });
    const slot = (PHONE - 2 * g.pad) / FOUNDER_COMPOSED_HOURS.data.length;
    g.bars.forEach((bar, i) => {
      expect(bar.x + bar.w / 2).toBeCloseTo(g.points[i]!.cx, 9);
      expect(bar.w).toBeCloseTo(slot * CHART_COMPOSED_BAR_SHARE, 9);
      // Inside the padded box.
      expect(bar.x).toBeGreaterThanOrEqual(g.pad - EPS);
      expect(bar.x + bar.w).toBeLessThanOrEqual(PHONE - g.pad + EPS);
    });
    const xs = g.points.map((p) => p.cx);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(g.xTicks).toEqual([
      { text: "12:00", align: "start" },
      { text: "00:00", align: "end" },
    ]);
  });

  it("a negative bar hangs below the zero line; one bucket sits in the middle", () => {
    const g = composedOf({
      data: [
        { x: "A", bar: -5, line: 2 },
        { x: "B", bar: 15, line: -2 },
      ],
    });
    expect(g.barScale).toEqual({ lo: -5, hi: 15, span: 20 });
    expect(g.bars[0]!.negative).toBe(true);
    expect(g.bars[0]!.y).toBeCloseTo(g.baseline, 9);
    expect(g.bars[1]!.y + g.bars[1]!.h).toBeCloseTo(g.baseline, 9);
    expect(g.barLabel).toBeNull();
    expect(g.lineLabel).toBeNull();

    const one = composedOf({ data: [{ x: "Only", bar: 0, line: 0 }] });
    expect(one.points[0]!.cx).toBe(one.width / 2);
    expect(one.xTicks).toHaveLength(1);
    for (const n of [one.bars[0]!.y, one.bars[0]!.h, one.points[0]!.cy])
      expect(Number.isFinite(n)).toBe(true);
  });

  it("states each bucket's two numbers for the spoken label", () => {
    const g = composedOf(FOUNDER_COMPOSED_DAYS);
    expect(g.values[0]).toEqual({
      name: "30 Oct",
      bar: (567).toLocaleString(),
      line: "44",
    });
  });
});

function pieOf(fixture: { data: unknown } & Record<string, unknown>) {
  const { data, ...props } = fixture;
  const g = chartGeometry(snapshot("chart-pie", data, props));
  expect(g.kind).toBe("pie");
  return g as Extract<ChartGeometry, { kind: "pie" }>;
}

describe("chartGeometry — pie (chart-pie)", () => {
  it("the founder's pie draws segments that share one ring, never bars", () => {
    const g = pieOf(FOUNDER_PIE);
    expect(g.ring.r * 2 * Math.PI).toBeCloseTo(100, 3);
    expect(g.total).toBe(354);
    expect(g.segments.map((s) => s.labelText)).toEqual([
      "After a crash (failed turn)",
      "Cleanly, at the end of a turn",
    ]);
    const [crash, clean] = g.segments;
    expect(crash!.share).toBeCloseTo((347 / 354) * 100, 9);
    expect(clean!.share).toBeCloseTo((7 / 354) * 100, 9);
    expect(crash!.shareText).toBe("98%");
    expect(clean!.shareText).toBe("2%");
    // Each segment starts where the one before ended; together they close the ring.
    expect(crash!.offset).toBe(0);
    expect(crash!.dashOffset).toBe(0);
    expect(clean!.offset).toBeCloseTo(crash!.share, 9);
    expect(clean!.dashOffset).toBeCloseTo(100 - crash!.share, 9);
    expect(clean!.offset + clean!.share).toBeCloseTo(100, 9);
    expect(crash!.dash).toBe(`${crash!.share} ${100 - crash!.share}`);
    expect(g.values[0]).toEqual({
      name: "After a crash (failed turn)",
      value: "347 (98%)",
    });
  });

  it("a bar chart with the same data still draws bars (the pie is told by its key)", () => {
    expect(chartGeometry(snapshot("chart-bar", FOUNDER_PIE.data)).kind).toBe(
      "bars"
    );
  });

  it("one category is the whole ring", () => {
    const g = pieOf({ data: [{ label: "All", value: 9 }] });
    expect(g.segments[0]!.share).toBe(100);
    expect(g.segments[0]!.dash).toBe("100 0");
  });

  it("an all-zero pie and a negative value are safe: no NaN, no share", () => {
    const zero = pieOf({
      data: [
        { label: "a", value: 0 },
        { label: "", value: 0 },
      ],
    });
    expect(zero.total).toBe(0);
    for (const s of zero.segments) {
      expect(s.share).toBe(0);
      expect(s.dash).toBe("0 100");
      expect(Number.isFinite(s.offset) && Number.isFinite(s.dashOffset)).toBe(
        true
      );
    }
    expect(zero.segments[1]!.labelText).toBe("—");
    expect(zero.values[1]!.name).toBeNull();

    const neg = pieOf({
      data: [
        { label: "Gain", value: 3 },
        { label: "Loss", value: -2 },
        { label: "Other", value: 1 },
      ],
    });
    expect(neg.total).toBe(4);
    expect(neg.segments.map((s) => s.share)).toEqual([75, 0, 25]);
    expect(neg.segments[1]!.valueText).toBe((-2).toLocaleString());
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
    expect(
      chartGeometry(snapshot("chart-sankey", { nodes: [], links: [] })).kind
    ).toBe("empty");
    expect(chartGeometry(snapshot("chart-choropleth", {})).kind).toBe("empty");
  });
});
