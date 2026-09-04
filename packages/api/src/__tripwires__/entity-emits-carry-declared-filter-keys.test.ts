/**
 * TRIPWIRE — an entity event that DECLARES a filter key must CARRY it.
 *
 * `packages/events/src/event-types.ts` declares `filterKeys: ["profileSlug"]` on
 * the entity lifecycle events. The runtime matcher's generic `matchFilters`
 * evaluates a rule's `filters` against the event's own `data`, so a declared
 * filter key that the emit does not put in `data` produces a filter that can
 * never match — a rule that is authorable, looks correct, and fires never.
 *
 * That is live today: of the entity update/delete/restore emit sites, only
 * `routers/entities/helpers.ts` includes `profileSlug`. This test does NOT
 * demand they all be fixed at once — it PINS the current set, so the gap cannot
 * grow while nobody is looking, and shrinking it is a one-line edit here.
 *
 * Derived from source on both sides: the declared keys are parsed out of the
 * event catalog, and the carrying sites out of the `emitSideEffects(...)` calls
 * themselves. Neither is a list maintained by hand.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** `src/__tripwires__` → src → api → packages → synap-backend. */
const BACKEND_ROOT = join(import.meta.dirname, "../../../..");
const ROOTS = [
  "apps",
  "packages/api/src",
  "packages/jobs/src",
  "packages/database/src",
  "packages/events/src",
];

/**
 * Emit sites that do NOT carry `profileSlug`, as of 2026-09-04. Each entry is a
 * rule that silently cannot match on kind. Shrink this list by adding the key to
 * the emit — never grow it.
 */
const KNOWN_MISSING = new Set([
  "packages/api/src/routers/workspaces.ts",
  "packages/api/src/routers/proposals.ts",
  "packages/api/src/routers/hub-protocol/rest/workspaces.ts",
  "packages/api/src/routers/hub-protocol/rest/projects.ts",
  "packages/api/src/routers/proposals/executors/entity.ts",
  "packages/jobs/src/workers/steps/output.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.includes(".test.")) out.push(full);
  }
  return out;
}

/** Balanced-paren slice of each `emitSideEffects(...)` call in `src`. */
function emitCalls(src: string): string[] {
  const calls: string[] = [];
  for (const m of src.matchAll(/emitSideEffects\(/g)) {
    let depth = 0;
    const start = m.index! + m[0].length - 1;
    for (let i = start; i < Math.min(src.length, start + 3000); i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) {
        calls.push(src.slice(start, i + 1));
        break;
      }
    }
  }
  return calls;
}

describe("entity emits carry the filter keys the catalog declares", () => {
  const catalog = join(BACKEND_ROOT, "packages/events/src/event-types.ts");

  it("the catalog really declares profileSlug as an entity filter key", () => {
    // If this stops being true the whole test is moot and must be revisited,
    // rather than passing over a premise that quietly changed.
    expect(existsSync(catalog)).toBe(true);
    const src = readFileSync(catalog, "utf8");
    expect(src).toMatch(
      /ENTITY_CREATED[\s\S]{0,300}filterKeys:\s*\["profileSlug"\]/
    );
  });

  it("no NEW entity emit drops profileSlug", () => {
    const offenders = new Set<string>();
    for (const root of ROOTS) {
      for (const file of walk(join(BACKEND_ROOT, root))) {
        for (const call of emitCalls(readFileSync(file, "utf8"))) {
          if (!/subjectType:\s*"entity"/.test(call)) continue;
          if (/\baction:\s*"create"/.test(call)) continue; // create sites all carry it
          if (!call.includes("profileSlug")) {
            offenders.add(file.replace(BACKEND_ROOT + "/", ""));
          }
        }
      }
    }
    const unexpected = [...offenders].filter((f) => !KNOWN_MISSING.has(f));
    expect(
      unexpected,
      "A new entity emit does not carry `profileSlug`, which the catalog declares as a filter key — a kind-filtered rule on this event can never match. Add it to the emit's `data`, or (if it genuinely cannot be resolved there) add the file to KNOWN_MISSING with a reason."
    ).toEqual([]);

    // And the list must SHRINK, never silently hold stale entries.
    const stale = [...KNOWN_MISSING].filter((f) => !offenders.has(f));
    expect(
      stale,
      "These files no longer drop `profileSlug` — remove them from KNOWN_MISSING so the list keeps meaning something."
    ).toEqual([]);
  });
});
