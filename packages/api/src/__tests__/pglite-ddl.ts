/**
 * PGlite DDL DERIVED from the real Drizzle schema — for tests that stand up a
 * few tables in a WASM Postgres.
 *
 * Why: a hand-written `create table documents (…)` in a test file is a second
 * copy of the schema that falls behind silently. W4a added
 * `documents.content_revision`; every test with a hand-typed `documents` table
 * then failed at insert ("column does not exist"), because Drizzle names every
 * column in an INSERT (`default` for the ones not given). Deriving the DDL from
 * `getTableConfig` means a new column joins the fixture by existing.
 *
 * Kept deliberately small: every column, its primary key, and simple defaults
 * (numbers, booleans, strings, `gen_random_uuid()` for uuid, `now()` for
 * timestamps, `'{}'` for jsonb). Enums and other non-basic types map to `text`.
 * NOT emitted: NOT NULL, foreign keys, indexes, checks — a test that needs a
 * constraint asserts it on purpose, by adding it itself.
 */

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

/** `create table "<name>" (…)` for one Drizzle table. */
export function pgliteTableDdl(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    let def = "";
    if (c.hasDefault) {
      if (typeof c.default === "number" || typeof c.default === "boolean")
        def = ` default ${c.default}`;
      else if (typeof c.default === "string")
        def = ` default '${c.default.replace(/'/g, "''")}'`;
      else if (type === "uuid") def = " default gen_random_uuid()";
      else if (type.startsWith("timestamp")) def = " default now()";
      else if (type === "jsonb") def = " default '{}'::jsonb";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

/** The DDL for several tables, in order. */
export function pgliteSchemaDdl(tables: readonly PgTable[]): string {
  return tables.map(pgliteTableDdl).join("\n");
}
