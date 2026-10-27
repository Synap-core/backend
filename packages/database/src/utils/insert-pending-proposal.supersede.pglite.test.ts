/**
 * The pending door on a REAL Postgres (PGlite): an agent's newer version of an
 * update REPLACES its older pending one, and an agent's proposal carries the
 * room moment it was filed at.
 *
 * Supersede scope — each row rules out one wrong rule:
 *   - same agent + session + target + update, new payload → the old row is
 *     `withdrawn`, stamped with what replaced it, its bell entry actioned;
 *   - a CREATE on the same target → untouched (a create is a new thing);
 *   - ANOTHER agent's update of the same target → untouched;
 *   - the same agent in ANOTHER session → untouched;
 *   - a PERSON's update → never withdrawn, and a person's filing withdraws
 *     nothing;
 *   - a section patch (part of a document) → two patches both stand;
 *   - a newer update that does NOT carry every change of the older one (two
 *     disjoint property patches, a move then a field edit, through the request
 *     envelope too) → both stand; one that covers it → it is replaced.
 *
 * Source message: the agent's NEWEST live post in the session's room — not a
 * deleted one, not another agent's, not a person's — and never over an id the
 * caller named.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { proposals } from "../schema/proposals.js";
import { notifications } from "../schema/notifications.js";
import { messages } from "../schema/messages.js";
import { focusSessions } from "../schema/focus-sessions.js";
import { channels } from "../schema/channels.js";
import { relations } from "../schema/relations.js";
import {
  insertPendingProposal,
  SUPERSEDED_BY_KEY,
  SUPERSEDED_REASON,
  type InsertPendingProposalInput,
} from "./insert-pending-proposal.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${["created_at", "updated_at", "timestamp"].includes(c.name) ? " default now()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

let client: PGlite;
let db: ReturnType<typeof drizzle>;
const q = <T>(sql: string, params?: unknown[]) =>
  client.query<T>(sql, params).then((r) => r.rows);

const AGENT = "agent-a";
const OTHER_AGENT = "agent-b";
const S1 = randomUUID();
const S2 = randomUUID();
const ROOM1 = randomUUID();
const ROOM2 = randomUUID();

const ids = (r: { superseded?: Array<{ id: string }> }) =>
  (r.superseded ?? []).map((v) => v.id);

const file = (over: Partial<InsertPendingProposalInput>) =>
  insertPendingProposal(
    {
      workspaceId: null,
      targetType: "entity",
      targetId: "e1",
      proposalType: "update",
      data: { title: "v" },
      createdBy: AGENT,
      agentUserId: AGENT,
      sessionId: S1,
      ...over,
    },
    db as never
  );

const statusOf = async (id: string) =>
  (
    await q<{ status: string; data: Record<string, unknown> }>(
      `select status, data from proposals where id = $1`,
      [id]
    )
  )[0]!;

beforeAll(async () => {
  client = new PGlite();
  for (const t of [
    proposals,
    notifications,
    messages,
    focusSessions,
    channels,
    relations,
  ]) {
    await client.exec(ddlFor(t as unknown as PgTable));
  }
  db = drizzle(client, { schema: { focusSessions, channels, relations } });
  await q(
    `insert into focus_sessions (id, channel_id) values ($1, $2), ($3, $4)`,
    [S1, ROOM1, S2, ROOM2]
  );
}, 120_000);

describe("supersede — an agent's newer version replaces its older pending one", () => {
  it("same agent, session, target, update: the old row is withdrawn, says what replaced it, leaves the bell", async () => {
    const v1 = await file({ data: { title: "v1" } });
    await q(
      `insert into notifications (id, user_id, type, source_type, source_id, status) values ($1, 'u', 'proposal.created', 'proposal', $2, 'unread')`,
      [randomUUID(), v1.proposal.id]
    );
    const v2 = await file({ data: { title: "v2" } });
    expect(v2.superseded).toEqual([
      expect.objectContaining({
        id: v1.proposal.id,
        workspaceId: null,
        data: expect.objectContaining({ title: "v1" }),
      }),
    ]);
    const old = await statusOf(v1.proposal.id);
    expect(old.status).toBe("withdrawn");
    // Decided now, like a person's withdraw.
    const [reviewed] = await q<{ reviewed_at: string | null }>(
      `select reviewed_at from proposals where id = $1`,
      [v1.proposal.id]
    );
    expect(reviewed!.reviewed_at).not.toBeNull();
    expect(old.data[SUPERSEDED_BY_KEY]).toBe(v2.proposal.id);
    expect(old.data.withdrawReason).toBe(SUPERSEDED_REASON);
    expect(old.data.title).toBe("v1");
    expect((await statusOf(v2.proposal.id)).status).toBe("pending");
    const [n] = await q<{ status: string }>(
      `select status from notifications where source_id = $1`,
      [v1.proposal.id]
    );
    expect(n!.status).toBe("actioned");
  });

  it("never a create, another agent, another session, or a person", async () => {
    const target = { targetId: "e2" };
    const create1 = await file({
      ...target,
      proposalType: "create",
      data: { name: "c1" },
    });
    const create2 = await file({
      ...target,
      proposalType: "create",
      data: { name: "c2" },
    });
    expect(ids(create2)).toEqual([]);
    const mine = await file({ ...target, data: { title: "mine" } });
    const theirs = await file({
      ...target,
      agentUserId: OTHER_AGENT,
      createdBy: OTHER_AGENT,
      data: { title: "theirs" },
    });
    const elsewhere = await file({
      ...target,
      sessionId: S2,
      data: { title: "elsewhere" },
    });
    const person = await file({
      ...target,
      agentUserId: null,
      createdBy: "user-1",
      data: { title: "person" },
    });
    // The agent files again in S1: only ITS S1 update goes.
    const again = await file({ ...target, data: { title: "again" } });
    expect(ids(again)).toEqual([mine.proposal.id]);
    for (const kept of [create1, create2, theirs, elsewhere, person]) {
      expect(
        (await statusOf(kept.proposal.id)).status,
        kept.proposal.proposalType
      ).toBe("pending");
    }
    expect(ids(theirs)).toEqual([]);
    expect(ids(person)).toEqual([]);
  });

  it("two section patches of one document both stand", async () => {
    const a = await file({
      targetType: "document",
      targetId: "d1",
      proposalType: "section_update",
      data: { section: "intro", text: "a" },
    });
    const b = await file({
      targetType: "document",
      targetId: "d1",
      proposalType: "section_update",
      data: { section: "plan", text: "b" },
    });
    expect(ids(b)).toEqual([]);
    expect((await statusOf(a.proposal.id)).status).toBe("pending");
  });
});

describe("supersede — only a newer version that carries every older change", () => {
  it("two disjoint property patches of one target both stand", async () => {
    const status = await file({
      targetId: "deal-1",
      data: { id: "deal-1", properties: { status: "won" } },
    });
    const amount = await file({
      targetId: "deal-1",
      data: { id: "deal-1", properties: { amount: 5000 } },
    });
    expect(ids(amount)).toEqual([]);
    expect((await statusOf(status.proposal.id)).status).toBe("pending");
  });

  it("a move then a field edit both stand", async () => {
    const move = await file({
      targetId: "deal-2",
      data: { id: "deal-2", toWorkspaceId: "ws-b" },
    });
    const edit = await file({
      targetId: "deal-2",
      data: { id: "deal-2", properties: { amount: 1 } },
    });
    expect(ids(edit)).toEqual([]);
    expect((await statusOf(move.proposal.id)).status).toBe("pending");
  });

  it("through the request envelope: disjoint stands, covering replaces", async () => {
    const envelope = (record: Record<string, unknown>) => ({
      requestId: randomUUID(),
      targetType: "entity",
      changeType: "update",
      data: { id: "deal-3", ...record },
    });
    const a = await file({
      targetId: "deal-3",
      data: envelope({ properties: { status: "won" } }),
    });
    const b = await file({
      targetId: "deal-3",
      data: envelope({ properties: { amount: 7 } }),
    });
    expect(ids(b)).toEqual([]);
    const c = await file({
      targetId: "deal-3",
      data: envelope({ properties: { status: "lost", amount: 8 } }),
    });
    expect(ids(c).sort()).toEqual([a.proposal.id, b.proposal.id].sort());
  });
});

describe("sourceMessageId — the room moment an agent's proposal was filed at", () => {
  it("is the agent's newest live post in the session's room", async () => {
    const post = async (o: {
      author: string;
      teammate: string | null;
      minutesAgo: number;
      deleted?: boolean;
      room?: string;
    }) => {
      const id = randomUUID();
      await q(
        `insert into messages (id, channel_id, author_type, routed_teammate_id, deleted_at, timestamp, content, user_id, hash)
         values ($1, $2, $3, $4, $5, now() - ($6 || ' minutes')::interval, 'x', 'u', $7)`,
        [
          id,
          o.room ?? ROOM1,
          o.author,
          o.teammate,
          o.deleted ? new Date().toISOString() : null,
          String(o.minutesAgo),
          `hash-${id}`,
        ]
      );
      return id;
    };
    await post({ author: "ai_agent", teammate: AGENT, minutesAgo: 30 });
    const newest = await post({
      author: "ai_agent",
      teammate: AGENT,
      minutesAgo: 10,
    });
    await post({
      author: "ai_agent",
      teammate: AGENT,
      minutesAgo: 1,
      deleted: true,
    });
    await post({ author: "ai_agent", teammate: OTHER_AGENT, minutesAgo: 2 });
    await post({ author: "human", teammate: null, minutesAgo: 3 });
    await post({
      author: "ai_agent",
      teammate: AGENT,
      minutesAgo: 0,
      room: ROOM2,
    });
    const filed = await file({ targetId: "e3", data: { title: "anchored" } });
    expect(filed.proposal.sourceMessageId).toBe(newest);
  });

  it("never replaces the message the caller named", async () => {
    const named = randomUUID();
    const filed = await file({
      targetId: "e4",
      data: { title: "named" },
      sourceMessageId: named,
    });
    expect(filed.proposal.sourceMessageId).toBe(named);
  });
});
