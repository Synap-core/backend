/**
 * PARITY: the intent vocabulary this mirror declares === the pod's seeded rows.
 *
 * WHY THIS TEST EXISTS: `src/capability-intents/index.ts` is a HAND MIRROR of
 * the pod's `capability_intents` table — the pod cannot import it (types
 * devDepends on database), so the two can drift. A hand copy nothing checks is
 * a comment; this is what makes it a mirror.
 *
 * WHAT IT PROVES: SAMENESS — never CORRECTNESS. If both sides agree on a slug
 * that no capability should ever declare, this stays green. The vocabulary's
 * MEANING is the pod's; this test only proves the two lists are the same list.
 *
 * IT RE-DERIVES FROM THE MIGRATION SQL, not from the pod's TypeScript, because
 * the SQL is what actually populates the table — a TypeScript-only check would
 * stay green while the shipped seed and this mirror disagreed.
 *
 * Scoped like the sibling `guideline-vocabulary-parity.test.ts` in
 * `@synap/database`: `package.json` declares no dependency on
 * `synap-backend`, and `tsconfig.json` excludes test files, so this file never
 * enters the types build. It skips cleanly in an isolated checkout where
 * synap-backend is absent.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ABSTRACT_INTENTS,
  REGISTERED_EXTRAS,
  CAPABILITY_INTENTS,
  isKnownIntent,
  unknownIntents,
} from "./index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// src/capability-intents → src → types → packages → synap-backend
const MIGRATIONS_DIR = join(HERE, "../../../../packages/database/migrations");
const MIGRATIONS = [
  join(MIGRATIONS_DIR, "0283_capability_intents.sql"),
  join(MIGRATIONS_DIR, "0284_publish_post_intent.sql"),
  join(MIGRATIONS_DIR, "0314_delegate_agent_task_intent.sql"),
];

/**
 * The slugs the pod actually seeds, read out of the migration INSERTs.
 *
 * Scans ONLY the `INSERT INTO "capability_intents"` VALUES list: matching the
 * whole file would pick up the CHECK constraint's `IN ('read','write','act')`
 * and inject a phantom `read` intent no seed may ever declare.
 */
function deriveSeededIntents(): Set<string> {
  const slugs = new Set<string>();
  for (const migration of MIGRATIONS) {
    const sql = readFileSync(migration, "utf8");
    const insert = sql.slice(sql.indexOf('INSERT INTO "capability_intents"'));
    // The anchor must exist — a renamed table would otherwise yield zero slugs
    // and compare an empty set against a full list, which happens to pass for
    // the wrong reason only if the list were empty too.
    expect(
      insert.length,
      `no capability_intents INSERT in ${migration}`
    ).toBeGreaterThan(0);
    for (const m of insert.matchAll(
      /\(\s*'([a-z][a-z0-9_]*)'\s*,\s*'(?:read|write|act)'\s*,/g
    )) {
      slugs.add(m[1]);
    }
  }
  return slugs;
}

const haveMigrations = MIGRATIONS.every((m) => existsSync(m));

describe("intent vocabulary parity — mirror === the pod's seeded intents", () => {
  it("non-vacuity: the vocabulary is a real, non-trivial closed set", () => {
    expect(CAPABILITY_INTENTS.length).toBeGreaterThanOrEqual(13);
    expect(CAPABILITY_INTENTS.length).toBe(new Set(CAPABILITY_INTENTS).size);
    expect(CAPABILITY_INTENTS).toContain("generate_media");
    expect(CAPABILITY_INTENTS).toContain("capture_into_pod");
    // isKnownIntent must reject, not merely accept — a test that only ever
    // asserts membership passes on an all-true implementation.
    expect(isKnownIntent("generate_media")).toBe(true);
    expect(isKnownIntent("definitely_not_an_intent")).toBe(false);
    expect(isKnownIntent(undefined)).toBe(false);
    expect(isKnownIntent(42)).toBe(false);
  });

  it("unknownIntents reports the offenders and nothing else", () => {
    expect(
      unknownIntents(["generate_media", "nope", "manage_file", "nope"])
    ).toEqual(["nope"]);
    expect(unknownIntents(CAPABILITY_INTENTS)).toEqual([]);
    expect(unknownIntents([])).toEqual([]);
  });

  it.skipIf(!haveMigrations)(
    "the mirrored vocabulary matches the pod's seeded intents",
    () => {
      const seeded = deriveSeededIntents();
      // Non-vacuity: we actually recovered slugs from the SQL.
      expect(seeded.size).toBeGreaterThanOrEqual(13);

      expect([...CAPABILITY_INTENTS].sort()).toEqual([...seeded].sort());
    }
  );

  it.skipIf(!haveMigrations)(
    "the seed union and the post-seed extras stay honestly distinguished",
    () => {
      const seeded = deriveSeededIntents();
      // If a slug is added to the union but not to one of these two lists,
      // these fail — which is the point of keeping them separate.
      expect(ABSTRACT_INTENTS.length).toBe(
        seeded.size - REGISTERED_EXTRAS.length
      );
      expect(ABSTRACT_INTENTS.length).toBe(13);
      // Every extra is genuinely a post-seed row, not a re-statement of a seed.
      for (const extra of REGISTERED_EXTRAS) {
        expect(ABSTRACT_INTENTS).not.toContain(extra);
      }
    }
  );
});
