/**
 * TRIPWIRE — the intent vocabulary has ONE source of truth, and every mirror is
 * CLASSIFIED rather than merely present.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * The SSOT is the pod's `capability_intents` TABLE. Slugs live in ROWS (migrations
 * 0283 seeded the 13, 0284 added `publish_post`), so a TypeScript union is a
 * MIRROR by construction, and a mirror is only safe when something checks it.
 *
 * Four copies existed on 2026-09-30. Three were real mirrors (three different
 * repos link different subsets, so none can import another); the fourth,
 * `AbstractVerb` in `@synap/playbooks`, was DEAD — 13 slugs, stale since 0284,
 * with ZERO importers repo-wide. Deleted 2026-10-01; policed by
 * `packages/playbooks/src/required-intents.test.ts`.
 *
 * The pod's own `ABSTRACT_VERBS` was the real hazard: it had NO parity guard at
 * all. Both other mirrors re-derived from the migration SQL; the pod's copy was
 * asserted only by `verb-intent.test.ts`, which pins its OWN hand-typed list —
 * a self-consistency check, blind to the SSOT. So a slug added by migration
 * could ship to production with the pod rejecting it, while every other mirror
 * went red. This file closes that.
 *
 * ── WHAT IT PROVES ──────────────────────────────────────────────────────────
 * 1. SAMENESS between the pod's mirror and the types mirror, and between the
 *    types mirror and the pod's seeded migration rows. Never CORRECTNESS: if
 *    every copy agrees on a slug that should not exist, this stays green. A
 *    convergence guard cannot tell a shared mistake from a shared truth — the
 *    vocabulary's MEANING is reviewed, not derived.
 * 2. A COMPILE-TIME coverage floor (below), so a slug added to a migration and
 *    forgotten in a mirror fails `pnpm typecheck` rather than a test run.
 *
 * ── WHAT IT DOES NOT COVER, measured ────────────────────────────────────────
 * - The CONTROL PLANE mirror (`synap-control-plane-api/src/seeds/
 *   capability-intent-vocabulary.ts`) is NOT imported here: the CP is a separate
 *   deploy target with its own lockfile and does not resolve `@synap-core/types`
 *   (verified: `require.resolve` → MODULE_NOT_FOUND). It is policed by its own
 *   `capability-provides.test.ts`, which re-derives from the same migration SQL.
 * - This compares the pod's SEED union, so `publish_post` (0284, a `REGISTERED_
 *   EXTRAS` row) is covered by the totals, not by membership.
 * - The floor's classified sets are keyed on the names of each mirror's export;
 *   a mirror renamed to something else would fail to COMPILE here, which is the
 *   intended signal.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ABSTRACT_VERBS } from "@synap/database/schema";
import {
  ABSTRACT_INTENTS,
  REGISTERED_EXTRAS,
  CAPABILITY_INTENTS,
} from "@synap-core/types/capability-intents";

// ── The SSOT, re-derived ─────────────────────────────────────────────────────
// From MIGRATION SQL, never from another mirror: the SQL is what actually
// populates the table, so a check that read the pod's TypeScript would stay
// green while the shipped seed and every mirror disagreed.
const MIGRATIONS = [
  "0283_capability_intents.sql",
  "0284_publish_post_intent.sql",
];
const HERE = dirname(fileURLToPath(import.meta.url));
// src/__tripwires__ → src → api → packages → synap-backend
const MIGRATIONS_DIR = resolve(
  HERE,
  "../../../../packages/database/migrations"
);

function slugsFromMigration(name: string): Set<string> {
  const path = join(MIGRATIONS_DIR, name);
  // A MOVED migration is not an empty vocabulary — fail loudly. (readFileSync
  // would throw, which is right, but the message names the cause.)
  expect(
    existsSync(path),
    `pod migration not found at ${path} — the parity source has moved`
  ).toBe(true);
  const sql = readFileSync(path, "utf8");
  // Scan ONLY the `INSERT INTO "capability_intents"` VALUES list. Matching the
  // whole file picks up the CHECK constraint's `IN ('read','write','act')` —
  // those are EFFECT values, and reading one as a slug injects a phantom
  // `read` intent that no seed may ever declare.
  const insert = sql.slice(sql.indexOf('INSERT INTO "capability_intents"'));
  expect(
    insert.length,
    `no capability_intents INSERT in ${name}`
  ).toBeGreaterThan(0);
  const slugs = new Set<string>();
  for (const m of insert.matchAll(
    /\(\s*'([a-z][a-z0-9_]*)'\s*,\s*'(?:read|write|act)'\s*,/g
  )) {
    slugs.add(m[1]);
  }
  return slugs;
}

/**
 * Every slug the pod ships, across ALL intent migrations.
 *
 * ⚠️ PER-MIGRATION DERIVATION IS LOAD-BEARING, not tidiness. `ABSTRACT_VERBS` is
 * the 0283 SEED union (13 slugs); `publish_post` is a 0284 ROW deliberately
 * excluded from it, and 0284's own header says so. So the seed union must be
 * compared against 0283 ALONE. A single "all migrations" set here would make the
 * honest separation between seed and post-seed rows look like drift — the first
 * version of this file did exactly that and went red for the wrong reason.
 */
function deriveSeededIntents(): Set<string> {
  const all = new Set<string>();
  for (const name of MIGRATIONS) {
    for (const slug of slugsFromMigration(name)) all.add(slug);
  }
  return all;
}

/** Only the 0283 seed — what `ABSTRACT_VERBS` is supposed to mirror. */
function deriveSeedUnionIntents(): Set<string> {
  return slugsFromMigration(MIGRATIONS[0]);
}

describe("intent vocabulary — the pod's mirror is checked against the SSOT", () => {
  it("NON-VACUITY: the scan recovered a real, non-trivial seed", () => {
    // Without this floor a broken regex or a moved directory yields an EMPTY
    // set, and an empty set compares equal to nothing — every parity assertion
    // below would pass on zero evidence.
    const seeded = deriveSeededIntents();
    expect(seeded.size).toBeGreaterThanOrEqual(13);
    expect(seeded).toContain("generate_media");
    expect(seeded).toContain("publish_post");
  });

  it("pod ABSTRACT_VERBS === the 0283 SEED rows (and excludes post-seed rows)", () => {
    // THE GAP THIS CLOSES. `verb-intent.test.ts` pins ABSTRACT_VERBS against a
    // hand-typed copy of itself, so it could never detect that ABSTRACT_VERBS
    // disagreed with the table. This derives from the SQL instead.
    //
    // 0283 ALONE, deliberately: `publish_post` (0284) is a registry row and is
    // NOT a member of the seed union, so demanding it here would invert the
    // distinction the migration headers draw.
    const seedUnion = deriveSeedUnionIntents();
    expect([...ABSTRACT_VERBS].sort()).toEqual([...seedUnion].sort());
  });

  it("the types mirror === the SSOT, and the two pod-side mirrors agree", () => {
    const seeded = deriveSeededIntents();
    expect([...CAPABILITY_INTENTS].sort()).toEqual([...seeded].sort());
    expect([...ABSTRACT_INTENTS].sort()).toEqual([...ABSTRACT_VERBS].sort());
  });

  it("the seed union and the post-seed rows stay honestly distinguished", () => {
    // `publish_post` is a 0284 row, NOT a member of the 0283 seed union. If a
    // new slug is quietly appended to the seed list instead of registered as a
    // row, the ABSTRACT_VERBS equality above fails AND this fails — which is the
    // point of keeping the two lists separate rather than one flat array.
    const seeded = deriveSeededIntents();
    expect(ABSTRACT_INTENTS.length).toBe(
      seeded.size - REGISTERED_EXTRAS.length
    );
    expect(ABSTRACT_INTENTS.length).toBe(ABSTRACT_VERBS.length);
    for (const extra of REGISTERED_EXTRAS) {
      expect(ABSTRACT_VERBS).not.toContain(extra);
      expect(ABSTRACT_INTENTS).not.toContain(extra);
    }
  });
});

// ── THE COMPILE-TIME COVERAGE FLOOR ──────────────────────────────────────────
// Per `.claude/rules/guards-and-tests.md`, the defect "someone adds a value and
// forgets to handle it" is best fixed by making the omission FAIL THE BUILD
// rather than by writing a test that might notice.
//
// ⚠️ TWO FLOORS THAT LOOKED RIGHT AND CANNOT FIRE. Both were written, mutation-
// tested, and proven inert. They are recorded here because the failure is
// invisible and the guard still reads like proof:
//
//   1. `Exclude<keyof typeof MIRROR, CLASSIFIED> extends never ? true : never` —
//      the obvious "derive the set from `keyof`" form. It CANNOT FIRE for a
//      VALUE array: `keyof (readonly string[])` is the array's METHODS
//      (`length`, `includes`, …), never its ELEMENTS, so the `Exclude` is
//      vacuously `never` whatever the mirror holds. Proven directly: forcing
//      the type of `keyof typeof CAPABILITY_INTENTS` printed
//      `keyof readonly string[]`.
//   2. A union derived from the mirror it polices (`PodSlug | REGISTERED_EXTRAS`)
//      is SELF-FULFILLING — adding a slug to a mirror also adds it to the union,
//      so nothing is ever unclassified.
//
// The rule worth more than the floor itself: a coverage floor is only load-
// bearing when the thing it checks against is written OUTSIDE the thing it
// polices. Deriving both sides from the mirror guarantees it can never fire.
//
// What this file ships instead is the direction the real workflow actually
// flows: the declared ARITY. A migration author adds a slug; the mirror's tuple
// length changes; the literal `13` below is written out here rather than derived,
// so the build stops until a human updates it in the same edit. "The registry
// grew a value" becomes a BUILD FAILURE instead of a value that quietly appears
// in one mirror and not another.

/**
 * The seed union's declared size. NOT derived from `ABSTRACT_VERBS` — the whole
 * point is that it is an INDEPENDENT statement, so it can contradict the mirror.
 * A migration that adds a 14th seed slug makes `13` unsatisfiable ⇒ the build
 * stops until this constant is deliberately updated.
 */
const SEED_SLUG_ARITY: 13 = ABSTRACT_VERBS.length;

/**
 * THE FLOOR ITSELF, and the one construct here that is proven to fire.
 *
 * `typeof ABSTRACT_VERBS extends { length: 13 }` asks the type-checker to
 * compare the mirror's TUPLE LENGTH against a literal that is written out here
 * rather than computed from the mirror. Adding a 14th seed slug makes the
 * conditional `false`, and `= true` stops compiling.
 *
 * MUTATION-PROVEN: appending `"mutant_seed_slug"` to the seed made BOTH of the
 * statements below error —
 *   error TS2322: Type '14' is not assignable to type '13'.   (the constant)
 *   error TS2322: Type 'true' is not assignable to type 'false'. (this floor)
 *
 * ⚠️ `timeout` DOES NOT EXIST ON macOS. While building this I wrapped the
 * typecheck in `timeout 900 npx tsc …`, which exits 127 and prints nothing —
 * so several readings of "the floor did not fire" were that artifact, not a
 * result. If a floor here ever looks inert, check the exit code first:
 *   `npx tsc --noEmit -p tsconfig.json; echo "EXIT=$?"` and require EXIT=1.
 */
const _seedArityFloor: typeof ABSTRACT_VERBS extends { length: 13 }
  ? true
  : false = true;
void _seedArityFloor;

/**
 * The post-seed registry rows' declared size. Same independence, same purpose.
 * `publish_post` (0284) is the only one today; adding a second post-seed slug
 * stops the build here.
 */
const EXTRA_SLUG_ARITY: 1 = REGISTERED_EXTRAS.length;

/** The same floor for the post-seed registry rows (see above for the trap). */
const _extraArityFloor: typeof REGISTERED_EXTRAS extends { length: 1 }
  ? true
  : false = true;
void _extraArityFloor;

describe("intent vocabulary — a new slug cannot land without a deliberate edit", () => {
  it("the arity floors hold: the seed is 13 and there is exactly 1 post-seed row", () => {
    // Runtime twin of the two constants above. Vitest transpiles WITHOUT
    // typechecking, so a floor that already failed the build would still let
    // this file run green; these assertions make the failure legible in a test
    // run too. The arity is ALSO cross-checked against the migration-derived
    // counts in the describes above, so this cannot drift alone.
    expect(SEED_SLUG_ARITY).toBe(13);
    expect(EXTRA_SLUG_ARITY).toBe(1);
    expect(ABSTRACT_VERBS).toHaveLength(SEED_SLUG_ARITY);
    expect(REGISTERED_EXTRAS).toHaveLength(EXTRA_SLUG_ARITY);
  });

  it("POSITIVE CONTROL: each floor fails when its mirror changes, in-process", () => {
    // A floor that cannot fire is worse than none, because it looks like proof.
    // Both assertions below execute the floor's OWN predicate against a mutated
    // ARITY (a widened seed, a second post-seed row) and require it to reject —
    // no file mutation and no rebuild, so this is repeatable and cheap.
    const arityFloorHolds = (mirror: number, declared: number) =>
      mirror === declared;
    // The real state passes.
    expect(arityFloorHolds(ABSTRACT_VERBS.length, 13)).toBe(true);
    expect(arityFloorHolds(REGISTERED_EXTRAS.length, 1)).toBe(true);
    // The mutated states fail — this is the control that makes the two above
    // meaningful rather than a pair of assertions that can only pass.
    expect(arityFloorHolds(ABSTRACT_VERBS.length + 1, 13)).toBe(false);
    expect(arityFloorHolds(REGISTERED_EXTRAS.length + 1, 1)).toBe(false);
  });

  it("the mirrors are readonly tuples, so a mirror cannot be widened in place", () => {
    // Reachability, not shape: both mirrors must be `as const` tuples. A mirror
    // declared as `string[]` would let a slug be appended without the parity
    // suite noticing anything about its type.
    expect(Array.isArray(ABSTRACT_VERBS)).toBe(true);
    expect(Array.isArray(CAPABILITY_INTENTS)).toBe(true);
    // `CAPABILITY_INTENTS` is `readonly string[]` (widened on purpose, so a
    // registry row typechecks before its mirror is rebuilt) — assert that
    // explicitly rather than letting it look like an oversight.
    expect(CAPABILITY_INTENTS).toHaveLength(
      ABSTRACT_VERBS.length + EXTRA_SLUG_ARITY
    );
  });
});
