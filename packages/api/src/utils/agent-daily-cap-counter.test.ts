/**
 * The per-agent proposal-cap counter must count what the cap protects: the
 * REVIEW QUEUE (still-PENDING proposals), not write volume.
 *
 * `countPendingAgentProposals` counts proposals attributed to THIS agent that
 * are STILL PENDING (`status = 'pending'`). Three prior defects made the old
 * predicate lie about that population:
 *   1. `createdBy = <human> AND agentUserId = <agent>` matched NOTHING for
 *      MCP-shaped rows (`createdBy` is overloaded), so the cap never fired.
 *   2. "created today, not auto-approved" measured WRITE VOLUME against a
 *      queue-pressure budget: approving a pending row did NOT free budget, so
 *      "review/clear pending to free budget" was a lie and only UTC midnight
 *      helped.
 *   3. Counting auto-approved RECEIPTS (audit rows for already-executed
 *      writes) measured a population the gate never gates.
 *
 * The fix keys on `agentUserId` (alone — an agent belongs to exactly one human,
 * `users.createdByUserId` single-valued FK + partial UNIQUE via migration 0228)
 * AND `status = PENDING`. Approved / rejected / auto-approved / withdrawn /
 * expired rows are all RESOLVED and stop consuming the budget the moment they
 * leave the queue. There is deliberately NO `created_at` day bound: a
 * stale-but-unexpired pending row is still unreviewed backlog.
 *
 * Asserted here, SHAPE ONLY — never a live count (no local Postgres):
 *   1. the predicate binds the AGENT id + the PENDING status, and carries NO
 *      `created_by` term and NO `created_at` day bound;
 *   2. the only id it binds is the agent's — another agent's rows cannot enter;
 *   3. the wiring: the enforcer composes exactly this predicate and passes only
 *      the agent, and `agent-scorecard.ts` CALLS the enforcer's function rather
 *      than keeping a second copy that can drift from what is enforced.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { and, eq, type SQL } from "drizzle-orm";
import { proposals, ProposalStatus } from "@synap/database/schema";

const dialect = new PgDialect();
const compile = (sql: SQL) => dialect.sqlToQuery(sql);

const here = dirname(fileURLToPath(import.meta.url));
const permissionCheckPath = join(here, "permission-check.ts");
const scorecardPath = join(here, "../services/diagnose/agent-scorecard.ts");
const read = (p: string) => readFileSync(p, "utf8");

const AGENT = "user-agent";
const OTHER_AGENT = "user-other-agent";

/** The counter's WHERE exactly as `countPendingAgentProposals` composes it. */
const capCounterWhere = (agentUserId: string) =>
  and(
    eq(proposals.agentUserId, agentUserId),
    eq(proposals.status, ProposalStatus.PENDING)
  )!;

describe("agent proposal-cap counter keys on the agent + PENDING status", () => {
  it("binds the agent id + the PENDING status, and nothing else", () => {
    const { sql, params } = compile(capCounterWhere(AGENT));

    expect(sql).toContain('"agent_user_id"');
    expect(sql).toContain('"status"');
    expect(params).toEqual([AGENT, "pending"]);
  });

  it("carries NO created_by term — so both authored shapes are counted", () => {
    const { sql, params } = compile(capCounterWhere(AGENT));

    expect(sql).not.toContain("created_by");
    expect(params).not.toContain("user-human");
  });

  it("carries NO created_at day bound — a stale pending row is still backlog", () => {
    const { sql } = compile(capCounterWhere(AGENT));

    expect(sql).not.toContain("created_at");
  });

  it("cannot count another agent's rows", () => {
    const mine = compile(capCounterWhere(AGENT));
    const theirs = compile(capCounterWhere(OTHER_AGENT));

    expect(mine.params).toContain(AGENT);
    expect(mine.params).not.toContain(OTHER_AGENT);
    expect(theirs.params).not.toContain(AGENT);
  });
});

describe("wiring: one counter, called by both the enforcer and the scorecard", () => {
  it("the enforcer's counter binds agent + PENDING, and never createdBy/createdAt", () => {
    const src = read(permissionCheckPath);

    const body =
      /export async function countPendingAgentProposals\([\s\S]*?\n\}/.exec(
        src
      );
    expect(
      body,
      "countPendingAgentProposals must still exist + be exported"
    ).not.toBeNull();
    const fn = body![0];

    expect(fn).toContain("eq(proposals.agentUserId, agentUserId)");
    expect(fn).toContain("eq(proposals.status, ProposalStatus.PENDING)");
    // THE REGRESSIONS: re-adding the human floor made the cap inert; re-adding
    // the day bound made it a throughput meter that "clear pending" can't move.
    expect(
      fn,
      "createdBy is overloaded — ANDing it here made the cap never fire"
    ).not.toContain("proposals.createdBy");
    expect(
      fn,
      "a created_at day bound made the cap a daily throughput meter"
    ).not.toContain("proposals.createdAt");

    // The enforcement call site passes the agent alone.
    expect(src).toContain("countPendingAgentProposals(attributionAgentUserId)");
  });

  it("the scorecard CALLS the enforcer's counter instead of re-deriving it", () => {
    const src = read(scorecardPath);

    expect(src).toMatch(
      /import\s*\{[^}]*countPendingAgentProposals[^}]*\}\s*from\s*["'][^"']*permission-check\.js["']/
    );
    expect(src).toContain("countPendingAgentProposals(agentId)");
    // A second copy of the predicate is how the reported posture drifted from
    // what the membrane enforces in the first place.
    expect(
      src,
      "the scorecard must not re-derive the pending-count predicate"
    ).not.toContain("eq(proposals.status, ProposalStatus.PENDING)");
  });
});
