/**
 * `synap_update_entities` — the MCP door onto the batch update service (R1).
 *
 * Drives the REAL handler through the REAL hub `entities.updateEntities`
 * procedure (its strict zod input, its acting-agent resolution) to the
 * `updateEntities` service, which is the only thing replaced: its own
 * planning / governance / pack filing has its own suite. What this pins is the
 * SEAM — that what the model sends arrives at the service intact (items,
 * agent identity, validate, idempotencyKey, reasoning), that the strict patch
 * still refuses an unknown field instead of dropping it, and that the
 * service's per-item receipt reaches the agent unchanged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../middleware/api-key-auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../middleware/api-key-auth.js")
    >();
  const { t } =
    await vi.importActual<typeof import("../../../trpc.js")>(
      "../../../trpc.js"
    );
  return { ...actual, scopedProcedure: () => t.procedure };
});
vi.mock("../../hub-protocol/utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hub-protocol/utils.js")>()),
  createHubProtocolCallerContext: async (userId: string) => ({ userId }),
}));
vi.mock("../../../services/entities/update-entities.js", async (orig) => ({
  ...(await orig<
    typeof import("../../../services/entities/update-entities.js")
  >()),
  updateEntities: async (params: Record<string, unknown>) => {
    h.calls.push(params);
    return {
      batchId: "b-1",
      items: [{ id: E1, verdict: "propose" }],
      applied: [],
      proposed: { proposalId: "p-1", count: 1, ids: [E1] },
      denied: [],
      skipped: [],
    };
  },
}));

import { entitiesRouter as hubEntitiesRouter } from "../../hub-protocol/entities.js";
import { entityHandlers } from "./entity.js";
import type { McpToolContext } from "./shared.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const E1 = "33333333-3333-4333-8333-333333333333";

function ctx(args: Record<string, unknown>): McpToolContext {
  return {
    toolName: "synap_update_entities",
    args,
    userId: USER,
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: AGENT,
    // The hub caller's `entities` namespace, served by the REAL hub router.
    lensCaller: {
      entities: hubEntitiesRouter.createCaller({
        userId: USER,
        agentUserId: AGENT,
        scopes: ["hub-protocol.write"],
      } as never),
    },
  } as unknown as McpToolContext;
}

const parse = (r: { content: Array<{ text?: string }> }) =>
  JSON.parse(r.content[0]!.text!) as Record<string, unknown>;

const update = entityHandlers.synap_update_entities!;

beforeEach(() => {
  h.calls = [];
});

describe("synap_update_entities — the change set reaches the batch service", () => {
  it("forwards items, agent, validate, idempotencyKey and reasoning; returns the receipt", async () => {
    const out = parse(
      (await update(
        ctx({
          items: [
            {
              id: E1,
              patch: { title: "Q3 plan", properties: { status: "done" } },
              expected: { title: "q3" },
            },
          ],
          validate: true,
          idempotencyKey: "retitle-0001",
          reasoning: "titles follow the naming rule",
        })
      )) as never
    );
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.items).toEqual([
      {
        id: E1,
        patch: { title: "Q3 plan", properties: { status: "done" } },
        expected: { title: "q3" },
      },
    ]);
    expect(call.agentUserId).toBe(AGENT);
    expect(call.validate).toBe(true);
    expect(call.idempotencyKey).toBe("retitle-0001");
    expect(call.reasoning).toBe("titles follow the naming rule");
    expect(out.proposed).toEqual({ proposalId: "p-1", count: 1, ids: [E1] });
  });

  it("refuses an unknown patch field instead of dropping it", async () => {
    await expect(
      update(ctx({ items: [{ id: E1, patch: { profileSlug: "task" } }] }))
    ).rejects.toThrow(/profileSlug|Unrecognized/);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a key without mcp.write", async () => {
    const c = ctx({ items: [{ id: E1, patch: { title: "x" } }] });
    (c as { apiKeyScopes: string[] }).apiKeyScopes = ["mcp.read"];
    await expect(update(c)).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
  });
});
