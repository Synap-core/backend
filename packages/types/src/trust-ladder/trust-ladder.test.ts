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
  type NextRungInput,
} from "./index.js";
import { NON_WIDENABLE_GOVERNANCE_REASONS } from "../proposals/governance-grant-options.js";
import {
  NEXT_RUNG_OUTCOME_LABELS,
  TRUST_RUNG_LABELS,
  resolveTrustRungLabel,
} from "../vocabulary/index.js";
import {
  NEXT_RUNG_OUTCOME,
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
    expect(resolveTrustRung({ kind: "proposal", status: "reverted" })).toBeNull();
    expect(resolveTrustRung({ kind: "proposal", status: "brand_new" })).toBeNull();
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
    for (const status of ["rejected", "withdrawn", "expired", "approval_failed"]) {
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
      expect(nextRung(pending({ governanceReason: code })), code).not.toBeNull();
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
    expect(resolveTrustRungLabel("quiet", "offer")).toBe("Always let it do this");
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
      const m = NEXT_RUNG_OUTCOME[o];
      expect(m.label.length, o).toBeGreaterThan(0);
      expect(m.label, o).toBe(NEXT_RUNG_OUTCOME_LABELS[o]);
    }
    expect(NEXT_RUNG_OUTCOME.needs_admin.label).toBe("Sent to a pod admin");
    expect(NEXT_RUNG_OUTCOME.failed).toMatchObject({ tone: "error", glyph: "alert" });
  });

  it("isNoNextRungError reads the typed code, and the pinned prefix for older pods", () => {
    expect(isNoNextRungError({ data: { reasonCode: NO_NEXT_RUNG_CODE } })).toBe(true);
    expect(isNoNextRungError({ shape: { data: { reasonCode: "NO_NEXT_RUNG" } } })).toBe(true);
    expect(isNoNextRungError({ message: "NO_NEXT_RUNG: nope" })).toBe(true);
    expect(isNoNextRungError({ data: { reasonCode: "OTHER" }, message: "boom" })).toBe(false);
    expect(isNoNextRungError(null)).toBe(false);
  });

  it("the looked-at row cap is shared", () => {
    expect(LOOKED_AT_ROW_CAP).toBe(2);
  });
});
