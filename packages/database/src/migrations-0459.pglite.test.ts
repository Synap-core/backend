/**
 * REAL-POSTGRES (PGlite) test for migration 0459 — an index on
 * `proposals(session_id, created_at DESC)`.
 *
 * The needs-you clocks (`utils/needs-you-predicate.ts`) read, once per
 * session row, the newest agent proposal of that session:
 *   (SELECT max(created_at) FROM proposals
 *     WHERE session_id = <row id> AND agent_user_id IS NOT NULL)
 * Postgres plans a lone max() as `ORDER BY created_at DESC LIMIT 1`, and
 * 0288's `idx_proposals_created_at_id` offers that order. Without an index
 * that leads with session_id and orders by created_at, the planner walks the
 * whole created_at index, filtering session_id row by row: a session with NO
 * agent proposal (an automation run) reads every proposal. The work graph
 * asks it for up to 500 such rows in one read.
 *
 * This pins the plan on the exact correlated shape, before and after, and
 * reads the rows the walk threw away for a session with no proposal.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0459 = readFileSync(
  resolve(HERE, "../migrations/0459_proposals_session_created_at_index.sql"),
  "utf8"
);

const PROPOSALS = 40_000;
const BUSY_SESSIONS = 40;
/** A session with no proposal at all: an automation run's. */
const EMPTY_SESSION = "00000000-0000-4000-8000-0000000000e0";

/** The clocks' own correlated shape, for the session with no proposal. */
const CLOCK = `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
  SELECT fs.id,
         (SELECT max(p.created_at) FROM proposals p
           WHERE p.session_id = fs.id AND p.agent_user_id IS NOT NULL) AS at
    FROM focus_sessions fs
   WHERE fs.id = '${EMPTY_SESSION}'`;

let pg: PGlite;

async function plan(): Promise<string> {
  const r = await pg.query<{ "QUERY PLAN": string }>(CLOCK);
  return r.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

/** The largest "Rows Removed by Filter" in the plan (0 when none). */
function rowsThrownAway(text: string): number {
  const counts = [...text.matchAll(/Rows Removed by Filter: (\d+)/g)].map((m) =>
    Number(m[1])
  );
  return counts.length ? Math.max(...counts) : 0;
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE focus_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid()
    );
    CREATE TABLE proposals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id uuid REFERENCES focus_sessions(id) ON DELETE SET NULL,
      agent_user_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    -- The indexes proposals carried before 0459: the session lookup
    -- (baseline / 0119) and the activity ledger's order (0288).
    CREATE INDEX idx_proposals_session_id ON proposals (session_id);
    CREATE INDEX idx_proposals_created_at_id
      ON proposals (created_at DESC, id DESC);

    -- A pod: agent sessions holding many proposals each, filed over time,
    -- and one automation run with none.
    INSERT INTO focus_sessions (id)
      SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid
        FROM generate_series(1, ${BUSY_SESSIONS}) g;
    INSERT INTO focus_sessions (id) VALUES ('${EMPTY_SESSION}');
    INSERT INTO proposals (session_id, agent_user_id, created_at)
      SELECT ('00000000-0000-4000-8000-' ||
               lpad(((g % ${BUSY_SESSIONS}) + 1)::text, 12, '0'))::uuid,
             'agent-1',
             now() - make_interval(secs => g)
        FROM generate_series(1, ${PROPOSALS}) g;
    ANALYZE focus_sessions;
    ANALYZE proposals;
  `);
}, 120_000);

describe("migration 0459 — proposals(session_id, created_at DESC)", () => {
  it("before: a session with no proposal walks the created_at index past every proposal", async () => {
    const before = await plan();
    expect(before).toMatch(/idx_proposals_created_at_id/);
    expect(rowsThrownAway(before)).toBe(PROPOSALS);
  });

  it("after: one descent bounded by the session reads nothing for it; re-running is a no-op", async () => {
    await pg.exec(M0459);
    await pg.exec(M0459); // idempotent
    await pg.exec("ANALYZE proposals;");
    const after = await plan();
    expect(after).toMatch(/idx_proposals_session_created_at/);
    expect(after).not.toMatch(/idx_proposals_created_at_id/);
    expect(rowsThrownAway(after)).toBe(0);
    const idx = await pg.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_proposals_session_created_at'`
    );
    expect(idx.rows).toHaveLength(1);
    expect(idx.rows[0]!.indexdef).toMatch(/\(session_id, created_at DESC\)/);
  });
});
