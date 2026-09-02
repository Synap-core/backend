import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { PgDialect } from "drizzle-orm/pg-core";
import { toolNotRetiredWhere } from "./visibility.js";

/**
 * Local Postgres is not available to this suite, so "absent from the registry"
 * is proven by RENDERING the real predicate and EVALUATING it — never by
 * restating the rule in JS (that would pass no matter what the predicate says).
 *
 * `evaluate` understands exactly one shape: a single binary comparison against
 * one bound parameter (`"tools"."status" <> $1`). That is deliberately narrow —
 * it is a reader of the production SQL, not a second copy of the rule. Change
 * the predicate's OPERATOR and every row's verdict below moves with it, which
 * is what makes the `error`-row assertion a real guard rather than a comment.
 */
function renderPredicate(): { sql: string; params: unknown[] } {
  const q = new PgDialect().sqlToQuery(toolNotRetiredWhere());
  return { sql: q.sql, params: q.params };
}

function evaluate(row: { status: string }): boolean {
  const { sql, params } = renderPredicate();
  const m = /^"tools"\."status"\s*(<>|!=|=)\s*\$1$/.exec(sql.trim());
  if (!m) {
    throw new Error(
      `predicate is no longer a single status comparison, so this test can no ` +
        `longer judge it honestly — rewrite the evaluator. Got: ${sql}`
    );
  }
  const [, op] = m;
  const bound = String(params[0]);
  return op === "=" ? row.status === bound : row.status !== bound;
}

describe("toolNotRetiredWhere — which tools stay advertised", () => {
  it("hides a RETIRED (inactive) tool", () => {
    expect(evaluate({ status: "inactive" })).toBe(false);
  });

  it("keeps an active tool", () => {
    expect(evaluate({ status: "active" })).toBe(true);
  });

  /**
   * THE assertion that protects the choice of `<> 'inactive'` over
   * `= 'active'`. `'error'` is a HEALTH state, not a retirement: a user must
   * still be able to SEE an errored tool in order to fix it. Tightening the
   * predicate to `= 'active'` turns this row invisible — a regression, and this
   * test is the thing that catches it.
   */
  it("KEEPS an errored tool — 'error' is health, not retirement", () => {
    expect(evaluate({ status: "error" })).toBe(true);
  });

  /**
   * `approved` is orthogonal to `status` (schema comment on the column) and
   * defaults to FALSE — a tool is born not approved. Consulting it here would
   * hide a large number of legitimate tools; it gates EXECUTION, not
   * visibility. So the predicate must not mention the column at all.
   */
  it("ignores `approved` — an unapproved active tool is still listed", () => {
    const { sql } = renderPredicate();
    expect(sql).not.toContain("approved");
    expect(evaluate({ status: "active" })).toBe(true);
  });
});

/**
 * The predicate only hides anything if the discovery reads actually AND it in.
 * Same source-tripwire shape as `capability-registry.skill-visibility.tripwire`.
 */
describe("the discovery reads apply it", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (p: string): string => readFileSync(join(here, p), "utf8");

  it("capability-registry's tool select ANDs in toolNotRetiredWhere()", () => {
    const src = read("../capabilities/capability-registry.ts");
    const start = src.indexOf("const toolRows = await db");
    expect(start).toBeGreaterThan(-1);
    const toolRead = src.slice(
      start,
      src.indexOf(";", src.indexOf(".where(", start) + 6)
    );
    expect(toolRead).toContain("toolNotRetiredWhere()");
  });

  it("the tools.list door ANDs in toolNotRetiredWhere()", () => {
    const src = read("../../routers/tools.ts");
    const start = src.indexOf("const rows = await db");
    expect(start).toBeGreaterThan(-1);
    const listRead = src.slice(start, start + 500);
    expect(listRead).toContain("toolNotRetiredWhere()");
  });
});
