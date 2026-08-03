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

/**
 * Cross-package guard: which steps of the SHIPPED report flow are allowed to
 * fail without stopping the run.
 *
 * `errorHandling.continueOnError` is the ONE switch that expresses this — there
 * is no separate `hard`/`optional` field, and adding one would be a second
 * vocabulary for a concept the engine already has. Its two meanings, read off
 * `automation-executor.ts`:
 *
 *   · `true`  = OPTIONAL. The step row records `failed`, `stepsFailed` is
 *     incremented (so the RUN still ends `failed` — the verdict stays honest),
 *     `context.steps[<id>] = { output: { error } }`, and the walk continues.
 *     The `{error: …}` object is what `ASSEMBLE_SYSTEM`'s MISSING ROUNDS rule
 *     renders as a visible `status="failed"` section — the anti-fabrication
 *     path. It is deliberately NOT "" : an empty string is indistinguishable
 *     from a round that had nothing to say.
 *   · absent/`false` = LOAD-BEARING. The walk `break`s, so no downstream node
 *     runs and no output artifact is written.
 *
 * WHY THIS LIVES IN @synap/jobs. The definition-side sibling
 * (`ensure-report-automation.test.ts`) is skipped wherever no test database
 * exists, because @synap/database's vitest setup opens a postgres connection.
 * This suite runs unconditionally, and it is the package that owns the
 * semantics being relied on.
 *
 * Asserted as a WHOLE-GRAPH PARTITION, not an id-by-id list: the regression to
 * catch is a NEW node shipping with `continueOnError: true` — precisely the node
 * a named list would never mention.
 */
describe("shipped report flow — load-bearing vs optional steps", () => {
  const continueOnError = (n: { data: unknown }): boolean | undefined =>
    (n.data as { errorHandling?: { continueOnError?: boolean } }).errorHandling
      ?.continueOnError;

  it("optional = the reads and the interpretation rounds, and nothing else", () => {
    // The four gathers and their four projections are optional for the same
    // reason the rounds are: one dead read should DEGRADE the report, not kill
    // the run, and the assembler renders the gap. Nothing past the projections
    // may join them — everything downstream either produces the body or writes
    // the artifact.
    const optional = REPORT_AUTOMATION_FLOW.nodes
      .filter((n) => continueOnError(n) === true)
      .map((n) => n.id)
      .sort();
    expect(optional).toEqual([
      "analyze",
      "gather-companies",
      "gather-notes",
      "gather-people",
      "gather-tasks",
      "project-companies",
      "project-notes",
      "project-people",
      "project-tasks",
      "relate",
    ]);
  });

  it("the body → summary → write chain is load-bearing, every link", () => {
    // A failed `assemble` must not produce a report entity with no body; a
    // failed `summarize` must not stamp `{"error":…}` into the report's
    // `summary` property (a bare whole-string placeholder passes the step
    // output through NATIVELY); and `create-report` is the artifact itself.
    for (const id of ["assemble", "summarize", "create-report"]) {
      const node = REPORT_AUTOMATION_FLOW.nodes.find((n) => n.id === id);
      expect(node, `node "${id}" is missing from the flow`).toBeDefined();
      expect(continueOnError(node!)).not.toBe(true);
    }
  });
});
