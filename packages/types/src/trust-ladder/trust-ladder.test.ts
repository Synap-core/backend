import { describe, it, expect } from "vitest";
import {
  GOVERNANCE_REASON_RULE_REACH,
  NEXT_RUNG_VIA,
  TRUST_RUNGS,
  nextRung,
  nextRungRuleDraft,
  proposalEventKey,
  resolveTrustRung,
  ruleCanReachReason,
  earnedStreak,
  MIN_DELIBERATION_MS,
  STREAK_MIN_DAYS,
  STREAK_NEEDED,
  type NextRungInput,
  type StreakDecision,
} from "./index.js";
import { NON_WIDENABLE_GOVERNANCE_REASONS } from "../proposals/governance-grant-options.js";
import {
  NEXT_RUNG_OUTCOME_LABELS,
  TRUST_RUNG_LABELS,
  resolveTrustRungLabel,
} from "../vocabulary/index.js";
import {
  resolveNextRungOutcomeView,
  NEXT_RUNG_OUTCOMES,
  NO_NEXT_RUNG_CODE,
  isNoNextRungError,
} from "./index.js";
import { LOOKED_AT_ROW_CAP } from "../ask/index.js";

const pending = (over: Partial<NextRungInput> = {}): NextRungInput => ({
  item: {
    kind: "proposal",
    status: "pending",
    proposalType: "update",
    targetType: "entity",
  },
  agentUserId: "agent-1",
  governanceReason: null,
  reversible: true,
  profileSlug: "note",
  workspaceId: "ws-1",
  ...over,
});

describe("resolveTrustRung", () => {
  it("a human-owned slot is an ask; an agent-owned one sits on no rung", () => {
    expect(resolveTrustRung({ kind: "slot", owner: "human" })).toBe("ask");
    expect(resolveTrustRung({ kind: "slot", owner: "agent" })).toBeNull();
    expect(resolveTrustRung({ kind: "slot" })).toBeNull();
  });

  it("every settled-or-open proposal status is the propose rung", () => {
    for (const status of [
      "pending",
      "approval_failed",
      "approved",
      "rejected",
      "withdrawn",
      "expired",
    ]) {
      expect(resolveTrustRung({ kind: "proposal", status }), status).toBe(
        "propose"
      );
    }
  });

  it("a receipt is do+tell under the default, quiet under the person's own rule", () => {
    const receipt = {
      kind: "proposal" as const,
      status: "auto_approved",
      proposalType: "entity.create",
      targetType: "entity",
    };
    expect(resolveTrustRung(receipt)).toBe("do_tell");
    expect(resolveTrustRung({ ...receipt, grantedByRule: false })).toBe(
      "do_tell"
    );
    expect(resolveTrustRung({ ...receipt, grantedByRule: true })).toBe("quiet");
  });

  it("session bookkeeping sits on no rung (the attention rule demotes it)", () => {
    expect(
      resolveTrustRung({
        kind: "proposal",
        status: "auto_approved",
        proposalType: "focus_session.update",
        targetType: "focus_session",
      })
    ).toBeNull();
  });

  it("reverted and unknown statuses are never guessed onto a rung", () => {
    expect(
      resolveTrustRung({ kind: "proposal", status: "reverted" })
    ).toBeNull();
    expect(
      resolveTrustRung({ kind: "proposal", status: "brand_new" })
    ).toBeNull();
    expect(resolveTrustRung({ kind: "proposal", status: null })).toBeNull();
  });
});

describe("nextRung", () => {
  it("a pending, reversible, agent proposal offers do+tell through a governance rule", () => {
    expect(nextRung(pending())).toEqual({
      from: "propose",
      to: "do_tell",
      via: "governance_rule",
      reach: "space",
    });
    expect(
      nextRung(
        pending({
          item: {
            kind: "proposal",
            status: "approved",
            proposalType: "update",
            targetType: "entity",
          },
        })
      )
    ).not.toBeNull();
  });

  it("offers nothing for a no, a missing agent, an irreversible or unknown-reversibility write", () => {
    for (const status of [
      "rejected",
      "withdrawn",
      "expired",
      "approval_failed",
    ]) {
      expect(
        nextRung(pending({ item: { kind: "proposal", status } })),
        status
      ).toBeNull();
    }
    expect(nextRung(pending({ agentUserId: null }))).toBeNull();
    expect(nextRung(pending({ reversible: false }))).toBeNull();
    expect(nextRung(pending({ reversible: undefined }))).toBeNull();
  });

  it("never offers a grant on an item a floor routed (every non-widenable code, scope, unknown)", () => {
    for (const code of [
      ...NON_WIDENABLE_GOVERNANCE_REASONS,
      "SCOPE_IDENTITY_CHANGE",
      "CRITERIA_CHANGE",
      "UNTRUSTED_ORIGIN",
      "DAILY_WRITE_CEILING",
      "CHANNEL_PROPOSE",
      "A_CODE_FROM_THE_FUTURE",
    ]) {
      expect(nextRung(pending({ governanceReason: code })), code).toBeNull();
    }
  });

  it("offers it when a rule (a posture) or the writes-require-proposal switch routed it", () => {
    for (const code of ["GOVERNANCE_RULE", "WRITES_REQUIRE_PROPOSAL"]) {
      expect(
        nextRung(pending({ governanceReason: code })),
        code
      ).not.toBeNull();
    }
  });

  it("do+tell is the V1 offer ceiling: a do+tell receipt offers nothing (quiet deferred)", () => {
    expect(
      nextRung(
        pending({
          item: {
            kind: "proposal",
            status: "auto_approved",
            proposalType: "entity.create",
            targetType: "entity",
          },
        })
      )
    ).toBeNull();
  });

  it("offers nothing where no config expresses the step (ask → propose), at the top, or on bookkeeping", () => {
    expect(nextRung({ item: { kind: "slot", owner: "human" } })).toBeNull();
    expect(
      nextRung(
        pending({
          item: {
            kind: "proposal",
            status: "auto_approved",
            proposalType: "entity.create",
            targetType: "entity",
            grantedByRule: true,
          },
        })
      )
    ).toBeNull();
    expect(
      nextRung(
        pending({
          item: {
            kind: "proposal",
            status: "auto_approved",
            proposalType: "focus_session.update",
            targetType: "focus_session",
          },
        })
      )
    ).toBeNull();
    expect(NEXT_RUNG_VIA).toEqual({
      ask: null,
      propose: "governance_rule",
      do_tell: null,
      quiet: null,
    });
  });
});

describe("ruleCanReachReason", () => {
  it("the mirrored non-widenable floor set is inside `floor`", () => {
    for (const code of NON_WIDENABLE_GOVERNANCE_REASONS) {
      expect(
        (GOVERNANCE_REASON_RULE_REACH as Record<string, string>)[code],
        code
      ).toBe("floor");
      expect(ruleCanReachReason(code), code).toBe(false);
    }
  });

  it("no code = the default fall-through, which every rule outranks", () => {
    expect(ruleCanReachReason(null)).toBe(true);
    expect(ruleCanReachReason(undefined)).toBe(true);
  });
});

describe("the grant", () => {
  it("reads a dotted receipt type and a bare pending verb as the same key", () => {
    expect(
      proposalEventKey({ targetType: "entity", proposalType: "entity.create" })
    ).toBe("entity.create");
    expect(
      proposalEventKey({ targetType: "entity", proposalType: "create" })
    ).toBe("entity.create");
  });

  it("drafts the NARROWEST rule: agent × workspace × exact action × profile, auto", () => {
    expect(
      nextRungRuleDraft({
        proposalId: "p-1",
        agentUserId: "agent-1",
        workspaceId: "ws-1",
        eventKey: "entity.update",
        profileSlug: "note",
      })
    ).toEqual({
      principalKind: "agent",
      agentUserId: "agent-1",
      scopeKind: "workspace",
      workspaceId: "ws-1",
      targetKind: "action",
      targetPattern: "entity.update",
      targetProfile: "note",
      verdict: "auto",
      sourceProposalId: "p-1",
    });
    const pod = nextRungRuleDraft({
      proposalId: "p-2",
      agentUserId: "agent-1",
      workspaceId: null,
      eventKey: "document.update",
    });
    expect(pod.scopeKind).toBe("pod");
    expect(pod).not.toHaveProperty("workspaceId");
    expect(pod).not.toHaveProperty("targetProfile");
  });
});

describe("the words", () => {
  it("every rung has a name and an offer, through the vocabulary", () => {
    for (const rung of TRUST_RUNGS) {
      expect(TRUST_RUNG_LABELS[rung].name.length, rung).toBeGreaterThan(0);
      expect(TRUST_RUNG_LABELS[rung].offer.length, rung).toBeGreaterThan(0);
    }
    expect(resolveTrustRungLabel("do_tell")).toBe("Does it, tells you");
    expect(resolveTrustRungLabel("quiet", "offer")).toBe(
      "Always let it do this"
    );
    expect(resolveTrustRungLabel("some_rung")).toBe("Some rung");
  });
});

describe("W7 review: kind, reach, outcomes, refusal", () => {
  it("an entity grant with no known kind is REFUSED, never widened to every kind", () => {
    expect(nextRung(pending({ profileSlug: null }))).toBeNull();
    expect(nextRung(pending({ profileSlug: undefined }))).toBeNull();
    // A non-entity subject needs no kind (a document is one kind already).
    expect(
      nextRung(
        pending({
          profileSlug: null,
          item: {
            kind: "proposal",
            status: "pending",
            proposalType: "update",
            targetType: "document",
          },
        })
      )
    ).not.toBeNull();
  });

  it("a pod-wide grant says so: reach is 'pod' without a space", () => {
    expect(nextRung(pending({ workspaceId: null }))?.reach).toBe("pod");
    expect(nextRung(pending())?.reach).toBe("space");
  });

  it("every outcome is a mark with words from the vocabulary", () => {
    for (const o of [...NEXT_RUNG_OUTCOMES, "failed"] as const) {
      const m = resolveNextRungOutcomeView(o);
      expect(m.label.length, o).toBeGreaterThan(0);
      expect(m.label, o).toBe(NEXT_RUNG_OUTCOME_LABELS[o]);
      expect(m.glyph, o).not.toBe("question");
    }
    expect(resolveNextRungOutcomeView("needs_admin").label).toBe(
      "Sent to a pod admin"
    );
    expect(resolveNextRungOutcomeView("failed")).toMatchObject({
      tone: "error",
      glyph: "alert",
    });
    expect(resolveNextRungOutcomeView("from_the_future")).toMatchObject({
      label: "From the future",
      glyph: "question",
    });
  });

  it("isNoNextRungError reads the typed code, and the pinned prefix for older pods", () => {
    expect(isNoNextRungError({ data: { reasonCode: NO_NEXT_RUNG_CODE } })).toBe(
      true
    );
    expect(
      isNoNextRungError({ shape: { data: { reasonCode: "NO_NEXT_RUNG" } } })
    ).toBe(true);
    expect(isNoNextRungError({ message: "NO_NEXT_RUNG: nope" })).toBe(true);
    expect(
      isNoNextRungError({ data: { reasonCode: "OTHER" }, message: "boom" })
    ).toBe(false);
    expect(isNoNextRungError(null)).toBe(false);
  });

  it("the looked-at row cap is shared", () => {
    expect(LOOKED_AT_ROW_CAP).toBe(2);
  });
});

// ─── The earned streak (S3, founder Q3) ─────────────────────────────────────

const DAY1 = Date.parse("2026-10-20T10:00:00.000Z");
const DAY2 = Date.parse("2026-10-21T10:00:00.000Z");

/**
 * A human approval decided `afterMs` after it was filed, at `at` (newest
 * first is NOT assumed: `earnedStreak` orders by the decided instant).
 */
function approval(
  at: number,
  over: Partial<StreakDecision> & { afterMs?: number } = {}
): StreakDecision {
  const { afterMs = 60_000, ...rest } = over;
  return {
    status: "approved",
    data: {},
    revisionHistory: [],
    createdAt: new Date(at - afterMs),
    reviewedAt: new Date(at),
    reviewedBy: "user-owner",
    ...rest,
  };
}

/** `n` approvals one minute apart, ending at `end` (the newest). */
function approvals(n: number, end: number): StreakDecision[] {
  return Array.from({ length: n }, (_, i) => approval(end - i * 60_000));
}

/** Ten approvals: five on day 2, five on day 1. */
function tenOverTwoDays(): StreakDecision[] {
  return [...approvals(5, DAY2), ...approvals(5, DAY1)];
}

describe("earnedStreak", () => {
  it("meets at exactly 10 human, unedited, ≥3 s approvals over 2 days", () => {
    expect(STREAK_NEEDED).toBe(10);
    expect(STREAK_MIN_DAYS).toBe(2);
    expect(MIN_DELIBERATION_MS).toBe(3_000);
    const s = earnedStreak(tenOverTwoDays());
    expect(s).toEqual({
      met: true,
      count: 10,
      needed: 10,
      since: new Date(DAY1 - 4 * 60_000).toISOString(),
    });
    // Exactly 3 s is deliberate enough.
    const atFloor = tenOverTwoDays();
    atFloor[0] = approval(DAY2, { afterMs: MIN_DELIBERATION_MS });
    expect(earnedStreak(atFloor).met).toBe(true);
  });

  it("nine is not ten", () => {
    const s = earnedStreak(tenOverTwoDays().slice(1));
    expect(s.met).toBe(false);
    expect(s.count).toBe(9);
  });

  it("ten on a single day is not met", () => {
    const s = earnedStreak(approvals(10, DAY2));
    expect(s.count).toBe(10);
    expect(s.met).toBe(false);
  });

  it("a receipt among them is never evidence: it counts for nothing", () => {
    const rows = tenOverTwoDays();
    rows[3] = {
      ...approval(DAY2 - 3 * 60_000),
      status: "auto_approved",
      reviewedBy: null,
      data: { _autoApprove: { approvedBy: "system:auto_approve" } },
    };
    const s = earnedStreak(rows);
    expect(s.count).toBe(9);
    expect(s.met).toBe(false);
    // Receipts alone earn nothing.
    const receipts = approvals(12, DAY2).map((r) => ({
      ...r,
      status: "auto_approved",
      reviewedBy: null,
    }));
    expect(earnedStreak(receipts).count).toBe(0);
  });

  it("a person's edit breaks the run; an agent's own revision does not", () => {
    const rows = tenOverTwoDays();
    rows[4] = approval(DAY2 - 4 * 60_000, {
      revisionHistory: [{ at: "x", by: "user-owner", before: {}, patch: {} }],
    });
    const s = earnedStreak(rows);
    expect(s.count).toBe(4);
    expect(s.met).toBe(false);

    const byAgent = tenOverTwoDays();
    byAgent[4] = approval(DAY2 - 4 * 60_000, {
      revisionHistory: [
        {
          at: "x",
          by: "user-owner",
          actingAgentUserId: "agent-1",
          before: {},
          patch: {},
        },
      ],
    });
    expect(earnedStreak(byAgent).met).toBe(true);
  });

  it("an approval faster than 3 s breaks the run", () => {
    const rows = tenOverTwoDays();
    rows[2] = approval(DAY2 - 2 * 60_000, { afterMs: 2_000 });
    const s = earnedStreak(rows);
    expect(s.count).toBe(2);
    expect(s.met).toBe(false);
  });

  it("a rejection breaks the run", () => {
    const rows = [
      ...approvals(3, DAY2),
      { ...approval(DAY2 - 3 * 60_000), status: "rejected" },
      ...approvals(10, DAY1),
    ];
    const s = earnedStreak(rows);
    expect(s.count).toBe(3);
    expect(s.met).toBe(false);
  });

  it("a partial approval, a revert and a reopened revert all break the run", () => {
    const partial = tenOverTwoDays();
    partial[1] = approval(DAY2 - 60_000, {
      data: { dispositions: { $op0: { status: "reject" } } },
    });
    expect(earnedStreak(partial).count).toBe(1);

    const reverted = tenOverTwoDays();
    reverted[1] = { ...approval(DAY2 - 60_000), status: "reverted" };
    expect(earnedStreak(reverted).count).toBe(1);

    // Reverted, re-proposed and approved again: the undo still happened.
    const reopened = tenOverTwoDays();
    reopened[1] = approval(DAY2 - 60_000, {
      data: { revertedAt: new Date(DAY2 - 90_000).toISOString() },
    });
    expect(earnedStreak(reopened).count).toBe(1);
  });

  it("withdrawn and expired rows neither count nor break", () => {
    const rows = tenOverTwoDays();
    rows.splice(2, 0, { ...approval(DAY2 - 90_000), status: "withdrawn" });
    rows.splice(6, 0, { ...approval(DAY2 - 300_000), status: "expired" });
    const s = earnedStreak(rows);
    expect(s.count).toBe(10);
    expect(s.met).toBe(true);
  });

  it("orders by the decided instant, never by input order", () => {
    const rows = tenOverTwoDays().reverse();
    expect(earnedStreak(rows).met).toBe(true);
  });

  it("no history is no streak", () => {
    expect(earnedStreak([])).toEqual({
      met: false,
      count: 0,
      needed: 10,
      since: null,
    });
  });
});
