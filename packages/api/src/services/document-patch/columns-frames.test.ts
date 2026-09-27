/**
 * Columns (columns.md, wave C0) through the pod's own seams: the write-time
 * diagnostics, the embed-removal floor and the chart freeze all read embeds
 * through markdown-core's `locateEmbeds`. Before C0 a column row read as ONE
 * unknown embed, so a chart inside a column was invisible to all three.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../access/index.js", () => ({
  AccessContext: { operator: () => ({ withLens: () => ({}) }) },
  scopedDb: () => ({ findMany: async () => [] }),
}));
vi.mock("../cells/renderables.js", () => ({
  listRenderables: async () => [],
}));

import {
  diagnoseDocument,
  type EmbedResolver,
} from "./document-diagnostics.js";
import { removedEmbeds } from "./patch-ops.js";
import { freezeChartEmbeds } from "../document-charts/freeze-chart-embeds.js";

const resolver: EmbedResolver = {
  renderables: async () =>
    new Map([
      [
        "chart-pie",
        { placements: ["bento", "inline"], requiredConfig: ["profileSlug"] },
      ],
    ]) as never,
  referents: async (_kind, ids) => new Map(ids.map((id) => [id, "visible"])),
};

const row = (left: string, right = "The reading.") =>
  [
    ":::::synap-columns",
    '::::synap-column{width="40%"}',
    left,
    "::::",
    '::::synap-column{width="60%"}',
    right,
    "::::",
    ":::::",
  ].join("\n");

const pie = (cellKey = "chart-pie") =>
  [
    `:::synap-cell{cellKey="${cellKey}"}`,
    "```json",
    '{"profileSlug":"task","groupBy":"status","label":"Tasks by status"}',
    "```",
    "",
    "Most tasks are done.",
    ":::",
  ].join("\n");

describe("columns through the pod's embed seams", () => {
  it("a clean row with a chart in a column has no diagnostics", async () => {
    expect(await diagnoseDocument(row(pie()), resolver)).toEqual([]);
  });

  it("the catalog pass sees a cell INSIDE a column", async () => {
    const out = await diagnoseDocument(row(pie("nope")), resolver);
    expect(out.map((d) => d.code)).toEqual(["unknown_key"]);
  });

  it("column grammar reaches the wire with a fix", async () => {
    const md = [
      ":::synap-columns",
      ":::synap-column",
      "A",
      ":::",
      ":::synap-column",
      "B",
      ":::",
      ":::",
    ].join("\n");
    const out = await diagnoseDocument(md, resolver);
    expect(out.map((d) => [d.code, d.severity])).toEqual([
      ["bad_columns", "info"],
      ["bad_columns", "error"],
    ]);
    expect(out[1]!.fix).toMatch(/:::::synap-columns/);
    const widths = await diagnoseDocument(
      row("a").replace('width="60%"', 'width="wide"'),
      resolver
    );
    expect(widths.map((d) => d.code)).toEqual(["bad_width"]);
    expect(widths[0]!.fix).toMatch(/from 15% to 85%/);
  });

  it("the removal floor sees a chart removed from a column", () => {
    expect(removedEmbeds(row(pie()), row("Nothing here."))).toEqual([
      "synap-cell{cellKey=chart-pie}",
    ]);
  });

  it("the freeze snapshots a chart that sits in a column", async () => {
    const read = vi.fn(async () => [
      { createdAt: "2026-09-24T10:00:00Z", properties: { status: "done" } },
    ]);
    const out = await freezeChartEmbeds(
      row(pie()),
      read,
      new Date("2026-09-25T12:00:00Z")
    );
    expect(out.frozen).toBe(1);
    expect(out.markdown).toContain('"capturedAt":"2026-09-25T12:00:00.000Z"');
    // The row around it is untouched.
    expect(
      out.markdown.startsWith(
        ':::::synap-columns\n::::synap-column{width="40%"}'
      )
    ).toBe(true);
    expect(out.markdown.endsWith("::::\n:::::")).toBe(true);
  });
});
