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
          return { returning: vi.fn(async () => [{ id: "auto-1" }]) };
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

beforeEach(() => {
  h.selectResults.length = 0;
  h.insertValues.length = 0;
  h.updateSets.length = 0;
  h.permissionCalls = 0;
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
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("missing.verb"),
    });

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
});
