/**
 * TRIPWIRE: every operator of the view-filter grammar
 * (`@synap-core/types/views` `VIEW_FILTER_OPERATORS`, which the compiler
 * re-exports — one declaration) is COMPILED by `ViewFilterCompiler`, on both
 * the core-column and the JSONB property path, and every core field compiles.
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
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as authored from "@synap-core/types/views";
import { entities } from "../schema/index.js";
import {
  ViewFilterCompiler,
  type EntityFilter,
  type StatusFilterSubject,
} from "./view-filter-compiler.js";

const dialect = new PgDialect();
// Neither path exercised here touches the db handle.
const compiler = new ViewFilterCompiler({} as never);

function sampleValue(op: authored.FilterOperator): unknown {
  const shape = authored.VIEW_FILTER_VALUE_SHAPE[op];
  // A number is a valid operand for every single-value operator: ranges need
  // a number or ISO date, and equals/contains bind it as text.
  return shape === "multi" ? ["a", "b"] : shape === "none" ? undefined : 5;
}

describe("view filter operators — every authored operator compiles", () => {
  it("non-vacuity: the authored grammar is real", () => {
    expect(authored.VIEW_FILTER_OPERATORS.length).toBeGreaterThanOrEqual(12);
    expect(authored.VIEW_FILTER_OPERATORS).toContain("is_not_empty");
  });

  it("every authored core field compiles", async () => {
    expect(authored.VIEW_FILTER_CORE_FIELDS.length).toBeGreaterThanOrEqual(5);
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

  // The status primitive is compiled PER SUBJECT: every operator on the
  // entity column (a kind), inside the role's facet EXISTS (a role), and as
  // facet-OR-kind for a scope naming both. A role subject that still read the
  // entity column is what made `status:"qualified"` list "new" leads.
  const roleCompiler = new ViewFilterCompiler(drizzle.mock() as never);
  const role: StatusFilterSubject = {
    roleProfileIds: ["r1"],
    facetScope: { userId: "u1", workspaceId: "ws-1" },
  };
  const subjects: Array<[string, StatusFilterSubject | undefined, RegExp]> = [
    ["kind", undefined, /^(?![\s\S]*entity_facets)[\s\S]*"entities"\."status/],
    [
      "role",
      role,
      /^(?![\s\S]*"entities"\."status)[\s\S]*exists[\s\S]*"entity_facets"\."status/,
    ],
    [
      "role + kind",
      { ...role, kindScope: eq(entities.type, "lead") },
      /exists[\s\S]*"entity_facets"\."status[\s\S]* or [\s\S]*"entities"\."type"[\s\S]*"entities"\."status/,
    ],
  ];
  for (const field of authored.VIEW_FILTER_STATUS_FIELDS) {
    for (const [name, subject, shape] of subjects) {
      it(`every authored operator compiles on ${field} for a ${name}`, async () => {
        const failures: string[] = [];
        for (const op of authored.VIEW_FILTER_OPERATORS) {
          const filter = {
            field,
            operator: op,
            value: sampleValue(op),
          } as EntityFilter;
          try {
            const compiled = await roleCompiler.compileFilter(
              filter,
              undefined,
              undefined,
              undefined,
              subject
            );
            const sql = compiled ? dialect.sqlToQuery(compiled.sql).sql : "";
            if (!shape.test(sql)) failures.push(`${op}: ${sql}`);
          } catch (error) {
            failures.push(`${op}: threw ${(error as Error).message}`);
          }
        }
        expect(failures).toEqual([]);
      });
    }
  }
});
