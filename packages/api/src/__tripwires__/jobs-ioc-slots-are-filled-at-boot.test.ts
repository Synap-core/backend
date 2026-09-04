/**
 * TRIPWIRE — every IoC slot `@synap/jobs` DECLARES is FILLED at boot by apps/api.
 *
 * `@synap/jobs` cannot statically import `@synap/api` (circular dep), so a worker
 * that needs an api-side implementation declares a slot —
 * `export function registerXRunner(fn)` — which `apps/api/src/index.ts` fills at
 * startup with a thunk. The pattern is correct. Its failure mode is that
 * declaring the slot and filling it are in two packages with NOTHING connecting
 * them: the declaration typechecks, the worker typechecks, the boot typechecks,
 * and the feature is simply dead.
 *
 * That is not hypothetical. `registerAgentWaker` shipped with the `wakeAgent`
 * agent-handoff feature and had ZERO call sites: every `channel_message` with
 * `wakeAgent: true` would have posted its message and then thrown "no agent waker
 * registered", leaving a handoff in a channel nobody would ever answer. It is the
 * same built-but-severed class this repo's own notes call its dominant defect.
 *
 * ── Why this is DERIVED, not a list ────────────────────────────────────────
 * Both sides are parsed out of the files that own the truth:
 *   • DECLARED ← every `export function register…(` in `packages/jobs/src`
 *   • FILLED   ← every `register…(` CALL in `apps/api/src/index.ts`
 * There is no list here to forget to update: adding a new slot to jobs turns
 * this test red until apps/api fills it. A slot that is deliberately optional
 * must be named in `UNFILLED_BY_DESIGN` below WITH a reason, so the next
 * unfilled one still goes red.
 *
 * Guarded like the other source-scan tripwires: a missing file or an empty parse
 * FAILS rather than reporting green over nothing.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** `src/__tripwires__` → src → api → packages → synap-backend. */
const BACKEND_ROOT = join(import.meta.dirname, "../../../..");
const JOBS_SRC = join(BACKEND_ROOT, "packages/jobs/src");
const BOOT = join(BACKEND_ROOT, "apps/api/src/index.ts");

/**
 * Slots that intentionally have no boot-time filler. Each entry must say WHY;
 * an empty reason is the same as no entry.
 */
const UNFILLED_BY_DESIGN: Record<string, string> = {};

function read(file: string): string {
  if (!existsSync(file)) {
    throw new Error(
      `Tripwire cannot read its subject: ${file}. A moved file must move this test, not silence it.`
    );
  }
  return readFileSync(file, "utf8");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.includes(".test.")) out.push(full);
  }
  return out;
}

/** Strip comments so prose naming a slot can never be read as a declaration or a call. */
function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("every @synap/jobs IoC slot is filled at boot", () => {
  const declared = (() => {
    if (!existsSync(JOBS_SRC)) {
      throw new Error(`Tripwire cannot read its subject: ${JOBS_SRC}`);
    }
    const names = new Set<string>();
    for (const file of walk(JOBS_SRC)) {
      for (const m of strip(readFileSync(file, "utf8")).matchAll(
        /export\s+function\s+(register[A-Z]\w*)\s*\(/g
      )) {
        names.add(m[1]!);
      }
    }
    return [...names].sort();
  })();

  const boot = strip(read(BOOT));

  it("parsed both sides (the sets are non-empty)", () => {
    // An empty declared set would make every assertion below vacuously true —
    // the exact shape of a tripwire that passes forever while guarding nothing.
    expect(declared.length).toBeGreaterThan(0);
    expect(boot.length).toBeGreaterThan(0);
  });

  it.each(declared.map((n) => [n]))(
    "%s is called in apps/api/src/index.ts",
    (name) => {
      if (UNFILLED_BY_DESIGN[name]) {
        expect(
          UNFILLED_BY_DESIGN[name].length,
          `${name} is exempt but carries no reason`
        ).toBeGreaterThan(0);
        return;
      }
      // The CALL, not the import: destructuring a slot and never invoking it is
      // exactly how `registerAgentWaker` would have looked half-done.
      expect(
        new RegExp(`\\b${name}\\s*\\(`).test(boot),
        `${name} is declared in packages/jobs but never called in apps/api/src/index.ts — the slot is empty and whatever depends on it is dead. Fill it at boot, or add it to UNFILLED_BY_DESIGN with a reason.`
      ).toBe(true);
    }
  );
});
