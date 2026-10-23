/**
 * REAL-POSTGRES (PGlite) test for migration 0341 — the session OWNER's room
 * message NOTIFYs `focus_session_changed`, so the session change feed's wait
 * (`waitForSessionChanges`, kind `owner_message`) wakes at once instead of on
 * its 5 s fallback poll.
 *
 * Pins the SAME predicate the feed reads with: role 'user' + author 'human' +
 * author = the session's owner. A teammate, an agent post (0297's job) and the
 * pod's recall notice (role 'assistant', author 'human') notify nothing here;
 * and only the sessions of THAT room whose owner wrote it are named.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0341 = readFileSync(
  resolve(HERE, "../migrations/0341_session_owner_message_notify.sql"),
  "utf8"
);

let pg: PGlite;
let heard: string[] = [];
const OWNER = "owner";
const TEAMMATE = "teammate";
const SESSION = randomUUID();
const TEAMMATE_SESSION = randomUUID();
const OTHER_ROOM_SESSION = randomUUID();
const ROOM = randomUUID();
const OTHER_ROOM = randomUUID();

const settle = () => new Promise((r) => setTimeout(r, 30));
const post = (room: string, userId: string, role: string, authorType: string) =>
  pg.query(
    `INSERT INTO messages (channel_id, user_id, role, author_type) VALUES ($1, $2, $3, $4)`,
    [room, userId, role, authorType]
  );

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE focus_sessions (
      id uuid PRIMARY KEY, user_id text NOT NULL, channel_id uuid
    );
    CREATE TABLE messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), channel_id uuid NOT NULL,
      user_id text NOT NULL, role text NOT NULL, author_type text NOT NULL
    );
  `);
  await pg.exec(M0341);
  await pg.exec(M0341); // idempotent: a second run must not fail or double up
  await pg.query(
    `INSERT INTO focus_sessions VALUES ($1, $2, $3), ($4, $5, $3), ($6, $2, $7)`,
    [
      SESSION,
      OWNER,
      ROOM,
      TEAMMATE_SESSION,
      TEAMMATE,
      OTHER_ROOM_SESSION,
      OTHER_ROOM,
    ]
  );
  await pg.listen("focus_session_changed", (p) => heard.push(p));
});

beforeEach(async () => {
  await settle();
  heard = [];
});

describe("migration 0341 — the owner's room message wakes the session", () => {
  it("the trigger exists exactly once after two runs", async () => {
    const { rows } = await pg.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
         AND tgname = 'trg_messages_session_owner_message_notify'`
    );
    expect(rows).toHaveLength(1);
  });

  it("the owner typing in the room names THEIR session — not a teammate's session in the same room", async () => {
    await post(ROOM, OWNER, "user", "human");
    await settle();
    expect(heard).toEqual([SESSION]);
  });

  it("a teammate typing wakes only the teammate's own session", async () => {
    await post(ROOM, TEAMMATE, "user", "human");
    await settle();
    expect(heard).toEqual([TEAMMATE_SESSION]);
  });

  it("an agent post, a recall notice and a system line notify nothing here", async () => {
    await post(ROOM, OWNER, "assistant", "ai_agent");
    await post(ROOM, OWNER, "assistant", "human");
    await post(ROOM, OWNER, "system", "human");
    await settle();
    expect(heard).toEqual([]);
  });
});
