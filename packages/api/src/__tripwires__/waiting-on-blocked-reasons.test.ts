/**
 * TRIPWIRE — every blocked reason says what a goal WAITS ON (R4).
 *
 * `BLOCKED_REASONS` (`@synap/playbooks`) is the closed set of why a slot is
 * owed to a person; `BLOCKED_REASON_WAITING_ON` (`@synap-core/types/units`)
 * maps each one to the waiting-on reasons a goal shows (input · approval
 * · access · another_work · outside_world). The mapping function falls back
 * to "input" for a reason it does not know — right for a slot that recorded
 * no reason, WRONG for a seventh blocked reason nobody mapped (a missing
 * credential would read as "waiting on input"). So the fallback must never be
 * how a declared blocked reason gets its answer: every one has its own row.
 *
 * The two packages cannot import each other; `@synap/api` is the first that
 * depends on both. Behavioural: the mapping FUNCTION is driven, not only the
 * table read.
 */
import { describe, it, expect } from "vitest";
import { BLOCKED_REASONS } from "@synap/playbooks";
import {
  BLOCKED_REASON_WAITING_ON,
  WAITING_ON_REASONS,
  waitingOnReasonOf,
} from "@synap-core/types/units";

describe("blocked reasons ↔ waiting-on reasons", () => {
  it("every blocked reason has its OWN row (never the input fallback)", () => {
    const unmapped = BLOCKED_REASONS.filter(
      (r) => !Object.hasOwn(BLOCKED_REASON_WAITING_ON, r)
    );
    expect(unmapped).toEqual([]);
    // Non-vacuity: the closed set is the six it was built from.
    expect(BLOCKED_REASONS.length).toBeGreaterThanOrEqual(6);
  });

  it("the table names no value outside the closed set", () => {
    const known = new Set<string>(BLOCKED_REASONS);
    expect(
      Object.keys(BLOCKED_REASON_WAITING_ON).filter((k) => !known.has(k))
    ).toEqual([]);
  });

  it("the mapping function answers each blocked reason from its row", () => {
    for (const r of BLOCKED_REASONS) {
      const reason = waitingOnReasonOf({ kind: "owed_slot", blockedReason: r });
      expect(WAITING_ON_REASONS).toContain(reason);
      expect(reason).toBe(
        BLOCKED_REASON_WAITING_ON[r as keyof typeof BLOCKED_REASON_WAITING_ON]
      );
    }
    // The R4 cut, pinned: the credential/permission/capability/policy family
    // is ACCESS, a person's choice is INPUT, a physical act is the OUTSIDE WORLD.
    expect(
      waitingOnReasonOf({ kind: "owed_slot", blockedReason: "credential" })
    ).toBe("access");
    expect(
      waitingOnReasonOf({ kind: "owed_slot", blockedReason: "decision" })
    ).toBe("input");
    expect(
      waitingOnReasonOf({ kind: "owed_slot", blockedReason: "physical" })
    ).toBe("outside_world");
    expect(waitingOnReasonOf({ kind: "owed_slot" })).toBe("input");
    expect(waitingOnReasonOf({ kind: "pending_proposal" })).toBe("approval");
    expect(waitingOnReasonOf({ kind: "blocked_by" })).toBe("another_work");
  });
});
