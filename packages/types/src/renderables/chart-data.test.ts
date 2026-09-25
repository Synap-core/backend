import { describe, expect, it } from "vitest";
import {
  CHART_DATA_EXAMPLES,
  CHART_DATA_SHAPES,
  WIDGET_DEFINITIONS,
  WIDGET_TYPE_KEYS,
  chartPropsMadeLive,
  configFieldsToJsonSchema,
  dataBindingFor,
  exampleEmbedProps,
  freezeChartProps,
  parseChartData,
  parseChartSnapshot,
} from "./index.js";

/** The chart keys, DERIVED from the declared key tuple — never hand-listed. */
const CHART_KEYS = WIDGET_TYPE_KEYS.filter((k) => k.startsWith("chart-"));
const byKey = new Map(WIDGET_DEFINITIONS.map((d) => [d.key as string, d]));

describe("chart data binding in the catalog (D2)", () => {
  it("sees every chart (non-vacuity)", () => {
    expect(CHART_KEYS.length).toBeGreaterThanOrEqual(14);
  });

  it("every chart declares the shape it draws", () => {
    for (const key of CHART_KEYS) {
      const binding = dataBindingFor(byKey.get(key)!);
      expect(binding?.dataShape, key).toBeDefined();
      expect(CHART_DATA_SHAPES).toContain(binding!.dataShape);
    }
  });

  it("every chart but the live line supports a snapshot, and defaults to it", () => {
    for (const key of CHART_KEYS) {
      const binding = dataBindingFor(byKey.get(key)!)!;
      if (key === "chart-live-line") {
        expect(binding.supports).toEqual(["query"]);
        continue;
      }
      expect(binding.supports, key).toEqual(
        expect.arrayContaining(["inline", "query"])
      );
      expect(binding.default, key).toBe("inline");
    }
  });

  it("an entry that holds `data` inline declares its shape (else nothing could validate it)", () => {
    for (const def of WIDGET_DEFINITIONS) {
      const hasDataField = def.configSchema.some((f) => f.key === "data");
      if (!hasDataField) continue;
      expect(dataBindingFor(def)?.dataShape, def.key).toBeDefined();
      expect(dataBindingFor(def)?.supports, def.key).toContain("inline");
    }
  });

  it("snapshot-capable charts declare data + capturedAt, hidden from the settings panel", () => {
    let seen = 0;
    for (const def of WIDGET_DEFINITIONS) {
      if (
        !dataBindingFor(def)?.supports.includes("inline") ||
        !dataBindingFor(def)?.dataShape
      )
        continue;
      seen++;
      const data = def.configSchema.find((f) => f.key === "data");
      const capturedAt = def.configSchema.find((f) => f.key === "capturedAt");
      expect(data?.settingsHidden, def.key).toBe(true);
      expect(capturedAt?.settingsHidden, def.key).toBe(true);
      // The AI-facing schema says the real shape, not "object".
      const schema = configFieldsToJsonSchema(def.configSchema);
      expect(schema.properties.data!.description, def.key).toMatch(
        /Snapshot data/
      );
    }
    expect(seen).toBe(13);
  });

  it("the example props of a snapshot chart carry valid data + the query keys", () => {
    const json = exampleEmbedProps(byKey.get("chart-bar")!) as Record<
      string,
      unknown
    >;
    expect(json.profileSlug).toBe("<profileSlug>");
    expect(parseChartData("categories", json.data).ok).toBe(true);
    expect(json.capturedAt).toBe("<ISO date>");
  });
});

describe("parseChartData — one schema, never coerced", () => {
  it("accepts every shape's example", () => {
    for (const shape of CHART_DATA_SHAPES) {
      expect(
        parseChartData(shape, CHART_DATA_EXAMPLES[shape]),
        shape
      ).toMatchObject({ ok: true });
    }
  });

  it("an empty snapshot is valid (EMPTY ≠ FAILED)", () => {
    expect(parseChartData("series", [])).toEqual({ ok: true, data: [] });
    expect(parseChartData("regions", {})).toEqual({ ok: true, data: {} });
  });

  it.each([
    ["series", "oops", /array/],
    ["series", [{ x: "Q1", y: 2 }], /ISO date/],
    ["series", [{ x: "2026-09-01", y: "2" }], /y must be a number/],
    ["categories", [{ label: "a" }], /value must be a number/],
    ["categories", { a: 1 }, /array/],
    ["composed", [{ x: "a", bar: 1 }], /line must be a number/],
    ["scalar", "72", /single number/],
    ["scalar", Number.NaN, /single number/],
    ["points", [{ x: 1, y: "2" }], /numbers/],
    [
      "flow",
      {
        nodes: [{ id: "a", label: "a" }],
        links: [{ source: "a", target: "b", value: 1 }],
      },
      /not in data.nodes/,
    ],
    ["flow", [], /nodes, links/],
    ["regions", { FR: "12" }, /must be a number/],
  ] as const)("%s rejects %j", (shape, value, message) => {
    const r = parseChartData(shape, value);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(message);
  });

  it("capturedAt, when present, must be a date", () => {
    expect(
      parseChartSnapshot("scalar", {
        data: 3,
        capturedAt: "2026-09-25T10:00:00.000Z",
      })
    ).toEqual({
      ok: true,
      data: 3,
      capturedAt: "2026-09-25T10:00:00.000Z",
    });
    expect(parseChartSnapshot("scalar", { data: 3 })).toEqual({
      ok: true,
      data: 3,
    });
    expect(
      parseChartSnapshot("scalar", { data: 3, capturedAt: "yesterday" }).ok
    ).toBe(false);
  });
});

describe("freeze ⇄ make live", () => {
  it("freeze keeps the query keys and adds data + capturedAt; make live removes exactly those", () => {
    const live = { profileSlug: "task", groupBy: "status", label: "By status" };
    const frozen = freezeChartProps(
      live,
      CHART_DATA_EXAMPLES.categories,
      new Date("2026-09-25T10:00:00Z")
    );
    expect(frozen).toEqual({
      ...live,
      data: CHART_DATA_EXAMPLES.categories,
      capturedAt: "2026-09-25T10:00:00.000Z",
    });
    expect(chartPropsMadeLive(frozen)).toEqual(live);
  });
});
