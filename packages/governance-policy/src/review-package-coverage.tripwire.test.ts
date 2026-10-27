/**
 * TRIPWIRE — every governed write door files under a REVIEW PACKAGE that was
 * decided, never reached by the classifier's fallback
 * (`reviewPackageOf`, `@synap-core/types/proposals/review-package`; founder
 * B-1, 27 Oct 2026).
 *
 * The scanned set is DERIVED, never hand-listed: the left side is
 * `GOVERNED_WRITE_DOORS`, the pair-keyed map every proposal-filing door must
 * be declared in (the gate's types and `grants-gate-actions` enforce it). A
 * new door therefore fails here until someone decides which decision it asks.
 *
 * Second check: every pair the pod's proposal CLASS calls `access` (who may
 * act) files under Access even when the caller passes no class — the two
 * tables cannot disagree on who-may-act.
 */
import { describe, expect, it } from "vitest";
import { GOVERNED_WRITE_DOORS } from "./index.js";
// Cross-package SOURCE imports, test-only (the `trust-ladder-reach.test.ts`
// precedent): the classifier lives in `@synap-core/types`, the class in
// `@synap/api`'s import-free `proposal-class.ts`.
import {
  REVIEW_PACKAGES,
  reviewPackageDecision,
} from "../../types/src/proposals/review-package.js";
import { classifyProposal } from "../../api/src/services/proposals/proposal-class.js";

const pairs = Object.keys(GOVERNED_WRITE_DOORS).map((key) => {
  const slash = key.indexOf("/");
  return { key, targetType: key.slice(0, slash), proposalType: key.slice(slash + 1) };
});

describe("review packages cover every governed write door", () => {
  it("the scanned set is the door map, and it is not empty", () => {
    expect(pairs.length).toBeGreaterThan(100);
  });

  it("no door reaches the fallback", () => {
    const untaught = pairs
      .filter(
        (p) =>
          reviewPackageDecision({
            kind: "proposal-cluster",
            proposalType: p.proposalType,
            targetType: p.targetType,
          }).rule === "fallback"
      )
      .map((p) => p.key);
    expect(untaught).toEqual([]);
  });

  it("each door lands in exactly one known package", () => {
    for (const p of pairs) {
      const { package: pkg } = reviewPackageDecision(p);
      expect(REVIEW_PACKAGES).toContain(pkg);
    }
  });

  it("every pair the pod classes `access` files under Access without being told", () => {
    const wrong = pairs
      .filter((p) => classifyProposal(p.proposalType, p.targetType) === "access")
      .filter(
        (p) =>
          reviewPackageDecision({
            proposalType: p.proposalType,
            targetType: p.targetType,
          }).package !== "access"
      )
      .map((p) => p.key);
    expect(wrong).toEqual([]);
  });
});
