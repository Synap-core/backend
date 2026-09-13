import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

/**
 * WAVE-5 invariant: revoking a Nango connection must clean up after itself.
 *
 * The bug this locks: the connection reconciler was insert-only and the three
 * disconnect doors called `revokeConnection` and nothing else — so a revoked
 * connection kept its `is_default` pointer row (dispatch kept picking a dead
 * account) and its `entity_external_links` stayed `active` forever.
 *
 * The tRPC and Hub REST doors delegate to ONE helper,
 * `disconnectOwnedConnection`, which (in order) proves the connection is in the
 * caller's own live broker list, revokes it, then detaches its registry
 * footprint. The ORDER is load-bearing: `detachNangoConnectionRegistry` matches
 * pointer rows by connection id across ALL users, so detaching before the
 * ownership check would let a caller wipe another user's rows.
 *
 * The DOOR SET is DERIVED: every non-test source under
 * `routers/` and `services/` that calls `.revokeConnection(` is scanned, so a
 * new disconnect door joins the check by existing. Each such file must read a
 * live list BEFORE its first revoke and detach AFTER it.
 *
 * WHAT IT CANNOT SEE (measured by the negative controls, not assumed):
 *   - It reads text, not behaviour: an ownership check that is present but
 *     wrong (e.g. comparing the wrong field) passes. It pins the `if (!own)`
 *     early return and the `connectionId === input.connectionId` match inside
 *     the helper only; for other doors it pins list-before-revoke-before-detach.
 *   - Granularity is the FILE: a file with two revokes where only the first is
 *     bracketed by list/detach still passes. Nothing under `connectors/` (the
 *     broker implementations themselves) is scanned.
 *   - The helper body is the text from its signature to the first line that is
 *     exactly `}`; a nested top-level-indented `}` would truncate the scan (the
 *     non-vacuity asserts would then go red, not silently pass).
 */

const srcRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const read = (rel: string) => readFileSync(join(srcRoot, rel), "utf-8");
const sync = read("services/capabilities/capability-nango-sync.ts");
const hubDoor = read("routers/hub-protocol/rest/connectors.ts");
const trpcDoor = read("routers/connectors-trpc.ts");

/** Every non-test .ts under routers/ and services/ calling `.revokeConnection(`. */
function revokeCallers(): string[] {
  const out: string[] = [];
  for (const top of ["routers", "services"]) {
    const entries = readdirSync(join(srcRoot, top), {
      recursive: true,
    }) as string[];
    for (const rel of entries) {
      if (
        !rel.endsWith(".ts") ||
        /\.test\.ts$/.test(rel) ||
        rel.includes("__tests__")
      ) {
        continue;
      }
      const path = `${top}/${rel}`;
      if (read(path).includes(".revokeConnection(")) out.push(path);
    }
  }
  return out.sort();
}

/** The `disconnectOwnedConnection` body, pinned at both ends. */
function disconnectHelperBody(): string {
  const start = sync.indexOf(
    "export async function disconnectOwnedConnection("
  );
  expect(start, "disconnectOwnedConnection not found").toBeGreaterThan(-1);
  const end = sync.indexOf("\n}\n", start);
  expect(end, "end of disconnectOwnedConnection not found").toBeGreaterThan(
    start
  );
  return sync.slice(start, end);
}

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
    // wipes live pointers on a transient blip. The reconciler MUST use the typed
    // `listConnectionsResult` and bail unless the broker definitively answered —
    // an ambiguous empty must never reach the removal branch.
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

  it("the disconnect helper checks ownership, THEN revokes, THEN detaches", () => {
    const body = disconnectHelperBody();
    // Non-vacuity: the scan is looking at the real helper, not a stub.
    expect(body).toContain("listConnectionsResult(");

    const ownershipMatch = body.indexOf("connectionId === input.connectionId");
    const ownershipGuard = body.search(/if\s*\(\s*!own\s*\)/);
    const revoke = body.indexOf(".revokeConnection(");
    const detach = body.indexOf("detachNangoConnectionRegistry(");

    expect(ownershipMatch, "ownership match missing").toBeGreaterThan(-1);
    expect(ownershipGuard, "ownership early-return missing").toBeGreaterThan(
      -1
    );
    expect(revoke, "revoke missing").toBeGreaterThan(-1);
    expect(detach, "detach missing").toBeGreaterThan(-1);

    expect(ownershipMatch).toBeLessThan(revoke);
    expect(ownershipGuard).toBeLessThan(revoke);
    expect(revoke).toBeLessThan(detach);
  });

  it("EVERY file that revokes (derived set) lists first and detaches after", () => {
    const callers = revokeCallers();
    // Non-vacuity: the known doors are found by the scan, not assumed.
    expect(callers).toContain("services/capabilities/capability-nango-sync.ts");
    expect(callers).toContain(
      "services/capabilities/capability-connections.ts"
    );
    for (const path of callers) {
      const text = read(path);
      const firstRevoke = text.indexOf(".revokeConnection(");
      const list = text.indexOf("listConnectionsResult(");
      const detach = text.indexOf(
        "detachNangoConnectionRegistry(",
        firstRevoke
      );
      expect(list, `${path}: no live list before revoking`).toBeGreaterThan(-1);
      expect(
        list,
        `${path}: the live list must precede the revoke`
      ).toBeLessThan(firstRevoke);
      expect(detach, `${path}: no detach after the revoke`).toBeGreaterThan(
        firstRevoke
      );
    }
  });

  it("the tRPC and Hub REST doors go through the helper and never revoke on their own", () => {
    // Hub REST has two doors (DELETE + POST); the tRPC router has one.
    expect(
      [...hubDoor.matchAll(/disconnectOwnedConnection\(/g)].length
    ).toBeGreaterThanOrEqual(2);
    expect(
      [...trpcDoor.matchAll(/disconnectOwnedConnection\(/g)].length
    ).toBeGreaterThanOrEqual(1);

    expect(hubDoor).not.toMatch(/\.revokeConnection\(/);
    expect(trpcDoor).not.toMatch(/\.revokeConnection\(/);
  });
});
