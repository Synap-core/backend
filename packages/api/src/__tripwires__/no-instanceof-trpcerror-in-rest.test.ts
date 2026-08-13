import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — `err instanceof TRPCError` is BANNED under hub-protocol/rest/.
 *
 * This check LOOKS more correct than duck-typing on `.code` and IS PROVEN
 * DEAD in the deployed bundle. Commit `9fb3e7d4` shipped it for the facet
 * REST routes; commit `2a163c7e`, same day, reverted it after live dogfood
 * proof the route still returned 500 — the tsup bundle carries its own
 * `@trpc/server` copy, so the `TRPCError` thrown at runtime and the class
 * imported for the `instanceof` check are different identities.
 *
 * Why this hid for 8+ days and why only a tripwire catches it: unit tests run
 * UNBUNDLED (single module graph — `instanceof` passes there); production
 * runs BUNDLED (`instanceof` silently fails there). `tsc --noEmit` cannot see
 * the difference (both are valid TypeScript). `vitest` cannot see the
 * difference (both pass in an unbundled test). The check reads as correct in
 * review, passes every gate, and does nothing live. Only a live dogfood or a
 * source-grep tripwire like this one can catch it — so THIS is now the only
 * gate standing between a re-introduced `instanceof TRPCError` and another
 * silent multi-day outage (the `getThreadContext` NOT_FOUND→500 incident,
 * measured live: 761/761 failures over 24h, all flattened to 500, hidden
 * because the Intelligence Service retried a permanent 404 as if transient).
 *
 * Thirteen call sites (`proposals.ts`, `playbooks.ts`, `sessions.ts`,
 * `threads.ts`) had exactly this dead check before this tripwire was added;
 * all now route through the duck-typed, cause-chain-walking
 * `httpStatusForTrpcError` / `errCode` (`./_shared.ts`) — the same technique
 * `entities.ts`'s `facetErrorStatus` has used, live-verified, since
 * `2a163c7e`.
 *
 * If this fails: replace `err instanceof TRPCError && err.code === "X"` with
 * `httpStatusForTrpcError(err)` (base 4-code mapping) or `errCode(err) ===
 * "X"` (for a code the base mapping doesn't cover) from `./_shared.ts`. Do
 * NOT add a file to the allowlist unless it is one of the two shared helpers
 * themselves, which need the real import to build the technique — they never
 * use `instanceof` in their own bodies, so they don't need an exception in
 * practice, but are allowlisted defensively in case a future edit adds a
 * TRPCError-shape assertion for a narrower reason.
 */

const REST_DIR = join(process.cwd(), "src", "routers", "hub-protocol", "rest");

// Only the shared-helper file itself may reference TRPCError at all (e.g. for
// a type-only import) — no route file needs the class, only the string codes.
const ALLOWLIST_SUFFIXES = [join("_shared.ts")];

// ANY identifier — not just `err`. A prior version of this regex hardcoded
// `err`, so `e instanceof TRPCError`, `error instanceof TRPCError`, or
// `cause instanceof TRPCError` all walked straight through undetected.
const BANNED = /\b\w+\s+instanceof\s+TRPCError\b/;

/** Strip comments so an illustrative mention of the banned pattern IN A
 * COMMENT (several files here document the incident by NAMING the dead
 * check) isn't itself flagged as an offense. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function tsFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      tsFiles(p, acc);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      acc.push(p);
    }
  }
  return acc;
}

describe("tripwire: no `instanceof TRPCError` under hub-protocol/rest", () => {
  it("no REST route file checks `err instanceof TRPCError` — duck-type via httpStatusForTrpcError/errCode instead", () => {
    const offenders = tsFiles(REST_DIR)
      .filter((f) => BANNED.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => relative(REST_DIR, f))
      .filter((rel) => !ALLOWLIST_SUFFIXES.includes(rel));
    expect(offenders).toEqual([]);
  });
});
