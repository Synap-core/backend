/**
 * Tripwire: every `RunScope` lens is REACHABLE from every door that takes a scope.
 *
 * WHY THIS EXISTS — it caught us, on the very feature it now guards.
 * `RunScope.sessionId` was added to the service, both query branches filtered on
 * it correctly, the dispatcher plumbed it, and a PGlite test proved the SQL. It
 * was still reachable by NOBODY: the tRPC `runs.list` input and the Hub REST
 * `GET /runs` handler each hand-enumerate the scope keys, and neither listed it.
 * The lens was exercised only by its own test — "built but severed", the exact
 * pattern this codebase keeps paying for, committed while documenting it.
 *
 * A hand-enumerated list is the root cause, so this guard DERIVES the expected
 * set from `keyof RunScope` and fails when a door falls behind. A new lens joins
 * the scan BY EXISTING; nobody has to remember.
 *
 * WHAT THIS DOES NOT COVER, measured:
 *  - It proves the key is ACCEPTED by each door, not that the door's value is
 *    forwarded intact to `listRuns`. The forwarding is covered by
 *    `services/runs/__tests__/capability-runs.session-lens.pglite.test.ts`,
 *    which drives real SQL against real rows.
 *  - It reads the REST door's key array as SOURCE TEXT, because that array is a
 *    runtime literal inside a route closure and cannot be imported. A door that
 *    accepted a key by some other mechanism would read as missing here (a false
 *    positive, which is the safe direction). The tRPC side is checked against
 *    the real Zod shape, not text.
 *  - Scope keys only. Other door inputs (flowType, flowId, status, limit) are
 *    out of scope for this guard.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { RunScope } from "../services/runs/index.js";

/**
 * The expected set, DERIVED. `satisfies` pins each entry to a real key, and the
 * `Exclude` floor below makes an UNLISTED key a compile error — so this constant
 * cannot silently fall behind `RunScope` the way both doors did.
 */
const RUN_SCOPE_KEYS = [
  "workspaceId",
  "projectId",
  "subjectEntityId",
  "sessionId",
] as const satisfies ReadonlyArray<keyof RunScope>;

// COMPILE-TIME FLOOR: a new `RunScope` field that is not listed above resolves
// to `never` and stops the build. This is the half `satisfies` alone does not
// give you — it checks membership, not coverage.
type _AllScopeKeysListed =
  Exclude<keyof RunScope, (typeof RUN_SCOPE_KEYS)[number]> extends never
    ? true
    : never;
const _allScopeKeysListed: _AllScopeKeysListed = true;
void _allScopeKeysListed;

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("tripwire: every RunScope lens is reachable from every door", () => {
  it("NON-VACUITY: the derived key set is plausible and includes a known lens", () => {
    // A guard whose expected set silently emptied would pass every assertion
    // after it.
    expect(RUN_SCOPE_KEYS.length).toBeGreaterThanOrEqual(4);
    expect(RUN_SCOPE_KEYS).toContain("workspaceId");
  });

  it("tRPC `runs.list` accepts every scope key", async () => {
    const { runsRouter } = await import("../routers/runs.js");
    // Read the REAL Zod shape, not the source text.
    const input = (
      runsRouter._def.procedures.list as unknown as {
        _def: { inputs: unknown[] };
      }
    )._def.inputs[0] as z.ZodObject<{
      scope: z.ZodOptional<z.ZodObject<never>>;
    }>;
    const scopeShape = (
      (input.shape.scope as z.ZodOptional<z.ZodObject<never>>)._def
        .innerType as z.ZodObject<Record<string, unknown>>
    ).shape;
    const accepted = Object.keys(scopeShape).sort();

    expect(
      RUN_SCOPE_KEYS.filter((k) => !accepted.includes(k)),
      "a RunScope lens the tRPC door cannot accept is reachable by nobody — " +
        "this is exactly how `sessionId` shipped severed"
    ).toEqual([]);
  });

  it("Hub REST `GET /runs` accepts every scope key", () => {
    const rest = src("../routers/hub-protocol/rest/runs.ts");

    // Non-vacuity: the array we are reading must actually be findable.
    expect(
      rest.includes('"workspaceId"'),
      "the REST scope-key array was not found — the scan is broken, not the door"
    ).toBe(true);

    const missing = RUN_SCOPE_KEYS.filter((k) => !rest.includes(`"${k}"`));
    expect(
      missing,
      "a RunScope lens the REST door does not enumerate is reachable by nobody"
    ).toEqual([]);
  });
});
