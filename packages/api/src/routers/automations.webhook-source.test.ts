/**
 * An automation's DECLARED inbound webhook source
 * (`triggerConfig.webhookSource.name`) reaches the binder through the ONE
 * insert door, AFTER governance:
 *   - an operator create stores the BOUND config (`webhookSubscriptionId`)
 *     and answers with the source's address, never its secret;
 *   - an approved agent proposal binds when it materializes;
 *   - an agent create that PROPOSES binds nothing (no source is created for a
 *     change nobody approved);
 *   - a malformed declaration is refused before governance and before insert.
 * The binder itself (find-or-create on a real table) is
 * `services/webhooks/inbound-source.pglite.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./hub-protocol/agent-belongs-to.js", () => ({
  agentBelongsTo: async () => true,
}));

const { mockGetDb, mockCheckPermission, bind, find } = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockCheckPermission: vi.fn(),
  bind: vi.fn(),
  find: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb: mockGetDb,
    // Operator RBAC on a create in a space: allowed.
    verifyPermission: async () => ({ allowed: true }),
  };
});
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/permission-check.js")>()),
  checkPermissionOrPropose: mockCheckPermission,
}));
// The binder and the address read are stubbed; the declaration parser
// (`declaredWebhookSource`) stays REAL so the early refusal is the door's own.
vi.mock("../services/webhooks/inbound-source.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../services/webhooks/inbound-source.js")
  >()),
  bindDeclaredWebhookSource: bind,
  findInboundWebhookSourceByName: find,
}));

import {
  automationsRouter,
  materializeApprovedAutomation,
} from "./automations.js";

const WS = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SOURCE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function insertChain(captured: { values?: Record<string, unknown> }) {
  const chain = {
    values: vi.fn((v: Record<string, unknown>) => {
      captured.values = v;
      return chain;
    }),
    onConflictDoNothing: vi.fn(() => chain),
    returning: vi.fn(async () => [{ id: "auto-1" }]),
  };
  return chain;
}

const FLOW = {
  nodes: [
    {
      id: "n1",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: { triggerType: "webhook", label: "GitHub", config: {} },
    },
  ],
  edges: [],
};

const CONTRACT = {
  version: 1 as const,
  mode: "react" as const,
  gets: [
    {
      id: "hook",
      label: "GitHub webhook",
      origin: "manual" as const,
      event: "GitHub posts an event",
      nodeIds: ["n1"],
    },
  ],
  stores: [],
  reacts: [
    {
      id: "run",
      label: "Record it",
      kind: "process" as const,
      nodeIds: ["n1"],
    },
  ],
};

const DECLARED = { webhookSource: { name: "GitHub" } };

beforeEach(() => {
  vi.clearAllMocks();
  bind.mockImplementation(
    async (input: { triggerConfig: Record<string, unknown> }) => ({
      triggerConfig: {
        ...input.triggerConfig,
        webhookSubscriptionId: SOURCE_ID,
      },
      source: { id: SOURCE_ID, name: "GitHub", created: true },
    })
  );
  find.mockResolvedValue({
    id: SOURCE_ID,
    name: "GitHub",
    workspaceId: WS,
    inboundPath: `/api/webhooks/inbound/${SOURCE_ID}`,
    inboundUrl: `https://pod.example.test/api/webhooks/inbound/${SOURCE_ID}`,
  });
});

const caller = () =>
  automationsRouter.createCaller({
    authenticated: true,
    userId: "user-1",
  } as never);

describe("automations — a declared inbound webhook source", () => {
  it("an operator create stores the BOUND config and answers with the address, never a secret", async () => {
    const captured: { values?: Record<string, unknown> } = {};
    mockGetDb.mockResolvedValue({ insert: vi.fn(() => insertChain(captured)) });

    const result = await caller().create({
      workspaceId: WS,
      name: "GitHub PR events",
      triggerType: "webhook",
      triggerConfig: DECLARED,
      flowDefinition: FLOW,
      status: "draft",
    });

    expect(bind).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: WS,
      triggerType: "webhook",
      triggerConfig: DECLARED,
    });
    expect(captured.values?.triggerConfig).toEqual({
      ...DECLARED,
      webhookSubscriptionId: SOURCE_ID,
    });
    expect(result).toMatchObject({
      status: "created",
      webhookSource: {
        id: SOURCE_ID,
        name: "GitHub",
        inboundUrl: `https://pod.example.test/api/webhooks/inbound/${SOURCE_ID}`,
      },
    });
    // The secret slot says where a person gets it; it never carries one.
    expect(
      (result as { webhookSource?: { secret?: string } }).webhookSource?.secret
    ).toMatch(/pod-admin/);
  });

  it("an approved agent proposal binds when it materializes, as its principal", async () => {
    const captured: { values?: Record<string, unknown> } = {};
    await materializeApprovedAutomation({
      database: { insert: vi.fn(() => insertChain(captured)) } as never,
      agentUserId: "agent-1",
      stableId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      definition: {
        workspaceId: WS,
        name: "GitHub PR events",
        triggerType: "webhook",
        triggerConfig: DECLARED,
        flowDefinition: FLOW,
        status: "draft",
        source: "ai",
        metadata: { dataContract: CONTRACT },
      },
    });
    expect(bind).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "agent-1",
        workspaceId: WS,
        triggerType: "webhook",
      })
    );
    expect(captured.values?.triggerConfig).toEqual({
      ...DECLARED,
      webhookSubscriptionId: SOURCE_ID,
    });
  });

  it("an agent create that PROPOSES binds nothing", async () => {
    mockCheckPermission.mockResolvedValue({
      proposalId: "p-1",
      proposalType: "create",
    });
    const insert = vi.fn();
    mockGetDb.mockResolvedValue({ insert });

    const result = await caller().create({
      agentUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "GitHub PR events",
      triggerType: "webhook",
      triggerConfig: DECLARED,
      flowDefinition: FLOW,
      status: "draft",
      metadata: { dataContract: CONTRACT },
    });

    expect(result).toMatchObject({ status: "proposed" });
    expect(bind).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it.each([
    ["a nameless declaration", { webhookSource: {} }, "webhook"],
    ["a declaration on an event trigger", DECLARED, "event"],
  ] as const)(
    "refuses %s before governance and before insert",
    async (_label, triggerConfig, triggerType) => {
      const insert = vi.fn();
      mockGetDb.mockResolvedValue({ insert });
      await expect(
        caller().create({
          agentUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          name: "Broken",
          triggerType,
          triggerConfig: {
            ...(triggerType === "event"
              ? { eventPattern: "entity.create.completed" }
              : {}),
            ...triggerConfig,
          },
          flowDefinition: FLOW,
          status: "draft",
          metadata: { dataContract: CONTRACT },
        })
      ).rejects.toThrow(/webhookSource/);
      expect(mockCheckPermission).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
    }
  );
});
