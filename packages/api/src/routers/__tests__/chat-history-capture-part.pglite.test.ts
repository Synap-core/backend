/**
 * GET /api/chat/history carries a persisted capture question's part — through
 * the REAL route, the REAL `queryChannelMessages` door and the REAL writer
 * (`persistCaptureQuestion`), on PGlite. Nothing is hand-built between the
 * stored row and the response body.
 *
 * Reachability, not shape: before this, the endpoint selected only
 * id/role/content/timestamp, so the relay chat tab could never see a question.
 *
 * Stubbed: `authMiddleware` (sets `userId`), realtime emit.
 * NOT covered: the default personal-channel path (`ensureAgentThread`) — the
 * projection is shared by both channel paths, so the explicit `channelId`
 * path exercises it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});
vi.mock("@synap/auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>
  ) => {
    c.set("userId", "user-1");
    await next();
  },
}));
vi.mock("../../utils/chat-realtime-broadcast.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitChatEvent: () => undefined,
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  channels,
  messages,
  workspaceMembers,
} from "@synap/database";
import { chatStreamApp } from "../chat-stream.js";
import { persistCaptureQuestion } from "../../services/intake/capture-clarification.js";

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
  for (const t of [focusSessions, channels, messages, workspaceMembers]) {
    await client.exec(ddlFor(t as unknown as PgTable));
  }
  holder.db = drizzle(client, {
    schema: { focusSessions, channels, messages, workspaceMembers },
  });
  await client.query(
    `insert into workspace_members (workspace_id, user_id, role) values (gen_random_uuid(), 'user-1', 'owner')`
  );
});

describe("GET /api/chat/history — capture clarification parts reach the chat tab", () => {
  it("a persisted question round-trips with metadata.capturePart; a plain message carries no metadata", async () => {
    const { rows } = await client.query<{ id: string }>(
      `insert into focus_sessions (user_id, goal, status, metadata)
       values ('user-1', 'Capture', 'active', '{"intake":{"door":"capture"}}'::jsonb) returning id`
    );
    const sessionId = rows[0]!.id;
    const asked = await persistCaptureQuestion({
      sessionId,
      userId: "user-1",
      followUp: { question: "Which Alice?", suggestions: [] },
      partialCount: 1,
      refine: { text: "Lunch with Alice" },
    });
    if (asked.status !== "persisted") throw new Error("expected persisted");
    await client.query(
      `insert into messages (channel_id, role, author_type, message_category, content, user_id, hash, metadata, timestamp)
       values ($1, 'assistant', 'ai_agent', 'chat', 'plain reply', 'user-1', 'h-plain', '{"agentType":"meta","aiSteps":[]}'::jsonb, now() + interval '1 second')`,
      [asked.channelId]
    );

    const res = await chatStreamApp.request(
      `/history?channelId=${asked.channelId}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ id: string; content: string; metadata?: unknown }>;
    };

    expect(body.messages.map((m) => m.content)).toEqual([
      "Which Alice?",
      "plain reply",
    ]);
    expect(body.messages[0]).toMatchObject({
      id: asked.followUpMessageId,
      metadata: {
        capturePart: {
          kind: "capture_question",
          sessionId,
          round: 1,
          status: "open",
        },
      },
    });
    // Only the part is projected — never the rest of the blob.
    expect(body.messages[1]).not.toHaveProperty("metadata");
  });
});
