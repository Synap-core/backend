/**
 * The "Seen by the agent" mark (plan efb315a5, W1) on PGlite, and what an
 * app reads back:
 *   - `stampOwnerMessagesSeen` (an agent's stamped wait) marks the session
 *     OWNER's typed messages in the session's room, ONCE (a later read never
 *     moves it), never an agent's post, never through another person's floor;
 *   - `GET /threads/:id/messages` (Hub) carries each message's
 *     `metadata.roomPost` (the room question marker) and
 *     `metadata.seenByAgentAt` — the two fields the session room model reads.
 * Stubbed: the channel visibility predicate (its own suite), the message
 * event append. Real: the route, the stamp, the tables.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, {
      schema: {
        focusSessions: actual.focusSessions as never,
        channels: actual.channels as never,
        channelMembers: actual.channelMembers as never,
        messages: actual.messages as never,
      },
    }),
    eventRepository: { append: async () => undefined },
    emitMessageEvent: async () => undefined,
  };
});
vi.mock("../../../utils/channel-visibility.js", async (importOriginal) => {
  const { sql } = await import("drizzle-orm");
  return {
    ...(await importOriginal<
      typeof import("../../../utils/channel-visibility.js")
    >()),
    channelVisibilityWhere: () => sql`true`,
  };
});

import { OpenAPIHono } from "@hono/zod-openapi";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  channels,
  channelMembers,
  messages,
} from "@synap/database";
import { stampOwnerMessagesSeen } from "../owner-message-seen.js";
import { registerThreadsRoutes } from "../../../routers/hub-protocol/rest/threads.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const AGENT = "22222222-2222-4222-8222-222222222222";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${c.name === "created_at" || c.name === "timestamp" ? " default now()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function room(): Promise<{ sessionId: string; channelId: string }> {
  const channelId = randomUUID();
  await q(
    `insert into channels (id, user_id, channel_type, title, created_at, updated_at) values ($1, $2, 'group', 'Pipeline', now(), now())`,
    [channelId, OWNER]
  );
  await q(
    `insert into channel_members (id, channel_id, member_id, member_kind, created_at) values ($1, $2, $3, 'human', now())`,
    [randomUUID(), channelId, OWNER]
  );
  const sessionId = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, expected_outputs, agent_ids, metadata, criteria, channel_id, created_at, updated_at, started_at)
     values ($1, $2, 'g', 'g', 'active', '[]'::jsonb, $3, '{}'::jsonb, '[]'::jsonb, $4, now(), now(), now())`,
    [sessionId, OWNER, [AGENT], channelId]
  );
  return { sessionId, channelId };
}

async function message(
  channelId: string,
  p: {
    role: string;
    authorType: string;
    content: string;
    metadata?: unknown;
    at: string;
  }
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into messages (id, channel_id, role, content, user_id, author_type, hash, previous_hash, metadata, timestamp, ephemeral) values ($1, $2, $3, $4, $5, $6, 'h', '', $7::jsonb, $8, false)`,
    [
      id,
      channelId,
      p.role,
      p.content,
      OWNER,
      p.authorType,
      p.metadata === undefined ? null : JSON.stringify(p.metadata),
      p.at,
    ]
  );
  return id;
}

const metaOf = async (id: string) =>
  (
    await q<{ metadata: Record<string, unknown> | null }>(
      `select metadata from messages where id = $1`,
      [id]
    )
  ).rows[0]!.metadata;

describe("the seen-by-agent mark", () => {
  beforeAll(async () => {
    for (const t of [focusSessions, channels, channelMembers, messages]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
  }, 120_000);
  afterAll(async () => {
    await h.client?.close();
  });

  it("marks the owner's typed message once; an agent's post never; another person's floor marks nothing", async () => {
    const { sessionId, channelId } = await room();
    const question = await message(channelId, {
      role: "assistant",
      authorType: "ai_agent",
      content: "Nurturing ou Disqualified ?",
      metadata: {
        roomPost: { kind: "question", slotLabel: "Disposition Esteban Arias" },
      },
      at: "2026-11-17T14:12:27.805Z",
    });
    const typed = await message(channelId, {
      role: "user",
      authorType: "human",
      content: "Not mine: Follow-ups #1 dus",
      at: "2026-11-18T11:26:17.314Z",
    });

    // Another person's floor: nothing.
    expect(
      await stampOwnerMessagesSeen({
        sessionId,
        userId: OTHER,
        agentUserId: AGENT,
        messageIds: [typed],
      })
    ).toBe(0);
    expect(await metaOf(typed)).toBeNull();

    const at = new Date("2026-11-18T11:27:00.000Z");
    expect(
      await stampOwnerMessagesSeen({
        sessionId,
        userId: OWNER,
        agentUserId: AGENT,
        messageIds: [typed, question],
        now: at,
      })
    ).toBe(1);
    expect(await metaOf(typed)).toEqual({
      seenByAgentAt: at.toISOString(),
      seenByAgentId: AGENT,
    });
    // The agent's question is not a person's message: untouched.
    expect(await metaOf(question)).toEqual({
      roomPost: { kind: "question", slotLabel: "Disposition Esteban Arias" },
    });

    // A later read never moves the mark.
    expect(
      await stampOwnerMessagesSeen({
        sessionId,
        userId: OWNER,
        agentUserId: AGENT,
        messageIds: [typed],
        now: new Date("2026-11-18T12:00:00.000Z"),
      })
    ).toBe(0);
    expect((await metaOf(typed))!.seenByAgentAt).toBe(at.toISOString());
  });

  it("GET /threads/:id/messages carries metadata.roomPost and metadata.seenByAgentAt", async () => {
    const { sessionId, channelId } = await room();
    const question = await message(channelId, {
      role: "assistant",
      authorType: "ai_agent",
      content: "Continue?",
      metadata: { roomPost: { kind: "question", slotLabel: "Keep the run going" } },
      at: "2026-11-17T14:12:27.805Z",
    });
    const typed = await message(channelId, {
      role: "user",
      authorType: "human",
      content: "Yes",
      at: "2026-11-18T11:25:50.916Z",
    });
    await stampOwnerMessagesSeen({
      sessionId,
      userId: OWNER,
      agentUserId: AGENT,
      messageIds: [typed],
      now: new Date("2026-11-18T11:26:00.000Z"),
    });

    const a = new OpenAPIHono();
    a.use("*", async (c, next) => {
      c.set("userId" as never, OWNER as never);
      c.set("scopes" as never, ["hub-protocol.read"] as never);
      await next();
    });
    registerThreadsRoutes(a as never);
    const res = await a.request(`/threads/${channelId}/messages`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{
      id: string;
      metadata: Record<string, unknown> | null;
    }>;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(question)!.metadata).toMatchObject({
      roomPost: { kind: "question", slotLabel: "Keep the run going" },
    });
    expect(byId.get(typed)!.metadata).toMatchObject({
      seenByAgentAt: "2026-11-18T11:26:00.000Z",
    });
  });
});
