/**
 * HubRestClient — list unwrapping across every Hub envelope shape.
 *
 * The bug: `unwrapList` only understood a bare array and `{ data: [...] }`.
 * The Hub also returns `{ <resourceName>: [...] }` and `{ items, lens }`, so
 * FIVE methods returned `[]` on every call, forever:
 *   getRelations · listProposals · listPropertyDefs · listAutomations ·
 *   listSubscriptions
 *
 * All five shapes below were captured from live GETs against a real pod, not
 * inferred from the route source — the route handlers pass a tRPC result
 * through verbatim, so reading the handler does not tell you the wire shape.
 *
 * These assert at the CALL SITE rather than on the helper, because the helper
 * was never the whole bug: it takes the envelope key as an argument, so a
 * correct helper plus a call site that forgets the key still returns `[]`. A
 * helper-only test would have passed throughout.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { HubRestClient } from "./client.js";

const USER = { id: "user-1", email: "u@example.com", name: "U" };

/** Bodies exactly as the pod returns them (shapes verified live). */
const BODIES: Record<string, unknown> = {
  "/api/hub/users/me": USER,
  "/api/hub/relations": { relations: [{ id: "r1" }, { id: "r2" }] },
  "/api/hub/proposals": {
    proposals: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
    total: 322,
    limit: 3,
    offset: 0,
    hasMore: true,
  },
  "/api/hub/property-defs": { propertyDefs: [{ id: "pd1" }] },
  "/api/hub/automations": { automations: [{ id: "a1" }, { id: "a2" }] },
  "/api/hub/subscriptions": { items: [{ id: "s1" }], lens: "user" },
  // Shapes that already worked — pinned so a "fix" cannot regress them.
  "/api/hub/views": [{ id: "v1" }, { id: "v2" }],
  "/api/hub/workspaces": { workspaces: [{ id: "w1" }] },
};

function bodyFor(url: string): unknown {
  const path = new URL(url).pathname;
  if (path in BODIES) return BODIES[path];
  throw new Error(`unstubbed path: ${path}`);
}

let client: HubRestClient;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (input: string | URL) =>
        new Response(JSON.stringify(bodyFor(String(input))), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    )
  );
  client = new HubRestClient({
    podUrl: "https://pod.example.test",
    apiKey: "synap_hub_test_key",
    workspaceId: "ws-1",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("list unwrapping — the five that silently returned []", () => {
  it("getRelations reads the `relations` envelope", async () => {
    const rows = await client.getRelations("e1");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "r1" });
  });

  it("listProposals reads the `proposals` envelope", async () => {
    const rows = await client.listProposals();
    // Was `[]` on every call, which is indistinguishable from an empty queue —
    // the reason this went unnoticed.
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ id: "p1" });
  });

  it("listPropertyDefs reads the `propertyDefs` envelope", async () => {
    const rows = await client.listPropertyDefs("note");
    expect(rows).toHaveLength(1);
  });

  it("listAutomations reads the `automations` envelope", async () => {
    const rows = await client.listAutomations();
    expect(rows).toHaveLength(2);
  });

  it("listSubscriptions reads the `items` envelope", async () => {
    const rows = await client.listSubscriptions();
    expect(rows).toHaveLength(1);
  });
});

describe("shapes that already worked — regression floor", () => {
  it("a bare array passes through", async () => {
    expect(await client.listViews("ws-1")).toHaveLength(2);
  });

  it("getWorkspaces still reads `workspaces` after folding its bespoke helper", async () => {
    // This one had its own one-off unwrapper. Folding it into the generic door
    // must not lose it — that helper existed BECAUSE the generic one was wrong.
    expect(await client.getWorkspaces()).toHaveLength(1);
  });
});

describe("listProposalsPage — surfacing what the array signature drops", () => {
  it("returns the server's real total, not the page length", async () => {
    const page = await client.listProposalsPage({ limit: 3 });
    expect(page.proposals).toHaveLength(3);
    // The number three UI surfaces were missing. `total` is the queue;
    // `proposals.length` is the page. Asserting they DIFFER is the point.
    expect(page.total).toBe(322);
    expect(page.total).not.toBe(page.proposals.length);
    expect(page.hasMore).toBe(true);
  });

  it("degrades honestly against a pod that predates the pagination fix", async () => {
    BODIES["/api/hub/proposals"] = { proposals: [{ id: "p1" }, { id: "p2" }] };
    const page = await client.listProposalsPage();
    // No envelope fields on the wire ⇒ report the page length and hasMore:false.
    // Never fabricate a count: a made-up total is worse than a modest one.
    expect(page.total).toBe(2);
    expect(page.hasMore).toBe(false);
    BODIES["/api/hub/proposals"] = {
      proposals: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
      total: 322,
      limit: 3,
      offset: 0,
      hasMore: true,
    };
  });
});
