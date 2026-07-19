/**
 * synap_get_graph — type-aware error fallback (§4).
 *
 * When a `name` matches no ENTITY of the requested kind but DOES match a
 * profile/role *type*, get_graph must return structured `candidates` + a routing
 * `hint` (attach_facet / list_profiles) instead of a bare "not found". A
 * genuinely-unknown name must still return the plain `No <kind> named` error.
 *
 * DB/router are stubbed — this exercises adapter dispatch + the fallback branch
 * only, not the object-graph query or the tRPC caller.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted so these mock fns exist when the hoisted vi.mock factory runs
// (vi.mock is lifted above plain const declarations → TDZ otherwise).
const { resolveByName, resolveProfileByName } = vi.hoisted(() => ({
  resolveByName: vi.fn(),
  resolveProfileByName: vi.fn(),
}));

// Stub the object-graph service so we drive the fallback branch directly.
vi.mock("../../services/object-graph/graph-service.js", () => ({
  getObjectGraph: vi.fn(),
  resolveByName,
  resolveProfileByName,
}));

// Keep every real @synap/database export, but neutralize the DB connect the
// caller factory performs (createHubProtocolCaller awaits getDb()).
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  getDb: vi.fn(async () => ({}) as never),
}));

import { executeMCPToolViaHubProtocol } from "./adapter.js";

function parse(
  result: Awaited<ReturnType<typeof executeMCPToolViaHubProtocol>>
) {
  const block = result.content?.[0];
  if (!block || block.type !== "text") throw new Error("expected text content");
  return JSON.parse(block.text) as Record<string, unknown>;
}

describe("synap_get_graph — profile/role fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns candidates + attach_facet hint when the name is a role type", async () => {
    resolveByName.mockResolvedValue([]); // no entity of this kind
    resolveProfileByName.mockResolvedValue([
      {
        slug: "client",
        displayName: "Client",
        profileKind: "role",
        applicableKinds: ["person", "company"],
      },
    ]);

    const result = await executeMCPToolViaHubProtocol(
      "synap_get_graph",
      { type: "entity", name: "client" },
      "user-1",
      ["mcp.read"]
    );

    const payload = parse(result);
    expect(payload.error).toContain("is a profile/role");
    expect(payload.candidates).toEqual([
      {
        slug: "client",
        displayName: "Client",
        profileKind: "role",
        applicableKinds: ["person", "company"],
      },
    ]);
    expect(String(payload.hint)).toContain("attach_facet");
  });

  it("returns the plain 'No entity named' error for a genuinely-unknown name", async () => {
    resolveByName.mockResolvedValue([]);
    resolveProfileByName.mockResolvedValue([]);

    const result = await executeMCPToolViaHubProtocol(
      "synap_get_graph",
      { type: "entity", name: "zzznope" },
      "user-1",
      ["mcp.read"]
    );

    const payload = parse(result);
    expect(payload.error).toBe("No entity named 'zzznope'");
    expect(payload.candidates).toBeUndefined();
    expect(payload.hint).toBeUndefined();
  });
});
