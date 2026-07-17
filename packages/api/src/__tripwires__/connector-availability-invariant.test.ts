import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — `connection.state` must NEVER be `"unavailable"` when provider
 * availability is UNKNOWN (capability-catalog.ts).
 *
 * `ConnState.providerAvailable: Set<string> | null` — `null` means UNKNOWN:
 * Nango could not be asked (unreachable, bad key, malformed answer). Claiming
 * "this pod can't offer <provider>" when we merely failed to ASK Nango is
 * exactly the lie this file's availability model exists to kill. Unknown must
 * degrade to `"missing"` (the connectable state), never to `"unavailable"`.
 *
 * The invariant has two load-bearing sites in capability-catalog.ts:
 *   1. `loadConnState()` only ever assigns `providerAvailable` INSIDE the
 *      `if (declared.ok)` guard — i.e. only when Nango actually answered.
 *      An unconditional assignment (or one moved outside the guard) reopens
 *      the "unknown reads as known-absent" bug.
 *   2. `deriveConnection()` only returns `state: "unavailable"` behind a
 *      `providerAvailable !== null` check. Dropping that null-check and
 *      returning "unavailable" whenever the provider is merely absent from
 *      the set (including when the set doesn't exist) is the same bug from
 *      the read side.
 *
 * Neither function is exported (loadConnState touches the `secrets` table —
 * not unit-testable without DB mocks; deriveConnection is pure but kept
 * private) so this is source-level static analysis, matching the style of
 * the other tripwires in this directory. If this fails: you moved the
 * `providerAvailable` assignment out of the `declared.ok` guard, added a
 * second assignment site, or made `deriveConnection` return "unavailable"
 * without checking `providerAvailable !== null`. Fix capability-catalog.ts —
 * do NOT loosen this test.
 */

const FILE = join(
  process.cwd(),
  "src/services/capabilities/capability-catalog.ts"
);

/**
 * Extract the body of a top-level function by name, via brace-counting from
 * its signature to the matching close — robust to nested braces/objects
 * inside the function, unlike a regex that stops at the first `}`.
 */
function extractFunctionBody(src: string, signature: RegExp): string {
  const sigMatch = signature.exec(src);
  if (!sigMatch) {
    throw new Error(`signature not found: ${signature}`);
  }
  const openBraceIdx = src.indexOf("{", sigMatch.index);
  if (openBraceIdx === -1) {
    throw new Error(`no opening brace found for: ${signature}`);
  }
  let depth = 0;
  for (let i = openBraceIdx; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(openBraceIdx, i + 1);
    }
  }
  throw new Error(`unbalanced braces for: ${signature}`);
}

describe("tripwire: connector availability degrades unknown → missing, never unavailable", () => {
  const src = readFileSync(FILE, "utf8");

  it("extractFunctionBody is alive (finds a known fixture function)", () => {
    // Guards against the helper itself silently breaking and passing vacuously.
    const fixture = "function foo() { const x = { a: 1 }; return x; }";
    const body = extractFunctionBody(fixture, /function foo\(\)/);
    expect(body).toContain("const x = { a: 1 }");
  });

  it("providerAvailable is initialized to null", () => {
    expect(src).toMatch(
      /providerAvailable\s*:\s*Set<string>\s*\|\s*null\s*=\s*null/
    );
  });

  it("loadConnState assigns providerAvailable exactly once, only inside the `declared.ok` guard", () => {
    const body = extractFunctionBody(src, /async function loadConnState\(/);

    // All reassignments (not the `let providerAvailable = null` init, which
    // uses `:` for the type annotation right before `=`).
    const allAssignments =
      body.match(/(?<!let\s)providerAvailable\s*=\s*new Set/g) ?? [];
    expect(allAssignments.length).toBe(1);

    const ifBlock = extractFunctionBody(body, /if\s*\(declared\.ok\)/);
    const assignmentsInGuard =
      ifBlock.match(/providerAvailable\s*=\s*new Set/g) ?? [];
    expect(assignmentsInGuard.length).toBe(1);
  });

  it('deriveConnection never returns state: "unavailable" without a providerAvailable !== null guard', () => {
    const body = extractFunctionBody(src, /function deriveConnection\(/);

    // Every occurrence of the "unavailable" state literal must be reachable
    // only through code that also references `providerAvailable !== null`
    // earlier in the function body (the null-guard that gates the downgrade).
    const unavailableUsages = [...body.matchAll(/"unavailable"/g)];
    expect(unavailableUsages.length).toBeGreaterThan(0); // regex is alive

    for (const usage of unavailableUsages) {
      const before = body.slice(0, usage.index);
      expect(before).toMatch(/providerAvailable\s*!==\s*null/);
    }
  });

  it("the guard-check regex actually bites (fails on an unguarded fixture)", () => {
    // Demonstrates non-vacuousness: a version of deriveConnection that drops
    // the null-guard and always returns "unavailable" when the provider is
    // absent from the set would FAIL the check above. Simulate the assertion
    // against such a fixture directly.
    const unguardedFixture = `
      function deriveConnection(refs, hasVault, conn) {
        const unavailable = !conn.providerAvailable.has("google");
        return { state: unavailable ? "unavailable" : "missing" };
      }
    `;
    const usages = [...unguardedFixture.matchAll(/"unavailable"/g)];
    expect(usages.length).toBeGreaterThan(0);
    const before = unguardedFixture.slice(0, usages[0].index);
    expect(before).not.toMatch(/providerAvailable\s*!==\s*null/);
  });
});
