import { describe, it, expect } from "vitest";
import { REPORT_AUTOMATION_FLOW } from "@synap/database";
import {
  parseQueryFilterConditions,
  type StepContext,
} from "../automation-executor.js";

/**
 * Cross-package guard: the SHIPPED report flow's filters, run through the REAL
 * parser.
 *
 * WHY THIS EXISTS. The seeded flow bounds each gather with
 * `{"updatedAt": {"$gte": "{{trigger.payload.since}}"}}`, and the automation is
 * documented to be runnable with NO payload at all. So on the canonical run
 * that placeholder resolves to `""`.
 *
 * That is the single most dangerous shape in this engine. If an unparseable
 * date were BOUND rather than dropped, every gather would silently match zero
 * rows, all three AI rounds would receive nothing, and the report would state
 * that the workspace is empty — which is exactly the failure that shipped on
 * 2026-07-27 (via a different mechanism) and cost a full debugging session.
 *
 * The failure directions are asymmetric and that asymmetry is the design:
 * dropping a bad term WIDENS the result (visible, self-correcting), binding one
 * NARROWS it to nothing (invisible, and the narrator confidently reports the
 * emptiness as a finding). This test pins the safe direction.
 *
 * It reads the filter off the REAL exported flow rather than restating the
 * string, so editing the flow without re-reading this file cannot quietly
 * invalidate the guarantee.
 */
function gatherFilters(): string[] {
  return REPORT_AUTOMATION_FLOW.nodes
    .filter((n) => n.type === "query")
    .map((n) => (n.data as { filter?: unknown }).filter)
    .filter((f): f is string => typeof f === "string" && f.length > 0);
}

const ctx = (payload: Record<string, unknown>): StepContext =>
  ({
    trigger: { payload },
    steps: {},
    automation: { id: "a", state: {} },
  }) as never;

describe("shipped report flow — gather filter safety", () => {
  it("has a filter on every gather node (guard against silent removal)", () => {
    expect(gatherFilters().length).toBeGreaterThan(0);
  });

  it("NO payload → every filter term is DROPPED, so gathers stay UNFILTERED", () => {
    for (const filter of gatherFilters()) {
      expect(parseQueryFilterConditions(filter, ctx({}))).toEqual([]);
    }
  });

  it("an unparseable date → dropped, never bound as Invalid Date", () => {
    for (const filter of gatherFilters()) {
      expect(
        parseQueryFilterConditions(filter, ctx({ since: "last week" }))
      ).toEqual([]);
      expect(parseQueryFilterConditions(filter, ctx({ since: "" }))).toEqual(
        []
      );
    }
  });

  it("a real ISO date → a REAL column condition carrying a real Date", () => {
    for (const filter of gatherFilters()) {
      const conds = parseQueryFilterConditions(
        filter,
        ctx({ since: "2026-07-20T00:00:00.000Z" })
      );
      expect(conds).toHaveLength(1);
      const c = conds[0] as unknown as { column?: unknown; value?: unknown };
      // A real COLUMN, not a jsonb property lookup — the whole point.
      expect(c.column).toBeDefined();
      expect(c.value).toBeInstanceOf(Date);
    }
  });
});
