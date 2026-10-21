/**
 * TRIPWIRE — the `app_person` key type has ONE mint site.
 *
 * WHY: `api_keys.key_type = 'app_person'` is the ONE marker that makes
 * `resolveKeyIdentity` treat a person-held key naming an app as the PERSON
 * ("Sign in with Synap", founder A1 2026-10-20) instead of adopting it onto
 * the app's agent (the 0313 rule). If any other door could write that type —
 * a mint that reads `keyType` from its caller, or a second literal — a person
 * could hand-make a key that names an app and acts as them, ungoverned by the
 * app's agent ladder: the 0313 hole reopened (threat T3,
 * services/app-person-token.ts).
 *
 * HOW (derived): walk `packages/api/src`, `apps/api/src`,
 * `packages/database/src` (tests skipped, comments blanked):
 *  1. the LITERAL `app_person` appears only where the constant is defined
 *     (`schema/api-keys.ts`: the constant and the column's type union);
 *  2. the constant is used AS A KEY TYPE TO WRITE (`keyType: APP_PERSON_KEY_TYPE`)
 *     only in the one mint site, `services/app-person-token.ts`;
 *  3. no code copies a REQUEST's key type into a key (`keyType: input.keyType`
 *     / `body.keyType` / `data.keyType`) — the shape a mint door reading its
 *     caller's choice takes.
 *
 * WHAT IT DOES NOT SEE (stated): a key type assembled from a variable outside
 * those spellings (`args.actorKeyType` / `params.keyType` pass the CALLER's
 * own key type to a check, not into a key, and are deliberately not matched),
 * or a raw SQL `UPDATE api_keys SET key_type` built from parts. Granularity is
 * the file.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const ROOTS = ["packages/api/src", "apps/api/src", "packages/database/src"].map(
  (r) => join(REPO, r)
);
const SKIP = new Set(["node_modules", "dist", "__tests__", "__tripwires__"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const LITERAL = /["'`]app_person["'`]/;
const WRITES_TYPE = /\bkeyType:\s*APP_PERSON_KEY_TYPE\b/;
const CALLER_TYPE = /\bkeyType:\s*(?:input|body|data)\.keyType\b/;

/**
 * The repository PRIMITIVE passes its caller's `data.keyType` through; every
 * caller of it is a mint site (api-key-mint-sites) and names a literal.
 */
const PASSTHROUGH = new Set([
  "packages/database/src/repositories/api-key-repository.ts",
]);

const literalFiles = new Set<string>();
const writerFiles = new Set<string>();
const callerTyped: string[] = [];
let scanned = 0;
for (const root of ROOTS) {
  for (const file of walk(root)) {
    scanned++;
    const code = stripComments(readFileSync(file, "utf8"), "ts");
    const rel = relative(REPO, file);
    if (LITERAL.test(code)) literalFiles.add(rel);
    if (WRITES_TYPE.test(code)) writerFiles.add(rel);
    if (!PASSTHROUGH.has(rel))
      for (const line of code.split("\n"))
        if (CALLER_TYPE.test(line)) callerTyped.push(`${rel}: ${line.trim()}`);
  }
}

describe("the app_person key type has one mint site", () => {
  it("scans real code and recognises what it hunts (non-vacuity)", () => {
    expect(scanned).toBeGreaterThan(200);
    expect(LITERAL.test(`keyType: "app_person"`)).toBe(true);
    expect(WRITES_TYPE.test(`{ keyType: APP_PERSON_KEY_TYPE, `)).toBe(true);
    expect(CALLER_TYPE.test(`keyType: input.keyType,`)).toBe(true);
    // The definition and the one writer are SEEN — the scan is not blind.
    expect(literalFiles.has("packages/database/src/schema/api-keys.ts")).toBe(
      true
    );
    expect(
      writerFiles.has("packages/api/src/services/app-person-token.ts")
    ).toBe(true);
    // The pass-through is still there — a stale exemption would hide nothing.
    for (const rel of PASSTHROUGH)
      expect(
        CALLER_TYPE.test(
          stripComments(readFileSync(join(REPO, rel), "utf8"), "ts")
        )
      ).toBe(true);
  });

  it("the literal lives only in the schema", () => {
    expect([...literalFiles].sort()).toEqual([
      "packages/database/src/schema/api-keys.ts",
    ]);
  });

  it("only the sign-in mint door writes the type", () => {
    expect([...writerFiles].sort()).toEqual([
      "packages/api/src/services/app-person-token.ts",
    ]);
  });

  it("no mint takes its key type from the caller", () => {
    expect(callerTyped).toEqual([]);
  });
});
