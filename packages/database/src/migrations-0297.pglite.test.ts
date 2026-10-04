/**
 * REAL-POSTGRES (PGlite) test for migration 0297 — the session ACTIVITY
 * ledger NOTIFYs `focus_session_changed` (founder decision D2, 2026-10-04).
 *
 * 0277's listener (`session-changed-listener.ts`, pglite-tested on its own:
 * coalescing, id-only body, audience = the session's readers) turns each
 * NOTIFY into `focus_session:updated`. This file pins only the NEW producers:
 * which activity writes notify, with WHICH session id, and which deliberately
 * do not (a streamed frame, a token delta, a human message) — so the push is
 * live without becoming a firehose.
 *
 * Tables are the minimal slices the triggers read (enums as text), plus 0277's
 * ledger function, which 0297 reuses.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const M0277 = read("0277_focus_session_changed_notify.sql");
const M0297 = read("0297_session_activity_notify.sql");

let pg: PGlite;
let heard: string[] = [];
const SESSION = randomUUID();
const OTHER_SESSION = randomUUID();
const ROOM = randomUUID();
const OTHER_ROOM = randomUUID();
const TURN = randomUUID();

const settle = () => new Promise((r) => setTimeout(r, 30));

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE focus_sessions (
      id uuid PRIMARY KEY, user_id text NOT NULL, channel_id uuid
    );
    CREATE TABLE session_evaluations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL
    );
    CREATE TABLE events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type text NOT NULL,
      session_id uuid
    );
    CREATE TABLE proposals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text NOT NULL,
      session_id uuid, data jsonb
    );
    CREATE TABLE chat_turns (
      id uuid PRIMARY KEY, channel_id uuid NOT NULL, status text NOT NULL,
      last_event_seq integer NOT NULL DEFAULT 0
    );
    CREATE TABLE chat_turn_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), turn_id uuid NOT NULL,
      type text NOT NULL
    );
    CREATE TABLE messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), channel_id uuid NOT NULL,
      author_type text NOT NULL
    );
  `);
  await pg.exec(M0277);
  await pg.exec(M0297);
  await pg.exec(M0297); // idempotent: a second run must not fail or double up
  await pg.query(
    `INSERT INTO focus_sessions VALUES ($1, 'u', $2), ($3, 'u', $4)`,
    [SESSION, ROOM, OTHER_SESSION, OTHER_ROOM]
  );
  await pg.query(
    `INSERT INTO chat_turns (id, channel_id, status) VALUES ($1, $2, 'completed')`,
    [TURN, ROOM]
  );
  await pg.listen("focus_session_changed", (p) => heard.push(p));
});

beforeEach(async () => {
  await settle();
  heard = [];
});

describe("migration 0297 — activity writes push the SESSION", () => {
  it("each trigger exists exactly once after two runs", async () => {
    const { rows } = await pg.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
         AND tgname LIKE '%session_activity_notify' ORDER BY tgname`
    );
    expect(rows.map((r) => r.tgname)).toEqual([
      "trg_chat_turn_events_session_activity_notify",
      "trg_chat_turns_session_activity_notify",
      "trg_events_session_activity_notify",
      "trg_messages_session_activity_notify",
      "trg_proposals_session_activity_notify",
    ]);
  });

  it("an agent's governed write filed under the session", async () => {
    await pg.query(
      `INSERT INTO events (type, session_id) VALUES ('entity.create.completed', $1)`,
      [SESSION]
    );
    await settle();
    expect(heard).toEqual([SESSION]);
  });

  it("an event with no session pushes nothing", async () => {
    await pg.query(
      `INSERT INTO events (type) VALUES ('entity.create.completed')`
    );
    await settle();
    expect(heard).toEqual([]);
  });

  it("a proposal filed, then decided", async () => {
    const id = randomUUID();
    await pg.query(
      `INSERT INTO proposals (id, status, session_id) VALUES ($1, 'pending', $2)`,
      [id, SESSION]
    );
    await settle();
    await pg.query(`UPDATE proposals SET status = 'approved' WHERE id = $1`, [
      id,
    ]);
    await settle();
    expect(heard).toEqual([SESSION, SESSION]);
    heard = [];
    // A non-status edit (e.g. a revised payload) is not activity.
    await pg.query(`UPDATE proposals SET data = '{}'::jsonb WHERE id = $1`, [
      id,
    ]);
    await settle();
    expect(heard).toEqual([]);
  });

  it("a turn starting and finishing in the session's room — not each streamed frame", async () => {
    const turn = randomUUID();
    await pg.query(
      `INSERT INTO chat_turns (id, channel_id, status) VALUES ($1, $2, 'running')`,
      [turn, ROOM]
    );
    await settle();
    expect(heard).toEqual([SESSION]);
    heard = [];
    await pg.query(
      `UPDATE chat_turns SET last_event_seq = last_event_seq + 1 WHERE id = $1`,
      [turn]
    );
    await settle();
    expect(heard).toEqual([]);
    await pg.query(`UPDATE chat_turns SET status = 'completed' WHERE id = $1`, [
      turn,
    ]);
    await settle();
    expect(heard).toEqual([SESSION]);
  });

  it("a turn's tool step reaches the session through its room; a token delta does not", async () => {
    await pg.query(
      `INSERT INTO chat_turn_events (turn_id, type) VALUES ($1, 'delta')`,
      [TURN]
    );
    await settle();
    expect(heard).toEqual([]);
    await pg.query(
      `INSERT INTO chat_turn_events (turn_id, type) VALUES ($1, 'step')`,
      [TURN]
    );
    await settle();
    expect(heard).toEqual([SESSION]);
  });

  it("an agent note in the room pushes; a human message does not; another room's note pushes ITS session", async () => {
    await pg.query(
      `INSERT INTO messages (channel_id, author_type) VALUES ($1, 'human')`,
      [ROOM]
    );
    await settle();
    expect(heard).toEqual([]);
    await pg.query(
      `INSERT INTO messages (channel_id, author_type) VALUES ($1, 'ai_agent')`,
      [ROOM]
    );
    await pg.query(
      `INSERT INTO messages (channel_id, author_type) VALUES ($1, 'ai_agent')`,
      [OTHER_ROOM]
    );
    await settle();
    expect(heard).toEqual([SESSION, OTHER_SESSION]);
  });

  it("the payload is the session id ONLY", async () => {
    await pg.query(
      `INSERT INTO events (type, session_id) VALUES ('entity.update.completed', $1)`,
      [SESSION]
    );
    await settle();
    expect(heard).toEqual([SESSION]); // non-vacuous: the loop below sees a payload
    for (const p of heard) expect(p).toMatch(/^[0-9a-f-]{36}$/);
  });
});
