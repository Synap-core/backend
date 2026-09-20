import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { dirname, join, relative } from "path";
import { fileURLToPath } from "url";
import { CRITERION_SLOT_KIND } from "@synap-core/types/focus-sessions";

/**
 * TRIPWIRE — `CRITERION_SLOT_KIND` has exactly ONE definition.
 *
 * The slot kind an escalated criterion is filed under is read by THREE
 * consumers and counting: the escalation writer (`evaluations/record.ts`), the
 * per-playbook scorecard (`@synap/jobs`), and now the needs-you tray in both
 * UIs — which must tell a criterion slot from an ordinary deliverable because
 * it takes a different verb (grade it, never "I did this"). It therefore lives
 * in `@synap-core/types/focus-sessions`: the ONLY backend package `browser/`
 * and `relay-app/` can resolve (neither links the `@synap/*` scope), and
 * `@synap/playbooks` is deliberately dependency-free so it cannot host it.
 *
 * It had already forked once: `packages/jobs/src/utils/playbook-scorecard.ts`
 * carried a hand-copied `const CRITERION_SLOT_KIND = "criterion"` under a
 * comment saying it mirrored the api one. A mirror is a fork with a promise.
 *
 * SCOPE + what this does NOT see: the scan is every non-test `.ts` under
 * every `synap-backend` package's `src`, so a fork in `browser/`, `relay-app/` or the
 * IS is invisible here (a monorepo-wide tripwire cannot run from one package).
 * It also only catches a DECLARATION whose name is `CRITERION_SLOT_KIND`, or a
 * bare `kind: "criterion"` written into an expected-output literal — not every
 * conceivable way to spell the string.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** …/packages — derived, never cwd-relative (a wrong cwd would scan nothing). */
const PACKAGES_ROOT = join(HERE, "..", "..", "..");
/** The ONE file permitted to declare it. */
const OWNER = "types/src/focus-sessions/criterion-slot.ts";

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(p, acc);
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    )
      acc.push(p);
  }
  return acc;
}

/** Every `packages/<pkg>/src` there is — DERIVED, so a new package joins by existing. */
function sourceRoots(): string[] {
  return readdirSync(PACKAGES_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "node_modules")
    .map((e) => join(PACKAGES_ROOT, e.name, "src"))
    .filter((p) => {
      try {
        return readdirSync(p).length > 0;
      } catch {
        return false;
      }
    });
}

/** A DECLARATION (not an import, not a re-export) of the constant. */
const DECLARES = /(?:const|let|var)\s+CRITERION_SLOT_KIND\s*[:=]/;
/** The literal written straight into an expected-output object. */
const RAW_SLOT_LITERAL = /\bkind:\s*["']criterion["']/;

describe("tripwire: CRITERION_SLOT_KIND has one home", () => {
  const files = sourceRoots().flatMap((r) => tsFiles(r));

  it("the scan actually reaches the backend's sources", () => {
    // Non-vacuity: a glob that matched nothing passes every assertion below.
    expect(files.length).toBeGreaterThan(500);
    // …and it can still SEE the thing it hunts, in the file that owns it.
    const owner = files.find((f) => relative(PACKAGES_ROOT, f) === OWNER);
    expect(owner).toBeDefined();
    expect(DECLARES.test(readFileSync(owner!, "utf8"))).toBe(true);
  });

  it("exactly one file declares it, and it is @synap-core/types", () => {
    const declarers = files
      .filter((f) => DECLARES.test(readFileSync(f, "utf8")))
      .map((f) => relative(PACKAGES_ROOT, f));
    expect(declarers).toEqual([OWNER]);
  });

  it('nobody writes the raw `kind: "criterion"` literal instead of importing it', () => {
    const offenders = files
      .filter((f) => RAW_SLOT_LITERAL.test(readFileSync(f, "utf8")))
      .map((f) => relative(PACKAGES_ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("the exported value is the string the stored slots carry", () => {
    // The value itself is load-bearing: stored rows already say "criterion".
    expect(CRITERION_SLOT_KIND).toBe("criterion");
  });
});
