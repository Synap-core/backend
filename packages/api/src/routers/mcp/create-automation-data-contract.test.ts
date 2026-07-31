/**
 * `synap_create_automation` was a DEAD DOOR.
 *
 * An MCP create always sets `agentUserId`, which fires the AI-authorship gate in
 * `automations.create` — it REQUIRES a valid `metadata.dataContract`. But the
 * published MCP tool schema exposed no contract at all (`metadata` was described
 * only as "Optional extra metadata bag"), so a well-formed MCP create could only
 * ever fail, and the agent had no schema-visible way to learn what to send.
 *
 * These tests pin the fix END TO END: the shape an agent reads off the published
 * MCP schema, threaded through the adapter's metadata assembly, is accepted by
 * the REAL create gate — and the gate itself is provably NOT weakened.
 *
 * DB rows are mocked (same harness as automations.flow-catalog-validation.test.ts):
 * this is a schema/door contract, not a Postgres integration test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const h = vi.hoisted(() => ({
  selectResults: [] as Array<Array<{ id: string; name: string }>>,
  insertValues: [] as Array<Record<string, unknown>>,
  updateSets: [] as Array<Record<string, unknown>>,
  existing: {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    createdBy: "user-1",
    version: 1,
    flowDefinition: { nodes: [], edges: [] },
    triggerType: "manual",
    triggerConfig: {},
    metadata: {} as Record<string, unknown>,
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

vi.mock("../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
}));

import { automationsRouter } from "../automations.js";
import { tools } from "./tools/index.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_USER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function caller() {
  return automationsRouter.createCaller({
    authenticated: true,
    userId: "user-1",
    workspaceId: WORKSPACE_ID,
  } as never);
}

type JsonSchema = Record<string, any>;

async function createAutomationTool(): Promise<JsonSchema> {
  const all = await tools.list();
  const tool = all.find((t) => t.name === "synap_create_automation");
  if (!tool) throw new Error("synap_create_automation is not published");
  return tool as unknown as JsonSchema;
}

/** Drop prose so structural comparisons compare SHAPE, which is what drifts. */
function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDescriptions);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "description") continue;
      out[k] = stripDescriptions(v);
    }
    return out;
  }
  return value;
}

/**
 * The payload an agent produces by reading ONLY the published MCP schema, and
 * the flow it declares. Deliberately hand-written (not derived from the gate) —
 * it stands in for a real agent call.
 */
const AGENT_FLOW = {
  nodes: [
    {
      id: "trigger",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: { triggerType: "manual", label: "On demand", config: {} },
    },
    { id: "notify", type: "output", data: { outputType: "notification" } },
  ],
  edges: [{ id: "e1", source: "trigger", target: "notify" }],
};

const AGENT_DATA_CONTRACT = {
  version: 1,
  mode: "react",
  gets: [
    {
      id: "on-demand",
      label: "Operator starts the automation",
      nodeIds: ["trigger"],
      origin: "manual",
      event: "Operator runs it",
    },
  ],
  stores: [],
  reacts: [
    {
      id: "tell-operator",
      label: "Notify the operator",
      nodeIds: ["notify"],
      kind: "notification",
      destination: "operator",
    },
  ],
};

/**
 * EXACTLY what adapter.ts's `synap_create_automation` case does with the tool
 * args before calling `automations.createAutomation`: it spreads `args.metadata`
 * through untouched. So a contract published under `metadata.dataContract` is
 * the one that reaches the gate.
 */
function adapterMetadata(args: {
  metadata?: Record<string, unknown>;
  resultRouting?: string;
}): Record<string, unknown> {
  return {
    ...(args.metadata ?? {}),
    ...(args.resultRouting ? { resultRouting: args.resultRouting } : {}),
  };
}

beforeEach(() => {
  h.selectResults.length = 0;
  h.insertValues.length = 0;
  h.updateSets.length = 0;
  h.existing.metadata = {};
  h.existing.flowDefinition = { nodes: [], edges: [] };
});

describe("synap_create_automation publishes the contract its own gate requires", () => {
  it("exposes dataContract where the gate reads it, and requires it", async () => {
    const tool = await createAutomationTool();
    const metadata = tool.inputSchema.properties.metadata;

    // The gate reads `metadata.dataContract` — so that is where it is published.
    expect(metadata.properties?.dataContract).toBeDefined();
    expect(metadata.required).toContain("dataContract");
    // ...and metadata itself is no longer optional, because the contract is not.
    expect(tool.inputSchema.required).toContain("metadata");

    // Prose must actually teach the three sections and the nodeIds rule.
    const contract = metadata.properties.dataContract;
    expect(contract.properties.gets.description).toMatch(/what ENTERS/i);
    expect(contract.properties.stores.description).toMatch(
      /WRITES into the pod/i
    );
    expect(contract.properties.reacts.description).toMatch(/happens AFTER/i);
    for (const section of ["gets", "stores", "reacts"] as const) {
      expect(
        contract.properties[section].items.properties.nodeIds.description
      ).toMatch(/MUST match a node you are sending in flowDefinition\.nodes/);
    }
  });

  it("publishes the DERIVED shape, not a hand-copied second one", async () => {
    // Guards the docblock's whole point: if someone replaces the derivation with
    // a literal, the published shape can drift from the schema that rejects it.
    const { automationDataContractSchema } = await import("../automations.js");
    const { z } = await import("zod");
    const expected = z.toJSONSchema(automationDataContractSchema, {
      io: "input",
    }) as Record<string, unknown>;
    delete expected.$schema;

    const tool = await createAutomationTool();
    const published =
      tool.inputSchema.properties.metadata.properties.dataContract;

    expect(stripDescriptions(published)).toEqual(stripDescriptions(expected));
    // Non-vacuous: the derived shape really does carry the gate's constraints.
    expect(published.required).toEqual([
      "version",
      "mode",
      "gets",
      "stores",
      "reacts",
    ]);
    expect(published.properties.gets.minItems).toBe(1);
  });

  it("keeps the committed manifest mirror in sync with the TS definition", async () => {
    const manifestPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "tools/mcp-tools.manifest.json"
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      tools: Array<{ name: string }>;
    };
    const mirrored = manifest.tools.find(
      (t) => t.name === "synap_create_automation"
    );
    const live = await createAutomationTool();
    // Regenerate with `pnpm --filter @synap/api gen:mcp-manifest` if this fails.
    expect(mirrored).toEqual(JSON.parse(JSON.stringify(live)));
  });
});

describe("the MCP-shaped create now reaches the database", () => {
  it("SUCCEEDS for a payload built from the published schema alone", async () => {
    // THE regression proof: before the fix this same call threw
    // "AI-authored automations require an explicit Gets data / Stores in Synap /
    // Reacts & sends contract", because the schema never told the agent to send one.
    await caller().create({
      workspaceId: WORKSPACE_ID,
      agentUserId: AGENT_USER_ID,
      // The hub door brands this: `source: input.agentUserId ? "agent" : "intelligence"`
      // (hub-protocol/automations.ts) — which is what makes createdVia "ai".
      source: "agent",
      name: "Notify on demand",
      triggerType: "manual",
      triggerConfig: {},
      flowDefinition: AGENT_FLOW,
      status: "active",
      metadata: adapterMetadata({
        metadata: { dataContract: AGENT_DATA_CONTRACT },
      }),
    } as never);

    expect(h.insertValues).toHaveLength(1);
    const written = h.insertValues[0].metadata as Record<string, unknown>;
    expect(written.dataContract).toEqual(AGENT_DATA_CONTRACT);
    expect(written.createdVia).toBe("ai");
  });

  it("still REJECTS the pre-fix payload that omitted the contract", async () => {
    // The fix publishes the contract; it does not weaken the gate.
    await expect(
      caller().create({
        workspaceId: WORKSPACE_ID,
        agentUserId: AGENT_USER_ID,
        name: "Notify on demand",
        triggerType: "manual",
        triggerConfig: {},
        flowDefinition: AGENT_FLOW,
        metadata: adapterMetadata({ metadata: { note: "no contract here" } }),
      } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(h.insertValues).toHaveLength(0);
  });

  it("still REJECTS a contract pointing at nodes the flow does not contain", async () => {
    await expect(
      caller().create({
        workspaceId: WORKSPACE_ID,
        agentUserId: AGENT_USER_ID,
        name: "Notify on demand",
        triggerType: "manual",
        triggerConfig: {},
        flowDefinition: AGENT_FLOW,
        metadata: adapterMetadata({
          metadata: {
            dataContract: {
              ...AGENT_DATA_CONTRACT,
              reacts: [
                { ...AGENT_DATA_CONTRACT.reacts[0], nodeIds: ["ghost-node"] },
              ],
            },
          },
        }),
      } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(h.insertValues).toHaveLength(0);
  });
});

describe("pattern-detector drafts are updatable (BUG 2, gate side)", () => {
  it("accepts an update to a row carrying the worker's metadata", async () => {
    // The exact metadata automation-pattern-detector.ts now writes: no forged
    // `createdVia: "ai"`, the honest suggestedByPattern signal instead.
    h.existing.metadata = {
      suggestedByPattern: true,
      patternConfidence: 0.82,
      description: "Detected nightly",
    };

    await caller().update({
      id: h.existing.id as string,
      status: "active",
    } as never);

    expect(h.updateSets).toHaveLength(1);
  });

  it("still REFUSES to strip the contract off a genuinely AI-authored row", async () => {
    // Proves the fix did not defang the update gate — only stopped forging its
    // precondition. This row went through the create door, so it has a contract
    // and `createdVia: "ai"`; an update must not be able to drop it.
    h.existing.metadata = { createdVia: "ai" };

    await expect(
      caller().update({
        id: h.existing.id as string,
        status: "active",
      } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(h.updateSets).toHaveLength(0);
  });
});
