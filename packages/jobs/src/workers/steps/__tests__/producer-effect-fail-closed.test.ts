import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * CONFUSED-DEPUTY GUARD — caller fail-closed (non-entity effect nodes)
 *
 * Proves that when an AGENT produced the trigger firing a HUMAN-owned automation,
 * the facet/relation output verbs (via `dispatchOutputVerb`) and the capability
 * node (via `executeCapabilityNode`) are GOVERNED against the producer and FAIL
 * CLOSED (throw) — the capability router is never reached, so the effect never
 * auto-executes under owner-bypass. Absent a producer, the node dispatches as
 * before.
 *
 * Mocks `resolveAgentGovernanceDecision` (so the real `guardProducerEffect` runs)
 * and the capability router (to assert it is / isn't reached).
 */

const { resolveDecisionMock, capabilityExecutorMock } = vi.hoisted(() => ({
  resolveDecisionMock: vi.fn(
    async (input: { agentUserId: string; forcePropose?: boolean }) => {
      switch (input.agentUserId) {
        case "producer-agent":
          return { decision: "propose" as const, reason: "forced review" };
        case "producer-agent-denied":
          return { decision: "deny" as const, reason: "capability denied" };
        default:
          return { decision: "not-agent" as const };
      }
    }
  ),
  capabilityExecutorMock: vi.fn(async () => ({
    kind: "run" as const,
    skillId: "s-1",
    result: { status: "ok" },
  })),
}));

vi.mock("@synap/database", () => ({
  db: { select: vi.fn() },
  eq: vi.fn(),
  and: vi.fn(),
  proposals: {},
  verifyPermission: vi.fn(),
  ProposalStatus: { PENDING: "pending" },
  insertPendingProposal: vi.fn(),
  automationStepRuns: {},
}));
vi.mock("@synap/database/agent-governance", () => ({
  resolveAgentGovernanceDecision: resolveDecisionMock,
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../../../utils/realtime-broadcast.js", () => ({
  broadcastNotification: vi.fn(),
}));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@synap/governance-policy", () => ({
  requiredPermissionFor: vi.fn(() => "write"),
}));
// The command/skill/capability node executor pulls in the IS client + template
// resolvers; only the capability path is exercised here, so keep the mock thin.
vi.mock("@synap/intelligence-client", () => ({
  getDefaultActiveService: vi.fn(),
  requestTaskExecute: vi.fn(),
}));

import {
  dispatchOutputVerb,
  registerCapabilityExecutor,
} from "../../capability-dispatch.js";
import { executeCapabilityNode } from "../command-skill-capability.js";
import type { StepContext } from "../../automation-executor-types.js";

const context = () =>
  ({
    trigger: { payload: {} },
    steps: {},
    automation: { id: "auto-1", state: {} },
  }) as unknown as StepContext;

beforeEach(() => {
  resolveDecisionMock.mockClear();
  capabilityExecutorMock.mockClear();
  registerCapabilityExecutor(capabilityExecutorMock);
});

describe("dispatchOutputVerb — producer guard fail-closed", () => {
  it("agent producer + human principal → THROWS, router never reached", async () => {
    await expect(
      dispatchOutputVerb(
        "graph.link",
        { fromEntityId: "a", toEntityId: "b", relationType: "rel" },
        "ws-1",
        "human-owner",
        "producer-agent"
      )
    ).rejects.toThrow(/confused-deputy guard/);
    expect(capabilityExecutorMock).not.toHaveBeenCalled();
  });

  it("agent producer denied by its own floor → THROWS 'denied'", async () => {
    await expect(
      dispatchOutputVerb(
        "entity_facet.attach",
        { entityId: "a", facetSlug: "client" },
        "ws-1",
        "human-owner",
        "producer-agent-denied"
      )
    ).rejects.toThrow(/denied by producer-agent governance/);
    expect(capabilityExecutorMock).not.toHaveBeenCalled();
  });

  it("NO producer → dispatches normally (router reached)", async () => {
    const result = await dispatchOutputVerb(
      "graph.link",
      { fromEntityId: "a", toEntityId: "b", relationType: "rel" },
      "ws-1",
      "human-owner"
    );
    expect(result).toEqual({ status: "ok" });
    expect(capabilityExecutorMock).toHaveBeenCalledTimes(1);
    // The guard never touched the ladder (no producer in chain).
    expect(resolveDecisionMock).not.toHaveBeenCalled();
  });
});

describe("executeCapabilityNode — producer guard fail-closed", () => {
  it("agent producer + human owner → THROWS, router never reached", async () => {
    await expect(
      executeCapabilityNode({ verbId: "mail.send" }, context(), {
        workspaceId: "ws-1",
        ownerId: "human-owner",
        producerAgentUserId: "producer-agent",
      })
    ).rejects.toThrow(/confused-deputy guard/);
    expect(capabilityExecutorMock).not.toHaveBeenCalled();
  });

  it("NO producer → dispatches normally (router reached)", async () => {
    const result = await executeCapabilityNode(
      { verbId: "mail.send" },
      context(),
      {
        workspaceId: "ws-1",
        ownerId: "human-owner",
      }
    );
    expect(result).toEqual({ status: "ok" });
    expect(capabilityExecutorMock).toHaveBeenCalledTimes(1);
  });
});
