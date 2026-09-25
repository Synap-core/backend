import { describe, it, expect } from "vitest";
import { ProposalStatus } from "@synap/database/schema";
import {
  PROPOSAL_STATUSES,
  STATUS_ATTENTION,
  isSessionBookkeeping,
  resolveProposalAttention,
  type ProposalAttention,
  type ProposalStatusValue,
} from "../attention.js";

/** An ordinary agent receipt — the shape `checkPermissionOrPropose` files. */
const ENTITY_RECEIPT = {
  proposalType: "entity.create",
  targetType: "entity",
};

describe("resolveProposalAttention — every status", () => {
  const EXPECTED: Record<ProposalStatusValue, ProposalAttention> = {
    pending: "decide",
    approval_failed: "decide",
    auto_approved: "notice",
    approved: "history",
    rejected: "history",
    reverted: "history",
    withdrawn: "history",
    expired: "history",
  };

  it.each(Object.entries(EXPECTED))("%s → %s", (status, attention) => {
    expect(resolveProposalAttention({ status, ...ENTITY_RECEIPT })).toBe(
      attention
    );
  });

  it("the status list is the RUNTIME DB enum, both directions", () => {
    // The compile-time floor in attention.ts proves this for the types; this
    // proves it for the runtime values the DB actually writes.
    const stored = Object.values(ProposalStatus).sort();
    expect([...PROPOSAL_STATUSES].sort()).toEqual(stored);
    expect(Object.keys(STATUS_ATTENTION).sort()).toEqual(stored);
    // Non-vacuity: the table above covers the whole enum.
    expect(Object.keys(EXPECTED).sort()).toEqual(stored);
    expect(stored.length).toBeGreaterThanOrEqual(8);
  });

  it("an unknown status is never guessed into a bucket", () => {
    expect(resolveProposalAttention({ status: "validated" })).toBeNull();
    expect(
      resolveProposalAttention({ status: "some_future_status" })
    ).toBeNull();
    expect(resolveProposalAttention({ status: undefined })).toBeNull();
    expect(resolveProposalAttention({ status: null })).toBeNull();
    // Prototype keys are not statuses.
    expect(resolveProposalAttention({ status: "toString" })).toBeNull();
  });
});

describe("session bookkeeping — the discriminating pairs", () => {
  it("an auto-approved SESSION create is history; an ENTITY create is a notice", () => {
    expect(
      resolveProposalAttention({
        status: "auto_approved",
        proposalType: "focus_session.create",
        targetType: "focus_session",
      })
    ).toBe("history");
    expect(
      resolveProposalAttention({
        status: "auto_approved",
        proposalType: "entity.create",
        targetType: "entity",
      })
    ).toBe("notice");
  });

  it("reads both proposalType shapes: dotted receipt and bare verb", () => {
    for (const proposalType of [
      "focus_session.update",
      "update",
      "focus_session.create",
      "create",
    ]) {
      expect(
        resolveProposalAttention({
          status: "auto_approved",
          proposalType,
          targetType: "focus_session",
        })
      ).toBe("history");
    }
  });

  it("a session-targeted GATE is not bookkeeping — targetType alone is not enough", () => {
    for (const proposalType of [
      "playbook.stage_gate",
      "dev.plan_approval",
      "dev.deploy_approval",
      // Another kind's update, dotted, on a session target: not session bookkeeping.
      "entity.update",
    ]) {
      expect(
        isSessionBookkeeping({
          status: "auto_approved",
          proposalType,
          targetType: "focus_session",
        })
      ).toBe(false);
      expect(
        resolveProposalAttention({
          status: "auto_approved",
          proposalType,
          targetType: "focus_session",
        })
      ).toBe("notice");
    }
  });

  it("bookkeeping never demotes a DECISION — a pending session create is still decide", () => {
    expect(
      resolveProposalAttention({
        status: "pending",
        proposalType: "create",
        targetType: "focus_session",
      })
    ).toBe("decide");
    expect(
      resolveProposalAttention({
        status: "approval_failed",
        proposalType: "focus_session.update",
        targetType: "focus_session",
      })
    ).toBe("decide");
  });

  it("an entity update verb on an entity target is not bookkeeping", () => {
    expect(
      isSessionBookkeeping({
        status: "auto_approved",
        proposalType: "update",
        targetType: "entity",
      })
    ).toBe(false);
  });
});
