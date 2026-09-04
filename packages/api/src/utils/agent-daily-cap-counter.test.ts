/**
 * The per-agent daily proposal cap counted NOTHING for the agents it exists to
 * bound.
 *
 * `countTodayAgentProposals` used to ask for
 *
 *     createdBy = <the human> AND agentUserId = <the agent> AND createdAt >= UTC-midnight
 *
 * but `proposals.createdBy` is an OVERLOADED column ("userId or agentUserId that
 * authored this row") and the INSERT two hundred lines away falls back
 * `createdBy: input.createdBy ?? input.agentUserId ?? input.userId`. An agent
 * write that passes no explicit `createdBy` — every MCP write — lands
 * `createdBy = agentUserId = <agent>`, so the AND-pair matched NOTHING,
 * `alreadyToday` was permanently 0, and the HARD REFUSAL it gates could never
 * fire. Only paths that pass `createdBy` explicitly (`routers/capture.ts`, which
 * documents doing so precisely to stay countable) were ever budgeted. Live on
 * this pod BOTH shapes exist side by side.
 *
 * The fix drops `createdBy` from the predicate entirely. That is sound because
 * an agent-user belongs to exactly ONE human — `users.createdByUserId` is a
 * single-valued FK and migration 0228 adds a partial UNIQUE
 * (created_by_user_id, agent_type) — so `agentUserId = <agent>` already implies
 * its owner and can never admit another human's rows. It is also the shape
 * `agentDailyProposalCap()` (the ceiling half of the same decision) has always
 * used.
 *
 * Asserted here, SHAPE ONLY — never a live count:
 *
 *   1. the predicate binds the AGENT id and the UTC-day boundary, and carries NO
 *      `created_by` term, so BOTH row shapes are counted;
 *   2. the only id it binds is the agent's — another agent's rows cannot enter;
 *   3. `startOfUtcDay()` really is UTC midnight (the day bound survives);
 *   4. the wiring: the enforcer composes exactly this predicate and passes only
 *      the agent, and `agent-scorecard.ts` CALLS the enforcer's function rather
 *      than keeping a second copy that can drift from what is enforced.
 *
 * Why predicate-level: there is no local Postgres in this environment.
 * Compiling the WHERE is the technique `services/proposals/proposal-author-floor.test.ts`
 * and the access suites already use; the wiring half is asserted against source.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { and, eq, gte, type SQL } from "drizzle-orm";
import { proposals } from "@synap/database/schema";

const dialect = new PgDialect();
const compile = (sql: SQL) => dialect.sqlToQuery(sql);

const here = dirname(fileURLToPath(import.meta.url));
const permissionCheckPath = join(here, "permission-check.ts");
const scorecardPath = join(here, "../services/diagnose/agent-scorecard.ts");
const read = (p: string) => readFileSync(p, "utf8");

const HUMAN = "user-human";
const AGENT = "user-agent";
const OTHER_AGENT = "user-other-agent";
const DAY_START = new Date(Date.UTC(2026, 8, 4));

/** The counter's WHERE exactly as `countTodayAgentProposals` composes it. */
const capCounterWhere = (agentUserId: string, since: Date) =>
  and(eq(proposals.agentUserId, agentUserId), gte(proposals.createdAt, since))!;

describe("agent daily-cap counter keys on the agent, not the overloaded createdBy", () => {
  it("binds the agent id + the UTC-day bound, and nothing else", () => {
    const { sql, params } = compile(capCounterWhere(AGENT, DAY_START));

    expect(sql).toContain('"agent_user_id"');
    expect(sql).toContain('"created_at"');
    // Drizzle serialises the timestamp param on the way to the driver.
    expect(params).toEqual([AGENT, DAY_START.toISOString()]);
  });

  it("carries NO created_by term — so both authored shapes are counted", () => {
    // The two shapes that exist live: an explicit-createdBy write
    // (createdBy=<human>, agentUserId=<agent>) and an MCP write that fell back
    // (createdBy=<agent>, agentUserId=<agent>). Neither can be excluded by a
    // predicate that never mentions the column.
    const { sql, params } = compile(capCounterWhere(AGENT, DAY_START));

    expect(sql).not.toContain("created_by");
    expect(params).not.toContain(HUMAN);
  });

  it("cannot count another agent's rows", () => {
    const mine = compile(capCounterWhere(AGENT, DAY_START));
    const theirs = compile(capCounterWhere(OTHER_AGENT, DAY_START));

    expect(mine.params).toContain(AGENT);
    expect(mine.params).not.toContain(OTHER_AGENT);
    expect(theirs.params).not.toContain(AGENT);
  });

  it("startOfUtcDay is UTC midnight — the day bound is not local-time", async () => {
    const { startOfUtcDay } = await import("./permission-check.js");
    const day = startOfUtcDay();

    expect(day.getUTCHours()).toBe(0);
    expect(day.getUTCMinutes()).toBe(0);
    expect(day.getUTCSeconds()).toBe(0);
    expect(day.getUTCMilliseconds()).toBe(0);
    expect(day.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe("wiring: one counter, called by both the enforcer and the scorecard", () => {
  it("the enforcer's counter has no createdBy term and takes only the agent", () => {
    const src = read(permissionCheckPath);

    const body =
      /export async function countTodayAgentProposals\([\s\S]*?\n\}/.exec(src);
    expect(
      body,
      "countTodayAgentProposals must still exist + be exported"
    ).not.toBeNull();
    const fn = body![0];

    expect(fn).toContain("eq(proposals.agentUserId, agentUserId)");
    expect(fn).toContain("gte(proposals.createdAt, startOfUtcDay())");
    // THE REGRESSION: re-adding the human floor makes the cap inert again.
    expect(
      fn,
      "createdBy is overloaded — ANDing it here is what made the cap never fire"
    ).not.toContain("proposals.createdBy");

    // The enforcement call site passes the agent alone.
    expect(src).toContain("countTodayAgentProposals(attributionAgentUserId)");
  });

  it("the scorecard CALLS the enforcer's counter instead of re-deriving it", () => {
    const src = read(scorecardPath);

    expect(src).toMatch(
      /import\s*\{[^}]*countTodayAgentProposals[^}]*\}\s*from\s*["'][^"']*permission-check\.js["']/
    );
    expect(src).toContain("countTodayAgentProposals(agentId)");
    // A second copy of the predicate is how the reported posture drifted from
    // what the membrane enforces in the first place.
    expect(
      src,
      "the scorecard must not re-derive the day-count predicate"
    ).not.toContain("eq(proposals.createdBy, userId)");
  });
});
