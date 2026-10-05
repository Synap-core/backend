/**
 * TRIPWIRE — every `OUTPUT_RETIRED_REASONS` value has a label in the
 * vocabulary SSOT, and the table holds nothing outside the closed set. Same
 * shape and same reason as `blocked-reason-vocabulary-parity.test.ts`: the set
 * lives in `@synap/playbooks`, the labels in `@synap-core/types/vocabulary`,
 * and `@synap/api` is the first package that sees both.
 *
 * Presence, not "differs from humanizeToken": "Session cancelled" IS the
 * humanized token, and that is the right word for it.
 */
import { describe, it, expect } from "vitest";
import { OUTPUT_RETIRED_REASONS } from "@synap/playbooks";
import { OUTPUT_RETIRED_REASON_LABELS } from "@synap-core/types/vocabulary";

describe("retiredReason ↔ vocabulary parity", () => {
  it("gives every retire reason an EXPLICIT row", () => {
    // Non-vacuity: the closed set is not empty.
    expect(OUTPUT_RETIRED_REASONS.length).toBeGreaterThanOrEqual(2);
    const missing = OUTPUT_RETIRED_REASONS.filter(
      (r) => !Object.hasOwn(OUTPUT_RETIRED_REASON_LABELS, r)
    );
    expect(missing).toEqual([]);
  });

  it("has no label for a value that is not in the closed set", () => {
    const known = new Set<string>(OUTPUT_RETIRED_REASONS);
    const orphans = Object.keys(OUTPUT_RETIRED_REASON_LABELS).filter(
      (k) => !known.has(k)
    );
    expect(orphans).toEqual([]);
  });
});
