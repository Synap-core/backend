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
import { sql as drizzleSql, type SQL } from "drizzle-orm";
import {
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
  deleted?: boolean;
};

async function session(p: {
  status?: string;
  slots?: unknown[];
  msgs?: Msg[];
}): Promise<string> {
  const id = randomUUID();
  const channel = randomUUID();
  await client.query(
    `insert into focus_sessions (id, status, expected_outputs, channel_id) values ($1, $2, $3::jsonb, $4)`,
    [id, p.status ?? "active", JSON.stringify(p.slots ?? []), channel]
  );
  for (const m of p.msgs ?? []) {
    const roomPost: Record<string, unknown> = { kind: m.kind ?? "question" };
    if (m.answered) roomPost.answer = { text: "yes" };
    await client.query(
      `insert into messages (id, channel_id, author_type, deleted_at, metadata) values ($1, $2, $3, $4, $5::jsonb)`,
      [
        randomUUID(),
        channel,
        m.authorType ?? "ai_agent",
        m.deleted ? new Date().toISOString() : null,
        JSON.stringify({ roomPost }),
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
    create table messages (id uuid primary key, channel_id uuid, author_type text, deleted_at timestamptz, metadata jsonb);
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
