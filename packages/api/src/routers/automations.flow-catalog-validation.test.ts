/**
 * Catalog-reference validation at the automation persistence doors.
 *
 * The flow validator itself is pure; these tests prove the router supplies its
 * optional resolvers before an operator write or an AI creation proposal can
 * happen. DB rows are mocked because this is specifically a door-ordering and
 * resolver-wiring contract, not an integration test for Postgres.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  selectResults: [] as Array<Array<{ id: string; name: string }>>,
  insertValues: [] as Array<Record<string, unknown>>,
  updateSets: [] as Array<Record<string, unknown>>,
  permissionCalls: 0,
  existing: {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    createdBy: "user-1",
    version: 1,
    flowDefinition: { nodes: [], edges: [] },
    triggerType: "manual",
    triggerConfig: {},
    metadata: {},
  } as Record<string, unknown>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const readChain = {
    from: vi.fn(() => readChain),
    where: vi.fn(async () => h.selectResults.shift() ?? []),
    limit: vi.fn(async () => h.selectResults.shift() ?? []),
  };
  return {
    ...actual,
    getDb: vi.fn(async () => ({
      select: vi.fn(() => readChain),
      query: {
        automations: { findFirst: vi.fn(async () => h.existing) },
      },
      insert: vi.fn(() => ({
        values: vi.fn((values: Record<string, unknown>) => {
          h.insertValues.push(values);
          return {
            onConflictDoNothing: vi.fn(() => ({
              returning: vi.fn(async () => [{ id: "auto-1" }]),
            })),
          };
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          h.updateSets.push(values);
          return { where: vi.fn(async () => undefined) };
        }),
      })),
    })),
  };
});

vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

vi.mock("../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async () => {
    h.permissionCalls += 1;
    return { granted: true };
  }),
}));

import { automationsRouter } from "./automations.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

function caller() {
  return automationsRouter.createCaller({
    authenticated: true,
    userId: "user-1",
    workspaceId: WORKSPACE_ID,
  } as never);
}

const UNKNOWN_REFERENCES_FLOW = {
  nodes: [
    {
      id: "capability-step",
      type: "capability",
      data: { verbId: "missing.verb" },
    },
    {
      id: "skill-step",
      type: "skill",
      data: { skillId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    },
    {
      id: "playbook-step",
      type: "playbook_run",
      data: { playbookId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    },
  ],
  edges: [],
};

const VALID_DATA_CONTRACT = {
  version: 1 as const,
  mode: "react" as const,
  gets: [
    {
      id: "manual-input",
      label: "Manual request",
      nodeIds: ["capability-step"],
      origin: "manual" as const,
      event: "Operator starts the automation",
    },
  ],
  stores: [],
  reacts: [
    {
      id: "perform-capability",
      label: "Run the selected capability",
      nodeIds: ["capability-step"],
      kind: "process" as const,
    },
  ],
};

beforeEach(() => {
  h.selectResults.length = 0;
  h.insertValues.length = 0;
  h.updateSets.length = 0;
  h.permissionCalls = 0;
  h.existing.metadata = {};
  h.existing.flowDefinition = { nodes: [], edges: [] };
});

describe("automations flow catalog validation", () => {
  it("rejects unknown capability verbs, skills, and playbooks before create writes or proposes", async () => {
    // One bounded skills lookup, then one bounded playbooks lookup; neither
    // returns a match for the three submitted references.
    h.selectResults.push([], []);

    await expect(
      caller().create({
        workspaceId: WORKSPACE_ID,
        name: "Broken agent automation",
        triggerType: "manual",
        triggerConfig: {},
        flowDefinition: UNKNOWN_REFERENCES_FLOW,
        agentUserId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        metadata: { dataContract: VALID_DATA_CONTRACT },
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("missing.verb"),
    });

    expect(h.insertValues).toHaveLength(0);
    expect(h.permissionCalls).toBe(0);
  });

  it("rejects AI-authored creates without a truthful data contract before database work", async () => {
    await expect(
      caller().create({
        workspaceId: WORKSPACE_ID,
        name: "Opaque agent automation",
        triggerType: "manual",
        triggerConfig: {},
        flowDefinition: { nodes: [{ id: "step-1" }], edges: [] },
        agentUserId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(h.selectResults).toHaveLength(0);
    expect(h.insertValues).toHaveLength(0);
    expect(h.permissionCalls).toBe(0);
  });

  it("rejects data-contract references that do not exist in the flow", async () => {
    await expect(
      caller().create({
        workspaceId: WORKSPACE_ID,
        name: "Untraceable agent automation",
        triggerType: "manual",
        triggerConfig: {},
        flowDefinition: { nodes: [{ id: "step-1" }], edges: [] },
        source: "ai",
        metadata: {
          dataContract: {
            ...VALID_DATA_CONTRACT,
            gets: [
              {
                ...VALID_DATA_CONTRACT.gets[0],
                nodeIds: ["missing-step"],
              },
            ],
          },
        },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(h.selectResults).toHaveLength(0);
    expect(h.insertValues).toHaveLength(0);
    expect(h.permissionCalls).toBe(0);
  });

  it("rejects AI-authored contracts whose mode contradicts their sections", async () => {
    await expect(
      caller().create({
        workspaceId: WORKSPACE_ID,
        name: "Contradictory agent automation",
        triggerType: "manual",
        triggerConfig: {},
        flowDefinition: {
          nodes: [{ id: "capability-step", type: "output", data: {} }],
          edges: [],
        },
        source: "ai",
        metadata: {
          dataContract: {
            ...VALID_DATA_CONTRACT,
            mode: "ingest",
          },
        },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(h.selectResults).toHaveLength(0);
    expect(h.insertValues).toHaveLength(0);
    expect(h.permissionCalls).toBe(0);
  });

  it("rejects the same unknown references before update persists", async () => {
    h.selectResults.push([], []);

    await expect(
      caller().update({
        id: h.existing.id as string,
        flowDefinition: UNKNOWN_REFERENCES_FLOW,
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("missing.verb"),
    });

    expect(h.updateSets).toHaveLength(0);
  });

  it("rejects a flow edit that would make the persisted data contract stale", async () => {
    h.existing.metadata = {
      ownerTag: "keep-me",
      dataContract: VALID_DATA_CONTRACT,
    };

    await expect(
      caller().update({
        id: h.existing.id as string,
        flowDefinition: {
          nodes: [
            {
              id: "new-trigger",
              type: "trigger",
              position: { x: 0, y: 0 },
              data: {
                triggerType: "manual",
                label: "On demand",
                config: {},
              },
            },
          ],
          edges: [],
        },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(h.updateSets).toHaveLength(0);
  });

  it("preserves a valid persisted contract across a compatible flow edit", async () => {
    h.existing.metadata = {
      ownerTag: "keep-me",
      dataContract: VALID_DATA_CONTRACT,
    };

    await caller().update({
      id: h.existing.id as string,
      flowDefinition: {
        nodes: [
          {
            id: "capability-step",
            type: "trigger",
            position: { x: 0, y: 0 },
            data: {
              triggerType: "manual",
              label: "On demand",
              config: {},
            },
          },
        ],
        edges: [],
      },
    });

    expect(h.updateSets).toHaveLength(1);
    expect(h.updateSets[0]).not.toHaveProperty("metadata");
  });

  it("rejects a metadata-only update with a mode-invalid data contract", async () => {
    await expect(
      caller().update({
        id: h.existing.id as string,
        metadata: {
          dataContract: {
            ...VALID_DATA_CONTRACT,
            mode: "ingest",
          },
        },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(h.updateSets).toHaveLength(0);
  });

  it("cannot relabel AI provenance or drop its contract through metadata replacement", async () => {
    h.existing.flowDefinition = {
      nodes: [
        {
          id: "capability-step",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: {
            triggerType: "manual",
            label: "On demand",
            config: {},
          },
        },
      ],
      edges: [],
    };
    h.existing.metadata = {
      createdVia: "ai",
      ownerTag: "keep-me",
      dataContract: VALID_DATA_CONTRACT,
    };

    await caller().update({
      id: h.existing.id as string,
      metadata: {
        createdVia: "manual",
        ownerTag: "changed",
      },
    });

    expect(h.updateSets[0]?.metadata).toEqual({
      createdVia: "ai",
      ownerTag: "changed",
      dataContract: VALID_DATA_CONTRACT,
    });
  });

  it("allows references returned by the scoped catalog lookups", async () => {
    h.selectResults.push(
      [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "missing.verb" }],
      [
        {
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          name: "Existing playbook",
        },
      ]
    );

    const result = await caller().create({
      name: "Valid automation",
      triggerType: "manual",
      triggerConfig: {},
      flowDefinition: UNKNOWN_REFERENCES_FLOW,
    });

    expect(result.status).toBe("created");
    expect(h.insertValues).toHaveLength(1);
  });

  // A payload that is VALID per the published MCP JSON Schema but breaks the
  // mode↔sections `.superRefine` (JSON Schema cannot express that rule). The old
  // message told the agent it had omitted the contract it had just sent, so it
  // would retry the identical shape forever. The rejection must name the rule
  // and must NOT claim the contract is absent.
  it("names the broken rule when an agent sends a present-but-invalid contract", async () => {
    let message = "";
    try {
      await caller().create({
        workspaceId: WORKSPACE_ID,
        name: "Mode mismatch",
        triggerType: "manual",
        triggerConfig: {},
        flowDefinition: UNKNOWN_REFERENCES_FLOW,
        agentUserId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        metadata: {
          // `ingest` requires stores > 0 AND reacts === 0; this carries the
          // reverse, so it parses structurally and fails only the refinement.
          dataContract: { ...VALID_DATA_CONTRACT, mode: "ingest" as const },
        },
      });
      throw new Error("expected the create to reject");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("mode");
    expect(message).not.toContain("require an explicit");
    expect(h.insertValues).toHaveLength(0);
  });
});
