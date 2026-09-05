import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — the `file` profile may not REQUIRE a property no file-creation
 * door writes.
 *
 * THE BUG THIS EXISTS FOR (a live production 500, errorId 59b87ca6):
 * `synap upload` → `POST /api/hub/files` → 500,
 *   "Property validation failed … property_0: Property 'storageKey' is required"
 *
 * The now-deleted `packages/database/src/scripts/seed-profiles.ts` had linked
 * `file.storageKey` as REQUIRED. The document/entity consolidation then made the
 * opposite call — canonical `file` entities keep storage pointers on the
 * `documents` row + `entities.documentId` and NEVER in properties (stated at
 * `routers/file-upload.ts`, `isCanonicalFile`) — and the seeder stopped
 * declaring the slug. But `ensureSystemProfiles`'s link pass is ADDITIVE ONLY:
 * deleting the declaration un-wrote nothing, so every pod seeded while the old
 * file existed still carries a required `storageKey` that no door writes, and
 * every file-entity create there fails. Verified live: the pod's `file` profile
 * returns 8 base props (incl. `storageKey` required) against the seed's 4.
 *
 * Note the shape: this was NEVER a door-parity defect. BOTH doors agree, and
 * both are correct — `createGovernedFileEntityFromBuffer` writes
 * `{mimeType, fileSize}`, and `uploadBufferAsFileEntity` forces
 * `storagePointerProperties = {}` for the canonical slug. The SCHEMA drifted
 * away from the doors. "Make a door write storageKey" would have re-introduced
 * the duplication the consolidation deliberately removed — and would still have
 * left every other file-creation door broken.
 *
 * THE INVARIANT, in two halves:
 *
 *  (A) Every `required: true` slug the seed declares on `file` must be a
 *      property the governed door provably writes. The permitted set is DERIVED
 *      by parsing the door's own `properties: {...}` literal — never
 *      hand-copied here — so the two can't drift apart silently. Marking a seed
 *      property required without teaching the door to write it fails this.
 *
 *  (B) The retirement that unlinks the fossil on already-seeded pods must still
 *      exist AND still be consumed. A `RETIRED_PROFILE_PROPERTIES` entry that
 *      nothing reads is a fix that never runs, so this asserts the CALL form —
 *      the loop over the table reaching `profilePropertyRepo.unlink(` — not a
 *      bare mention of the constant.
 *
 * Both halves fail loudly if their source parse finds nothing, so this can never
 * pass vacuously by silently matching an empty set.
 */

const DB_SRC = join(process.cwd(), "..", "database", "src");
const SEED_PATH = join(DB_SRC, "utils", "ensure-system-profiles.ts");
const GOVERNED_DOOR_PATH = join(
  process.cwd(),
  "src",
  "routers",
  "create-governed-file-entity.ts"
);

/**
 * `title` is an ENTITY COLUMN, not a bag key: every file door passes it as
 * `title:` and `PropertyValidationService` merges it in before validating
 * (see ENTITY_COLUMN_KEYS). So a required `title` def IS satisfied by the doors
 * even though it never appears in a `properties` literal.
 */
const ENTITY_COLUMN_KEYS = ["title"];

/** Keys the governed door writes into `properties: { … }`. */
function doorSuppliedProperties(): string[] {
  const src = readFileSync(GOVERNED_DOOR_PATH, "utf8");
  const call =
    /profileSlug:\s*"file",[\s\S]{0,600}?properties:\s*\{([^{}]*)\}/.exec(src);
  if (!call) {
    throw new Error(
      `Could not parse the \`properties: { … }\` literal out of the governed ` +
        `file door (${GOVERNED_DOOR_PATH}). This tripwire derives its permitted ` +
        `required-set from that literal; if the door was restructured, update ` +
        `the parse here — do NOT hand-maintain the key list.`
    );
  }
  const keys = call[1]
    .split(",")
    .map((part) => part.split(":")[0].trim())
    .filter((k) => /^[A-Za-z_$][\w$]*$/.test(k));
  if (keys.length === 0) {
    throw new Error(
      "Parsed the governed door's properties literal but found no keys — " +
        "refusing to pass vacuously."
    );
  }
  return keys;
}

/** `{ slug, required }` for every property the seed links to `file`. */
function seededFileProperties(): Array<{ slug: string; required: boolean }> {
  const src = readFileSync(SEED_PATH, "utf8");
  const block = /profileSlug:\s*"file",\s*propertySlugs:\s*\[([\s\S]*?)\]/.exec(
    src
  );
  if (!block) {
    throw new Error(
      `Could not find the \`file\` profile's propertySlugs block in ${SEED_PATH}.`
    );
  }
  const entries = [
    ...block[1].matchAll(/\{\s*slug:\s*"([^"]+)"([^}]*)\}/g),
  ].map((m) => ({ slug: m[1], required: /required:\s*true/.test(m[2]) }));
  if (entries.length === 0) {
    throw new Error(
      "Parsed the `file` propertySlugs block but found no entries — " +
        "refusing to pass vacuously."
    );
  }
  return entries;
}

describe("tripwire: file profile requires nothing the file doors omit", () => {
  it("every required property on the seeded `file` profile is written by the governed door", () => {
    const supplied = new Set([
      ...doorSuppliedProperties(),
      ...ENTITY_COLUMN_KEYS,
    ]);
    const unmet = seededFileProperties()
      .filter((p) => p.required && !supplied.has(p.slug))
      .map((p) => p.slug);

    // If this fails: EITHER the door must write the property, OR the property
    // must not be required. Do not "fix" it by adding the key to a list here.
    expect(unmet).toEqual([]);
  });

  it("`storageKey` is not re-declared on the `file` profile", () => {
    // The consolidation's standing decision: storage pointers live on the
    // `documents` row + `entities.documentId`, never as entity properties.
    expect(seededFileProperties().map((p) => p.slug)).not.toContain(
      "storageKey"
    );
  });

  it("the fossil `file.storageKey` link is retired on already-seeded pods", () => {
    const src = readFileSync(SEED_PATH, "utf8");

    const entry =
      /\{[^{}]*profileSlug:\s*"file"[^{}]*propertySlug:\s*"storageKey"[\s\S]{0,800}?\}/.exec(
        src
      );
    expect(
      entry,
      "RETIRED_PROFILE_PROPERTIES must keep the { profileSlug: 'file', " +
        "propertySlug: 'storageKey' } entry — without it, pods seeded by the " +
        "old seeder keep a required `storageKey` and every file upload 500s."
    ).not.toBeNull();

    // The table must be CONSUMED, not merely declared. Assert the call form:
    // a loop over RETIRED_PROFILE_PROPERTIES that reaches `.unlink(`.
    const consumer =
      /for\s*\(\s*const\s+\w+\s+of\s+RETIRED_PROFILE_PROPERTIES\s*\)([\s\S]{0,1200}?)profilePropertyRepo\.unlink\(/.exec(
        src
      );
    expect(
      consumer,
      "RETIRED_PROFILE_PROPERTIES is declared but no loop over it calls " +
        "`profilePropertyRepo.unlink(` — the retirement never runs, so the " +
        "fossil link survives on every already-seeded pod."
    ).not.toBeNull();
  });
});
