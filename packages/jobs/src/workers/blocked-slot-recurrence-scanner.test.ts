import { describe, it, expect } from "vitest";
import {
  clusterBlockedSlots,
  computeBlockedSlotFingerprint,
  qualifiesForRemedy,
  REMEDIABLE_BLOCKED_REASONS,
  type BlockedSlotRow,
} from "./blocked-slot-recurrence-scanner.js";

/**
 * The pure half of the recurrence scanner: fingerprinting, the reason filter,
 * and the two thresholds.
 *
 * FIXTURE DISCIPLINE. Every row below is here because it RULES A RULE OUT —
 * a fixture that no candidate rule disagrees about is decoration. The
 * discriminating cases are: three slots inside ONE session (occurrence
 * threshold met, session threshold not — the two knobs are not redundant), a
 * terminal reason at high volume (the filter is not a volume filter), and a
 * cluster whose members differ only by `label` (the label must not split it).
 */

function slot(o: Partial<BlockedSlotRow> = {}): BlockedSlotRow {
  return {
    sessionId: "s1",
    userId: "u1",
    workspaceId: "ws1",
    blockedReason: "credential",
    why: "the Stripe restricted key for the live account",
    label: "Send the invoice",
    owedSince: "2026-09-01T00:00:00.000Z",
    ...o,
  };
}

describe("computeBlockedSlotFingerprint", () => {
  it("clusters on blockedReason x normalized `why`, and IGNORES the per-session label", () => {
    // The label differs per session; if it entered the key, every cluster would
    // be a singleton and the scanner could never fire.
    const a = computeBlockedSlotFingerprint(
      slot({ label: "Send the invoice", why: "The Stripe  KEY " })
    );
    const b = computeBlockedSlotFingerprint(
      slot({ label: "Reconcile payouts", why: "the stripe key" })
    );
    expect(a).toBe(b);
  });

  it("a different blockedReason with the SAME why is a different cluster", () => {
    expect(
      computeBlockedSlotFingerprint(slot({ blockedReason: "credential" }))
    ).not.toBe(
      computeBlockedSlotFingerprint(slot({ blockedReason: "capability" }))
    );
  });

  it("falls back to the label when `why` is absent, PREFIXED so the two namespaces cannot collide", () => {
    const noWhy = computeBlockedSlotFingerprint(
      slot({ why: undefined, label: "xyz" })
    );
    const withWhy = computeBlockedSlotFingerprint(slot({ why: "xyz" }));
    expect(noWhy).toContain("label:xyz");
    expect(withWhy).toContain("why:xyz");
    expect(noWhy).not.toBe(withWhy);
  });
});

describe("clusterBlockedSlots — the thresholds", () => {
  it("3 slots across 2 sessions qualifies", () => {
    const out = clusterBlockedSlots([
      slot({ sessionId: "s1" }),
      slot({ sessionId: "s1" }),
      slot({ sessionId: "s2" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].occurrences).toBe(3);
    expect(out[0].sessionIds).toEqual(["s1", "s2"]);
    expect(out[0].blockedReason).toBe("credential");
  });

  it("DISCRIMINATING: 3 slots inside ONE session does NOT qualify — one stalled piece of work is not a pattern", () => {
    const out = clusterBlockedSlots([
      slot({ sessionId: "s1" }),
      slot({ sessionId: "s1" }),
      slot({ sessionId: "s1" }),
    ]);
    expect(out).toEqual([]);
  });

  it("DISCRIMINATING: 2 slots across 2 sessions does NOT qualify — the occurrence floor is separate", () => {
    const out = clusterBlockedSlots([
      slot({ sessionId: "s1" }),
      slot({ sessionId: "s2" }),
    ]);
    expect(out).toEqual([]);
  });

  it("DISCRIMINATING: a terminal reason never qualifies, at ANY volume", () => {
    // The reason filter is a filter on KIND, not on volume: `decision` and
    // `physical` have no buildable remedy, and `permission` is excluded from
    // this wave on purpose (the agent arguing for its own power).
    for (const reason of ["policy", "decision", "physical", "permission"]) {
      const many = Array.from({ length: 20 }, (_, i) =>
        slot({ blockedReason: reason, sessionId: `s${i}` })
      );
      expect(clusterBlockedSlots(many)).toEqual([]);
    }
  });

  it("both remediable reasons DO qualify — the filter is not accidentally empty", () => {
    // NON-VACUITY for the test above: if the allowlist were empty, every
    // assertion there would pass for the wrong reason.
    expect(REMEDIABLE_BLOCKED_REASONS.length).toBe(2);
    for (const reason of REMEDIABLE_BLOCKED_REASONS) {
      const out = clusterBlockedSlots([
        slot({ blockedReason: reason, sessionId: "s1" }),
        slot({ blockedReason: reason, sessionId: "s2" }),
        slot({ blockedReason: reason, sessionId: "s3" }),
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].blockedReason).toBe(reason);
    }
  });

  it("clusters are per-USER — two people's identical blocks are two patterns, never one", () => {
    // focus_sessions is owner-private; merging them would propose one person's
    // guideline off another person's evidence.
    const out = clusterBlockedSlots([
      slot({ userId: "u1", sessionId: "s1" }),
      slot({ userId: "u1", sessionId: "s2" }),
      slot({ userId: "u2", sessionId: "s3" }),
      slot({ userId: "u2", sessionId: "s4" }),
    ]);
    expect(out).toEqual([]);
  });

  it("a cluster spanning workspaces becomes pod-wide, not pinned to whichever it saw first", () => {
    // A guideline scoped to ws1 would silently not apply to the ws2 sessions
    // that are half its own evidence.
    const out = clusterBlockedSlots([
      slot({ sessionId: "s1", workspaceId: "ws1" }),
      slot({ sessionId: "s2", workspaceId: "ws2" }),
      slot({ sessionId: "s3", workspaceId: "ws2" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].workspaceId).toBeNull();
  });

  it("a single-workspace cluster stays scoped to it", () => {
    const out = clusterBlockedSlots([
      slot({ sessionId: "s1" }),
      slot({ sessionId: "s2" }),
      slot({ sessionId: "s3" }),
    ]);
    expect(out[0].workspaceId).toBe("ws1");
  });
});

describe("qualifiesForRemedy — the knobs, stated so a change to them is visible", () => {
  it("pins the UNVALIDATED thresholds: 3 occurrences, 2 sessions", () => {
    const base = {
      key: "k",
      userId: "u1",
      workspaceId: null,
      blockedReason: "capability",
      signature: "why:x",
    };
    // Written as literals, NOT as `Math.min(n, THRESHOLD)` — an assertion
    // computed from the constant it is checking is a tautology, which has
    // passed here before. If a knob moves, this test must be edited, which is
    // the whole point: these numbers are unvalidated and their movement should
    // be a visible decision.
    expect(
      qualifiesForRemedy({ ...base, occurrences: 3, sessionIds: ["a", "b"] })
    ).toBe(true);
    expect(
      qualifiesForRemedy({ ...base, occurrences: 2, sessionIds: ["a", "b"] })
    ).toBe(false);
    expect(
      qualifiesForRemedy({ ...base, occurrences: 3, sessionIds: ["a"] })
    ).toBe(false);
  });
});
