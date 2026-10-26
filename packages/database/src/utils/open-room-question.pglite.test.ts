/**
 * "Waits on the person" = an owed slot OR an open agent question in the
 * session's room — run through the REAL rendered SQL on PGlite.
 *
 * Why it exists: an external agent (a Claude Code routine) asks in the room
 * and STOPS. Before, a slotless question owed nothing, so the 24h reapers read
 * the session as abandoned and closed it under the open question.
 *
 * Each row names what it rules out:
 *   - an answered question still counted (the `answer` stamp ignored);
 *   - a question closed without an answer (its session ended, its agent
 *     withdrew it) still counted (the `closed` stamp ignored, Resolve-XP W2);
 *   - a deleted question still counted;
 *   - a HUMAN's message marked question counted (only agents ask);
 *   - a plain agent update counted as a question;
 *   - a CLOSED session's leftover question parking a run forever;
 *   - the owed-slot half dropped when the OR was added.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { sql as drizzleSql, type SQL } from "drizzle-orm";
import {
  closeOpenRoomQuestions,
  focusSessionWaitsOnPersonWhere,
  sessionWaitsOnPersonWhere,
} from "./open-room-question.js";

let client: PGlite;
const dialect = new PgDialect();

async function run(sql: SQL): Promise<Array<Record<string, unknown>>> {
  const q = dialect.sqlToQuery(sql);
  return (await client.query<Record<string, unknown>>(q.sql, q.params)).rows;
}

type Msg = {
  authorType?: string;
  kind?: string;
  answered?: boolean;
  closed?: boolean;
  deleted?: boolean;
  askedBy?: string;
};

async function session(p: {
  status?: string;
  slots?: unknown[];
  msgs?: Msg[];
  channel?: string;
}): Promise<string> {
  const id = randomUUID();
  const channel = p.channel ?? randomUUID();
  await client.query(
    `insert into focus_sessions (id, status, expected_outputs, channel_id) values ($1, $2, $3::jsonb, $4)`,
    [id, p.status ?? "active", JSON.stringify(p.slots ?? []), channel]
  );
  for (const m of p.msgs ?? []) {
    const roomPost: Record<string, unknown> = { kind: m.kind ?? "question" };
    if (m.answered) roomPost.answer = { text: "yes" };
    if (m.closed) roomPost.closed = { reason: "session_ended", at: "x" };
    await client.query(
      `insert into messages (id, channel_id, author_type, deleted_at, metadata, routed_teammate_id) values ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        randomUUID(),
        channel,
        m.authorType ?? "ai_agent",
        m.deleted ? new Date().toISOString() : null,
        JSON.stringify({ roomPost }),
        m.askedBy ?? null,
      ]
    );
  }
  return id;
}

async function waits(id: string): Promise<{ byId: boolean; byRow: boolean }> {
  const [a] = await run(
    drizzleSql`select ${sessionWaitsOnPersonWhere(drizzleSql`${id}::uuid`)} as w`
  );
  const rows = await run(
    drizzleSql`select id from focus_sessions where id = ${id}::uuid and ${focusSessionWaitsOnPersonWhere()}`
  );
  return { byId: a!.w === true, byRow: rows.length === 1 };
}

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    create table focus_sessions (id uuid primary key, status text, expected_outputs jsonb, channel_id uuid);
    create table messages (id uuid primary key, channel_id uuid, author_type text, deleted_at timestamptz, metadata jsonb, routed_teammate_id text);
  `);
});
afterAll(async () => {
  await client.close();
});

describe("session waits on the person", () => {
  it("an open agent question in the room ⇒ waits", async () => {
    expect(await waits(await session({ msgs: [{}] }))).toEqual({
      byId: true,
      byRow: true,
    });
  });

  it("an answered, deleted, human-authored or non-question post ⇒ does not wait", async () => {
    for (const m of [
      { answered: true },
      { closed: true },
      { deleted: true },
      { authorType: "human" },
      { kind: "update" },
    ] satisfies Msg[]) {
      expect(
        await waits(await session({ msgs: [m] })),
        JSON.stringify(m)
      ).toEqual({
        byId: false,
        byRow: false,
      });
    }
  });

  it("a CLOSED session's leftover question never parks a run (by-id is open-status gated)", async () => {
    const id = await session({ status: "closed", msgs: [{}] });
    expect((await waits(id)).byId).toBe(false);
  });

  it("an owed slot still waits without any question (the OR kept the slot half)", async () => {
    expect(
      await waits(await session({ slots: [{ owner: "human", label: "x" }] }))
    ).toEqual({ byId: true, byRow: true });
    expect(await waits(await session({}))).toEqual({
      byId: false,
      byRow: false,
    });
  });
});

describe("closeOpenRoomQuestions — the one writer of `roomPost.closed`", () => {
  const exec = () =>
    drizzle(client) as unknown as Parameters<typeof closeOpenRoomQuestions>[0];
  const closed = { reason: "session_ended" as const, at: "2026-10-26T00:00:00.000Z" };

  async function roomRows(channel: string) {
    return (
      await client.query<{ id: string; routed_teammate_id: string | null; metadata: { roomPost: Record<string, unknown> } }>(
        `select id, routed_teammate_id, metadata from messages where channel_id = $1`,
        [channel]
      )
    ).rows;
  }

  it("closes only the OPEN questions of the room, once, and the session stops waiting", async () => {
    const channel = randomUUID();
    const id = await session({
      channel,
      msgs: [{}, { answered: true }, { kind: "update" }, { authorType: "human" }],
    });
    // Another room's open question is never touched.
    const other = randomUUID();
    await session({ channel: other, msgs: [{}] });

    const first = await closeOpenRoomQuestions(exec(), { channelId: channel, closed });
    expect(first).toHaveLength(1);
    const rows = await roomRows(channel);
    const stamped = rows.filter((r) => "closed" in r.metadata.roomPost);
    expect(stamped.map((r) => r.id)).toEqual(first);
    // The answered one keeps its answer and gets no closure: an answer wins.
    expect(
      rows.filter((r) => "answer" in r.metadata.roomPost && "closed" in r.metadata.roomPost)
    ).toEqual([]);
    expect(await waits(id)).toEqual({ byId: false, byRow: false });
    // Idempotent: nothing is open any more.
    expect(await closeOpenRoomQuestions(exec(), { channelId: channel, closed })).toEqual([]);
    const otherRows = await roomRows(other);
    expect(otherRows.every((r) => !("closed" in r.metadata.roomPost))).toBe(true);
  });

  it("narrows to named questions and to the asking agent", async () => {
    const channel = randomUUID();
    await session({
      channel,
      msgs: [{ askedBy: "agent-a" }, { askedBy: "agent-a" }, { askedBy: "agent-b" }],
    });
    const rows = await roomRows(channel);
    const [a1, a2] = rows.filter((r) => r.routed_teammate_id === "agent-a");
    const b = rows.find((r) => r.routed_teammate_id === "agent-b")!;

    // Naming another agent's question while narrowing to agent-a closes nothing.
    expect(
      await closeOpenRoomQuestions(exec(), {
        channelId: channel,
        messageIds: [b.id],
        askedBy: "agent-a",
        closed: { ...closed, reason: "withdrawn", by: "agent-a" },
      })
    ).toEqual([]);
    expect(
      await closeOpenRoomQuestions(exec(), {
        channelId: channel,
        messageIds: [a1!.id],
        askedBy: "agent-a",
        closed: { ...closed, reason: "withdrawn", by: "agent-a", note: "overtaken" },
      })
    ).toEqual([a1!.id]);
    // An empty list names nothing — never "every question".
    expect(
      await closeOpenRoomQuestions(exec(), { channelId: channel, messageIds: [], closed })
    ).toEqual([]);
    const after = await roomRows(channel);
    const byId = new Map(after.map((r) => [r.id, r.metadata.roomPost]));
    expect(byId.get(a1!.id)!.closed).toMatchObject({ reason: "withdrawn", note: "overtaken" });
    expect(byId.get(a2!.id)!.closed).toBeUndefined();
    expect(byId.get(b.id)!.closed).toBeUndefined();
  });
});
