import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  isRuleExpired,
  normalizeExpiresAt,
  ruleNotExpiredWhere,
} from "./expiry.js";
import { visibleSkillsWhere } from "../skills/visibility.js";

/**
 * Local Postgres is not available to this suite, so "an expired rule is
 * excluded from the reader" is proven by RENDERING the real predicate and
 * EVALUATING it — never by restating the rule in JS (that would pass no matter
 * what the predicate says).
 *
 * `evaluate` understands exactly one shape: the two-armed NULL-or-greater
 * comparison over the same JSONB path against one bound `now`. Deliberately
 * narrow — it reads the production SQL rather than duplicating it, so changing
 * the operator (or dropping an arm) moves every verdict below.
 */
function render(sql: Parameters<PgDialect["sqlToQuery"]>[0]): {
  sql: string;
  params: unknown[];
} {
  const q = new PgDialect().sqlToQuery(sql);
  return { sql: q.sql, params: q.params };
}

/** Evaluate the standalone predicate against a row's stored `expiresAt`. */
function evaluate(row: { expiresAt: string | null }): boolean {
  const { sql, params } = render(ruleNotExpiredWhere());
  const m =
    /^\(\s*"skills"\."metadata"\s*#>>\s*\$1\s+IS NULL\s+OR\s+"skills"\."metadata"\s*#>>\s*\$2\s*(>|>=)\s*\$3\s*\)$/.exec(
      sql.trim()
    );
  if (!m) {
    throw new Error(
      `the expiry predicate is no longer a NULL-or-compare over one JSONB ` +
        `path, so this test can no longer judge it honestly — rewrite the ` +
        `evaluator. Got: ${sql}`
    );
  }
  expect(params[0]).toBe("{rule,expiresAt}");
  expect(params[1]).toBe("{rule,expiresAt}");
  const op = m[1];
  const now = String(params[2]);
  // `#>>` on an absent path yields SQL NULL — that is the "no expiry" arm.
  if (row.expiresAt === null) return true;
  return op === ">" ? row.expiresAt > now : row.expiresAt >= now;
}

describe("ruleNotExpiredWhere — which rules still apply", () => {
  it("EXCLUDES a rule whose expiry has passed", () => {
    expect(evaluate({ expiresAt: "2020-01-01T00:00:00.000Z" })).toBe(false);
  });

  it("keeps a rule whose expiry is still in the future", () => {
    expect(evaluate({ expiresAt: "2099-01-01T00:00:00.000Z" })).toBe(true);
  });

  /**
   * THE assertion that protects "absent means no expiry, never expired".
   * Every rule written before this field existed carries no key at all; if the
   * NULL arm were dropped, the whole existing corpus would vanish from the
   * model's prompt at once. No migration, no backfill — this arm is why.
   */
  it("keeps a rule with NO expiry — absent is never 'expired'", () => {
    expect(evaluate({ expiresAt: null })).toBe(true);
  });

  /**
   * The predicate must not cast in SQL. `metadata` is JSONB so the value is
   * text, and Postgres does not guarantee short-circuit evaluation of an OR —
   * one hand-edited row would make the whole LIST query throw.
   */
  it("compares as text, never `::timestamptz` (a bad row must not error the list)", () => {
    expect(render(ruleNotExpiredWhere()).sql).not.toContain("timestamptz");
  });

  it("binds `now` as the canonical ISO form the stored value is normalised to", () => {
    const now = new Date("2026-09-02T10:00:00.000Z");
    expect(render(ruleNotExpiredWhere(now)).params[2]).toBe(
      "2026-09-02T10:00:00.000Z"
    );
  });
});

/**
 * The predicate only hides anything if the read doors actually AND it in.
 * `visibleSkillsWhere` is the narrowest point EVERY rule reader inherits:
 *   - the IS prompt path: `/api/hub/agent-skills/executable`
 *     → hub `skills.getSkills` → tRPC `skills.list`,
 *   - `GET /api/hub/rules`,
 *   - tRPC `skills.listRules`.
 * So this is enforcement at one door, not three copies of a filter.
 */
describe("the shared read door applies it", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (p: string): string => readFileSync(join(here, p), "utf8");

  it("visibleSkillsWhere ANDs the expiry predicate into its returned SQL", () => {
    for (const workspaceId of [
      undefined,
      "11111111-1111-1111-1111-111111111111",
    ]) {
      const { sql } = render(visibleSkillsWhere("user-1", workspaceId));
      expect(sql).toContain(`"skills"."metadata" #>>`);
      // ANDed, not ORed — an expired rule must not be re-admitted by a tier.
      expect(sql).toMatch(/\band\b/i);
    }
  });

  it("the IS prompt path inherits it: skills.list uses visibleSkillsWhere", () => {
    const src = read("../../routers/skills.ts");
    expect(src).toContain("visibleSkillsWhere(userId, input?.workspaceId)");
  });

  it("GET /api/hub/rules inherits it", () => {
    const src = read("../../routers/hub-protocol/rest/rules.ts");
    expect(src).toContain(
      "visibleSkillsWhere(userId, parsed.data.workspaceId)"
    );
  });

  it("skills.listRules inherits it", () => {
    const src = read("../../routers/skills.ts");
    expect(src).toContain("visibleSkillsWhere(userId, input?.workspaceId)");
    expect(src).toContain("eq(skills.category, RULE_CATEGORY)");
  });
});

describe("normalizeExpiresAt / isRuleExpired — the JS mirror", () => {
  it("canonicalises any parseable instant to the SQL-comparable form", () => {
    expect(normalizeExpiresAt("2027-03-01T12:00:00+02:00")).toBe(
      "2027-03-01T10:00:00.000Z"
    );
    expect(normalizeExpiresAt(new Date(0))).toBe("1970-01-01T00:00:00.000Z");
  });

  it("returns undefined for absent, throws for a non-instant", () => {
    expect(normalizeExpiresAt(undefined)).toBeUndefined();
    expect(normalizeExpiresAt(null)).toBeUndefined();
    expect(() => normalizeExpiresAt("soon")).toThrow(/not a valid instant/);
  });

  it("agrees with the SQL verdict on both arms", () => {
    const now = new Date("2026-09-02T10:00:00.000Z");
    expect(isRuleExpired(undefined, now)).toBe(false);
    expect(isRuleExpired("2020-01-01T00:00:00.000Z", now)).toBe(true);
    expect(isRuleExpired("2099-01-01T00:00:00.000Z", now)).toBe(false);
  });
});
