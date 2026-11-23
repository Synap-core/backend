/**
 * The criteria WRITE boundary — strict where a typo would make a criterion
 * unmeetable, bounded at 12, keys unique.
 */

import { describe, it, expect } from "vitest";
import { MAX_SESSION_CRITERIA } from "@synap/playbooks";
import {
  sessionCriteriaSchema,
  sessionCriterionSchema,
} from "./session-criteria.js";
import { playbookStageSchema } from "./playbook-stage.js";

const ok = {
  key: "tsc",
  statement: "Typecheck passes",
  check: { kind: "evidence", evidenceKey: "tsc" },
};

describe("sessionCriterionSchema", () => {
  it("accepts every check kind with its required field", () => {
    for (const check of [
      { kind: "evidence", evidenceKey: "tsc" },
      { kind: "capability", capability: "smoke.run" },
      { kind: "judge", hint: "the README" },
      { kind: "human" },
    ]) {
      expect(sessionCriterionSchema.safeParse({ ...ok, check }).success).toBe(
        true
      );
    }
  });

  it("posts an evidence check with no evidenceKey under the criterion's key; refuses a capability check with no verb", () => {
    const parsed = sessionCriterionSchema.safeParse({
      ...ok,
      check: { kind: "evidence" },
    });
    expect(parsed.success && parsed.data.check).toEqual({
      kind: "evidence",
      evidenceKey: ok.key,
    });
    expect(
      sessionCriterionSchema.safeParse({ ...ok, check: { kind: "capability" } })
        .success
    ).toBe(false);
  });

  it("refuses a misspelled key inside check (a control, not a loose bag)", () => {
    expect(
      sessionCriterionSchema.safeParse({
        ...ok,
        check: { kind: "evidence", evidenceKy: "tsc" },
      }).success
    ).toBe(false);
  });

  // W1 (work model): a criterion may name the session output it checks.
  it("accepts an outputKey in the output-key alphabet, refuses any other", () => {
    const parsed = sessionCriterionSchema.safeParse({
      ...ok,
      outputKey: "pr-backend",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.outputKey).toBe("pr-backend");
    for (const outputKey of ["", "PR backend", "-lead", 3]) {
      expect(
        sessionCriterionSchema.safeParse({ ...ok, outputKey }).success
      ).toBe(false);
    }
  });

  it("refuses a criterion about the method that names an output (W4)", () => {
    const method = { ...ok, about: "method", outputKey: "pr-backend" };
    expect(sessionCriterionSchema.safeParse(method).success).toBe(false);
    expect(
      sessionCriterionSchema.safeParse({ ...method, about: "result" }).success
    ).toBe(true);
    const { outputKey: _o, ...noOutput } = method;
    expect(sessionCriterionSchema.safeParse(noOutput).success).toBe(true);
  });

  it("refuses an unknown kind and a non-slug key", () => {
    expect(
      sessionCriterionSchema.safeParse({ ...ok, check: { kind: "vibes" } })
        .success
    ).toBe(false);
    expect(
      sessionCriterionSchema.safeParse({ ...ok, key: "Has Spaces" }).success
    ).toBe(false);
  });
});

// P8 (pathways): a KPI the pod measures rides on a capability criterion.
describe("sessionCriterionSchema — check.params (measure.check)", () => {
  const measured = {
    key: "ten-meetings",
    statement: "Ten meetings are logged",
    check: {
      kind: "capability",
      capability: "measure.check",
      params: {
        op: "entities.list",
        params: { profileSlug: "meeting" },
        threshold: 10,
        comparator: "gte",
      },
    },
  };

  it("keeps a capability check's params, measure arguments included", () => {
    const parsed = sessionCriterionSchema.safeParse(measured);
    expect(parsed.success && parsed.data.check).toEqual(measured.check);
    const other = sessionCriterionSchema.safeParse({
      ...ok,
      check: { kind: "capability", capability: "smoke.run", params: { n: 1 } },
    });
    expect(other.success && other.data.check.params).toEqual({ n: 1 });
  });

  it("refuses params on a check that runs no verb", () => {
    expect(
      sessionCriterionSchema.safeParse({
        ...ok,
        check: { kind: "judge", hint: "x", params: { n: 1 } },
      }).success
    ).toBe(false);
  });

  it("refuses a measure that would read something else, or nothing", () => {
    const withMeasure = (params: unknown) =>
      sessionCriterionSchema.safeParse({
        ...measured,
        check: { ...measured.check, params },
      }).success;
    // An op outside the measure ops, a param the op does not take, a
    // misspelled comparator, no threshold, a board with no kind.
    expect(withMeasure({ op: "entities.get", threshold: 1 })).toBe(false);
    expect(
      withMeasure({
        op: "entities.list",
        params: { profileslug: "meeting" },
        threshold: 1,
      })
    ).toBe(false);
    expect(
      withMeasure({ op: "entities.list", threshold: 1, comparater: "lt" })
    ).toBe(false);
    expect(withMeasure({ op: "entities.list" })).toBe(false);
    expect(withMeasure({ op: "lifecycle.board", threshold: 1 })).toBe(false);
    expect(withMeasure(undefined)).toBe(false);
    // The space is never a param: the run stamps it.
    expect(
      withMeasure({
        op: "entities.list",
        params: { workspaceId: "w" },
        threshold: 1,
      })
    ).toBe(false);
    expect(
      withMeasure({
        op: "lifecycle.board",
        params: { profileSlug: "deal", column: "won" },
        threshold: 3,
        comparator: "gte",
      })
    ).toBe(true);
  });
});

describe("sessionCriteriaSchema", () => {
  it("refuses more than MAX_SESSION_CRITERIA", () => {
    const list = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...ok, key: `k${i}` }));
    expect(
      sessionCriteriaSchema.safeParse(list(MAX_SESSION_CRITERIA)).success
    ).toBe(true);
    expect(
      sessionCriteriaSchema.safeParse(list(MAX_SESSION_CRITERIA + 1)).success
    ).toBe(false);
  });

  it("refuses duplicate keys", () => {
    expect(sessionCriteriaSchema.safeParse([ok, ok]).success).toBe(false);
  });
});

describe("playbookStageSchema — criteria + check gate", () => {
  const base = { key: "build", name: "Build", category: "started" as const };
  it("accepts stage criteria and a check gate", () => {
    expect(
      playbookStageSchema.safeParse({
        ...base,
        criteria: [ok],
        gate: { kind: "check" },
      }).success
    ).toBe(true);
  });
  it("a stage criterion carries its outputKey", () => {
    const parsed = playbookStageSchema.safeParse({
      ...base,
      criteria: [{ ...ok, outputKey: "pr-backend" }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.criteria?.[0]?.outputKey).toBe("pr-backend");
  });
  it("still refuses malformed stage criteria", () => {
    expect(
      playbookStageSchema.safeParse({ ...base, criteria: [{ key: "x" }] })
        .success
    ).toBe(false);
  });
});
