/**
 * What an agent's PLAN made, once a person approved it, is that agent's own
 * fresh work (`isOwnFreshWork`): it may file it or close it through the
 * own-organise class like work it made directly. The proof is the record of
 * what the approval materialized, on a proposal this agent filed through this
 * key; the approval's own create event is the making, not a person's touch.
 *
 * Rows where a naive reading disagrees: a plan-made session (it carries no
 * client key, and its create event names no agent); the same plan filed
 * through ANOTHER key (not this computer's work); a person's edit after the
 * approval (touched); a plan still pending (nothing was made).
 *
 * Real `isOwnFreshWork` on PGlite with every table.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@synap/database/schema";
import { isOwnFreshWork, writePodNumberSetting } from "@synap/database";
import { allSchemaTables, pgliteSchemaDdl } from "../__tests__/pglite-ddl.js";

const AGENT = randomUUID();
const HUMAN = randomUUID();
const KEY = randomUUID();
const OTHER_KEY = randomUUID();

let client: PGlite;
let db: ReturnType<typeof drizzle>;
const q = (sql: string, params?: unknown[]) => client.query(sql, params);

async function planMadeSession(opts: {
  key: string;
  status?: string;
  personEditAfter?: boolean;
  editedAtApproval?: boolean;
}): Promise<string> {
  const session = randomUUID();
  const proposal = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, metadata, created_at, updated_at) values ($1, $2, 'Plan step', 'active', '{}'::jsonb, now(), now())`,
    [session, HUMAN]
  );
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, agent_user_id, api_key_id, created_by, data, created_at, updated_at)
     values ($1, $2, 'create', 'composite', $3, $4, $5, $6, $7::jsonb, now(), now())`,
    [
      proposal,
      opts.status ?? "approved",
      randomUUID(),
      AGENT,
      opts.key,
      HUMAN,
      JSON.stringify({
        materialized: {
          sessionIds: [session],
          byOp: { s1: { op: "create_session", sessionId: session } },
        },
        ...(opts.editedAtApproval
          ? { dispositions: { s1: { status: "edit", edits: { goal: "x" } } } }
          : {}),
      }),
    ]
  );
  // The approval's own create event: as the session's person, no agent.
  await q(
    `insert into events (id, type, subject_id, user_id, source, is_agent, timestamp) values ($1, 'focus_session.create.completed', $2, $3, 'intelligence', false, now())`,
    [randomUUID(), session, HUMAN]
  );
  if (opts.personEditAfter) {
    await q(
      `insert into events (id, type, subject_id, user_id, source, is_agent, timestamp) values ($1, 'focus_session.update.completed', $2, $3, 'api', false, now())`,
      [randomUUID(), session, HUMAN]
    );
  }
  return session;
}

const own = (session: string) =>
  isOwnFreshWork(db as never, {
    agentUserId: AGENT,
    apiKeyId: KEY,
    subjectType: "focus_session",
    subjectIds: [session],
  });

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await client.exec(pgliteSchemaDdl(allSchemaTables()));
}, 120_000);

describe("what an agent's approved plan made is its own fresh work", () => {
  it("a session its plan made, through this key, untouched since", async () => {
    expect(await own(await planMadeSession({ key: KEY }))).toBe(true);
  });

  it("not when the plan was filed through another key", async () => {
    expect(await own(await planMadeSession({ key: OTHER_KEY }))).toBe(false);
  });

  it("not once a person edited it after the approval", async () => {
    expect(
      await own(await planMadeSession({ key: KEY, personEditAfter: true }))
    ).toBe(false);
  });

  it("not an item the reviewer edited at approval: that is the person's work too", async () => {
    expect(
      await own(await planMadeSession({ key: KEY, editedAtApproval: true }))
    ).toBe(false);
  });

  it("not while the plan is still pending", async () => {
    expect(
      await own(await planMadeSession({ key: KEY, status: "pending" }))
    ).toBe(false);
  });

  it("fresh is the pod's own-work window, not a constant", async () => {
    // A session this key opened (its client key), not a plan's: the window
    // is the only thing this case reads.
    const twoHoursOld = randomUUID();
    const made = new Date(Date.now() - 2 * 3_600_000);
    await q(
      `insert into focus_sessions (id, user_id, goal, status, metadata, created_at, updated_at) values ($1, $2, 'Own step', 'active', $3::jsonb, $4, $4)`,
      [twoHoursOld, HUMAN, JSON.stringify({ clientKey: `key:${KEY}` }), made]
    );
    expect(await own(twoHoursOld)).toBe(true);
    await writePodNumberSetting(db as never, {
      key: "governance.own_work_fresh_hours",
      value: 1,
      createdBy: HUMAN,
    });
    expect(await own(twoHoursOld)).toBe(false);
  });
});
