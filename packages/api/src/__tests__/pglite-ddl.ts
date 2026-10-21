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

import * as schema from "@synap/database/schema";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

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
      const d = c.default;
      if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (typeof d === "string")
        def = ` default '${d.replace(/'/g, "''")}'`;
      // A Postgres array column (`text[]`) with a JS array default is an array
      // literal, not jsonb — `'[]'::jsonb` on `focus_sessions.agent_ids` fails.
      else if (Array.isArray(d) && t.endsWith("[]"))
        def = ` default '{${d.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(",")}}'`;
      // A JS object/array default on a jsonb column: its own JSON, not `{}`.
      else if (
        d &&
        typeof d === "object" &&
        !("queryChunks" in d) &&
        type === "jsonb"
      )
        def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
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

/**
 * EVERY table of `@synap/database/schema`, deduped by name. A test that stands
 * up a hand-picked few tables rots the day the code under test reads one more
 * (governance_rules, links, session_evaluations, … — 11 files went red that
 * way by 2026-10-21). Empty tables are the honest state for the reads the test
 * is not about; the access floors and best-effort side reads then run for real.
 */
export function allSchemaTables(): PgTable[] {
  const seen = new Set<string>();
  const out: PgTable[] = [];
  for (const t of Object.values(schema)) {
    if (!is(t, PgTable)) continue;
    const name = getTableConfig(t).name;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(t);
  }
  return out;
}

/** The DDL for every schema table — see {@link allSchemaTables}. */
export function pgliteAllTablesDdl(): string {
  return pgliteSchemaDdl(allSchemaTables());
}
