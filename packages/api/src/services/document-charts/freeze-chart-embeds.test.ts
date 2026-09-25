import { describe, expect, it, vi } from "vitest";
import { parseMarkdown, readEmbed } from "@synap-core/markdown-core";
import {
  parseChartSnapshot,
  shapeChartEntities,
} from "@synap-core/types/renderables";
import { freezeChartEmbeds } from "./freeze-chart-embeds.js";

const NOW = new Date("2026-09-25T12:00:00Z");
const TASKS = [
  { createdAt: "2026-09-24T10:00:00Z", properties: { status: "done" } },
  { createdAt: "2026-09-23T10:00:00Z", properties: { status: "done" } },
  { createdAt: "2026-09-20T10:00:00Z", properties: { status: "open" } },
];

const pie = (profileSlug: string, fallback = "Most tasks are done.") =>
  [
    `:::synap-cell{cellKey="chart-pie"}`,
    "```json",
    JSON.stringify({
      profileSlug,
      groupBy: "status",
      label: "Tasks by status",
    }),
    "```",
    "",
    fallback,
    ":::",
  ].join("\n");

const report = (...blocks: string[]) =>
  [
    "# Workspace report",
    "",
    '::::synap-section{agent="analyst" round="analyze"}',
    "## Most tasks are done",
    "",
    ...blocks.flatMap((b) => [b, ""]),
    "Review is quiet.",
    "::::",
  ].join("\n");

function cells(markdown: string) {
  const out: Array<NonNullable<ReturnType<typeof readEmbed>>> = [];
  const walk = (n: { type: string; name?: string; children?: unknown[] }) => {
    if (n.type === "containerDirective" && n.name === "synap-cell")
      out.push(readEmbed(n as never)!);
    for (const c of n.children ?? []) walk(c as typeof n);
  };
  walk(parseMarkdown(markdown) as never);
  return out;
}

describe("freezeChartEmbeds (D2: report charts are snapshots, the model never writes numbers)", () => {
  it("freezes a live chart into EXACTLY what the live shaper draws from the same rows", async () => {
    const read = vi.fn(async () => TASKS);
    const out = await freezeChartEmbeds(report(pie("task")), read, NOW);
    expect(out.frozen).toBe(1);
    expect(out.diagnostics).toEqual([]);
    const [cell] = cells(out.markdown);
    const props = cell!.props!;
    expect(props).toMatchObject({
      profileSlug: "task",
      groupBy: "status",
      label: "Tasks by status",
    });
    expect(props.data).toEqual(
      shapeChartEntities("chart-pie", TASKS, props, NOW)
    );
    expect(props.data).toEqual([
      { label: "done", value: 2 },
      { label: "open", value: 1 },
    ]);
    expect(props.capturedAt).toBe(NOW.toISOString());
    expect(parseChartSnapshot("categories", props)).toMatchObject({ ok: true });
    // Prose, the section and the fallback are untouched.
    expect(out.markdown).toContain("Most tasks are done.");
    expect(out.markdown).toContain("## Most tasks are done");
    expect(out.markdown.endsWith("Review is quiet.\n::::")).toBe(true);
  });

  it("a FAILED read leaves the chart LIVE, byte-for-byte, with a freeze_failed diagnostic — never empty data", async () => {
    const input = report(pie("task"));
    const out = await freezeChartEmbeds(
      input,
      async () => {
        throw new Error("Unknown profile slug");
      },
      NOW
    );
    expect(out.markdown).toBe(input);
    expect(out.frozen).toBe(0);
    expect(out.diagnostics).toEqual([
      expect.objectContaining({
        code: "freeze_failed",
        severity: "warning",
        ref: { cellKey: "chart-pie" },
      }),
    ]);
    expect(out.diagnostics[0]!.message).toMatch(
      /still reads live.*Unknown profile slug/
    );
    expect(out.diagnostics[0]!.fix).toMatch(/Freeze/);
    expect(out.diagnostics[0]!.line).toBe(6);
    expect(cells(out.markdown)[0]!.props).not.toHaveProperty("data");
  });

  it("ZERO rows is a genuine snapshot: an explicit empty series with its date", async () => {
    const out = await freezeChartEmbeds(
      report(pie("task")),
      async () => [],
      NOW
    );
    const props = cells(out.markdown)[0]!.props!;
    expect(props.data).toEqual([]);
    expect(props.capturedAt).toBe(NOW.toISOString());
    expect(out.diagnostics).toEqual([]);
  });

  it("one read per profile; a failure on one chart does not stop another", async () => {
    const read = vi.fn(async (slug?: string) => {
      if (slug === "ghost") throw new Error("nope");
      return TASKS;
    });
    const out = await freezeChartEmbeds(
      report(pie("task"), pie("task", "Again."), pie("ghost", "Ghosts.")),
      read,
      NOW
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(out.frozen).toBe(2);
    expect(out.diagnostics).toHaveLength(1);
    const embeds = cells(out.markdown);
    expect(embeds.map((e) => "data" in (e.props ?? {}))).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("a failed chart's line is its line in the STORED (output) text, even when a frozen chart above it grew", async () => {
    const tall = [
      ':::synap-cell{cellKey="chart-pie"}',
      "```json",
      "{",
      '  "profileSlug": "task",',
      '  "groupBy": "status"',
      "}",
      "```",
      ":::",
    ].join("\n"); // pretty JSON: the frozen writer compacts it, so lines BELOW shift up
    const read = async (slug?: string) => {
      if (slug === "ghost") throw new Error("nope");
      return TASKS;
    };
    const out = await freezeChartEmbeds(
      report(tall, pie("ghost", "Ghosts.")),
      read,
      NOW
    );
    const line = out.diagnostics[0]!.line;
    expect(out.markdown.split("\n")[line - 1]).toBe(
      ':::synap-cell{cellKey="chart-pie"}'
    );
    expect(out.markdown.split("\n")[line + 1]).toContain('"ghost"');
  });

  it("leaves alone what it cannot freeze honestly: snapshots, live-only charts, non-charts, instances, broken props", async () => {
    const input = report(
      [
        ':::synap-cell{cellKey="chart-pie"}',
        "```json",
        '{"profileSlug":"task","data":[{"label":"x","value":1}]}',
        "```",
        ":::",
      ].join("\n"),
      [
        ':::synap-cell{cellKey="chart-live-line"}',
        "```json",
        '{"profileSlug":"task"}',
        "```",
        ":::",
      ].join("\n"),
      [
        ':::synap-cell{cellKey="stat-card"}',
        "```json",
        '{"profileSlug":"task"}',
        "```",
        ":::",
      ].join("\n"),
      [
        ':::synap-cell{instanceId="11111111-1111-4111-8111-111111111111"}',
        ":::",
      ].join("\n"),
      [
        ':::synap-cell{cellKey="chart-bar"}',
        "```json",
        "{not json",
        "```",
        ":::",
      ].join("\n")
    );
    const read = vi.fn(async () => TASKS);
    const out = await freezeChartEmbeds(input, read, NOW);
    expect(out.markdown).toBe(input);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("the freeze reads with the live chart's cap", () => {
  it("LIVE_CHART_ENTITIES_LIMIT equals the browser chart's CHART_ENTITIES_LIMIT (read from its source)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { LIVE_CHART_ENTITIES_LIMIT } =
      await import("./freeze-charts-verb.js");
    const src = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "..",
        "..",
        "..",
        "synap-app",
        "packages",
        "synap-stores",
        "src",
        "chartEntitiesQueryStore.ts"
      ),
      "utf8"
    );
    const m = src.match(/export const CHART_ENTITIES_LIMIT = (\d+);/);
    expect(m, "browser cap declaration").not.toBeNull();
    expect(LIVE_CHART_ENTITIES_LIMIT).toBe(Number(m![1]));
  });
});
