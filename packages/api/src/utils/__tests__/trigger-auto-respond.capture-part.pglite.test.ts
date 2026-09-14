/**
 * The ONE auto-respond door refuses a capture clarification part — on a real
 * Postgres (PGlite), through the real `triggerAutoRespond`.
 *
 * A capture answer is role USER in an IS-eligible THREAD room; without this
 * guard any caller that forwards it (a future door, an anchored comment on a
 * question block) would wake an agent turn the capture door never asked for.
 *
 * Stubbed: IS routing and pg-boss (the enqueue is recorded, which is what makes
 * the plain-message control non-vacuous), and the logger (the distinct
 * `reason: "capture_part"` is asserted).
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
let channelId: string;

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
  const { rows } = await client.query<{ id: string }>(
    `insert into channels (user_id, channel_type, scope, status, title)
     values ('user-1', 'thread', 'pod', 'active', 'room') returning id`
  );
  channelId = rows[0]!.id;
});

async function message(metadata: unknown): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into messages (channel_id, role, author_type, message_category, content, user_id, hash, metadata)
     values ($1, 'user', 'human', 'chat', 'hi', 'user-1', gen_random_uuid()::text, $2::jsonb) returning id`,
    [channelId, JSON.stringify(metadata)]
  );
  return rows[0]!.id;
}

describe("triggerAutoRespond — a capture clarification part never becomes an agent turn", () => {
  it("refuses a message carrying metadata.capturePart, loudly and distinctly", async () => {
    const id = await message({
      capturePart: {
        kind: "capture_answer",
        v: 1,
        answer: { type: "text", text: "Acme" },
      },
    });
    const ok = await triggerAutoRespond({
      channelId,
      userMessageId: id,
      content: "Acme",
    });
    expect(ok).toBe(false);
    expect(holder.sent).toHaveLength(0);
    expect(holder.warns).toEqual([
      expect.objectContaining({ reason: "capture_part", userMessageId: id }),
    ]);
  });

  it("control: a plain user message in the same room is enqueued", async () => {
    const id = await message({});
    const ok = await triggerAutoRespond({
      channelId,
      userMessageId: id,
      content: "hello",
    });
    expect(ok).toBe(true);
    expect(holder.sent).toHaveLength(1);
    expect(holder.warns).toHaveLength(0);
  });
});
