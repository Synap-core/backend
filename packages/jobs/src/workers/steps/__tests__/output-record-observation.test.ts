import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The `record_observation` output step: an outside fact read off this run's
 * trigger is handed to the ONE observation writer through the fail-closed
 * slot (`utils/observation-door.ts`), with the run's chain, for the OWNER in
 * the automation's own workspace. Driven through the REAL slot and the REAL
 * `guardProducerEffect` (only the governance ladder and the sinks are mocked).
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
import {
  registerObservationDoor,
  resetObservationDoorForTests,
  type AutomationObservation,
} from "../../../utils/observation-door.js";
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
  chainDepth: 2,
  rootRunId: "run-0",
  chainAutomationIds: ["auto-0", "auto-1"],
} as unknown as ExecutionPayload["automationContext"];

const run = (config: Record<string, unknown>, producerAgentUserId?: string) =>
  executeOutputStep(
    { outputType: "record_observation", config },
    context(),
    "ws-1",
    autoCtx,
    "human-owner",
    "human-owner",
    { nodeId: "n-1", stepRunId: "sr-1" },
    null,
    producerAgentUserId
  );

const merged = {
  type: "dev.pr_merged",
  subjectId: "Synap-core/backend#12",
  data: {
    repo: "Synap-core/backend",
    number: 12,
    url: "https://github.com/Synap-core/backend/pull/12",
    body: null,
    intoDefault: true,
  },
};

const recorded: AutomationObservation[] = [];

beforeEach(() => {
  resolveDecisionMock.mockClear();
  recorded.length = 0;
  resetObservationDoorForTests();
  registerObservationDoor(async (input) => {
    recorded.push(input);
    return { id: "evt-1" };
  });
});

describe("record_observation — reaches the one writer", () => {
  it("hands the fact, the owner, the run's workspace and its chain to the door", async () => {
    const res = await run(merged);
    expect(res).toEqual({
      status: "recorded",
      eventId: "evt-1",
      type: "dev.pr_merged",
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({
      type: "dev.pr_merged",
      subjectId: "Synap-core/backend#12",
      // `body: null` (a PR with no description) is LEFT OUT: the contract
      // reads an optional field as absent, never null.
      data: {
        repo: "Synap-core/backend",
        number: 12,
        url: "https://github.com/Synap-core/backend/pull/12",
        intoDefault: true,
      },
      ownerId: "human-owner",
      workspaceId: "ws-1",
      automationContext: {
        automationRunId: "run-1",
        automationId: "auto-1",
        chainDepth: 2,
        rootRunId: "run-0",
        chainAutomationIds: ["auto-0", "auto-1"],
      },
    });
  });

  it("names a numeric subject as text", async () => {
    await run({ ...merged, subjectId: 12 });
    expect(recorded[0]!.subjectId).toBe("12");
  });

  it("refuses a step with no type or no subject, recording nothing", async () => {
    await expect(run({ ...merged, type: "" })).rejects.toThrow(
      /config\.type is required/
    );
    await expect(run({ ...merged, subjectId: undefined })).rejects.toThrow(
      /config\.subjectId is required/
    );
    expect(recorded).toHaveLength(0);
  });

  it("FAILS CLOSED when the slot is unfilled", async () => {
    resetObservationDoorForTests();
    await expect(run(merged)).rejects.toThrow(/observation door unregistered/);
  });
});

describe("record_observation — confused-deputy guard", () => {
  it("agent producer + human owner → THROWS, nothing recorded", async () => {
    await expect(run(merged, "producer-agent")).rejects.toThrow(
      /confused-deputy guard/
    );
    expect(recorded).toHaveLength(0);
  });

  it("agent producer whose floor denies → THROWS as denied, nothing recorded", async () => {
    await expect(run(merged, "producer-agent-denied")).rejects.toThrow(
      /denied by producer-agent governance.*capability denied/
    );
    expect(recorded).toHaveLength(0);
  });

  it("a HUMAN producer who is not the owner (an inbound source's owner) → recorded", async () => {
    // An inbound webhook run carries the SOURCE's owner as its producer
    // (events side-effects: `producerAgentUserId: payload.userId`). A person
    // is no agent: the ladder is read and finds none, and the fact records.
    await run(merged, "source-owner");
    expect(recorded).toHaveLength(1);
    expect(resolveDecisionMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentUserId: "source-owner" })
    );
  });

  it("NO producer (a manual or cron run) → recorded, the ladder never read", async () => {
    await run(merged);
    expect(recorded).toHaveLength(1);
    expect(resolveDecisionMock).not.toHaveBeenCalled();
  });
});
