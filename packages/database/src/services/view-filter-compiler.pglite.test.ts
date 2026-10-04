/**
 * REAL-POSTGRES (PGlite) test for the JSONB fallback of ViewFilterCompiler.
 *
 * Every `EntityFilter` operator is compiled through the PUBLIC `compileFilter`
 * (no scope profiles ⇒ the JSONB path), rendered by drizzle's PgDialect, and
 * EXECUTED against a minimal `entities` slice. Asserting the matched ids —
 * not just the SQL text — is what catches the two shipped defects:
 *   - `in` emitted an unbalanced `(... = ANY(...)` → syntax error, and a JS
 *     array inside ANY() expands to `($1, $2)`, which is not an array;
 *   - every other operator (not_contains, not_in, ranges) compiled to FALSE,
 *     so a valid filter rendered as an empty view.
 *
 * `entities` here is only the two columns the JSONB path reads.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  ViewFilterCompiler,
  type EntityFilter,
} from "./view-filter-compiler.js";

let pg: PGlite;
const dialect = new PgDialect();
// The JSONB path never touches the db handle.
const compiler = new ViewFilterCompiler({} as never);

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE entities (id text PRIMARY KEY, properties jsonb);
    INSERT INTO entities VALUES
      ('a', '{"status":"open","n":10,"due":"2026-01-10","tag":"Alpha"}'),
      ('b', '{"status":"done","n":2.5,"due":"2026-03-01T00:00:00Z","tag":"beta"}'),
      ('c', '{"status":"open","n":"abc","due":"not a date"}'),
      ('d', '{}'),
      ('e', '{"status":"archived","n":100}');
  `);
});

afterAll(async () => {
  await pg?.close();
});

async function compile(filter: Omit<EntityFilter, "field"> & { key: string }) {
  const compiled = await compiler.compileFilter({
    field: `properties.${filter.key}`,
    operator: filter.operator,
    value: filter.value,
  });
  if (!compiled) throw new Error("compileFilter returned null");
  return compiled;
}

async function matchIds(
  filter: Omit<EntityFilter, "field"> & { key: string }
): Promise<string[]> {
  const compiled = await compile(filter);
  expect(compiled.usesIndex).toBe(false);
  const query = dialect.sqlToQuery(
    sql`select "id" from "entities" where ${compiled.sql} order by "id"`
  );
  const res = await pg.query<{ id: string }>(query.sql, query.params);
  return res.rows.map((r) => r.id);
}

describe("ViewFilterCompiler — JSONB fallback, executed", () => {
  // Discriminating rows: c holds garbage (non-numeric / non-date) values,
  // d has the key absent, so NULL semantics and cast safety are both on trial.
  const cases: Array<
    [Omit<EntityFilter, "field"> & { key: string }, string[]]
  > = [
    [{ key: "status", operator: "equals", value: "open" }, ["a", "c"]],
    [{ key: "status", operator: "not_equals", value: "open" }, ["b", "e"]],
    [{ key: "tag", operator: "contains", value: "alp" }, ["a"]],
    [{ key: "tag", operator: "not_contains", value: "alp" }, ["b"]],
    [{ key: "tag", operator: "is_empty" }, ["c", "d", "e"]],
    [{ key: "tag", operator: "is_not_empty" }, ["a", "b"]],
    [
      { key: "status", operator: "in", value: ["open", "done"] },
      ["a", "b", "c"],
    ],
    [{ key: "status", operator: "in", value: ["done"] }, ["b"]],
    [{ key: "n", operator: "in", value: [10, 100] }, ["a", "e"]],
    [{ key: "status", operator: "in", value: [] }, []],
    [{ key: "status", operator: "not_in", value: ["open"] }, ["b", "e"]],
    [
      { key: "status", operator: "not_in", value: [] },
      ["a", "b", "c", "d", "e"],
    ],
    [{ key: "n", operator: "greater_than", value: 5 }, ["a", "e"]],
    [{ key: "n", operator: "greater_than_or_equal", value: 10 }, ["a", "e"]],
    [{ key: "n", operator: "less_than", value: 10 }, ["b"]],
    [{ key: "n", operator: "less_than_or_equal", value: "10" }, ["a", "b"]],
    [{ key: "due", operator: "greater_than", value: "2026-02-01" }, ["b"]],
    [
      { key: "due", operator: "less_than_or_equal", value: "2026-01-10" },
      ["a"],
    ],
  ];

  it.each(cases)("%o matches %o", async (filter, expected) => {
    expect(await matchIds(filter)).toEqual(expected);
  });

  it("in renders a balanced IN list, never ANY() over an expanded tuple", async () => {
    const compiled = await compile({
      key: "status",
      operator: "in",
      value: ["open", "done"],
    });
    const { sql: text, params } = dialect.sqlToQuery(compiled.sql);
    expect(text).toBe(`("entities"."properties"->>$1 IN ($2, $3))`);
    expect(params).toEqual(["status", "open", "done"]);
    expect(text).not.toMatch(/ANY/i);
  });

  it("numeric range casts both sides to numeric behind a CASE guard", async () => {
    const compiled = await compile({
      key: "n",
      operator: "greater_than",
      value: 5,
    });
    const { sql: text, params } = dialect.sqlToQuery(compiled.sql);
    expect(text).toMatch(
      /THEN \("entities"\."properties"->>\$\d\)::numeric END > \$\d::numeric/
    );
    expect(params).toContain("5");
  });

  it("every operator in the EntityFilter union compiles (none silently FALSE)", async () => {
    // Derived from the case table so a new operator row joins by existing.
    const operators = new Set(cases.map(([f]) => f.operator));
    expect(operators.size).toBe(12);
    for (const [filter] of cases) {
      const { sql: text } = dialect.sqlToQuery((await compile(filter)).sql);
      if (Array.isArray(filter.value) && filter.value.length === 0) continue;
      expect(text).not.toBe("FALSE");
    }
  });

  it("throws instead of matching nothing for what it cannot compile", async () => {
    await expect(
      compile({ key: "status", operator: "bogus" as never, value: "x" })
    ).rejects.toThrow(/Unsupported filter operator "bogus"/);
    await expect(
      compile({ key: "status", operator: "in", value: "open" })
    ).rejects.toThrow(/requires an array value/);
    await expect(
      compile({ key: "n", operator: "greater_than", value: "soon" })
    ).rejects.toThrow(/requires a number or an ISO date value/);
  });
});
