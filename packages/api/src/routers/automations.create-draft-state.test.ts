/**
 * P2-3 (draft-state remedy) contract test.
 *
 * `automation.create` is in DEFAULT_AUTO_APPROVE, so a prompt-injected agent
 * could otherwise plant a standing WHEN-trigger automation with no human
 * review. The remedy keeps auto-approve (no proposal friction for the
 * proactive-bridge roadmap) but forces every agent-originated create to land
 * `draft` regardless of the `status` it requested — a planted trigger exists
 * but can never FIRE (the cron scheduler / trigger matcher only select
 * `status='active'` rows) until a human explicitly activates it.
 *
 * A human's own direct create (no `agentUserId`) is NOT forced — it keeps
 * whatever `status` it requested. This test pins both halves of that
 * contract at `insertAutomationAfterGovernance`'s single INSERT door.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetDb, mockCheckPermission } = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockCheckPermission: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, getDb: mockGetDb };
});

vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

// Auto-approve is the branch under test: the agent-authored create is
// GRANTED (not proposed), so `create()` falls straight through to the
// direct-insert door — exactly the DEFAULT_AUTO_APPROVE path this remedy
// guards.
vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: mockCheckPermission,
}));

import {
  automationsRouter,
  materializeApprovedAutomation,
} from "./automations.js";

function insertChain(captured: { values?: Record<string, unknown> }) {
  const chain = {
    values: vi.fn((v: Record<string, unknown>) => {
      captured.values = v;
      return chain;
    }),
    onConflictDoNothing: vi.fn(() => chain),
    returning: vi.fn(async () => [
      { id: (captured.values?.id as string | undefined) ?? "auto-created-1" },
    ]),
  };
  return chain;
}

const VALID_DATA_CONTRACT = {
  version: 1 as const,
  mode: "react" as const,
  gets: [
    {
      id: "manual-input",
      label: "Manual request",
      origin: "manual" as const,
      event: "Operator starts the automation",
      nodeIds: ["n1"],
    },
  ],
  stores: [],
  reacts: [
    {
      id: "run-process",
      label: "Run the process",
      kind: "process" as const,
      nodeIds: ["n1"],
    },
  ],
};

function callerCtx() {
  return { authenticated: true, userId: "user-1" } as never;
}

const MANUAL_FLOW = {
  nodes: [
    {
      id: "n1",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: { triggerType: "manual", label: "Manual", config: {} },
    },
  ],
  edges: [],
};

describe("P2-3 draft-state remedy — automation create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckPermission.mockResolvedValue({ granted: true });
  });

  it("forces an agent-originated (auto-approved) create to 'draft', overriding the requested 'active' status", async () => {
    const captured: { values?: Record<string, unknown> } = {};
    mockGetDb.mockResolvedValue({ insert: vi.fn(() => insertChain(captured)) });

    const caller = automationsRouter.createCaller(callerCtx());
    const result = await caller.create({
      agentUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Agent-planted trigger",
      triggerType: "manual",
      triggerConfig: {},
      flowDefinition: MANUAL_FLOW,
      status: "active", // requested active — must NOT be honored
      metadata: { dataContract: VALID_DATA_CONTRACT },
    });

    expect(mockCheckPermission).toHaveBeenCalled();
    expect(result.status).toBe("created");
    expect(captured.values?.status).toBe("draft");
    expect(result.message).toContain("draft");
  });

  it("does NOT force a human direct create (no agentUserId) — requested 'active' status is honored", async () => {
    const captured: { values?: Record<string, unknown> } = {};
    mockGetDb.mockResolvedValue({ insert: vi.fn(() => insertChain(captured)) });

    const caller = automationsRouter.createCaller(callerCtx());
    const result = await caller.create({
      name: "Human-authored automation",
      triggerType: "manual",
      triggerConfig: {},
      flowDefinition: MANUAL_FLOW,
      status: "active",
    });

    // No agentUserId → the governance membrane is never consulted (operator
    // direct-write path).
    expect(mockCheckPermission).not.toHaveBeenCalled();
    expect(result.status).toBe("created");
    expect(captured.values?.status).toBe("active");
    expect(result.message).toContain("active");
  });

  it("materializeApprovedAutomation (proposal-approved, always agent-originated) also forces 'draft'", async () => {
    const captured: { values?: Record<string, unknown> } = {};
    const database = { insert: vi.fn(() => insertChain(captured)) };

    const result = await materializeApprovedAutomation({
      database: database as never,
      agentUserId: "agent-1",
      stableId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      definition: {
        name: "Proposal-approved automation",
        triggerType: "manual",
        triggerConfig: {},
        flowDefinition: MANUAL_FLOW,
        status: "active", // the approved proposal requested active
        source: "ai",
        metadata: { dataContract: VALID_DATA_CONTRACT },
      },
    });

    expect(captured.values?.status).toBe("draft");
    expect(result).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });
});
