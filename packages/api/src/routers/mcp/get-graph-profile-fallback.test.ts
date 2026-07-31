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
const { getObjectGraph, resolveByName, resolveProfileByName } = vi.hoisted(
  () => ({
    getObjectGraph: vi.fn(),
    resolveByName: vi.fn(),
    resolveProfileByName: vi.fn(),
  })
);

// Stub the object-graph service so we drive the fallback branch directly.
vi.mock("../../services/object-graph/graph-service.js", () => ({
  getObjectGraph,
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

describe("synap_get_graph — unknown id contract (found:false, never a phantom node)", () => {
  // TRIPWIRE: `getObjectGraph` signals a genuinely-unknown/invisible id via
  // `found: false` on its `GraphEnvelope` (graph-service.ts's `hydrated !==
  // undefined || neighbors.length > 0` check) — the adapter's id-path branch
  // for synap_get_graph must turn that into a plain "No <kind> with id '<id>'"
  // error, exactly mirroring the name-not-found branch above. If this ever
  // regresses (envelope returned as-is), the caller gets back a fabricated
  // node named by its own UUID instead of an honest not-found.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("an id that resolves to found:false returns 'No <kind> with id' — not the raw envelope", async () => {
    getObjectGraph.mockResolvedValue({
      object: { kind: "capability", id: "missing-id", name: "(not found)" },
      neighbors: [],
      counts: { total: 0, byKind: {}, byVia: {} },
      found: false,
    });

    const result = await executeMCPToolViaHubProtocol(
      "synap_get_graph",
      { type: "capability", id: "missing-id" },
      "user-1",
      ["mcp.read"]
    );

    const payload = parse(result);
    expect(payload.error).toBe("No capability with id 'missing-id'");
    expect(payload.object).toBeUndefined();
    expect(payload.neighbors).toBeUndefined();
  });

  it("an id that resolves to found:true returns the envelope itself", async () => {
    getObjectGraph.mockResolvedValue({
      object: { kind: "capability", id: "real-id", name: "ExaSearch" },
      neighbors: [],
      counts: { total: 0, byKind: {}, byVia: {} },
      found: true,
    });

    const result = await executeMCPToolViaHubProtocol(
      "synap_get_graph",
      { type: "capability", id: "real-id" },
      "user-1",
      ["mcp.read"]
    );

    const payload = parse(result);
    expect(payload.error).toBeUndefined();
    expect(payload.found).toBe(true);
    expect(payload.object).toEqual({
      kind: "capability",
      id: "real-id",
      name: "ExaSearch",
    });
  });
});
