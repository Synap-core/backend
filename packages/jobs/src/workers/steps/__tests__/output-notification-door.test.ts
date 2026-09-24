import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * `notification` output node — the LAST of three jobs-side `db.insert(notifications)`
 * bypasses (the other two, `proactive-post.ts` and `a2ai-response-trigger.ts`, were
 * fixed onto the `notification-creator.ts` IoC slot earlier). This asserts the
 * bypass is gone: the node goes through `createNotificationViaService` and never
 * touches `db.insert` directly.
 */

const { createNotificationViaServiceMock, dbInsertMock } = vi.hoisted(() => ({
  createNotificationViaServiceMock: vi.fn(async () => "notif-1"),
  dbInsertMock: vi.fn(),
}));

vi.mock("@synap/database", () => ({
  db: { select: vi.fn(), update: vi.fn(), insert: dbInsertMock },
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  isNull: vi.fn(),
  desc: vi.fn(),
  automations: {},
  entities: {},
  users: {},
  channels: {},
  focusSessions: {},
  playbookEnrollments: {},
  relations: {},
  drizzleSql: vi.fn(),
  EntityRepository: class {},
  EntityBodyService: class {},
  materializeEntity: vi.fn(),
  eventRepository: {},
  insertChannelMessage: vi.fn(),
  ChannelRepository: class {},
  proposals: {},
  ProposalStatus: { PENDING: "pending" },
  insertPendingProposal: vi.fn(),
  automationStepRuns: {},
  verifyPermission: vi.fn(),
}));
vi.mock("@synap/database/agent-governance", () => ({
  resolveAgentGovernanceDecision: vi.fn(async () => ({
    decision: "not-agent" as const,
  })),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../../../utils/vault-resolver.js", () => ({
  resolveVaultReferences: vi.fn(async (h: unknown) => h),
  isVaultReference: vi.fn(() => false),
}));
vi.mock("@synap/shared-utils", () => ({
  validateExternalUrl: vi.fn(() => ({ valid: true })),
  safeExternalFetch: vi.fn(async () => ({ ok: true, status: 200 })),
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
vi.mock("../../../utils/notification-creator.js", () => ({
  createNotificationViaService: createNotificationViaServiceMock,
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

const run = (config: Record<string, unknown>) =>
  executeOutputStep(
    { outputType: "notification", config },
    context(),
    "ws-1",
    autoCtx,
    "human-owner",
    "human-owner",
    { nodeId: "n-1", stepRunId: "sr-1" },
    null,
    undefined
  );

beforeEach(() => {
  createNotificationViaServiceMock.mockClear();
  dbInsertMock.mockClear();
});

describe("output notification — routed through the canonical write door", () => {
  it("calls createNotificationViaService with the fixed 'automation.notification' type, never db.insert", async () => {
    const res = await run({ title: "Heads up", body: "Something happened" });

    expect(res).toMatchObject({ status: "sent" });
    expect(dbInsertMock).not.toHaveBeenCalled();
    expect(createNotificationViaServiceMock).toHaveBeenCalledTimes(1);
    expect(createNotificationViaServiceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "automation.notification",
        userId: "human-owner",
        workspaceId: "ws-1",
        sourceType: "automation",
        data: { title: "Heads up", body: "Something happened" },
      })
    );
  });

  it("entityId becomes sourceId and derives a groupKey when config.groupKey is absent", async () => {
    await run({ body: "note", entityId: "entity-9" });

    expect(createNotificationViaServiceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "entity-9",
        groupKey: "automation.auto-1.entity-9",
      })
    );
  });

  it("missing body/message → skipped, door never called", async () => {
    const res = await run({ title: "No body" });

    expect(res).toMatchObject({ status: "skipped" });
    expect(createNotificationViaServiceMock).not.toHaveBeenCalled();
  });
});
