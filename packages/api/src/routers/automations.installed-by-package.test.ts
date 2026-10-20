/**
 * `metadata.installedByPackage` is server-owned: it names the package allowed
 * to re-install over the automation (`assertNoNamedClash`), so only a package
 * apply stamps it (`stampInstalledByPackage`). A client's create or update,
 * an agent's proposal and an approved proposal's materialization all drop the
 * key from the caller's metadata — a forged stamp would hand the row to any
 * package that names it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./hub-protocol/agent-belongs-to.js", () => ({
  agentBelongsTo: async () => true,
}));

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
vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
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
    returning: vi.fn(async () => [{ id: "auto-1" }]),
  };
  return chain;
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

const DATA_CONTRACT = {
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

const caller = () =>
  automationsRouter.createCaller({
    authenticated: true,
    userId: "user-1",
  } as never);

describe("installedByPackage is never the caller's to write", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a person's create drops it and keeps the rest", async () => {
    const captured: { values?: Record<string, unknown> } = {};
    mockGetDb.mockResolvedValue({ insert: vi.fn(() => insertChain(captured)) });
    await caller().create({
      name: "Digest",
      triggerType: "manual",
      triggerConfig: {},
      flowDefinition: MANUAL_FLOW,
      metadata: { kind: "digest", installedByPackage: "acme/crm" },
    });
    expect(captured.values?.metadata).toEqual({
      kind: "digest",
      createdVia: "manual",
    });
  });

  it("an agent's create never carries it into the proposal", async () => {
    mockGetDb.mockResolvedValue({});
    mockCheckPermission.mockResolvedValue({
      proposalId: "p1",
      proposalType: "automation.create",
    });
    await caller().create({
      agentUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Digest",
      triggerType: "manual",
      triggerConfig: {},
      flowDefinition: MANUAL_FLOW,
      metadata: {
        dataContract: DATA_CONTRACT,
        installedByPackage: "acme/crm",
      },
    });
    const data = mockCheckPermission.mock.calls[0]![0].data as {
      metadata: Record<string, unknown>;
    };
    expect(data.metadata).toEqual({ dataContract: DATA_CONTRACT });
  });

  it("an approved proposal carrying it (filed or revised before) materializes without it", async () => {
    const captured: { values?: Record<string, unknown> } = {};
    const database = { insert: vi.fn(() => insertChain(captured)) };
    await materializeApprovedAutomation({
      database: database as never,
      agentUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      stableId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      definition: {
        name: "Digest",
        triggerType: "manual",
        triggerConfig: {},
        flowDefinition: MANUAL_FLOW,
        status: "draft",
        metadata: {
          dataContract: DATA_CONTRACT,
          installedByPackage: "acme/crm",
        },
        source: "ai",
      },
    });
    expect(captured.values?.metadata).toEqual({
      dataContract: DATA_CONTRACT,
      createdVia: "ai",
    });
  });
});
