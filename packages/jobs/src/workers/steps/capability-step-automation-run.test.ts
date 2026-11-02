/**
 * A `capability` step hands the canonical router the RUN it belongs to.
 *
 * Decision D4 (Generative UI plan 678c56c4): a document's bound refresher may
 * rewrite the AI sections it wrote itself without a proposal, judged at the
 * patch door from the writing agent and the run session. The executor runs a
 * flow's `document.update` step as the automation's owner with no agent and no
 * session, so D4 could never apply (founder, 2 Nov: "make it work end to end").
 * The step now passes `automationRun` (the run's session + the agent the run
 * writes as) to the router; `executeCapability` hands it to builtin verbs only,
 * never to its gate.
 *
 * This drives the real `executeCapabilityNode` and asserts on what reaches the
 * router (the IoC slot apps/api fills with `executeCapability`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const dispatchViaCapabilityRouter = vi.fn(
  async (..._args: unknown[]): Promise<unknown> => ({
    kind: "run",
    skillId: "skill-document-update",
    result: { status: "applied" },
  })
);
vi.mock("../capability-dispatch.js", () => ({
  dispatchViaCapabilityRouter,
}));
vi.mock("../../utils/automation-governance.js", () => ({
  guardProducerEffect: async () => ({ allow: true }),
  PolicyBlockedError: class extends Error {},
}));

const { executeCapabilityNode } = await import("./command-skill-capability.js");

const context = {
  trigger: { payload: { documentId: "doc-1" } },
  steps: {},
} as unknown as Parameters<typeof executeCapabilityNode>[1];

const NODE = {
  verbId: "document.update",
  inputMapping: { documentId: "{{trigger.payload.documentId}}" },
};

beforeEach(() => dispatchViaCapabilityRouter.mockClear());

describe("capability step: the automation run reaches the router", () => {
  it("passes the run's session and the agent the run writes as", async () => {
    await executeCapabilityNode(NODE, context, {
      workspaceId: "ws-1",
      ownerId: "agent-owner",
      automationRun: { sessionId: "run-session-1", agentUserId: "agent-owner" },
    });
    expect(dispatchViaCapabilityRouter).toHaveBeenCalledTimes(1);
    expect(dispatchViaCapabilityRouter.mock.calls[0]![0]).toMatchObject({
      verbId: "document.update",
      userId: "agent-owner",
      parameters: { documentId: "doc-1" },
      automationRun: { sessionId: "run-session-1", agentUserId: "agent-owner" },
    });
  });

  it("a person's automation run passes its session with no agent", async () => {
    await executeCapabilityNode(NODE, context, {
      workspaceId: "ws-1",
      ownerId: "user-1",
      automationRun: { sessionId: "run-session-2", agentUserId: null },
    });
    expect(dispatchViaCapabilityRouter.mock.calls[0]![0]).toMatchObject({
      automationRun: { sessionId: "run-session-2", agentUserId: null },
    });
  });

  it("never names an agent to the gate (`agentUserId` is not set on the dispatch)", async () => {
    await executeCapabilityNode(NODE, context, {
      workspaceId: "ws-1",
      ownerId: "agent-owner",
      automationRun: { sessionId: "run-session-1", agentUserId: "agent-owner" },
    });
    const input = dispatchViaCapabilityRouter.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect("agentUserId" in input).toBe(false);
  });
});
