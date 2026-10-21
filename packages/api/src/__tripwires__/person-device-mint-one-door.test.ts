/**
 * TRIPWIRE — a Synap app's device ACCESS token has ONE mint site.
 *
 * WHY: a row in `person_device_tokens` IS the person on the app API: the
 * session gate (`middleware/app-session.ts`) and realtime resolve it into the
 * same identity a Kratos session gives, with no grant and no governance in
 * between (join plan target A; threat M2, services/person-device-token.ts). If
 * a second door could insert one — a convenience "mint a token for this user",
 * a test helper promoted to src, a raw SQL insert — anyone reaching that door
 * would become any person on `/trpc`. The ONE door makes it only from a
 * first-party authorization code or a refresh of the device's own family.
 *
 * HOW (derived): walk `packages/*\/src` and `apps/*\/src` (tests, dist,
 * node_modules skipped; comments blanked) and find every file that
 *  1. writes the table through Drizzle: `.insert(personDeviceTokens)`;
 *  2. names the table in SQL text: `person_device_tokens` next to INSERT.
 * Exactly one file may do (1), `services/person-device-token.ts`; none may do
 * (2) (the migrations and baseline are `.sql`, outside the scan).
 *
 * NON-VACUITY: the scan sees > 300 files and sees the one mint site; both
 * patterns match a literal sample of what they hunt.
 *
 * WHAT IT DOES NOT SEE (stated): an insert through an aliased table binding
 * (`const t = personDeviceTokens; db.insert(t)`) or SQL assembled from parts.
 * Granularity is the file.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const SKIP = new Set(["node_modules", "dist", "__tests__", "__tripwires__"]);
const MINT_SITE = "packages/api/src/services/person-device-token.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Every `src` tree under packages/* and apps/*, found, not listed. */
function sourceRoots(): string[] {
  const roots: string[] = [];
  for (const group of ["packages", "apps"]) {
    for (const name of readdirSync(join(REPO, group))) {
      const src = join(REPO, group, name, "src");
      try {
        if (statSync(src).isDirectory()) roots.push(src);
      } catch {
        // a package without src (config-only) has nothing to scan
      }
    }
  }
  return roots;
}

const DRIZZLE_INSERT = /\.insert\(\s*personDeviceTokens\s*\)/;
const SQL_INSERT = /insert\s+into\s+["']?person_device_tokens/i;

const drizzleWriters = new Set<string>();
const sqlWriters = new Set<string>();
let scanned = 0;
for (const root of sourceRoots()) {
  for (const file of walk(root)) {
    scanned++;
    const code = stripComments(readFileSync(file, "utf8"), "ts") as string;
    const rel = relative(REPO, file);
    if (DRIZZLE_INSERT.test(code)) drizzleWriters.add(rel);
    if (SQL_INSERT.test(code)) sqlWriters.add(rel);
  }
}

describe("a device access token has one mint site", () => {
  it("scans real code and recognises what it hunts (non-vacuity)", () => {
    expect(scanned).toBeGreaterThan(300);
    expect(
      DRIZZLE_INSERT.test(`await db.insert(personDeviceTokens).values(`)
    ).toBe(true);
    expect(
      SQL_INSERT.test(`INSERT INTO "person_device_tokens" (token_hash)`)
    ).toBe(true);
    expect(drizzleWriters.has(MINT_SITE)).toBe(true);
  });

  it("only the device mint door inserts one", () => {
    expect([...drizzleWriters].sort()).toEqual([MINT_SITE]);
  });

  it("no source inserts one in SQL text", () => {
    expect([...sqlWriters]).toEqual([]);
  });
});
