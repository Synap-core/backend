import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * CONFUSED-DEPUTY GUARD — the DIRECT-effect output nodes + the backstop.
 *
 * `webhook` (external POST with the owner's vault creds) and `channel_message`
 * (post under the owner's identity) emit DIRECTLY — not through the capability
 * gate — so the node-by-node guard originally MISSED them. These prove that when
 * an AGENT produced the trigger firing a HUMAN-owned automation, both nodes FAIL
 * CLOSED (throw) BEFORE any external fetch / channel insert, and that an
 * unclassified output type is caught by the fail-closed backstop. Absent a
 * producer (or an agent-OWNED automation), behavior is unchanged.
 *
 * Mocks `resolveAgentGovernanceDecision` (so the real `guardProducerEffect` +
 * backstop run) and the external sinks (to assert they are never reached).
 */

const { resolveDecisionMock, safeExternalFetchMock, insertChannelMessageMock } =
  vi.hoisted(() => ({
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
    safeExternalFetchMock: vi.fn(async () => ({ ok: true, status: 200 })),
    insertChannelMessageMock: vi.fn(async () => ({ id: "msg-1" })),
  }));

vi.mock("@synap/database", () => ({
  db: { select: vi.fn(), update: vi.fn(), insert: vi.fn() },
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  isNull: vi.fn(),
  desc: vi.fn(),
  automations: {},
  entities: {},
  users: {},
  channels: {},
  notifications: {},
  focusSessions: {},
  playbookEnrollments: {},
  relations: {},
  drizzleSql: vi.fn(),
  EntityRepository: class {},
  EntityBodyService: class {},
  materializeEntity: vi.fn(),
  eventRepository: {},
  insertChannelMessage: insertChannelMessageMock,
  ChannelRepository: class {},
  proposals: {},
  ProposalStatus: { PENDING: "pending" },
  insertPendingProposal: vi.fn(),
  automationStepRuns: {},
  verifyPermission: vi.fn(),
}));
vi.mock("@synap/database/agent-governance", () => ({
  resolveAgentGovernanceDecision: resolveDecisionMock,
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../../../utils/vault-resolver.js", () => ({
  resolveVaultReferences: vi.fn(async (h: unknown) => h),
  isVaultReference: vi.fn(() => false),
}));
vi.mock("@synap/shared-utils", () => ({
  validateExternalUrl: vi.fn(() => ({ valid: true })),
  safeExternalFetch: safeExternalFetchMock,
}));
vi.mock("../../template-resolve.js", () => ({
  deepResolveTemplates: vi.fn((c: unknown) => c),
}));
vi.mock("../../capability-dispatch.js", () => ({
  dispatchOutputVerb: vi.fn(async () => ({ status: "ok" })),
}));
vi.mock("../../automation-executor-logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@synap/governance-policy", () => ({
  requiredPermissionFor: vi.fn(() => "write"),
}));

import { executeOutputStep } from "../output.js";
import type {
  StepContext,
  ExecutionPayload,
} from "../../automation-executor-types.js";

const context = () =>
  ({
    trigger: { payload: {} },
    steps: {},
    automation: { id: "auto-1", state: {} },
  }) as unknown as StepContext;

const autoCtx = {
  automationId: "auto-1",
  automationRunId: "run-1",
} as unknown as ExecutionPayload["automationContext"];

// executeOutputStep(data, context, workspaceId, automationContext, ownerId,
//                   actingUserId, attribution?, runSubjectEntityId?, producerAgentUserId?)
const run = (
  data: { outputType: string; config: Record<string, unknown> },
  producerAgentUserId?: string,
  ownerId = "human-owner"
) =>
  executeOutputStep(
    data,
    context(),
    "ws-1",
    autoCtx,
    ownerId,
    ownerId,
    { nodeId: "n-1", stepRunId: "sr-1" },
    null,
    producerAgentUserId
  );

beforeEach(() => {
  resolveDecisionMock.mockClear();
  safeExternalFetchMock.mockClear();
  insertChannelMessageMock.mockClear();
});

describe("webhook — producer guard fail-closed (M1)", () => {
  it("agent producer + human owner → THROWS, external fetch never reached", async () => {
    await expect(
      run(
        { outputType: "webhook", config: { url: "https://example.com/hook" } },
        "producer-agent"
      )
    ).rejects.toThrow(/confused-deputy guard/);
    expect(safeExternalFetchMock).not.toHaveBeenCalled();
  });

  it("agent producer denied by its own floor → THROWS 'denied'", async () => {
    await expect(
      run(
        { outputType: "webhook", config: { url: "https://example.com/hook" } },
        "producer-agent-denied"
      )
    ).rejects.toThrow(/denied by producer-agent governance/);
    expect(safeExternalFetchMock).not.toHaveBeenCalled();
  });

  it("NO producer → proceeds to fetch (guard never touches the ladder)", async () => {
    const res = await run({
      outputType: "webhook",
      config: { url: "https://example.com/hook" },
    });
    expect(res).toMatchObject({ status: "sent" });
    expect(safeExternalFetchMock).toHaveBeenCalledTimes(1);
    expect(resolveDecisionMock).not.toHaveBeenCalled();
  });

  it("agent-OWNED automation (producer === owner) → NOT blocked, proceeds", async () => {
    const res = await run(
      { outputType: "webhook", config: { url: "https://example.com/hook" } },
      "human-owner"
    );
    expect(res).toMatchObject({ status: "sent" });
    expect(safeExternalFetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("channel_message — producer guard fail-closed (S2)", () => {
  it("agent producer + human owner → THROWS, no channel insert", async () => {
    await expect(
      run(
        {
          outputType: "channel_message",
          config: { content: "hi", channelId: "c-1" },
        },
        "producer-agent"
      )
    ).rejects.toThrow(/confused-deputy guard/);
    expect(insertChannelMessageMock).not.toHaveBeenCalled();
  });
});

describe("fail-closed backstop — unclassified effect type", () => {
  it("agent producer + unknown output type → THROWS backstop", async () => {
    await expect(
      run({ outputType: "some_future_effect", config: {} }, "producer-agent")
    ).rejects.toThrow(/fail-closed backstop/);
  });

  it("NO producer + unknown output type → falls to inert default (no throw)", async () => {
    const res = await run({ outputType: "some_future_effect", config: {} });
    expect(res).toMatchObject({ status: "unknown_output_type" });
  });

  it("agent-OWNED (producer === owner) + unknown type → inert default, no backstop throw", async () => {
    const res = await run(
      { outputType: "some_future_effect", config: {} },
      "human-owner"
    );
    expect(res).toMatchObject({ status: "unknown_output_type" });
  });
});
