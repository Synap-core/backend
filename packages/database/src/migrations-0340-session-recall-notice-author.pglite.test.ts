/**
 * REAL-POSTGRES (PGlite) test for migration 0340 — the session-recall notice
 * written before `postChannelMessage` stamped pod posts `bot` was stored as
 * `author_type = 'human'`.
 *
 * Pinned: only the recall notice (fixed copy, assistant role, no routed agent,
 * in a focus session's room) is repaired; a person's own post with the same
 * words, the same words outside a session room, and an unrelated
 * assistant+human row (a person's authorised connector send) are untouched;
 * running it twice changes nothing more.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0340 = readFileSync(
  resolve(HERE, "../migrations/0340_session_recall_notice_author_bot.sql"),
  "utf8"
);

const NOTICE =
  "Found 2 things you captured earlier that may help this session:\n- A (note) — close in meaning to this session";

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create table focus_sessions (id text primary key, channel_id text);
    create table messages (
      id text primary key, channel_id text not null, role text not null,
      author_type text not null default 'human', routed_teammate_id text,
      content text not null
    );
    insert into focus_sessions values ('s1', 'room-session');
  `);
  const row = (
    id: string,
    channel: string,
    role: string,
    content: string,
    routed: string | null = null
  ) =>
    db.query(
      `insert into messages (id, channel_id, role, content, routed_teammate_id) values ($1,$2,$3,$4,$5)`,
      [id, channel, role, content, routed]
    );
  await row("recall", "room-session", "assistant", NOTICE);
  await row("recall-one", "room-session", "assistant", "Found 1 thing you captured earlier that may help this session:\n- A");
  await row("person-same-words", "room-session", "user", NOTICE);
  await row("other-room", "room-other", "assistant", NOTICE);
  await row("agent-same-words", "room-session", "assistant", NOTICE, "agent-1");
  await row("connector-send", "room-session", "assistant", "Thanks, see you Tuesday");
  return db;
}

const authors = async (db: PGlite) =>
  Object.fromEntries(
    (
      await db.query<{ id: string; author_type: string }>(
        `select id, author_type from messages order by id`
      )
    ).rows.map((r) => [r.id, r.author_type])
  );

describe("migration 0340 — recall notice author", () => {
  it("repairs only the recall notice, and is idempotent", async () => {
    const db = await setup();
    await db.exec(M0340);
    const once = await authors(db);
    expect(once).toEqual({
      recall: "bot",
      "recall-one": "bot",
      "person-same-words": "human",
      "other-room": "human",
      "agent-same-words": "human",
      "connector-send": "human",
    });
    await db.exec(M0340);
    expect(await authors(db)).toEqual(once);
  });
});
