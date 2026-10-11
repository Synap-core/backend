/**
 * Test harness: a PGlite database holding the tables the lifecycle doors touch,
 * built FROM the drizzle schema (so a declared column is always present) plus
 * the 0319 migration (its CHECKs and the one-lifecycle unique index).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../../schema/index.js";

const MIGRATION_0319 = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../migrations/0319_lifecycle_columns.sql"
  ),
  "utf8"
);

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    const type = c.getSQLType();
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (Array.isArray(d)) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d)}'`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    const nn = c.notNull && !c.primary ? " not null" : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${nn}${def}`;
  });
  const pk = cfg.primaryKeys[0];
  if (pk)
    columns.push(
      `primary key (${pk.columns.map((c) => `"${c.name}"`).join(", ")})`
    );
  return `create table if not exists "${cfg.name}" (${columns.join(", ")});`;
}

export async function makeLifecyclePglite() {
  const pg = new PGlite();
  for (const t of [
    schema.profiles,
    schema.propertyDefs,
    schema.profileProperties,
    schema.entities,
    schema.entityFacets,
  ]) {
    await pg.exec(ddlFor(t as unknown as PgTable));
  }
  await pg.exec(MIGRATION_0319);
  const db = drizzle(pg, { schema });
  return { pg, db };
}
