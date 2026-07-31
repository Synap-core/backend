/**
 * Filter-coercion tests for the two LEDGER source nodes (`runs_query`,
 * `proposals_query`).
 *
 * The two rules under test pull in OPPOSITE directions on purpose, and getting
 * either backwards produces a report that lies:
 *
 *   - `since` — an unparseable date is DROPPED (with a warning), never bound.
 *     Dropping WIDENS the result set, which is visible in the output; binding an
 *     `Invalid Date` NARROWS it to zero rows silently, i.e. a report that says
 *     "nothing happened last night" when everything did. Same discipline as
 *     `coerceDateFilterValue` in the entity `query` node.
 *   - `status` — a filter that resolves to no KNOWN enum value yields an EMPTY
 *     set, never every row. The author asked to narrow, so a bad narrow must not
 *     silently become "show me everything" dressed up as an answer. (Same
 *     semantic as `listAutomationRuns` in packages/api.)
 *
 * No mocks: the executor module imports cleanly without a DB connection (same as
 * automation-executor-internals.test.ts).
 */

import { describe, it, expect } from "vitest";
import {
  parseMultiValueField,
  resolveSinceFilter,
  narrowStatuses,
  RUN_STATUS_VALUES,
  PROPOSAL_STATUS_VALUES,
  type StepContext,
} from "../automation-executor.js";

const ctx = (overrides: Partial<StepContext> = {}): StepContext => ({
  trigger: { payload: {} },
  steps: {},
  automation: { id: "a1", state: {} },
  ...overrides,
});

describe("resolveSinceFilter — DROP, never bind, an unparseable date", () => {
  it("parses an ISO-8601 string", () => {
    const d = resolveSinceFilter("2026-07-30T00:00:00Z", ctx(), "runs_query");
    expect(d).toBeInstanceOf(Date);
    expect(d!.toISOString()).toBe("2026-07-30T00:00:00.000Z");
  });

  it("parses epoch millis", () => {
    const d = resolveSinceFilter(1753833600000, ctx(), "runs_query");
    expect(d?.getTime()).toBe(1753833600000);
  });

  it("DROPS a non-date phrase rather than binding Invalid Date", () => {
    expect(
      resolveSinceFilter("last week", ctx(), "runs_query")
    ).toBeUndefined();
  });

  it("DROPS an unresolved template (resolves to '') rather than binding it", () => {
    // `resolveTemplate` returns "" for a missing path — the exact silent-zero-rows
    // trap this rule exists to kill.
    expect(
      resolveSinceFilter("{{trigger.payload.nope}}", ctx(), "proposals_query")
    ).toBeUndefined();
  });

  it("resolves a template that DOES point at a real date", () => {
    const d = resolveSinceFilter(
      "{{trigger.payload.since}}",
      ctx({ trigger: { payload: { since: "2026-07-30T00:00:00Z" } } }),
      "runs_query"
    );
    expect(d?.toISOString()).toBe("2026-07-30T00:00:00.000Z");
  });

  it("treats absent / empty as 'no filter' (undefined), not as a bad date", () => {
    expect(resolveSinceFilter(undefined, ctx(), "runs_query")).toBeUndefined();
    expect(resolveSinceFilter("", ctx(), "runs_query")).toBeUndefined();
    expect(resolveSinceFilter(null, ctx(), "runs_query")).toBeUndefined();
  });
});

describe("parseMultiValueField", () => {
  it("splits a comma-separated string and trims", () => {
    expect(parseMultiValueField("failed, completed ", ctx())).toEqual([
      "failed",
      "completed",
    ]);
  });

  it("accepts a real array", () => {
    expect(parseMultiValueField(["a", "b"], ctx())).toEqual(["a", "b"]);
  });

  it("resolves templates before splitting", () => {
    expect(
      parseMultiValueField(
        "{{trigger.payload.statuses}}",
        ctx({ trigger: { payload: { statuses: "failed,cancelled" } } })
      )
    ).toEqual(["failed", "cancelled"]);
  });

  it("returns undefined (= no filter) for empty / whitespace / unresolved", () => {
    expect(parseMultiValueField(undefined, ctx())).toBeUndefined();
    expect(parseMultiValueField("  ,  ", ctx())).toBeUndefined();
    expect(
      parseMultiValueField("{{trigger.payload.nope}}", ctx())
    ).toBeUndefined();
  });
});

describe("narrowStatuses — a bad narrow yields EMPTY, never everything", () => {
  it("keeps known run statuses", () => {
    expect(narrowStatuses(["failed", "completed"], RUN_STATUS_VALUES)).toEqual([
      "failed",
      "completed",
    ]);
  });

  it("drops an unknown value but keeps the known ones", () => {
    expect(narrowStatuses(["faild", "failed"], RUN_STATUS_VALUES)).toEqual([
      "failed",
    ]);
  });

  it("returns an EMPTY array (→ caller returns no rows) when nothing is known", () => {
    // NOT `undefined` — undefined would mean "no filter" and widen to every run.
    expect(narrowStatuses(["faild"], RUN_STATUS_VALUES)).toEqual([]);
  });

  it("passes `undefined` (no filter specified) straight through", () => {
    expect(narrowStatuses(undefined, RUN_STATUS_VALUES)).toBeUndefined();
  });

  it("proposal statuses use their own enum, not the run one", () => {
    expect(narrowStatuses(["pending"], PROPOSAL_STATUS_VALUES)).toEqual([
      "pending",
    ]);
    // "running" is a RUN status and must not pass the proposal enum.
    expect(narrowStatuses(["running"], PROPOSAL_STATUS_VALUES)).toEqual([]);
    expect(narrowStatuses(["pending"], RUN_STATUS_VALUES)).toEqual([]);
  });
});
