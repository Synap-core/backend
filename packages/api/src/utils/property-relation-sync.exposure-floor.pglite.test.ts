/**
 * The property → relation forward sync must never mint (or drop) an EXPOSURE
 * edge.
 *
 * THE GAP THIS CLOSES (pod cleanup 2026-09-28): `update_entity
 * properties.projectId=<project>` reached `syncPropertyToRelations`, whose skip
 * named only `visible_to`. A property def mapped to the `belongs_to_project`
 * relation def therefore FILED the record into the project — exposing it to
 * every project member — without `linkEntityToProject`'s existence/visibility
 * checks and without the governed filing door. That contradicted the
 * relations router's contract ("EVERY member of EXPOSURE_RELATION_TYPES is
 * rejected by the generic doors").
 *
 * Driven on PGlite through the REAL function. The set under test is DERIVED
 * from `EXPOSURE_RELATION_TYPES` (a new exposure type joins by existing), and a
 * POSITIVE CONTROL (`related_to`) proves the sync still writes ordinary edges —
 * without it, a broken insert (the sync swallows insert errors) would make every
 * "no edge" assertion pass vacuously.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const d = drizzle(client, { schema });
  return { ...actual, db: d, getDb: async () => d };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { syncPropertyToRelations } from "./property-relation-sync.js";
import { EXPOSURE_RELATION_TYPES } from "./project-scope.js";

const USER = randomUUID();
const PROFILE = randomUUID();
const ENTITY = randomUUID();
const TARGET = randomUUID();
const CONTROL_TYPE = "related_to";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? type === "uuid"
        ? " primary key default gen_random_uuid()"
        : " primary key"
      : "";
    return `"${c.name}" ${type}${pk}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/** property slug per relation type — one entity_id def mapped to each. */
const slugFor = (type: string) => `prop_${type}`;
const TYPES = [...EXPOSURE_RELATION_TYPES, CONTROL_TYPE];

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  for (const type of TYPES) {
    const relDefId = randomUUID();
    await q(
      `insert into relation_defs (id, slug, display_name, user_id) values ($1,$2,$2,$3)`,
      [relDefId, type, USER]
    );
    await q(
      `insert into property_defs (id, slug, profile_id, value_type, relation_def_id)
       values ($1,$2,$3,'entity_id',$4)`,
      [randomUUID(), slugFor(type), PROFILE, relDefId]
    );
  }
});

const edges = async (type: string) =>
  (
    await q<{ n: number }>(
      `select count(*)::int as n from relations where source_entity_id = $1 and target_entity_id = $2 and type = $3`,
      [ENTITY, TARGET, type]
    )
  ).rows[0]!.n;

describe("syncPropertyToRelations — exposure floor", () => {
  it("the scanned set is the real exposure whitelist (non-vacuity)", () => {
    expect(EXPOSURE_RELATION_TYPES).toContain("belongs_to_project");
    expect(EXPOSURE_RELATION_TYPES).toContain("visible_to");
  });

  it("a property write mints NO exposure edge, while an ordinary edge still syncs", async () => {
    const newProps = Object.fromEntries(TYPES.map((t) => [slugFor(t), TARGET]));
    await syncPropertyToRelations(ENTITY, PROFILE, null, USER, {}, newProps);

    // Positive control: the sync is alive and CAN write an edge.
    expect(await edges(CONTROL_TYPE)).toBe(1);
    for (const type of EXPOSURE_RELATION_TYPES) {
      expect(await edges(type), `${type} was minted by a property`).toBe(0);
    }
  });

  it("clearing the property never DROPS an existing exposure edge either", async () => {
    for (const type of EXPOSURE_RELATION_TYPES) {
      await q(
        `insert into relations (id, user_id, source_entity_id, target_entity_id, type)
         values ($1,$2,$3,$4,$5)`,
        [randomUUID(), USER, ENTITY, TARGET, type]
      );
    }
    const oldProps = Object.fromEntries(TYPES.map((t) => [slugFor(t), TARGET]));
    await syncPropertyToRelations(ENTITY, PROFILE, null, USER, oldProps, {});

    expect(await edges(CONTROL_TYPE)).toBe(0); // control: the drop half runs
    for (const type of EXPOSURE_RELATION_TYPES) {
      expect(await edges(type), `${type} was dropped by a property`).toBe(1);
    }
  });
});
