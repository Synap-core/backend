/**
 * REAL-POSTGRES (PGlite) test for migration 0428: an agent's automatic
 * receipt names no reviewer. Each fixture row sits where a looser or tighter
 * WHERE would disagree:
 *   - a failed capture receipt, `source: 'agent'`, no agent, reviewed 1 ms
 *     before creation → agent recorded from its session, reviewer cleared;
 *   - a person approved a pending capture that failed minutes later → keeps
 *     the person (a WHERE without the one-second rule clears it);
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

const PERSON = "11111111-1111-4111-8111-111111111111";
const SCOUT = "22222222-2222-4222-8222-222222222222";
const OTHER_AGENT = "33333333-3333-4333-8333-333333333333";
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
    reviewedBy: PERSON,
    reviewedAt: SAME,
  },
  {
    id: "p-auto-capture-door",
    status: "auto_approved",
    agent: SCOUT,
    source: "capture",
    reviewedBy: PERSON,
    reviewedAt: SAME,
  },
  {
    id: "p-redecided",
    status: "auto_approved",
    type: "import.graph",
    agent: SCOUT,
    source: "agent",
    reviewedBy: PERSON,
    reviewedAt: LATER,
  },
  // agent receipts filed before 9f1f7c005: no agent on the row
  {
    id: "p-agent-failed",
    status: "approval_failed",
    source: "agent",
    reviewedBy: PERSON,
    reviewedAt: SAME,
    session: "s-scout",
  },
  {
    id: "p-old-auto",
    status: "auto_approved",
    source: "agent",
    reviewedBy: PERSON,
    reviewedAt: SAME,
    session: "s-scout",
  },
  {
    id: "p-two-agents",
    status: "auto_approved",
    source: "agent",
    reviewedBy: PERSON,
    reviewedAt: SAME,
    session: "s-two",
  },
  {
    id: "p-playbook",
    status: "approval_failed",
    source: "agent",
    reviewedBy: PERSON,
    reviewedAt: SAME,
    session: "s-playbook",
  },
  {
    id: "p-gone",
    status: "auto_approved",
    source: "agent",
    reviewedBy: PERSON,
    reviewedAt: SAME,
    session: "s-gone",
  },
  {
    id: "p-no-session",
    status: "auto_approved",
    source: "agent",
    reviewedBy: PERSON,
    reviewedAt: SAME,
    session: null,
  },
  // a person decided: kept
  {
    id: "p-person-failed",
    status: "approval_failed",
    source: "agent",
    reviewedBy: PERSON,
    reviewedAt: LATER,
    session: "s-scout",
  },
  {
    id: "p-approved",
    status: "approved",
    agent: SCOUT,
    source: "agent",
    reviewedBy: PERSON,
    reviewedAt: LATER,
  },
  {
    id: "p-failed-after-click",
    status: "approval_failed",
    agent: SCOUT,
    source: "agent",
    reviewedBy: PERSON,
    reviewedAt: LATER,
  },
  // not a receipt: never given an agent (a pending one would count toward
  // that agent's pending cap), never touched
  {
    id: "p-pending",
    status: "pending",
    source: "agent",
    reviewedBy: null,
    reviewedAt: null,
    session: "s-scout",
  },
  {
    id: "p-rejected",
    status: "rejected",
    source: "agent",
    reviewedBy: PERSON,
    reviewedAt: LATER,
    session: "s-scout",
  },
  // a person's own first-party capture: kept
  {
    id: "p-own",
    status: "auto_approved",
    source: "capture",
    reviewedBy: PERSON,
    reviewedAt: SAME,
  },
  {
    id: "p-raycast",
    status: "auto_approved",
    source: "raycast",
    reviewedBy: PERSON,
    reviewedAt: SAME,
  },
  {
    id: "p-own-failed",
    status: "approval_failed",
    source: "capture",
    reviewedBy: PERSON,
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
    INSERT INTO users (id) VALUES ('${PERSON}'), ('${SCOUT}'), ('${OTHER_AGENT}');
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
      "p-agent-failed",
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
    expect((await row("p-agent-failed")).agent_user_id).toBe(SCOUT);
    expect((await row("p-old-auto")).agent_user_id).toBe(SCOUT);
    expect((await row("p-person-failed")).agent_user_id).toBe(SCOUT);
    for (const id of [
      "p-two-agents",
      "p-playbook",
      "p-gone",
      "p-no-session",
      "p-pending",
      "p-rejected",
    ]) {
      expect({ id, agent: (await row(id)).agent_user_id }).toEqual({
        id,
        agent: null,
      });
    }
  });

  it("keeps the person where a person decided, or did the write themselves", async () => {
    for (const id of [
      "p-person-failed",
      "p-rejected",
      "p-approved",
      "p-failed-after-click",
      "p-own",
      "p-raycast",
      "p-own-failed",
    ]) {
      expect({ id, reviewedBy: (await row(id)).reviewed_by }).toEqual({
        id,
        reviewedBy: PERSON,
      });
    }
  });
});
