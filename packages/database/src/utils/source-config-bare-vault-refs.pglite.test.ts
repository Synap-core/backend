/**
 * REAL-POSTGRES (PGlite) test for migration 0264: suffixed `vault://<uuid>/value`
 * references to admin-provisioned inline secrets become bare `vault://<uuid>`.
 *
 * Applies the real migration file twice and asserts the rewrite reaches exactly
 * the rows it names — and nothing else.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { PGlite } from "@electric-sql/pglite";
import { parseVaultReference } from "./vault-resolver.js";

const MIGRATION = readFileSync(
  join(__dirname, "../../migrations/0264_source_config_bare_vault_refs.sql"),
  "utf8"
);

const ADMIN_SECRET = "11111111-1111-1111-1111-111111111111";
const NESTED_SECRET = "22222222-2222-2222-2222-222222222222";
const OTHER_SERVICE_SECRET = "33333333-3333-3333-3333-333333333333";
const FOREIGN_USER_SECRET = "44444444-4444-4444-4444-444444444444";

let pg: PGlite;

async function config(id: string): Promise<Record<string, unknown>> {
  const { rows } = await pg.query<{ config: Record<string, unknown> }>(
    `SELECT config FROM source_configs WHERE id = $1`,
    [id]
  );
  return rows[0]!.config;
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE secrets (id uuid PRIMARY KEY, user_id text NOT NULL, service_id text);
    CREATE TABLE source_configs (id text PRIMARY KEY, user_id text NOT NULL, config jsonb NOT NULL);
  `);
  await pg.query(
    `INSERT INTO secrets (id, user_id, service_id) VALUES
      ($1, 'owner', 'source:admin-provisioned'),
      ($2, 'owner', 'source:admin-provisioned'),
      ($3, 'owner', 'nango-connector'),
      ($4, 'someone-else', 'source:admin-provisioned')`,
    [ADMIN_SECRET, NESTED_SECRET, OTHER_SERVICE_SECRET, FOREIGN_USER_SECRET]
  );
  const rows: Array<[string, unknown]> = [
    [
      "relay",
      { relayUrl: "https://cp", relayKey: `vault://${ADMIN_SECRET}/value` },
    ],
    [
      "nested",
      { headers: { Authorization: `vault://${NESTED_SECRET}/value` } },
    ],
    ["other-service", { apiKey: `vault://${OTHER_SERVICE_SECRET}/value` }],
    ["foreign-user", { apiKey: `vault://${FOREIGN_USER_SECRET}/value` }],
    ["other-field", { apiKey: `vault://${ADMIN_SECRET}/token` }],
    ["already-bare", { relayKey: `vault://${ADMIN_SECRET}` }],
  ];
  for (const [id, cfg] of rows) {
    await pg.query(
      `INSERT INTO source_configs (id, user_id, config) VALUES ($1, 'owner', $2::jsonb)`,
      [id, JSON.stringify(cfg)]
    );
  }
  // Applied twice: the second pass must find nothing left to do.
  await pg.exec(MIGRATION);
  await pg.exec(MIGRATION);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

describe("migration 0264: bare vault refs for admin-provisioned secrets", () => {
  it("rewrites a relay key reference to the bare form the resolver reads as the raw value", async () => {
    const cfg = await config("relay");
    expect(cfg).toEqual({
      relayUrl: "https://cp",
      relayKey: `vault://${ADMIN_SECRET}`,
    });
    expect(parseVaultReference(cfg.relayKey as string)).toEqual({
      secretId: ADMIN_SECRET,
      fieldName: undefined,
    });
  });

  it("rewrites a reference at any depth", async () => {
    expect(await config("nested")).toEqual({
      headers: { Authorization: `vault://${NESTED_SECRET}` },
    });
  });

  it("leaves references to other services, other users' secrets and other fields untouched", async () => {
    expect(await config("other-service")).toEqual({
      apiKey: `vault://${OTHER_SERVICE_SECRET}/value`,
    });
    expect(await config("foreign-user")).toEqual({
      apiKey: `vault://${FOREIGN_USER_SECRET}/value`,
    });
    expect(await config("other-field")).toEqual({
      apiKey: `vault://${ADMIN_SECRET}/token`,
    });
    expect(await config("already-bare")).toEqual({
      relayKey: `vault://${ADMIN_SECRET}`,
    });
  });
});
