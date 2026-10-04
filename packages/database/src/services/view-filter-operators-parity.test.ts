/**
 * TRIPWIRE: every operator of the authored view-filter grammar
 * (`@synap-core/types/views` `VIEW_FILTER_OPERATORS`) is COMPILED by
 * `ViewFilterCompiler`, on both the core-column and the JSONB property path —
 * and the compiler's runtime mirror is the same set.
 *
 * TEST-ONLY relative import of the authored grammar: `@synap/database` cannot
 * depend on `@synap-core/types` (types already depends on database — a build
 * cycle), so no package dependency is declared; tsconfig excludes tests, so
 * this path never enters the database build. Same precedent as
 * `utils/guideline-vocabulary-parity.test.ts`.
 *
 * The operator set and each operator's sample value are DERIVED from the
 * authored grammar (`VIEW_FILTER_OPERATORS` × `VIEW_FILTER_VALUE_SHAPE`), never
 * hand-listed — a new operator joins the scan by existing.
 *
 * WHAT IT DOES NOT COVER: the INDEXED path (needs merged property metadata from
 * a DB; it falls back to JSONB for what it does not handle, so the JSONB path
 * is the floor) and whether the compiled SQL MATCHES the right rows — that is
 * `view-filter-compiler.pglite.test.ts`, which executes it.
 */
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  ViewFilterCompiler,
  VIEW_FILTER_OPERATORS as MIRROR,
  VIEW_FILTER_CORE_FIELDS as CORE_FIELDS_MIRROR,
  type EntityFilter,
} from "./view-filter-compiler.js";
import * as authored from "../../../types/src/views/filters.js";

const dialect = new PgDialect();
// Neither path exercised here touches the db handle.
const compiler = new ViewFilterCompiler({} as never);

function sampleValue(op: authored.FilterOperator): unknown {
  const shape = authored.VIEW_FILTER_VALUE_SHAPE[op];
  // A number is a valid operand for every single-value operator: ranges need
  // a number or ISO date, and equals/contains bind it as text.
  return shape === "multi" ? ["a", "b"] : shape === "none" ? undefined : 5;
}

describe("view filter operators — authored grammar ⇔ compiler", () => {
  it("non-vacuity: the authored grammar is real", () => {
    expect(authored.VIEW_FILTER_OPERATORS.length).toBeGreaterThanOrEqual(12);
    expect(authored.VIEW_FILTER_OPERATORS).toContain("is_not_empty");
  });

  it("the compiler's runtime mirror is the authored set", () => {
    expect([...MIRROR].sort()).toEqual(
      [...authored.VIEW_FILTER_OPERATORS].sort()
    );
  });

  it("the compiler's core-field mirror is the authored set, and each compiles", async () => {
    expect(authored.VIEW_FILTER_CORE_FIELDS.length).toBeGreaterThanOrEqual(5);
    expect([...CORE_FIELDS_MIRROR].sort()).toEqual(
      [...authored.VIEW_FILTER_CORE_FIELDS].sort()
    );
    for (const field of authored.VIEW_FILTER_CORE_FIELDS) {
      expect(authored.isViewFilterField(field), field).toBe(true);
      const compiled = await compiler.compileFilter({
        field,
        operator: "is_empty",
      });
      expect(compiled, field).not.toBeNull();
    }
  });

  for (const field of ["title", "properties.status"]) {
    it(`every authored operator compiles on ${field}`, async () => {
      const failures: string[] = [];
      for (const op of authored.VIEW_FILTER_OPERATORS) {
        const filter = {
          field,
          operator: op,
          value: sampleValue(op),
        } as EntityFilter;
        try {
          const compiled = await compiler.compileFilter(filter);
          if (!compiled) {
            failures.push(`${op}: null`);
            continue;
          }
          const { sql } = dialect.sqlToQuery(compiled.sql);
          if (!sql || sql === "FALSE") failures.push(`${op}: ${sql}`);
        } catch (error) {
          failures.push(`${op}: threw ${(error as Error).message}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }
});
