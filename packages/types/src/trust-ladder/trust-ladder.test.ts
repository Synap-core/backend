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
import { TRUST_RUNG_LABELS, resolveTrustRungLabel } from "../vocabulary/index.js";

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

  it("an auto-approved receipt is do+tell when told, quiet when not (the attention rule)", () => {
    expect(
      resolveTrustRung({
        kind: "proposal",
        status: "auto_approved",
        proposalType: "entity.create",
        targetType: "entity",
      })
    ).toBe("do_tell");
    expect(
      resolveTrustRung({
        kind: "proposal",
        status: "auto_approved",
        proposalType: "focus_session.update",
        targetType: "focus_session",
      })
    ).toBe("quiet");
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

  it("offers nothing where no config expresses the step yet (ask → propose, do+tell → quiet) or at the top", () => {
    expect(nextRung({ item: { kind: "slot", owner: "human" } })).toBeNull();
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
    expect(resolveTrustRungLabel("quiet", "offer")).toBe("Next time, just do it");
    expect(resolveTrustRungLabel("some_rung")).toBe("Some rung");
  });
});
