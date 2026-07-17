import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

/**
 * WAVE-5 invariant: revoking a Nango connection must clean up after itself.
 *
 * The bug this locks: the connection reconciler was insert-only and the three
 * disconnect doors called `revokeConnection` and nothing else — so a revoked
 * connection kept its `is_default` pointer row (dispatch kept picking a dead
 * account) and its `entity_external_links` stayed `active` forever.
 *
 * Source-level proofs (behaviour needs a live DB, which is fragile here):
 *   1. the reconciler has a REMOVAL branch, not just inserts
 *   2. a direct `detach` helper exists and touches both orphan surfaces
 *   3. every disconnect door calls it right after revoke
 */

const sync = readFileSync(
  new URL("../services/capabilities/capability-nango-sync.ts", import.meta.url),
  "utf-8"
);
const hubDoor = readFileSync(
  new URL("../routers/hub-protocol/rest/connectors.ts", import.meta.url),
  "utf-8"
);
const trpcDoor = readFileSync(
  new URL("../routers/connectors-trpc.ts", import.meta.url),
  "utf-8"
);

describe("tripwire: Nango disconnect self-heals the connection registry", () => {
  it("the reconciler is symmetric — it removes orphaned pointer rows, not just inserts", () => {
    // The removal half: it computes hints Nango no longer reports and soft-deletes.
    expect(sync).toContain("liveHints");
    expect(sync).toContain("orphanHints");
    expect(sync).toMatch(/\.set\(\s*\{\s*deletedAt/);
  });

  it("removal is driven by the TYPED result, never the ambiguous listConnections()", () => {
    // The bug caught in review: `listConnections()` returns `[]` on ANY Nango
    // HTTP error (429/500) AND on a truncated page, so driving deletion off it
    // wipes live pointers on a transient blip. The reconciler MUST use the typed,
    // paginated `listConnectionsResult` and bail unless Nango definitively
    // answered — an ambiguous empty must never reach the removal branch.
    expect(sync).toContain("listConnectionsResult");
    expect(sync).toMatch(/if\s*\(\s*!liveResult\.ok\s*\)/);
    // And the lossy wrapper must not be what the reconciler reconciles against.
    expect(sync).not.toMatch(/await\s+connector\.listConnections\(/);
  });

  it("detachNangoConnectionRegistry exists and clears both orphan surfaces", () => {
    expect(sync).toContain(
      "export async function detachNangoConnectionRegistry"
    );
    // pointer rows keyed by the revoked connectionId ...
    expect(sync).toContain("eq(secrets.accountHint, connectionId)");
    // ... and the entity source links flip to disconnected.
    expect(sync).toContain("entityExternalLinks");
    expect(sync).toContain('status: "disconnected"');
  });

  it("every disconnect door calls detach right after revoke (no revoke-and-forget)", () => {
    // Hub REST has two doors (DELETE + POST); the tRPC router has one.
    const hubRevokes = [...hubDoor.matchAll(/revokeConnection\(/g)].length;
    const hubDetaches = [
      ...hubDoor.matchAll(/detachNangoConnectionRegistry\(/g),
    ].length;
    // One import + one call per door → detaches ≥ revokes.
    expect(hubDetaches).toBeGreaterThanOrEqual(hubRevokes);

    expect(trpcDoor).toContain("detachNangoConnectionRegistry(");
    const trpcRevokes = [...trpcDoor.matchAll(/\.revokeConnection\(/g)].length;
    const trpcDetaches = [
      ...trpcDoor.matchAll(/detachNangoConnectionRegistry\(/g),
    ].length;
    expect(trpcDetaches).toBeGreaterThanOrEqual(trpcRevokes);
  });
});
