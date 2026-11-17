/**
 * REAL-POSTGRES (PGlite) test for migration 0428: an agent's automatic
 * receipt names no reviewer (plan 8032a127 D4, finding d4d20c02).
 *
 * Fixture rows copy the founder's rows as the Hub read them on 17 Nov 2026,
 * and sit where a looser or tighter WHERE would disagree:
 *   - 7ad8bdde-shaped: a failed capture receipt, `source: 'agent'`, no agent,
 *     reviewer = the person 1 ms before creation → agent recorded from its
 *     session, reviewer cleared;
 *   - 6253b035-shaped: the person approved a pending capture that then
 *     failed, minutes later → keeps the person (a WHERE without the
 *     one-second rule clears it);
 *   - a person's own first-party capture (`source: 'capture'` / 'raycast',
 *     no agent) → keeps the person (a WHERE without the agent rule clears it);
 *   - an `approved` row an agent filed and the person approved → keeps them;
 *   - sessions with two agents, a playbook origin, or an agent that no longer
 *     exists → the agent stays unknown (never a guess), the reviewer still
 *     goes.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(HERE, "../migrations/0428_agent_receipts_name_no_reviewer.sql"),
  "utf8"
);

const FOUNDER = "e418d146-e495-4b8a-8e8b-985f9f885431";
const SCOUT = "592af5e1-3d3f-4d84-8a0e-461f4932cf97";
const OTHER_AGENT = "0e0403a8-7fc4-43da-8d59-b9d2d13b4dd1";
const GONE_AGENT = "deadbeef-0000-0000-0000-000000000000";

const CREATED = "2026-10-18T19:31:38.731Z";
const SAME = "2026-10-18T19:31:38.730Z"; // reviewed_at 1 ms before, as stored
const LATER = "2026-10-26T09:00:00.000Z";

let pg: PGlite;

type Row = {
  id: string;
  status: string;
  type?: string;
  agent?: string | null;
  source: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  session?: string | null;
};

const ROWS: Row[] = [
  // agent receipts, agent recorded
  {
    id: "p-auto",
    status: "auto_approved",
    agent: SCOUT,
    source: "agent",
    reviewedBy: FOUNDER,
    reviewedAt: SAME,
  },
  {
    id: "p-auto-capture-door",
    status: "auto_approved",
    agent: SCOUT,
    source: "capture",
    reviewedBy: FOUNDER,
    reviewedAt: SAME,
  },
  {
    id: "p-redecided",
    status: "auto_approved",
    type: "import.graph",
    agent: SCOUT,
    source: "agent",
    reviewedBy: FOUNDER,
    reviewedAt: LATER,
  },
  // agent receipts filed before 9f1f7c005: no agent on the row
  {
    id: "p-7ad8bdde",
    status: "approval_failed",
    source: "agent",
    reviewedBy: FOUNDER,
    reviewedAt: SAME,
    session: "s-scout",
  },
  {
    id: "p-old-auto",
    status: "auto_approved",
    source: "agent",
    reviewedBy: FOUNDER,
    reviewedAt: SAME,
    session: "s-scout",
  },
  {
    id: "p-two-agents",
    status: "auto_approved",
    source: "agent",
    reviewedBy: FOUNDER,
    reviewedAt: SAME,
    session: "s-two",
  },
  {
    id: "p-playbook",
    status: "approval_failed",
    source: "agent",
    reviewedBy: FOUNDER,
    reviewedAt: SAME,
    session: "s-playbook",
  },
  {
    id: "p-gone",
    status: "auto_approved",
    source: "agent",
    reviewedBy: FOUNDER,
    reviewedAt: SAME,
    session: "s-gone",
  },
  {
    id: "p-no-session",
    status: "auto_approved",
    source: "agent",
    reviewedBy: FOUNDER,
    reviewedAt: SAME,
    session: null,
  },
  // a person decided: kept
  {
    id: "p-6253b035",
    status: "approval_failed",
    source: "agent",
    reviewedBy: FOUNDER,
    reviewedAt: LATER,
    session: "s-scout",
  },
  {
    id: "p-approved",
    status: "approved",
    agent: SCOUT,
    source: "agent",
    reviewedBy: FOUNDER,
    reviewedAt: LATER,
  },
  {
    id: "p-failed-after-click",
    status: "approval_failed",
    agent: SCOUT,
    source: "agent",
    reviewedBy: FOUNDER,
    reviewedAt: LATER,
  },
  // a person's own first-party capture: kept
  {
    id: "p-own",
    status: "auto_approved",
    source: "capture",
    reviewedBy: FOUNDER,
    reviewedAt: SAME,
  },
  {
    id: "p-raycast",
    status: "auto_approved",
    source: "raycast",
    reviewedBy: FOUNDER,
    reviewedAt: SAME,
  },
  {
    id: "p-own-failed",
    status: "approval_failed",
    source: "capture",
    reviewedBy: FOUNDER,
    reviewedAt: SAME,
  },
];

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (id text PRIMARY KEY);
    CREATE TABLE focus_sessions (
      id text PRIMARY KEY, origin text, agent_ids text[] DEFAULT '{}'
    );
    CREATE TABLE proposals (
      id text PRIMARY KEY, status text NOT NULL, proposal_type text NOT NULL,
      agent_user_id text REFERENCES users(id), session_id text, data jsonb,
      reviewed_by text, reviewed_at timestamptz, created_at timestamptz NOT NULL
    );
    INSERT INTO users (id) VALUES ('${FOUNDER}'), ('${SCOUT}'), ('${OTHER_AGENT}');
    INSERT INTO focus_sessions (id, origin, agent_ids) VALUES
      ('s-scout', 'agent', ARRAY['${SCOUT}']),
      ('s-two', 'agent', ARRAY['${SCOUT}', '${OTHER_AGENT}']),
      ('s-playbook', 'playbook', ARRAY['${SCOUT}']),
      ('s-gone', 'agent', ARRAY['${GONE_AGENT}']);
  `);
  for (const r of ROWS) {
    await pg.query(
      `INSERT INTO proposals (id, status, proposal_type, agent_user_id, session_id, data, reviewed_by, reviewed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
      [
        r.id,
        r.status,
        r.type ?? "capture.graph",
        r.agent ?? null,
        r.session ?? null,
        JSON.stringify({ source: r.source }),
        r.reviewedBy,
        r.reviewedAt,
        CREATED,
      ]
    );
  }
  await pg.exec(MIGRATION);
  await pg.exec(MIGRATION); // re-runnable
});

const row = async (id: string) =>
  (
    await pg.query<{
      agent_user_id: string | null;
      reviewed_by: string | null;
      reviewed_at: Date | null;
    }>(
      `SELECT agent_user_id, reviewed_by, reviewed_at FROM proposals WHERE id = $1`,
      [id]
    )
  ).rows[0]!;

describe("0428 an agent's automatic receipt names no reviewer", () => {
  it("clears the person from every agent receipt, failed or applied, and keeps when it settled", async () => {
    for (const id of [
      "p-auto",
      "p-auto-capture-door",
      "p-redecided",
      "p-7ad8bdde",
      "p-old-auto",
      "p-two-agents",
      "p-playbook",
      "p-gone",
      "p-no-session",
    ]) {
      const r = await row(id);
      expect({ id, reviewedBy: r.reviewed_by }).toEqual({
        id,
        reviewedBy: null,
      });
      expect(r.reviewed_at).not.toBeNull();
    }
  });

  it("records the agent from a session that was ONE agent's, and guesses nothing else", async () => {
    expect((await row("p-7ad8bdde")).agent_user_id).toBe(SCOUT);
    expect((await row("p-old-auto")).agent_user_id).toBe(SCOUT);
    expect((await row("p-6253b035")).agent_user_id).toBe(SCOUT);
    for (const id of ["p-two-agents", "p-playbook", "p-gone", "p-no-session"]) {
      expect({ id, agent: (await row(id)).agent_user_id }).toEqual({
        id,
        agent: null,
      });
    }
  });

  it("keeps the person where a person decided, or did the write themselves", async () => {
    for (const id of [
      "p-6253b035",
      "p-approved",
      "p-failed-after-click",
      "p-own",
      "p-raycast",
      "p-own-failed",
    ]) {
      expect({ id, reviewedBy: (await row(id)).reviewed_by }).toEqual({
        id,
        reviewedBy: FOUNDER,
      });
    }
  });
});
