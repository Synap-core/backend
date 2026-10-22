import { describe, expect, it } from "vitest";
import {
  CHART_DATA_EXAMPLES,
  CHART_DATA_SHAPE_BY_KEY,
  LIVE_ONLY_SNAPSHOT_MESSAGE,
  WIDGET_DEFINITIONS,
  dataBindingFor,
  describeEmbed,
  isChartCellKey,
} from "./index.js";

/** Chart keys by binding, DERIVED from the catalog — never hand-listed. */
const CHART_DEFS = WIDGET_DEFINITIONS.filter((d) => isChartCellKey(d.key));
const SNAPSHOT_CHARTS = CHART_DEFS.filter((d) =>
  dataBindingFor(d)?.supports.includes("inline")
);
const LIVE_ONLY_CHARTS = CHART_DEFS.filter(
  (d) => !dataBindingFor(d)?.supports.includes("inline")
);
const NON_CHART_WIDGET = WIDGET_DEFINITIONS.find(
  (d) => !isChartCellKey(d.key) && !d.key.includes(":")
)!;

const cell = (
  cellKey: string,
  props?: Record<string, unknown>,
  extra: Record<string, string> = {}
) => describeEmbed({ kind: "cell", attrs: { cellKey, ...extra }, props });

describe("describeEmbed — the scan sees what it claims", () => {
  it("found charts of both bindings and a non-chart widget", () => {
    expect(SNAPSHOT_CHARTS.length).toBeGreaterThan(5);
    expect(LIVE_ONLY_CHARTS.map((d) => d.key)).toContain("chart-live-line");
    expect(NON_CHART_WIDGET).toBeDefined();
  });
});

describe("describeEmbed — charts", () => {
  it("every snapshot-capable chart with its shape's example data is a snapshot", () => {
    for (const def of SNAPSHOT_CHARTS) {
      const shape =
        CHART_DATA_SHAPE_BY_KEY[
          def.key as keyof typeof CHART_DATA_SHAPE_BY_KEY
        ];
      const model = cell(def.key, {
        data: CHART_DATA_EXAMPLES[shape],
        capturedAt: "2026-10-01T00:00:00Z",
      });
      expect(model).toMatchObject({
        kind: "chart-snapshot",
        cellKey: def.key,
        shape,
        data: CHART_DATA_EXAMPLES[shape],
        capturedAt: "2026-10-01T00:00:00Z",
        label: def.name,
      });
    }
  });

  it("the authored label titles the chart; no capturedAt is null, not invented", () => {
    const model = cell("chart-bar", {
      label: "Tasks by status",
      data: [{ label: "Done", value: 3 }],
    });
    expect(model).toMatchObject({
      kind: "chart-snapshot",
      label: "Tasks by status",
      capturedAt: null,
    });
  });

  it("an empty array is a valid, empty snapshot — not a broken one", () => {
    expect(cell("chart-bar", { data: [] })).toMatchObject({
      kind: "chart-snapshot",
      data: [],
    });
  });

  it("a malformed snapshot is broken with the parser's message, never an empty chart", () => {
    expect(cell("chart-bar", { data: "oops" })).toEqual({
      kind: "chart-broken",
      cellKey: "chart-bar",
      label: "Bar Chart",
      message: "data must be an array of {label, value} items",
    });
  });

  it("data of the WRONG shape is broken (series data on a bar chart)", () => {
    expect(cell("chart-bar", { data: CHART_DATA_EXAMPLES.series }).kind).toBe(
      "chart-broken"
    );
  });

  it("a scalar snapshot carries its 0–100 share, against max unless completion", () => {
    expect(cell("chart-ring", { data: 72 })).toMatchObject({ percent: 72 });
    expect(
      cell("chart-gauge", { data: 5, aggregation: "count", max: 20 })
    ).toMatchObject({ kind: "chart-snapshot", percent: 25 });
    expect(
      cell("chart-gauge", { data: 500, aggregation: "sum" })
    ).toMatchObject({
      percent: 100,
    });
    expect(cell("chart-bar", { data: [] })).not.toHaveProperty("percent");
  });

  it("a bad capturedAt is broken — the badge would lie", () => {
    expect(cell("chart-ring", { data: 4, capturedAt: "yesterday" }).kind).toBe(
      "chart-broken"
    );
  });

  it("props that could not be read are broken, not a live chart", () => {
    const model = describeEmbed({
      kind: "cell",
      attrs: { cellKey: "chart-bar" },
      propsError: "The props block is not valid JSON (x).",
    });
    expect(model).toMatchObject({
      kind: "chart-broken",
      message: "The props block is not valid JSON (x).",
    });
  });

  it("a chart without data reads live", () => {
    expect(cell("chart-line", { profileSlug: "task" })).toEqual({
      kind: "chart-live",
      cellKey: "chart-line",
      label: "Line Chart",
    });
    expect(cell("chart-line").kind).toBe("chart-live");
  });

  it("a live-only chart carrying VALID data is broken, not drawn", () => {
    // Rules disagree here: "has data ⇒ snapshot" would draw it; the catalog
    // says chart-live-line cannot hold a snapshot.
    expect(
      cell("chart-live-line", { data: CHART_DATA_EXAMPLES.series })
    ).toMatchObject({
      kind: "chart-broken",
      cellKey: "chart-live-line",
      message: LIVE_ONLY_SNAPSHOT_MESSAGE,
    });
  });
});

describe("describeEmbed — cells that are not charts", () => {
  it("a generated cell carrying chart-shaped data is a frame, never a chart", () => {
    // Rules disagree here: "has data ⇒ chart" would draw it.
    expect(
      cell("generated:weekly-pulse", { data: CHART_DATA_EXAMPLES.categories })
    ).toEqual({
      kind: "cell-frame",
      cellKey: "generated:weekly-pulse",
      keyName: "weekly-pulse",
      instanceId: null,
      label: null,
    });
  });

  it("an installed pack cell is a frame named by its last segment", () => {
    expect(cell("cell:acme.pack:deal-board")).toMatchObject({
      kind: "cell-frame",
      keyName: "deal-board",
    });
  });

  it("an instance with no key is a frame", () => {
    expect(
      describeEmbed({ kind: "cell", attrs: { instanceId: "i-1" } })
    ).toMatchObject({ kind: "cell-frame", instanceId: "i-1", cellKey: null });
  });

  it("a built-in widget is named by the catalog, or its authored label", () => {
    expect(cell(NON_CHART_WIDGET.key)).toEqual({
      kind: "cell-builtin",
      cellKey: NON_CHART_WIDGET.key,
      label: NON_CHART_WIDGET.name,
    });
    expect(cell(NON_CHART_WIDGET.key, { label: "Mine" })).toMatchObject({
      label: "Mine",
    });
  });

  it("a key the catalog does not know is unknown", () => {
    expect(cell("mystery-widget")).toEqual({
      kind: "unknown",
      directiveKind: "cell",
      cellKey: "mystery-widget",
      label: null,
    });
  });

  it("a cell naming nothing is broken", () => {
    expect(describeEmbed({ kind: "cell", attrs: {} })).toEqual({
      kind: "broken",
      directiveKind: "cell",
    });
  });
});

describe("describeEmbed — references", () => {
  it("an entity carries its id and only an AUTHORED attribute label", () => {
    expect(
      describeEmbed({
        kind: "entity",
        attrs: { id: "e-1" },
        props: { label: "x" },
      })
    ).toEqual({ kind: "entity", id: "e-1", label: null });
    expect(
      describeEmbed({ kind: "entity", attrs: { id: "e-1", label: "Ana" } })
    ).toMatchObject({ label: "Ana" });
  });

  it("an entity without an id is broken", () => {
    expect(describeEmbed({ kind: "entity", attrs: { id: "  " } })).toEqual({
      kind: "broken",
      directiveKind: "entity",
    });
  });

  it("a view reads its id from either attribute", () => {
    expect(
      describeEmbed({
        kind: "view",
        attrs: { "data-view-id": "v-1", viewType: "kanban" },
      })
    ).toEqual({ kind: "view", viewId: "v-1", viewType: "kanban", label: null });
    expect(describeEmbed({ kind: "view", attrs: {} }).kind).toBe("broken");
  });

  it("an unknown synap-* kind is unknown, its kind kept for the words", () => {
    expect(describeEmbed({ kind: "instance", attrs: { id: "x" } })).toEqual({
      kind: "unknown",
      directiveKind: "instance",
      cellKey: null,
      label: null,
    });
  });
});
