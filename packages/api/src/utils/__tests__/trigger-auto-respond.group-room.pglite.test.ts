/**
 * The ONE auto-respond door wakes a GROUP room only when SUMMONED — on a real
 * Postgres (PGlite), through the real `triggerAutoRespond`.
 *
 * A focus session's room is a GROUP (2026-09-24) where an AI answers only when
 * named. Callers that name the agent (a resolved @mention, an anchored comment,
 * a playbook is-agent step, a delegated output, MCP post_message with an
 * agentType) must reach the IS; an un-named trigger (an agent's own post, a
 * generic `triggerAI`) must not wake the room — refused LOUDLY with the
 * distinct reason `group_room_not_summoned`. A THREAD is unchanged: it wakes
 * with or without a named agent.
 *
 * Stubbed: IS routing and pg-boss (the enqueue is recorded, so the summoned
 * cases are non-vacuous), and the logger (the refusal reason is asserted).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  sent: [] as unknown[],
  warns: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});
vi.mock("@synap-core/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    warn: (o: Record<string, unknown>) => holder.warns.push(o),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock("../intelligence-routing.js", () => ({
  resolveIntelligenceService: async () => ({
    endpoint: "http://is.test",
    serviceApiKey: "k",
    serviceId: "svc",
    agentUserId: "agent",
  }),
}));
vi.mock("@synap/jobs", () => ({
  A2AI_TRIGGER_JOB_OPTIONS: {},
  A2AI_TRIGGER_QUEUE: "queue",
  getBoss: () => ({
    send: async (_q: string, data: unknown) => {
      holder.sent.push(data);
      return "job-1";
    },
  }),
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions, channels, messages } from "@synap/database";
import { triggerAutoRespond } from "../trigger-auto-respond.js";

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

let client: PGlite;

beforeEach(async () => {
  client = new PGlite();
  for (const t of [focusSessions, channels, messages]) {
    await client.exec(ddlFor(t as unknown as PgTable));
  }
  holder.db = drizzle(client, {
    schema: { focusSessions, channels, messages },
  });
  holder.sent.length = 0;
  holder.warns.length = 0;
});

async function room(channelType: "group" | "thread"): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into channels (user_id, channel_type, scope, status, title, ai_reaction_mode)
     values ('user-1', $1, 'pod', 'active', 'room', 'only_mentioned') returning id`,
    [channelType]
  );
  return rows[0]!.id;
}

async function message(channelId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into messages (channel_id, role, author_type, message_category, content, user_id, hash, metadata)
     values ($1, 'user', 'human', 'chat', 'hi', 'user-1', gen_random_uuid()::text, '{}'::jsonb) returning id`,
    [channelId]
  );
  return rows[0]!.id;
}

describe("triggerAutoRespond — a GROUP room wakes only when summoned", () => {
  it("GROUP + a named agent ⇒ enqueued, carrying that agent", async () => {
    const channelId = await room("group");
    const ok = await triggerAutoRespond({
      channelId,
      userMessageId: await message(channelId),
      content: "@researcher look at this",
      agentType: "researcher",
    });
    expect(ok).toBe(true);
    expect(holder.sent).toEqual([
      expect.objectContaining({ channelId, agentType: "researcher" }),
    ]);
    expect(holder.warns).toHaveLength(0);
  });

  it("GROUP with no named agent ⇒ refused, reason group_room_not_summoned", async () => {
    const channelId = await room("group");
    for (const agentType of [undefined, null, "   "]) {
      const ok = await triggerAutoRespond({
        channelId,
        userMessageId: await message(channelId),
        content: "an agent's own post",
        agentType,
      });
      expect(ok).toBe(false);
    }
    expect(holder.sent).toHaveLength(0);
    expect(holder.warns).toEqual([
      expect.objectContaining({ reason: "group_room_not_summoned" }),
      expect.objectContaining({ reason: "group_room_not_summoned" }),
      expect.objectContaining({ reason: "group_room_not_summoned" }),
    ]);
  });

  it("THREAD is unchanged: wakes with no named agent", async () => {
    const channelId = await room("thread");
    const ok = await triggerAutoRespond({
      channelId,
      userMessageId: await message(channelId),
      content: "hello",
    });
    expect(ok).toBe(true);
    expect(holder.sent).toHaveLength(1);
    expect(holder.warns).toHaveLength(0);
  });
});
