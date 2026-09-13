/**
 * The list door's STATUS filter, rendered to SQL.
 *
 * DB-free, the way `owed-outputs.test.ts` tests its predicate: the real
 * operators build the real SQL and the assertions read it. What this cannot do
 * is EXECUTE the query — the behavioural half is the live-pod replay recorded in
 * `session-status-filter.ts`'s header.
 *
 * The discriminating cases are the window blocks. Fetching a status and
 * filtering its window on the device, versus admitting it by window in SQL,
 * select different rows exactly where the first fix went wrong: rows concluded
 * or last touched long ago.
 */
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { and } from "@synap/database";
import type { SQL } from "@synap/database";
import { sessionStatusConditions } from "../session-status-filter.js";

const dialect = new PgDialect();
const render = (conds: SQL[]) =>
  conds.length === 0 ? null : dialect.sqlToQuery(and(...conds) as SQL);

// The Work home's set: the open four plus `failed`. `stale` and `closed` are
// admitted by window, never by status.
const HOME = ["active", "paused", "forming", "scheduled", "failed"] as const;
const WEEK_AGO = "2026-09-06T12:00:00.000Z";
const DAY_AGO = "2026-09-12T12:00:00.000Z";
const CLOCK =
  /coalesce\("focus_sessions"\."closed_at", "focus_sessions"\."updated_at"\) >= \$\d+::timestamptz/g;

describe("status alone", () => {
  it('"all" adds no condition, windows or not', () => {
    expect(sessionStatusConditions("all")).toEqual([]);
    expect(
      sessionStatusConditions("all", { stale: WEEK_AGO, closed: DAY_AGO })
    ).toEqual([]);
  });

  it("a single status is an equality", () => {
    const q = render(sessionStatusConditions("stale"))!;
    expect(q.sql).toMatch(/"focus_sessions"\."status" = \$1/);
    expect(q.params).toEqual(["stale"]);
  });

  it("a set is an IN, with no window unless asked", () => {
    const q = render(sessionStatusConditions(HOME))!;
    expect(q.sql).toMatch(/"focus_sessions"\."status" in \(/);
    expect(q.sql).not.toMatch(/coalesce/);
  });
});

describe("a window admits a status by RECENCY, in SQL", () => {
  it("ORs recently-closed onto a set that does not select closed", () => {
    const q = render(sessionStatusConditions(HOME, { closed: DAY_AGO }))!;
    expect(q.sql).toMatch(/ or /);
    expect(q.sql.match(CLOCK)).toHaveLength(1);
    // Bound as a parameter, never interpolated into the SQL text.
    expect(q.params).toContain(DAY_AGO);
    expect(q.sql).not.toContain(DAY_AGO);
  });

  it("ORs recently-stale onto a set that does not select stale", () => {
    const q = render(sessionStatusConditions(HOME, { stale: WEEK_AGO }))!;
    expect(q.sql.match(CLOCK)).toHaveLength(1);
    expect(q.params).toEqual(expect.arrayContaining(["stale", WEEK_AGO]));
  });

  it("applies BOTH windows at once — the Work home's request", () => {
    const q = render(
      sessionStatusConditions(HOME, { stale: WEEK_AGO, closed: DAY_AGO })
    )!;
    expect(q.sql.match(CLOCK)).toHaveLength(2);
    expect(q.params).toEqual(
      expect.arrayContaining(["stale", WEEK_AGO, "closed", DAY_AGO])
    );
  });

  it("never narrows an explicit ask: a selected status ignores its window", () => {
    // Selecting `stale` already returns every stale row; applying the window
    // would silently remove rows the caller named.
    const q = render(
      sessionStatusConditions([...HOME, "stale"], { stale: WEEK_AGO })
    )!;
    expect(q.sql).not.toMatch(/coalesce/);
    const single = render(
      sessionStatusConditions("closed", { closed: DAY_AGO })
    )!;
    expect(single.sql).not.toMatch(/coalesce/);
  });

  it("works for a single non-windowed status too", () => {
    const q = render(sessionStatusConditions("failed", { closed: DAY_AGO }))!;
    expect(q.sql).toMatch(/ or /);
    expect(q.params).toEqual(
      expect.arrayContaining(["failed", "closed", DAY_AGO])
    );
  });
});
