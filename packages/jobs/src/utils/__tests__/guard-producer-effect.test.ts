import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * PRODUCER-EFFECT GUARD — guardProducerEffect
 *
 * The confused-deputy guard for the NON-ENTITY effect nodes (facet/relation +
 * capability/skill/command/playbook). Those nodes dispatch through the capability
 * gate as the automation's PRINCIPAL (ownerId / actingUserId), so an
 * agent-produced trigger firing a HUMAN-owned automation would run them under
 * owner-bypass, ungoverned. The guard re-resolves the PRODUCER ladder with
 * forcePropose and reports whether the effect may proceed; the callers fail
 * closed on a block (throw).
 *
 * Mocks `resolveAgentGovernanceDecision` at its module boundary, keyed by the
 * `agentUserId` each call is made against (mirrors the entity guard's test).
 */

const { resolveDecisionMock } = vi.hoisted(() => ({
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
        case "agent-principal":
          return {
            decision: "execute" as const,
            explicitAutoApproveFor: ["*"],
          };
        // human-* / anything else = not an agent user.
        default:
          return { decision: "not-agent" as const };
      }
    }
  ),
}));

vi.mock("@synap/database", () => ({
  db: { select: vi.fn() },
  eq: vi.fn(),
  and: vi.fn(),
  proposals: {},
  verifyPermission: vi.fn(),
  ProposalStatus: { PENDING: "pending" },
  insertPendingProposal: vi.fn(),
}));
vi.mock("@synap/database/agent-governance", () => ({
  resolveAgentGovernanceDecision: resolveDecisionMock,
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../realtime-broadcast.js", () => ({
  broadcastNotification: vi.fn(),
}));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@synap/governance-policy", () => ({
  requiredPermissionFor: vi.fn(() => "write"),
}));

import { guardProducerEffect } from "../automation-governance.js";

const base = {
  workspaceId: "ws-1",
  subjectType: "relation",
  action: "create",
} as const;

beforeEach(() => {
  resolveDecisionMock.mockClear();
});

describe("guardProducerEffect (confused-deputy guard for non-entity nodes)", () => {
  it("agent producer + human principal → BLOCK review (fail closed)", async () => {
    const result = await guardProducerEffect({
      ...base,
      principalUserId: "human-owner",
      producerAgentUserId: "producer-agent",
    });
    expect(result).toEqual({
      block: true,
      kind: "review",
      reason: "forced review",
    });
    // Principal resolved first (not-agent), then producer with forcePropose.
    expect(resolveDecisionMock).toHaveBeenCalledTimes(2);
    expect(resolveDecisionMock.mock.calls[0][0].agentUserId).toBe(
      "human-owner"
    );
    const producerCall = resolveDecisionMock.mock.calls[1][0];
    expect(producerCall.agentUserId).toBe("producer-agent");
    expect(producerCall.forcePropose).toBe(true);
  });

  it("producer agent denied by its own floor → BLOCK deny", async () => {
    const result = await guardProducerEffect({
      ...base,
      principalUserId: "human-owner",
      producerAgentUserId: "producer-agent-denied",
    });
    expect(result).toEqual({
      block: true,
      kind: "deny",
      reason: "capability denied",
    });
  });

  it("no producer → proceed, ZERO DB work (fast path)", async () => {
    const result = await guardProducerEffect({
      ...base,
      principalUserId: "human-owner",
    });
    expect(result).toEqual({ proceed: true });
    expect(resolveDecisionMock).not.toHaveBeenCalled();
  });

  it("human (non-agent) producer → proceed (unchanged owner behavior)", async () => {
    const result = await guardProducerEffect({
      ...base,
      principalUserId: "human-owner",
      producerAgentUserId: "human-producer",
    });
    expect(result).toEqual({ proceed: true });
    // producer resolves not-agent → no block.
    expect(resolveDecisionMock).toHaveBeenCalledTimes(2);
  });

  it("producer === principal → proceed, ZERO DB work (fast path)", async () => {
    const result = await guardProducerEffect({
      ...base,
      principalUserId: "producer-agent",
      producerAgentUserId: "producer-agent",
    });
    expect(result).toEqual({ proceed: true });
    expect(resolveDecisionMock).not.toHaveBeenCalled();
  });

  it("AGENT principal (agent-owned automation) → proceed, producer branch skipped", async () => {
    // The principal's OWN ladder governs the dispatch — guardrail: agent-owned
    // automations are unchanged. The producer is never consulted.
    const result = await guardProducerEffect({
      ...base,
      principalUserId: "agent-principal",
      producerAgentUserId: "producer-agent",
    });
    expect(result).toEqual({ proceed: true });
    expect(resolveDecisionMock).toHaveBeenCalledTimes(1);
    expect(resolveDecisionMock.mock.calls[0][0].agentUserId).toBe(
      "agent-principal"
    );
  });
});
