/**
 * `synap_update_facet` — the MCP door onto the one facet write door
 * (`entities.updateFacet`). Before it, an agent could not change a role's
 * fields at all: `synap_update_entity` writes the entity's own properties and
 * `synap_attach_facet` on a worn role writes nothing (finding 5b0a22b5).
 *
 * What this pins is the SEAM: the facet is targeted by facetId, or by
 * entityId + facetSlug resolved against the entity's live facets (refused when
 * none or several match, never a guess), and what the model sends reaches the
 * door intact (properties, expectedStatus, agent, reasoning). The door itself
 * (merge, governance, status move) has its own suites.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  facets: [] as Array<{
    facet: { id: string; workspaceId: string | null };
    profile: { slug?: string };
  }>,
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../hub-protocol/utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hub-protocol/utils.js")>()),
  createHubProtocolCallerContext: async (userId: string) => ({ userId }),
}));
vi.mock("../../entities.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../entities.js")>()),
  entitiesRouter: {
    createCaller: () => ({
      get: async () => ({ facets: h.facets }),
    }),
  },
}));

import { entityHandlers } from "./entity.js";
import type { McpToolContext } from "./shared.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const ENTITY = "33333333-3333-4333-8333-333333333333";
const LEAD = "44444444-4444-4444-8444-444444444444";
const LEAD_2 = "55555555-5555-4555-8555-555555555555";

function ctx(args: Record<string, unknown>): McpToolContext {
  return {
    toolName: "synap_update_facet",
    args,
    userId: USER,
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: AGENT,
    lensCaller: {
      entities: {
        updateFacet: async (input: Record<string, unknown>) => {
          h.updates.push(input);
          return { status: "updated", message: "Facet updated" };
        },
      },
    },
  } as unknown as McpToolContext;
}

const parse = (r: unknown) =>
  JSON.parse(
    (r as { content: Array<{ text?: string }> }).content[0]!.text!
  ) as Record<string, unknown>;

const update = () => {
  const handler = entityHandlers.synap_update_facet;
  expect(handler, "synap_update_facet has a handler").toBeTypeOf("function");
  return handler!;
};

beforeEach(() => {
  h.facets = [
    { facet: { id: LEAD, workspaceId: null }, profile: { slug: "lead" } },
    {
      facet: { id: "x-client", workspaceId: null },
      profile: { slug: "client" },
    },
  ];
  h.updates = [];
});

describe("synap_update_facet — a role's fields reach the facet door", () => {
  it("entityId + facetSlug resolves the one live facet and forwards the change intact", async () => {
    const out = parse(
      await update()(
        ctx({
          entityId: ENTITY,
          facetSlug: "lead",
          properties: { nextAction: "send the proposal" },
          expectedStatus: "contacted",
          reasoning: "the call went well",
        })
      )
    );
    expect(h.updates).toEqual([
      {
        userId: USER,
        facetId: LEAD,
        properties: { nextAction: "send the proposal" },
        expectedStatus: "contacted",
        agentUserId: AGENT,
        reasoning: "the call went well",
      },
    ]);
    expect(out).toMatchObject({ facetId: LEAD, status: "updated" });
  });

  it("a facetId is used as given, without reading the entity", async () => {
    h.facets = [];
    await update()(ctx({ facetId: LEAD_2, properties: { nextAction: "x" } }));
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]!.facetId).toBe(LEAD_2);
    expect(h.updates[0]).not.toHaveProperty("expectedStatus");
  });

  it("the role worn in two spaces is refused with both candidates, nothing written", async () => {
    h.facets.push({
      facet: { id: LEAD_2, workspaceId: "ws-2" },
      profile: { slug: "lead" },
    });
    const out = parse(
      await update()(
        ctx({ entityId: ENTITY, facetSlug: "lead", properties: { a: 1 } })
      )
    );
    expect(h.updates).toHaveLength(0);
    expect(out.error).toMatch(/2 live 'lead' facets/);
    expect(out.candidates).toEqual([
      { facetId: LEAD, workspaceId: null },
      { facetId: LEAD_2, workspaceId: "ws-2" },
    ]);
  });

  it("a role the entity does not wear is refused, nothing written", async () => {
    const out = parse(
      await update()(
        ctx({ entityId: ENTITY, facetSlug: "investor", properties: { a: 1 } })
      )
    );
    expect(h.updates).toHaveLength(0);
    expect(out.error).toMatch(/No live 'investor' facet/);
  });

  it("no properties to change is refused, nothing written", async () => {
    for (const properties of [undefined, {}, [], "nextAction"]) {
      const res = (await update()(ctx({ facetId: LEAD, properties }))) as {
        isError?: boolean;
      };
      expect(res.isError).toBe(true);
    }
    expect(h.updates).toHaveLength(0);
  });
});
