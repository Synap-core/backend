import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * CONFUSED-DEPUTY GUARD — checkAutomationWriteOrPropose
 *
 * When an automation fires, its THEN-actions were governed against the
 * automation OWNER only. If the owner is a HUMAN, the owner path resolves
 * `not-agent` and auto-executes under RBAC — so an AGENT-produced trigger firing
 * a human-owned automation laundered the agent's write into an UNGOVERNED effect
 * (a confused deputy). The fix threads the causal-chain PRODUCER and, when it is
 * an agent, re-resolves the agent ladder against the PRODUCER with forcePropose:
 * at minimum a PROPOSAL, attributed to the producer — never auto-executes.
 *
 * These tests mock `resolveAgentGovernanceDecision` at its module boundary so
 * the OWNER-vs-PRODUCER branch logic is exercised directly, keyed by the
 * `agentUserId` each call is made against.
 */

const {
  verifyPermissionMock,
  resolveDecisionMock,
  insertPendingProposalMock,
  broadcastMock,
  emitSideEffectsMock,
} = vi.hoisted(() => ({
  verifyPermissionMock: vi.fn(async () => ({ allowed: true })),
  // Verdict keyed by the principal the ladder is resolved against.
  resolveDecisionMock: vi.fn(
    async (input: { agentUserId: string; forcePropose?: boolean }) => {
      switch (input.agentUserId) {
        case "producer-agent":
          return {
            decision: "propose" as const,
            reason: "forced review",
            reasonCode: "SCOPE_IDENTITY_CHANGE",
          };
        case "producer-agent-denied":
          return { decision: "deny" as const, reason: "capability denied" };
        case "agent-owner":
          return {
            decision: "execute" as const,
            explicitAutoApproveFor: ["*"],
          };
        // "human-owner" / "human-producer" / anything else = not an agent user.
        default:
          return { decision: "not-agent" as const };
      }
    }
  ),
  insertPendingProposalMock: vi.fn(async (_input: Record<string, unknown>) => ({
    proposal: { id: "proposal-1" },
    deduped: false,
  })),
  broadcastMock: vi.fn(async () => undefined),
  emitSideEffectsMock: vi.fn(),
}));

vi.mock("@synap/database", () => ({
  db: { select: vi.fn() },
  eq: vi.fn(),
  and: vi.fn(),
  proposals: {},
  verifyPermission: verifyPermissionMock,
  ProposalStatus: { PENDING: "pending" },
  insertPendingProposal: insertPendingProposalMock,
}));

vi.mock("@synap/database/agent-governance", () => ({
  resolveAgentGovernanceDecision: resolveDecisionMock,
}));

vi.mock("@synap/events", () => ({ emitSideEffects: emitSideEffectsMock }));
vi.mock("../realtime-broadcast.js", () => ({
  broadcastNotification: broadcastMock,
}));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@synap/governance-policy", () => ({
  requiredPermissionFor: vi.fn(() => "write"),
}));

import { checkAutomationWriteOrPropose } from "../automation-governance.js";

const baseOpts = {
  workspaceId: "ws-1",
  subjectType: "entity",
  action: "create",
  data: { profileSlug: "note", title: "T" },
} as const;

beforeEach(() => {
  verifyPermissionMock.mockClear();
  verifyPermissionMock.mockResolvedValue({ allowed: true });
  resolveDecisionMock.mockClear();
  insertPendingProposalMock.mockClear();
  insertPendingProposalMock.mockResolvedValue({
    proposal: { id: "proposal-1" },
    deduped: false,
  });
  broadcastMock.mockClear();
  emitSideEffectsMock.mockClear();
});

describe("confused-deputy guard", () => {
  // (i) agent-produced trigger → human-owned automation → PROPOSES, attributed
  //     to the PRODUCER agent (not the human owner).
  it("agent producer + human owner → PROPOSES, attributed to the producer agent", async () => {
    const result = await checkAutomationWriteOrPropose({
      ...baseOpts,
      ownerId: "human-owner",
      producerAgentUserId: "producer-agent",
    });

    expect(result).toEqual({ proposed: true, proposalId: "proposal-1" });
    // Owner resolved first (not-agent), then producer with forcePropose.
    expect(resolveDecisionMock).toHaveBeenCalledTimes(2);
    expect(resolveDecisionMock.mock.calls[0][0].agentUserId).toBe(
      "human-owner"
    );
    const producerCall = resolveDecisionMock.mock.calls[1][0];
    expect(producerCall.agentUserId).toBe("producer-agent");
    expect(producerCall.forcePropose).toBe(true);
    // Proposal is attributed to the PRODUCER agent.
    const inserted = insertPendingProposalMock.mock.calls[0][0];
    expect(inserted.agentUserId).toBe("producer-agent");
    expect(inserted.createdBy).toBe("producer-agent");
  });

  // (ii) human / non-agent trigger → owner auto-executes exactly as before.
  it("human (non-agent) producer + human owner → auto-executes (granted)", async () => {
    const result = await checkAutomationWriteOrPropose({
      ...baseOpts,
      ownerId: "human-owner",
      producerAgentUserId: "human-producer",
    });

    expect(result).toEqual({ granted: true });
    expect(insertPendingProposalMock).not.toHaveBeenCalled();
  });

  it("no producer at all + human owner → auto-executes (granted), unchanged", async () => {
    const result = await checkAutomationWriteOrPropose({
      ...baseOpts,
      ownerId: "human-owner",
    });

    expect(result).toEqual({ granted: true });
    // Only the owner ladder ran; the producer branch was never entered.
    expect(resolveDecisionMock).toHaveBeenCalledTimes(1);
    expect(insertPendingProposalMock).not.toHaveBeenCalled();
  });

  it("producer === owner (both human) → no extra resolution, granted", async () => {
    const result = await checkAutomationWriteOrPropose({
      ...baseOpts,
      ownerId: "human-owner",
      producerAgentUserId: "human-owner",
    });

    expect(result).toEqual({ granted: true });
    // producerInChain is false when producer === owner → single resolution.
    expect(resolveDecisionMock).toHaveBeenCalledTimes(1);
  });

  // (iii) agent-owned automation path is unchanged: the owner ladder governs and
  //       the producer branch is NEVER entered (only reached on owner not-agent).
  it("agent-owned automation → owner ladder governs, producer branch skipped", async () => {
    const result = await checkAutomationWriteOrPropose({
      ...baseOpts,
      ownerId: "agent-owner",
      producerAgentUserId: "producer-agent",
    });

    // agent-owner resolves "execute" → granted, exactly as before the guard.
    expect(result).toEqual({ granted: true });
    expect(resolveDecisionMock).toHaveBeenCalledTimes(1);
    expect(resolveDecisionMock.mock.calls[0][0].agentUserId).toBe(
      "agent-owner"
    );
  });

  // A producer agent whose own FLOOR denies must DENY, not silently grant.
  it("producer agent denied by its own governance floor → DENIED", async () => {
    const result = await checkAutomationWriteOrPropose({
      ...baseOpts,
      ownerId: "human-owner",
      producerAgentUserId: "producer-agent-denied",
    });

    expect(result).toEqual({ denied: true, reason: "capability denied" });
    expect(insertPendingProposalMock).not.toHaveBeenCalled();
  });
});
