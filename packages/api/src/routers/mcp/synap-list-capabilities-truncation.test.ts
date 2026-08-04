/**
 * `synap_list_capabilities` — truncation-after-dedup fix (§ "the MCP door").
 *
 * `listCapabilities` used to be sliceable BEFORE `sectionCapabilities` deduped
 * its result (a provider installed twice, N backing-skill copies of one verb).
 * A distinct, genuinely-matching capability could rank just past the raw slice
 * window and never reach the agent — which is worse over MCP than over the
 * human tRPC picker: an agent that gets an empty/short result for a real
 * capability concludes it does not exist and either gives up or invents one.
 *
 * The fix (mirrors `routers/capabilities.ts`'s `sections` door, verified
 * separately in `services/capabilities/section-capabilities.test.ts`): the
 * adapter now always passes `limit: null` to `listCapabilities` (never slice
 * the raw list) and caps AFTER dedup via `sectionCapabilities(..., { limit })`.
 *
 * DB/router are stubbed (same pattern as `get-graph-profile-fallback.test.ts`)
 * — this exercises the adapter's OWN plumbing (which options it passes to the
 * registry doors), not a live database. `sectionCapabilities` itself is the
 * REAL implementation (not mocked) so the dedup+rank logic under test is real.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RegistryCapability } from "../../services/capabilities/capability-registry.js";

// vi.hoisted so this mock fn exists when the hoisted vi.mock factory runs.
const { listCapabilities } = vi.hoisted(() => ({
  listCapabilities: vi.fn(),
}));

// Keep the REAL `sectionCapabilities` (and everything else) — only
// `listCapabilities` is stubbed, and its stub REPRODUCES the historic bug
// (slice-before-dedup) whenever it is called with a non-null `limit`, so a
// regression that stops passing `limit: null` makes this test fail again.
vi.mock(
  "../../services/capabilities/capability-registry.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../services/capabilities/capability-registry.js")
    >()),
    listCapabilities,
  })
);

// Neutralize the DB connect `createHubProtocolCaller` performs — this case
// never reaches a real query once `listCapabilities` is stubbed.
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  getDb: vi.fn(async () => ({}) as never),
}));

// `executeMCPToolViaHubProtocol` verifies the `args.workspaceId` lens against
// a real DB row (`verifyWorkspaceAccess`) BEFORE the tool-name switch even
// runs — unrelated to the fix under test, but real enough to hit a live
// Postgres connection in this suite. Stub only that one check to `true`; every
// other export of the module stays real.
vi.mock("../hub-protocol/rest/_shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hub-protocol/rest/_shared.js")>()),
  verifyWorkspaceAccess: vi.fn(async () => true),
}));

import { executeMCPToolViaHubProtocol } from "./adapter.js";

function parse(
  result: Awaited<ReturnType<typeof executeMCPToolViaHubProtocol>>
) {
  const block = result.content?.[0];
  if (!block || block.type !== "text") throw new Error("expected text content");
  return JSON.parse(block.text) as Record<string, unknown>;
}

function cap(
  partial: Partial<RegistryCapability> & {
    kind: RegistryCapability["kind"];
    name: string;
    id: string;
  }
): RegistryCapability {
  return {
    description: null,
    inputSchema: {},
    executor: "is-agent",
    governance: "propose",
    ...partial,
  } as RegistryCapability;
}

/**
 * Score-sorted fixture, as the real `listCapabilities` would hand it over: two
 * RAW rows for the same integration (ranks 0/1), then one genuinely distinct
 * capability (rank 2).
 */
const DUPLICATE_THEN_DISTINCT: RegistryCapability[] = [
  cap({ kind: "source-provider", name: "google", id: "google-1" }),
  cap({ kind: "source-provider", name: "google", id: "google-2" }),
  cap({ kind: "tool", name: "exa_api", id: "exa-1" }),
];

describe("synap_list_capabilities — cap after dedup, not before", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reproduces the OLD bug on demand: a numeric `limit` slices the RAW list
    // (before this test's `sectionCapabilities` call dedupes it); `limit: null`
    // (the fix) returns everything, unsliced.
    listCapabilities.mockImplementation(
      async (_ctx: unknown, opts?: { limit?: number | null }) => {
        if (typeof opts?.limit === "number") {
          return DUPLICATE_THEN_DISTINCT.slice(0, opts.limit);
        }
        return DUPLICATE_THEN_DISTINCT;
      }
    );
  });

  it("returns a distinct match that a pre-dedup slice would have hidden behind duplicate rows of something else", async () => {
    const result = await executeMCPToolViaHubProtocol(
      "synap_list_capabilities",
      { workspaceId: "ws-1", query: "e", limit: 2 },
      "user-1",
      ["mcp.read"]
    );
    const payload = parse(result);
    const names = (payload.integrations as Array<{ name: string }>)
      .map((i) => i.name)
      .sort();
    // If the adapter regressed to passing the caller's `limit` straight
    // through to `listCapabilities`, the mock above slices to
    // [google-1, google-2] and `exa_api` never reaches `sectionCapabilities`
    // at all — this assertion is the whole point of the test.
    expect(names).toEqual(["exa_api", "google"]);
  });

  it("always calls listCapabilities with limit: null, never the caller's raw limit", async () => {
    await executeMCPToolViaHubProtocol(
      "synap_list_capabilities",
      { workspaceId: "ws-1", query: "e", limit: 2 },
      "user-1",
      ["mcp.read"]
    );
    expect(listCapabilities).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: null })
    );
  });

  it("built-ins never compete with integrations/skills/commands for the ranked budget", async () => {
    listCapabilities.mockImplementation(
      async (_ctx: unknown, opts?: { limit?: number | null }) => {
        const fixture: RegistryCapability[] = [
          // Two built-ins rank AHEAD of the one real integration a query would
          // actually want the agent to see.
          cap({
            kind: "builtin-tool",
            name: "b_one",
            id: "b1",
            catalogOnly: true,
          }),
          cap({
            kind: "builtin-tool",
            name: "b_two",
            id: "b2",
            catalogOnly: true,
          }),
          cap({ kind: "tool", name: "exa_api", id: "exa-1" }),
        ];
        if (typeof opts?.limit === "number")
          return fixture.slice(0, opts.limit);
        return fixture;
      }
    );
    const result = await executeMCPToolViaHubProtocol(
      "synap_list_capabilities",
      { workspaceId: "ws-1", query: "e", limit: 1 },
      "user-1",
      ["mcp.read"]
    );
    const payload = parse(result);
    // A limit of 1 must not be entirely consumed by the two built-ins that
    // outrank it — the ranked budget only governs the FORWARDED kinds.
    expect(
      (payload.integrations as Array<{ name: string }>).map((i) => i.name)
    ).toEqual(["exa_api"]);
    // The excluded count still reflects BOTH built-ins — read from the
    // unbounded fold, not the ranked/capped one.
    expect((payload.excluded as { builtinTools: number }).builtinTools).toBe(2);
  });
});
