/**
 * REAL-POSTGRES (PGlite) test for migration 0319 — the lifecycle columns:
 *  - idempotent (applied twice);
 *  - the CHECK refuses a category outside the fixed five;
 *  - the partial unique index makes "one lifecycle per profile" a DB fact;
 *  - the drizzle schema declares exactly the columns the migration adds, and
 *    the fresh-DB baseline carries the same DDL.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { entities } from "./schema/entities.js";
import { entityFacets } from "./schema/entity-facets.js";
import { profileProperties } from "./schema/profile-properties.js";

const MIGRATIONS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations"
);
const MIGRATION = readFileSync(
  resolve(MIGRATIONS, "0319_lifecycle_columns.sql"),
  "utf8"
);
const BASELINE = readFileSync(
  resolve(MIGRATIONS, "0000_baseline_schema.sql"),
  "utf8"
);

const P1 = "a0000000-0000-4000-8000-000000000001";
const D1 = "b0000000-0000-4000-8000-000000000001";
const D2 = "b0000000-0000-4000-8000-000000000002";

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE entities (id uuid PRIMARY KEY, profile_id uuid, properties jsonb NOT NULL DEFAULT '{}', deleted_at timestamptz);
    CREATE TABLE entity_facets (id uuid PRIMARY KEY, profile_id uuid NOT NULL, status text, deleted_at timestamptz);
    CREATE TABLE profile_properties (profile_id uuid NOT NULL, property_def_id uuid NOT NULL, PRIMARY KEY (profile_id, property_def_id));
  `);
  await pg.exec(MIGRATION);
  await pg.exec(MIGRATION); // idempotent
});

describe("0319 lifecycle columns", () => {
  it("adds the columns, and the CHECK refuses an unknown category", async () => {
    await pg.query(
      `INSERT INTO entities (id, status, status_category) VALUES (gen_random_uuid(), 'won', 'done')`
    );
    await expect(
      pg.query(
        `INSERT INTO entities (id, status, status_category) VALUES (gen_random_uuid(), 'x', 'closed')`
      )
    ).rejects.toThrow(/status_category_check/);
    await expect(
      pg.query(
        `INSERT INTO entity_facets (id, profile_id, status, status_category) VALUES (gen_random_uuid(), '${P1}', 'x', 'archived')`
      )
    ).rejects.toThrow(/status_category_check/);
  });

  it("refuses a second lifecycle on one profile", async () => {
    await pg.query(
      `INSERT INTO profile_properties (profile_id, property_def_id, is_lifecycle) VALUES ('${P1}', '${D1}', true)`
    );
    await expect(
      pg.query(
        `INSERT INTO profile_properties (profile_id, property_def_id, is_lifecycle) VALUES ('${P1}', '${D2}', true)`
      )
    ).rejects.toThrow(/one_lifecycle/);
    // a non-lifecycle link on the same profile is fine
    await pg.query(
      `INSERT INTO profile_properties (profile_id, property_def_id) VALUES ('${P1}', '${D2}')`
    );
  });

  it("drizzle and the baseline declare what the migration adds", () => {
    const cols = (t: Parameters<typeof getTableConfig>[0]) =>
      getTableConfig(t).columns.map((c) => c.name);
    expect(cols(entities)).toEqual(
      expect.arrayContaining(["status", "status_category"])
    );
    expect(cols(entityFacets)).toContain("status_category");
    expect(cols(profileProperties)).toContain("is_lifecycle");
    for (const ddl of [
      `ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "status_category" text;`,
      `ALTER TABLE "entity_facets" ADD COLUMN IF NOT EXISTS "status_category" text;`,
      `"profile_properties_one_lifecycle_uniq"`,
      `"entities_profile_status_category_idx"`,
    ]) {
      expect(BASELINE).toContain(ddl);
      expect(MIGRATION).toContain(ddl);
    }
  });
});
