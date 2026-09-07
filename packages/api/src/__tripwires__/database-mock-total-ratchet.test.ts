import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

/**
 * TRIPWIRE — ratchet on TOTAL `vi.mock("@synap/database", ...)` replacements.
 *
 * A TOTAL mock — one that returns a hand-listed object instead of spreading
 * the real module — dies at COLLECTION time the moment any source file in the
 * test's import graph starts using an export the mock's object does not list:
 *
 *     Error: [vitest] No "isNull" export is defined on the "@synap/database"
 *     mock. Did you forget to return it from "vi.mock"?
 *
 * That is not one failing test — the WHOLE FILE goes dark. Every test in it
 * stops running, silently, until someone notices the suite shrank. Two files
 * did exactly this (`auth.test.ts`, `profiles.renderer-governance.test.ts`)
 * and sat dark before being fixed.
 *
 * THE FIX — partial mock via `importOriginal`, so a new export the file never
 * mentions just resolves to the real thing instead of exploding:
 *
 *     vi.mock("@synap/database", async (importOriginal) => {
 *       const actual = await importOriginal<typeof import("@synap/database")>();
 *       return {
 *         ...actual,
 *         db: { ... },        // only what THIS test needs to fake
 *       };
 *     });
 *
 * Worked examples to copy from:
 *   - src/routers/hub-protocol/rest/auth.test.ts
 *   - src/routers/profiles.renderer-governance.test.ts
 *
 * ⚠️ `importOriginal` is not automatically safe — verify the real module has
 * no import-time side effect that would fire in a DB-down test env (in this
 * package, `@synap/database`'s `db`/`getDb` are postgres.js clients, which are
 * LAZY-CONNECT: constructing them does not open a socket, so importing the
 * real module here is safe. Confirmed empirically, not just by reading — run
 * the converted file with Postgres down and check it doesn't hang.).
 *
 * WHY A RATCHET, NOT A HARD BAN: 65 files (measured 2026-09-06) still use the
 * total-mock form. Converting all of them in one pass is large, per-file-risky
 * churn nobody asked for — each mock fakes a different slice of the module,
 * and `importOriginal` safety has to be checked per file, not assumed. A
 * ratchet freezes the baseline: no NEW total mock may be added, and the
 * baseline must be LOWERED (never silently raised) whenever a conversion
 * lands, so the debt can only shrink.
 *
 * Derived, never hand-listed: the count comes from scanning `src/**\/*.test.ts`
 * for the total-mock call shape, so a new offender is always caught here —
 * there is no separate list to forget to update.
 */

// 66 -> 65 on 2026-09-06: `routers/n8n/actions.test.ts` converted to
// `importOriginal` (it was dying on a missing `workspaces` export). Locking the
// improvement in is part of that fix — a ratchet left stale-HIGH is a guard
// quietly losing its teeth, tolerating a file's worth of new debt in silence.
// NOT lowered further in anticipation: a scan found ~35 more test files whose
// total mocks are latently missing a name, but they pass today and the baseline
// must describe what is true now, not what anyone intends.
const BASELINE = 65;

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..");

// Matches `vi.mock("@synap/database", () => {`  or  `vi.mock("@synap/database", async () => {`
// — i.e. the mock factory takes NO parameter, so it cannot be the partial
// `(importOriginal) => ...` form. A factory that spreads the real module some
// other way (e.g. `vi.importActual("@synap/database")` inside a no-arg
// factory) would still show up here — none currently do (verified by hand
// when this baseline was set) — so a future one legitimately ratchets the
// baseline down rather than being a false positive to special-case away.
// ⚠️ The `\s*` MUST sit outside the async alternation. An earlier version read
// `(?:\(\)|async\s*\(\)\s*)=>` — which requires `=>` IMMEDIATELY after `()`
// on the non-async branch, so it matched `()=>` but missed the far commoner
// `() =>`. It found 8 files where there are 67. The self-guard below is what
// caught it; without that floor this ratchet would have passed vacuously
// forever while guarding nothing.
const TOTAL_MOCK_RE =
  /vi\.mock\(\s*["']@synap\/database["']\s*,\s*(?:async\s*)?\(\s*\)\s*=>/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "dist" || name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function totalMockFiles(): string[] {
  return walk(SRC)
    .filter((f) => TOTAL_MOCK_RE.test(readFileSync(f, "utf8")))
    .map((f) => relative(SRC, f))
    .sort();
}

describe("tripwire: @synap/database total-mock ratchet", () => {
  it("does not exceed the pinned baseline of total vi.mock replacements", () => {
    const offenders = totalMockFiles();

    // Sanity floor — a broken regex/walk that matches nothing would pass
    // vacuously and stop guarding anything.
    expect(
      offenders.length,
      "totalMockFiles() found suspiciously few matches — the scan is probably broken, not the codebase fixed"
    ).toBeGreaterThan(10);

    if (offenders.length > BASELINE) {
      const newOffenders = offenders.slice(BASELINE); // informational only, list below is exhaustive
      throw new Error(
        `[database-mock-total-ratchet] ${offenders.length} files use a TOTAL ` +
          `vi.mock("@synap/database", ...) replacement — baseline is ${BASELINE}.\n\n` +
          `A total mock dies at COLLECTION time the moment any source file in its ` +
          `import graph starts using an export the mock doesn't list — the whole ` +
          `file goes dark, not one test.\n\n` +
          `Fix: switch to the partial-mock form —\n\n` +
          `  vi.mock("@synap/database", async (importOriginal) => {\n` +
          `    const actual = await importOriginal<typeof import("@synap/database")>();\n` +
          `    return { ...actual, db: { /* only what this test fakes */ } };\n` +
          `  });\n\n` +
          `See src/routers/hub-protocol/rest/auth.test.ts and ` +
          `src/routers/profiles.renderer-governance.test.ts for worked examples. ` +
          `Verify importOriginal has no import-time side effect (e.g. an eager DB ` +
          `connect) before relying on it.\n\n` +
          `All offenders:\n` +
          offenders.map((f) => `  ${f}`).join("\n") +
          `\n\n(new since baseline, approx: ${newOffenders.length} file(s))`
      );
    }

    if (offenders.length < BASELINE) {
      throw new Error(
        `[database-mock-total-ratchet] Only ${offenders.length} files use a TOTAL ` +
          `vi.mock("@synap/database", ...) replacement — the pinned baseline is ` +
          `${BASELINE}, which is now stale (too high).\n\n` +
          `Nice work retiring some debt. Lower BASELINE in this file to ${offenders.length} ` +
          `and commit it, so the improvement is locked in and the count can't silently ` +
          `creep back up.`
      );
    }

    expect(offenders.length).toBe(BASELINE);
  });
});
