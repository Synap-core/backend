/**
 * REAL-POSTGRES (PGlite) semantics of ViewFilterCompiler, executed on BOTH
 * property paths over one fixture whose index rows mirror its JSONB bag:
 *
 *   1. boolean equality on the JSONB path binds TEXT ('true'/'false') —
 *      postgres-js types a JS boolean as `bool`, and Postgres has no
 *      `text = boolean`. PGlite infers param types from the statement, so it
 *      would NOT fail on a boolean param; the bound-param assertion is the
 *      guard for the postgres-js case;
 *   2. negations (not_equals / not_in / not_contains) INCLUDE rows whose value
 *      is missing, and give the SAME rows on the indexed and JSONB paths;
 *   3. a date-only value (YYYY-MM-DD) compares by DAY on the indexed path, the
 *      JSONB path and the core timestamp columns; a datetime keeps instant
 *      semantics;
 *   4. an unknown core field / non-array `in` / malformed property field
 *      THROW (the router maps it to BAD_REQUEST) — never "no condition".
 *
 * Each parity row asserts the expected ids as well as path agreement: a
 * convergence check alone would pass two paths agreeing on a wrong answer.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  ViewFilterCompiler,
  type EntityFilter,
  type PropertyFilterMeta,
} from "./view-filter-compiler.js";

let pg: PGlite;
const dialect = new PgDialect();

const VALUE_TYPES: Record<string, string> = {
  done: "boolean",
  status: "string",
  due: "date",
};
const DEF_ID = (slug: string) => `def-${slug}`;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    SET TIME ZONE 'UTC';
    CREATE TABLE entities (
      id text PRIMARY KEY, type text, created_at timestamptz, properties jsonb
    );
    INSERT INTO entities VALUES
      ('a', 'task', '2026-10-04T10:00:00Z',
        '{"done":true,"status":"open","due":"2026-10-04T15:30:00Z"}'),
      ('b', 'task', '2026-10-03T23:00:00Z',
        '{"done":false,"status":"closed","due":"2026-10-03"}'),
      ('c', 'task', '2026-10-05T00:00:00Z',
        '{"status":null,"due":"2026-10-05T00:00:00Z"}'),
      ('d', 'task', '2026-09-01T00:00:00Z', '{}');
    CREATE TABLE entity_property_index (
      entity_id text NOT NULL,
      property_def_id text NOT NULL,
      value_text text, value_num numeric, value_bool boolean,
      value_ts timestamptz, value_entity_id text, value_jsonb jsonb
    );
    INSERT INTO entity_property_index (entity_id, property_def_id, value_bool) VALUES
      ('a', 'def-done', true), ('b', 'def-done', false);
    INSERT INTO entity_property_index (entity_id, property_def_id, value_text) VALUES
      ('a', 'def-status', 'open'), ('b', 'def-status', 'closed');
    INSERT INTO entity_property_index (entity_id, property_def_id, value_ts) VALUES
      ('a', 'def-due', '2026-10-04T15:30:00Z'),
      ('b', 'def-due', '2026-10-03'),
      ('c', 'def-due', '2026-10-05T00:00:00Z');
  `);
});

afterAll(async () => {
  await pg?.close();
});

function compilerWithMerge(): ViewFilterCompiler {
  const c = new ViewFilterCompiler({} as never);
  (c as unknown as { propertyMerging: unknown }).propertyMerging = {
    mergePropertiesFromProfiles: async () =>
      new Map(
        Object.entries(VALUE_TYPES).map(([slug, valueType]) => [
          slug,
          { valueType, propertyDefIds: [DEF_ID(slug)], indexed: true },
        ])
      ),
  };
  return c;
}

async function run(
  filter: EntityFilter,
  path: "indexed" | "jsonb" | "core"
): Promise<{ ids: string[]; usesIndex: boolean }> {
  const c = compilerWithMerge();
  const meta = new Map<string, PropertyFilterMeta>(
    Object.keys(VALUE_TYPES).map((slug) => [
      slug,
      { propertyDefIds: [DEF_ID(slug)], indexed: path === "indexed" },
    ])
  );
  const compiled = await c.compileFilter(filter, ["profile-a"], meta);
  if (!compiled) throw new Error("compileFilter returned null");
  const query = dialect.sqlToQuery(
    sql`select "id" from "entities" where ${compiled.sql} order by "id"`
  );
  const res = await pg.query<{ id: string }>(query.sql, query.params);
  return { ids: res.rows.map((r) => r.id), usesIndex: compiled.usesIndex };
}

type Row = [
  slug: string,
  operator: EntityFilter["operator"],
  value: unknown,
  expected: string[],
];

describe("ViewFilterCompiler semantics — indexed ⇔ JSONB, executed", () => {
  const rows: Row[] = [
    // 1. booleans
    ["done", "equals", true, ["a"]],
    ["done", "equals", false, ["b"]],
    // 2. negations include the missing value (c: JSON null, d: absent)
    ["done", "not_equals", true, ["b", "c", "d"]],
    ["status", "not_equals", "open", ["b", "c", "d"]],
    ["status", "not_in", ["open"], ["b", "c", "d"]],
    ["status", "not_contains", "op", ["b", "c", "d"]],
    // 3. date-only ⇒ DAY semantics (a = Oct 4 15:30, b = Oct 3, c = Oct 5 00:00)
    ["due", "equals", "2026-10-04", ["a"]],
    ["due", "not_equals", "2026-10-04", ["b", "c", "d"]],
    ["due", "greater_than", "2026-10-04", ["c"]],
    ["due", "greater_than_or_equal", "2026-10-04", ["a", "c"]],
    ["due", "less_than", "2026-10-04", ["b"]],
    ["due", "less_than_or_equal", "2026-10-04", ["a", "b"]],
    // ...a datetime keeps INSTANT semantics (day semantics would add a)
    ["due", "less_than_or_equal", "2026-10-04T00:00:00Z", ["b"]],
  ];

  it.each(rows)(
    "properties.%s %s %o → %o on both paths",
    async (slug, operator, value, expected) => {
      const filter = { field: `properties.${slug}`, operator, value };
      const jsonb = await run(filter, "jsonb");
      const indexed = await run(filter, "indexed");
      expect(jsonb.usesIndex).toBe(false);
      expect(jsonb.ids).toEqual(expected);
      expect(indexed.ids).toEqual(expected);
    }
  );

  it("the indexed rows really take the index (non-vacuity)", async () => {
    for (const [slug, operator, value] of [
      ["done", "not_equals", true],
      ["due", "equals", "2026-10-04"],
      ["due", "less_than", "2026-10-04"],
    ] as const) {
      const out = await run(
        { field: `properties.${slug}`, operator, value },
        "indexed"
      );
      expect(out.usesIndex, `${slug} ${operator}`).toBe(true);
    }
  });

  it("JSONB boolean equality binds TEXT, never a JS boolean (postgres-js types it bool)", async () => {
    const c = compilerWithMerge();
    for (const operator of ["equals", "not_equals"] as const) {
      const compiled = await c.compileFilter({
        field: "properties.done",
        operator,
        value: false,
      });
      const { params } = dialect.sqlToQuery(compiled!.sql);
      expect(params, operator).toEqual(["done", "false"]);
    }
  });
});

describe("ViewFilterCompiler semantics — core timestamp columns by day", () => {
  const rows: Array<[EntityFilter["operator"], string, string[]]> = [
    ["equals", "2026-10-04", ["a"]],
    ["not_equals", "2026-10-04", ["b", "c", "d"]],
    ["greater_than", "2026-10-04", ["c"]],
    ["less_than", "2026-10-04", ["b", "d"]],
    ["less_than_or_equal", "2026-10-04", ["a", "b", "d"]],
  ];
  it.each(rows)("createdAt %s %s → %o", async (operator, value, expected) => {
    const out = await run({ field: "createdAt", operator, value }, "core");
    expect(out.ids).toEqual(expected);
  });
});

describe("ViewFilterCompiler — what it cannot compile THROWS", () => {
  const c = new ViewFilterCompiler({} as never);
  it.each([
    [
      { field: "status", operator: "equals", value: "x" },
      /Unknown filter field "status"/,
    ],
    [
      { field: "metadata.status", operator: "equals", value: "x" },
      /Unknown filter field/,
    ],
    [
      { field: "type", operator: "in", value: "task" },
      /requires an array value/,
    ],
    [
      { field: "type", operator: "not_in", value: "task" },
      /requires an array value/,
    ],
    [
      { field: "properties.", operator: "equals", value: "x" },
      /not a property field/,
    ],
    [
      { field: "properties.a.b", operator: "equals", value: "x" },
      /not a property field/,
    ],
  ] as Array<[EntityFilter, RegExp]>)("%o", async (filter, message) => {
    await expect(c.compileFilter(filter)).rejects.toThrow(message);
  });

  it("compileFilters propagates the throw instead of dropping the filter", async () => {
    await expect(
      c.compileFilters([
        { field: "title", operator: "equals", value: "a" },
        { field: "status", operator: "equals", value: "open" },
      ])
    ).rejects.toThrow(/Unknown filter field/);
  });
});
