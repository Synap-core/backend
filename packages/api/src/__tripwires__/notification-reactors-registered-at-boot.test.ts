/**
 * TRIPWIRE — every notification reactor `packages/api/src/notifications` DECLARES
 * is REGISTERED at boot by apps/api.
 *
 * A reactor is inert until someone calls its `register…Reactor()`. Nothing
 * connects the two: the reactor typechecks, its unit tests pass against the
 * handler called directly, and the notification is simply never produced in
 * production. That is this repo's dominant defect class — route written and
 * tested but unmounted, 404 — and it is the exact shape a notification failure
 * takes: silent. Nobody reports a push they never expected.
 *
 * ── DERIVED, not a list ────────────────────────────────────────────────────
 * Both sides are parsed out of the files that own the truth:
 *   • DECLARED  ← every `export function register…Reactor(` under
 *                 `packages/api/src/notifications`
 *   • EXPORTED  ← every such name re-exported from `packages/api/src/index.ts`
 *                 (apps/api can only import through the barrel)
 *   • REGISTERED ← every `register…Reactor(` CALL in `apps/api/src/index.ts`
 * A new reactor joins this scan BY EXISTING. There is no array to forget.
 *
 * Modelled on `jobs-ioc-slots-are-filled-at-boot.test.ts`, which guards the same
 * class across the jobs↔api seam, and guarded the same way: a missing file or an
 * empty parse FAILS rather than reporting green over nothing.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** `src/__tripwires__` → src → api → packages → synap-backend. */
const BACKEND_ROOT = join(import.meta.dirname, "../../../..");
const NOTIFICATIONS_SRC = join(BACKEND_ROOT, "packages/api/src/notifications");
const BARREL = join(BACKEND_ROOT, "packages/api/src/index.ts");
const BOOT = join(BACKEND_ROOT, "apps/api/src/index.ts");

/**
 * Reactors intentionally NOT registered at boot. Each entry must say WHY; an
 * empty reason is the same as no entry, so the next unregistered one still
 * goes red.
 */
const UNREGISTERED_BY_DESIGN: Record<string, string> = {};

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
    if (name === "node_modules" || name === "dist" || name === "__tests__")
      continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.includes(".test.")) out.push(full);
  }
  return out;
}

const DECLARE = /export function (register[A-Za-z0-9_]*Reactor)\s*\(/g;

function declaredReactors(): Set<string> {
  const found = new Set<string>();
  for (const file of walk(NOTIFICATIONS_SRC)) {
    for (const m of read(file).matchAll(DECLARE)) found.add(m[1]!);
  }
  return found;
}

describe("TRIPWIRE: notification reactors are registered at boot", () => {
  it("the scan can still see what it hunts (non-vacuity)", () => {
    const declared = declaredReactors();
    // Not "more than zero": name a reactor that has existed since before this
    // tripwire, so a regex that silently stops matching cannot pass here.
    expect(declared).toContain("registerSessionUnblockReactor");
    expect(declared.size).toBeGreaterThanOrEqual(2);

    // And prove the DECLARE pattern matches a literal sample of its subject —
    // a regex that matched zero lines would pass every assertion after it.
    const sample = "export function registerFooReactor(): void {";
    expect([...sample.matchAll(DECLARE)].map((m) => m[1])).toEqual([
      "registerFooReactor",
    ]);
  });

  it("every declared reactor is exported from the package barrel", () => {
    const barrel = read(BARREL);
    const missing = [...declaredReactors()].filter(
      (name) =>
        !UNREGISTERED_BY_DESIGN[name] &&
        !new RegExp(`\\b${name}\\b`).test(barrel)
    );
    expect(
      missing,
      `Not exported from packages/api/src/index.ts, so apps/api cannot register them: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("every declared reactor is CALLED at boot", () => {
    const boot = read(BOOT);
    const declared = declaredReactors();
    const missing = [...declared].filter((name) => {
      if (UNREGISTERED_BY_DESIGN[name]) return false;
      // A CALL, not an import line — importing it and never calling it is
      // exactly the defect.
      return !new RegExp(`\\b${name}\\s*\\(`).test(boot);
    });
    expect(
      missing,
      `Declared but never registered at boot (apps/api/src/index.ts) — these reactors are dead: ${missing.join(", ")}`
    ).toEqual([]);
  });

  /**
   * MEASURED LIMIT, stated rather than implied. Granularity is the FILE and the
   * CALL SITE, not the runtime: this proves the call appears in boot source, not
   * that the branch it sits in actually executes on every deployment. Both
   * existing reactor registrations sit outside the `localMode` / pg-boss
   * branches for that reason, and a future one placed INSIDE a conditional
   * would still pass here. Verified by deleting one of the two calls and
   * watching only the third test go red.
   */
  it("documents its own boundary", () => {
    expect(Object.keys(UNREGISTERED_BY_DESIGN)).toEqual([]);
  });
});
