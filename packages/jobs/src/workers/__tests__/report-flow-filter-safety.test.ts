import { describe, it, expect } from "vitest";
import {
  parseQueryFilterConditions,
  type StepContext,
} from "../automation-executor.js";

/**
 * ENGINE guard: the report flow's gather filters, run through the REAL parser.
 *
 * WHY THIS EXISTS. The `base` report automation bounds each gather with
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
 * emptiness as a finding). This test pins the safe direction of the PARSER.
 *
 * WHAT CHANGED (report-automation retire). This suite used to read the filter
 * strings off the exported `REPORT_AUTOMATION_FLOW` const. That const is gone —
 * the flow now lives in base.yaml (@synap-core/workspace-templates), which
 * `@synap/jobs` does not (and should not) depend on. So the ENGINE invariant
 * (this parser drops an unparseable date, binds a real one) is pinned here on
 * the exact filter SHAPE base uses, and the complementary CONTENT invariant
 * (base's flow actually uses that shape on every gather) is pinned at the SSOT
 * in `@synap-core/workspace-templates`' `base.template.test.ts`.
 */

/** The exact filter shape every base-report gather node carries. */
const BASE_GATHER_FILTER =
  '{"updatedAt": {"$gte": "{{trigger.payload.since}}"}}';

const ctx = (payload: Record<string, unknown>): StepContext =>
  ({
    trigger: { payload },
    steps: {},
    automation: { id: "a", state: {} },
  }) as never;

describe("report gather filter — parser date safety", () => {
  it("NO payload → the term is DROPPED, so the gather stays UNFILTERED", () => {
    expect(parseQueryFilterConditions(BASE_GATHER_FILTER, ctx({}))).toEqual([]);
  });

  it("an unparseable date → dropped, never bound as Invalid Date", () => {
    expect(
      parseQueryFilterConditions(
        BASE_GATHER_FILTER,
        ctx({ since: "last week" })
      )
    ).toEqual([]);
    expect(
      parseQueryFilterConditions(BASE_GATHER_FILTER, ctx({ since: "" }))
    ).toEqual([]);
  });

  it("a real ISO date → a REAL column condition carrying a real Date", () => {
    const conds = parseQueryFilterConditions(
      BASE_GATHER_FILTER,
      ctx({ since: "2026-07-20T00:00:00.000Z" })
    );
    expect(conds).toHaveLength(1);
    const c = conds[0] as unknown as { column?: unknown; value?: unknown };
    // A real COLUMN, not a jsonb property lookup — the whole point.
    expect(c.column).toBeDefined();
    expect(c.value).toBeInstanceOf(Date);
  });
});

/**
 * The load-bearing-vs-optional PARTITION of the report flow (which steps may
 * fail without stopping the run) is a property of base.yaml's flow content, not
 * of this engine. It moved to the SSOT test alongside base.yaml
 * (`@synap-core/workspace-templates`' `base.template.test.ts`) when the hardcoded
 * `REPORT_AUTOMATION_FLOW` const was retired — @synap/jobs no longer has the flow
 * to read. The `continueOnError` SEMANTICS the executor gives that field are
 * covered by `step-retry-policy.test.ts`.
 */
