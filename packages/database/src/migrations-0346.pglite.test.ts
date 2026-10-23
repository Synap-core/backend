/**
 * REAL-POSTGRES (PGlite) test for migrations 0346 + 0346b (FB1020 B7, B3).
 *
 * 0346 — `proposals.api_key_id`: runs twice; the column equals the Drizzle
 * schema's; the baseline guards it; the boot coherence list names it,
 * attributed to 0346.
 *
 * 0346b — the `@own-organise` pod default: seeded ONCE, active, the exact
 * shape `readOwnOrganiseDefault` reads (principal any · pod · action · auto);
 * re-running inserts nothing; a pod whose owner switched it OFF (a revoked
 * row) is never switched back on.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { proposals } from "./schema/proposals.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, `../migrations/${f}`), "utf8");
const M0346 = read("0346_proposals_api_key_id.sql");
const M0346B = read("0346b_governance_own_organise_default.sql");
const BASELINE = read("0000_baseline_schema.sql");

const RULES_TABLE = `CREATE TABLE governance_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_kind text NOT NULL, scope_kind text NOT NULL,
  target_kind text NOT NULL, target_pattern text NOT NULL,
  verdict text NOT NULL, created_by text, revoked_at timestamptz
);`;

describe("0346 — proposals.api_key_id", () => {
  it("adds the column (twice is fine) with the schema's type", async () => {
    const db = new PGlite();
    await db.exec(`CREATE TABLE proposals (id uuid PRIMARY KEY);`);
    await db.exec(M0346);
    await db.exec(M0346);
    const { rows } = await db.query<{ data_type: string }>(
      `select data_type from information_schema.columns
       where table_name = 'proposals' and column_name = 'api_key_id'`
    );
    expect(rows).toEqual([{ data_type: "uuid" }]);
    const col = getTableConfig(proposals).columns.find(
      (c) => c.name === "api_key_id"
    );
    expect(col?.getSQLType()).toBe("uuid");
  });

  it("the baseline guards it and boot coherence names it, from 0346", () => {
    expect(BASELINE).toMatch(
      /ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "api_key_id" uuid;/
    );
    expect(
      REQUIRED_COLUMNS.find(
        (r) =>
          typeof r === "object" &&
          r.table === "proposals" &&
          r.column === "api_key_id"
      )
    ).toMatchObject({ addedBy: "0346_proposals_api_key_id.sql" });
  });
});

describe("0346b — the @own-organise pod default", () => {
  const active = (db: PGlite) =>
    db.query<{ n: number }>(
      `select count(*)::int as n from governance_rules
       where principal_kind = 'any' and scope_kind = 'pod'
         and target_kind = 'action' and target_pattern = '@own-organise'
         and verdict = 'auto' and revoked_at is null`
    );

  it("seeds one active row, once", async () => {
    const db = new PGlite();
    await db.exec(RULES_TABLE);
    await db.exec(M0346B);
    await db.exec(M0346B);
    expect((await active(db)).rows[0]!.n).toBe(1);
  });

  it("never switches back on a pod whose owner switched it off", async () => {
    const db = new PGlite();
    await db.exec(RULES_TABLE);
    await db.exec(M0346B);
    await db.exec(
      `update governance_rules set revoked_at = now() where target_pattern = '@own-organise'`
    );
    await db.exec(M0346B);
    expect((await active(db)).rows[0]!.n).toBe(0);
  });
});
