/**
 * Tripwire — `key_requests` stores NO secret in clear (keys plan Decision 4;
 * the device-door rule, `device-auth-requests.no-plaintext.tripwire.test.ts`).
 * The request code is the CLI's poll secret: it may live here only as a hash,
 * and no key is ever stored (it is minted at collection and returned once).
 *
 * DERIVED: every column of the drizzle table AND of migration 0363 is read; a
 * column whose name speaks of a code, token, secret, password or key must be a
 * `*_hash` or be classified below with its reason. A new column joins the scan
 * by existing. DOES NOT SEE: a secret written into a column with an innocent
 * name, or into `approved_draft` (jsonb) — the service test asserts no row
 * carries the request code or the minted key.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/pg-core";
import { keyRequests } from "./key-requests.js";

const SECRETISH = /code|token|secret|password|key|credential/i;
/** Secret-sounding but not a secret — each with why. */
const CLASSIFIED: Record<string, string> = {
  minted_key_id: "the id of the minted api_keys row — the key is hashed there",
  requester_key_id:
    "the id of the api_keys row the request was made with — hashed there",
};

const MIGRATION = readFileSync(
  fileURLToPath(
    new URL(
      "../../migrations/0363_key_requests_and_role_uses.sql",
      import.meta.url
    )
  ),
  "utf8"
);
const tableDdl =
  /CREATE TABLE IF NOT EXISTS "key_requests" \(([\s\S]*?)\n\);/.exec(
    MIGRATION
  )?.[1] ?? "";
const migrationColumns = [
  ...tableDdl.matchAll(
    /^\s+"([a-z_]+)"\s+(?:uuid|text|integer|timestamptz|boolean|jsonb)/gm
  ),
].map((m) => m[1]!);

const offenders = (cols: string[]) =>
  cols.filter(
    (c) => SECRETISH.test(c) && !c.endsWith("_hash") && !(c in CLASSIFIED)
  );

describe("key_requests holds no plaintext secret", () => {
  const schemaColumns = getTableConfig(keyRequests).columns.map((c) => c.name);

  it("non-vacuous: both scans see the hashed code and every column", () => {
    expect(schemaColumns).toContain("request_code_hash");
    expect(migrationColumns).toContain("request_code_hash");
    expect(migrationColumns.length).toBeGreaterThanOrEqual(20);
    expect(offenders(["request_code", "api_key"])).toEqual([
      "request_code",
      "api_key",
    ]);
  });

  it("schema: every secret-sounding column is a hash or classified", () => {
    expect(offenders(schemaColumns)).toEqual([]);
  });

  it("migration: same rule on what the database actually gets", () => {
    expect(offenders(migrationColumns)).toEqual([]);
  });

  it("the drizzle table and the migration declare the same columns", () => {
    expect([...schemaColumns].sort()).toEqual(
      [...new Set(migrationColumns)].sort()
    );
  });

  it("every classified column exists (no stale reason)", () => {
    for (const c of Object.keys(CLASSIFIED))
      expect(schemaColumns, c).toContain(c);
  });
});
