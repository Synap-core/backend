/**
 * REAL-POSTGRES (PGlite) test for migration 0358 — a session that ended stops
 * asking (founder, 2026-10-26). Minimal tables carry the columns the migration
 * reads; it runs TWICE.
 *
 * Each row names what it rules out:
 *   - an ended session's open question left open (it stays in needs-you);
 *   - an OPEN session's question, an answered one, a human's, an update or a
 *     deleted question stamped;
 *   - an act / form / no-ask slot retired (a person's deliverable stays owed);
 *   - a criterion grade retired (its `choose` is the person's verdict on the
 *     scorecard, not the agent's need to go on);
 *   - a confirm, a choose, or an ask-less `decision` slot left owed;
 *   - a done, already retired, optional or agent-owned slot re-stamped;
 *   - a slot moved (order kept) or a second run re-stamping (`at` stable).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0358 = readFileSync(
  resolve(HERE, "../migrations/0358_session_end_closes_questions.sql"),
  "utf8"
);

let pg: PGlite;

const CLOSED_AT = "2026-10-01T10:00:00.000Z";
const ENDED = randomUUID();
const ENDED_ROOM = randomUUID();
const OPEN_ROOM = randomUUID();

const Q = {
  open: randomUUID(),
  answered: randomUUID(),
  human: randomUUID(),
  update: randomUUID(),
  deleted: randomUUID(),
  liveRoom: randomUUID(),
};

const SLOTS = [
  {
    kind: "decision",
    label: "confirm",
    owner: "human",
    ask: { mode: "confirm" },
  },
  {
    kind: "decision",
    label: "choose",
    owner: "human",
    ask: { mode: "choose", options: [] },
  },
  {
    kind: "decision",
    label: "bare decision",
    owner: "human",
    blockedReason: "decision",
  },
  {
    kind: "playbook_param",
    label: "param",
    owner: "human",
    blockedReason: "decision",
  },
  { kind: "doc", label: "act", owner: "human", ask: { mode: "act" } },
  { kind: "doc", label: "form", owner: "human", ask: { mode: "form" } },
  {
    kind: "credential",
    label: "no ask",
    owner: "human",
    blockedReason: "credential",
  },
  {
    kind: "decision",
    label: "done",
    owner: "human",
    status: "done",
    ask: { mode: "confirm" },
  },
  {
    kind: "decision",
    label: "retired",
    owner: "human",
    retiredAt: "x",
    retiredReason: "withdrawn",
    ask: { mode: "confirm" },
  },
  {
    kind: "decision",
    label: "optional",
    owner: "human",
    optional: true,
    ask: { mode: "confirm" },
  },
  { kind: "decision", label: "agent", ask: { mode: "confirm" } },
  {
    kind: "criterion",
    label: "criterion",
    owner: "human",
    criterionKey: "tests-pass",
    ask: { mode: "choose", options: [] },
  },
];

async function msg(
  id: string,
  channel: string,
  roomPost: Record<string, unknown>,
  extra: { author?: string; deleted?: boolean } = {}
) {
  await pg.query(
    `INSERT INTO messages (id, channel_id, author_type, deleted_at, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      id,
      channel,
      extra.author ?? "ai_agent",
      extra.deleted ? new Date().toISOString() : null,
      JSON.stringify({ roomPost }),
    ]
  );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE focus_sessions (id uuid PRIMARY KEY, status text NOT NULL, channel_id uuid, closed_at timestamptz, expected_outputs jsonb);
    CREATE TABLE messages (id uuid PRIMARY KEY, channel_id uuid NOT NULL, author_type text NOT NULL, deleted_at timestamptz, metadata jsonb);
  `);
  await pg.query(
    `INSERT INTO focus_sessions (id, status, channel_id, closed_at, expected_outputs) VALUES ($1, 'closed', $2, $3, $4::jsonb)`,
    [ENDED, ENDED_ROOM, CLOSED_AT, JSON.stringify(SLOTS)]
  );
  // An open session with the same owed asks: never touched.
  await pg.query(
    `INSERT INTO focus_sessions (id, status, channel_id, expected_outputs) VALUES ($1, 'active', $2, $3::jsonb)`,
    [randomUUID(), OPEN_ROOM, JSON.stringify(SLOTS)]
  );
  await msg(Q.open, ENDED_ROOM, { kind: "question" });
  await msg(Q.answered, ENDED_ROOM, {
    kind: "question",
    answer: { text: "yes" },
  });
  await msg(Q.human, ENDED_ROOM, { kind: "question" }, { author: "human" });
  await msg(Q.update, ENDED_ROOM, { kind: "update" });
  await msg(Q.deleted, ENDED_ROOM, { kind: "question" }, { deleted: true });
  await msg(Q.liveRoom, OPEN_ROOM, { kind: "question" });
  await pg.exec(M0358);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

async function roomPost(id: string): Promise<Record<string, unknown>> {
  const r = await pg.query<{ metadata: { roomPost: Record<string, unknown> } }>(
    `SELECT metadata FROM messages WHERE id = $1`,
    [id]
  );
  return r.rows[0]!.metadata.roomPost;
}

async function slots(status: string) {
  const r = await pg.query<{
    expected_outputs: Array<Record<string, unknown>>;
  }>(`SELECT expected_outputs FROM focus_sessions WHERE status = $1`, [status]);
  return r.rows[0]!.expected_outputs;
}

describe("migration 0358 — a session that ended stops asking", () => {
  it("closes the ended session's open agent question, stamped at its closed_at", async () => {
    expect((await roomPost(Q.open)).closed).toEqual({
      reason: "session_ended",
      at: CLOSED_AT,
    });
  });

  it("leaves answered, human, update and deleted posts, and an open session's question", async () => {
    for (const id of [Q.answered, Q.human, Q.update, Q.deleted, Q.liveRoom]) {
      expect((await roomPost(id)).closed, id).toBeUndefined();
    }
  });

  it("retires exactly the session-bound asks, in place", async () => {
    const after = await slots("closed");
    expect(after.map((s) => s.label)).toEqual(SLOTS.map((s) => s.label));
    const retired = after
      .filter((s) => s.retiredReason === "session_ended")
      .map((s) => s.label);
    expect(retired).toEqual(["confirm", "choose", "bare decision"]);
    for (const s of after.filter((x) => x.retiredReason === "session_ended")) {
      expect(s.retiredAt).toBe(CLOSED_AT);
    }
    // The rest are byte-for-byte what they were.
    const untouched = after.filter((s) => s.retiredReason !== "session_ended");
    expect(untouched).toEqual(
      SLOTS.filter(
        (s) => !["confirm", "choose", "bare decision"].includes(s.label)
      )
    );
  });

  it("never touches an open session", async () => {
    expect(await slots("active")).toEqual(SLOTS);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const before = JSON.stringify(await slots("closed"));
    const q = JSON.stringify(await roomPost(Q.open));
    await pg.exec(M0358);
    expect(JSON.stringify(await slots("closed"))).toBe(before);
    expect(JSON.stringify(await roomPost(Q.open))).toBe(q);
  });
});
