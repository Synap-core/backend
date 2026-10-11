/**
 * Tripwire — `device_auth_requests` stores NO secret in clear
 * (MACHINE-IDENTITY-PLAN W2; the `mcp_connect_codes` rule). The device code is
 * the terminal's poll secret and the user code is what binds an approval to a
 * terminal: both may live here only as hashes, and no key is ever stored (keys
 * are minted at collection and returned once).
 *
 * DERIVED: every column of the drizzle table AND of migration 0321 is read; a
 * column whose name speaks of a code, token, secret, password or key must be a
 * `*_hash` or be classified below with its reason. A new column joins the scan
 * by existing. DOES NOT SEE: a secret written into a column with an innocent
 * name (e.g. `user_agent`) — the service test asserts no row carries the codes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/pg-core";
import { deviceAuthRequests } from "./device-auth-requests.js";

const SECRETISH = /code|token|secret|password|key|credential/i;
/** Secret-sounding but not a secret — each with why. */
const CLASSIFIED: Record<string, string> = {
  minted_key_id: "the id of the computer's api_keys row — the key is hashed there",
  failed_code_attempts: "a counter",
};

const MIGRATION = readFileSync(
  fileURLToPath(new URL("../../migrations/0321_device_auth_requests.sql", import.meta.url)),
  "utf8"
);
const migrationColumns = [
  ...MIGRATION.matchAll(/^\s+"([a-z_]+)"\s+(?:uuid|text|integer|timestamptz)/gm),
].map((m) => m[1]!);

const offenders = (cols: string[]) =>
  cols.filter(
    (c) => SECRETISH.test(c) && !c.endsWith("_hash") && !(c in CLASSIFIED)
  );

describe("device_auth_requests holds no plaintext secret", () => {
  const schemaColumns = getTableConfig(deviceAuthRequests).columns.map(
    (c) => c.name
  );

  it("non-vacuous: both scans see the hashed codes", () => {
    expect(schemaColumns).toContain("device_code_hash");
    expect(schemaColumns).toContain("user_code_hash");
    expect(migrationColumns).toContain("device_code_hash");
    expect(migrationColumns.length).toBeGreaterThanOrEqual(20);
    expect(offenders(["device_code"])).toEqual(["device_code"]);
  });

  it("schema: every secret-sounding column is a hash or classified", () => {
    expect(offenders(schemaColumns)).toEqual([]);
  });

  it("migration: same rule on what the database actually gets", () => {
    expect(offenders(migrationColumns)).toEqual([]);
  });

  it("the drizzle table and the migration declare the same columns", () => {
    expect([...schemaColumns].sort()).toEqual([...new Set(migrationColumns)].sort());
  });
});
