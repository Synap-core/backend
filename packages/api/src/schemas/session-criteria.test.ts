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

  it("refuses an evidence check with no evidenceKey, a capability check with no verb", () => {
    expect(
      sessionCriterionSchema.safeParse({ ...ok, check: { kind: "evidence" } })
        .success
    ).toBe(false);
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
  it("still refuses malformed stage criteria", () => {
    expect(
      playbookStageSchema.safeParse({ ...base, criteria: [{ key: "x" }] })
        .success
    ).toBe(false);
  });
});
