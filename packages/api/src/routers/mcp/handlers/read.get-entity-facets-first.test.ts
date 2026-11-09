/**
 * synap_get_entity (lean): `facets` come BEFORE `effectiveProperties`.
 *
 * The MCP reply cap cuts from the END of the JSON. `effectiveProperties` is the
 * long half of a person's read, so with it first the cut took the person's
 * facets (their roles and role status) with it: live on 2026-11-09, entities
 * eddaa74b, b3372cca and 77b977c2 lost them. Key order is the contract here.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../hub-protocol/utils.js", () => ({
  createHubProtocolCallerContext: vi.fn(async () => ({})),
}));
vi.mock("../../entities.js", () => ({
  entitiesRouter: {
    createCaller: () => ({
      get: async () => ({
        entity: { id: "e1" },
        profile: { slug: "person" },
        effectiveProperties: [{ slug: "email" }],
        effectivePropertiesByWorkspace: {},
        facets: [{ slug: "lead", status: "outreach" }],
        externalLinks: [],
      }),
    }),
  },
}));
vi.mock("./shared.js", async (orig) => ({
  ...(await orig<typeof import("./shared.js")>()),
  buildGraphEnvelope: vi.fn(async () => {
    throw new Error("no graph in this test");
  }),
}));

import { readHandlers } from "./read.js";
import type { McpToolContext } from "./shared.js";

describe("synap_get_entity lean key order", () => {
  it("emits facets before effectiveProperties", async () => {
    const r = await readHandlers.synap_get_entity!({
      toolName: "synap_get_entity",
      args: { entityId: "e1" },
      userId: "user-1",
      apiKeyScopes: ["mcp.read"],
    } as McpToolContext);
    const b = r.content?.[0];
    if (!b || b.type !== "text") throw new Error("expected text");
    const keys = Object.keys(JSON.parse(b.text));
    expect(keys).toContain("facets");
    expect(keys.indexOf("facets")).toBeLessThan(
      keys.indexOf("effectiveProperties")
    );
  });
});
