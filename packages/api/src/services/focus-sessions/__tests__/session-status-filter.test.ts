/**
 * The list door's STATUS filter, rendered to SQL.
 *
 * DB-free, the way `owed-outputs.test.ts` tests its predicate: the real
 * operators build the real SQL and the assertions read it. What this cannot do
 * is EXECUTE the query — the behavioural half is the live-pod replay recorded in
 * `session-status-filter.ts`'s header.
 *
 * The discriminating case is the SECOND describe block. A set with the time
 * window and a set with `closed` inside it select different rows exactly where
 * the first fix went wrong: sessions closed long ago. Every other fixture here
 * agrees across both designs and rules nothing out on its own.
 */
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { and } from "@synap/database";
import type { SQL } from "@synap/database";
import { sessionStatusConditions } from "../session-status-filter.js";

const dialect = new PgDialect();
const render = (conds: SQL[]) =>
  conds.length === 0 ? null : dialect.sqlToQuery(and(...conds) as SQL);

const UNCONCLUDED = [
  "active",
  "paused",
  "forming",
  "scheduled",
  "stale",
  "failed",
] as const;
const SINCE = "2026-09-12T00:00:00.000Z";

describe("status alone", () => {
  it('"all" adds no condition', () => {
    expect(sessionStatusConditions("all")).toEqual([]);
    expect(sessionStatusConditions("all", SINCE)).toEqual([]);
  });

  it("a single status is an equality", () => {
    const q = render(sessionStatusConditions("stale"))!;
    expect(q.sql).toMatch(/"focus_sessions"\."status" = \$1/);
    expect(q.params).toEqual(["stale"]);
  });

  it("a set is an IN, with no time window unless asked", () => {
    const q = render(sessionStatusConditions(UNCONCLUDED))!;
    expect(q.sql).toMatch(/"focus_sessions"\."status" in \(/);
    expect(q.sql).not.toMatch(/coalesce/);
  });
});

describe("the recently-closed window is a WHERE clause, not a device filter", () => {
  it("ORs closed-since onto a set that does not select closed", () => {
    const q = render(sessionStatusConditions(UNCONCLUDED, SINCE))!;
    expect(q.sql).toMatch(/ or /);
    expect(q.sql).toMatch(
      /coalesce\("focus_sessions"\."closed_at", "focus_sessions"\."updated_at"\) >= \$\d+::timestamptz/
    );
    // The window is bound as a parameter, never interpolated into the SQL.
    expect(q.params).toContain(SINCE);
    expect(q.sql).not.toContain(SINCE);
  });

  it("does NOT narrow an explicit ask for closed", () => {
    // `closed` in the set already returns every closed row; applying the window
    // would silently remove rows the caller named.
    const q = render(
      sessionStatusConditions([...UNCONCLUDED, "closed"], SINCE)
    )!;
    expect(q.sql).not.toMatch(/coalesce/);
    const single = render(sessionStatusConditions("closed", SINCE))!;
    expect(single.sql).not.toMatch(/coalesce/);
  });

  it("works for a single non-closed status too", () => {
    const q = render(sessionStatusConditions("stale", SINCE))!;
    expect(q.sql).toMatch(/ or /);
    expect(q.params).toEqual(
      expect.arrayContaining(["stale", "closed", SINCE])
    );
  });
});
