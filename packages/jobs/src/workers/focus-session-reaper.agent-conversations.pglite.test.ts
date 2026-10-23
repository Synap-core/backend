/**
 * The hourly reaper's presence hygiene, on PGlite with the REAL 0354
 * migration: `pruneAgentConversations` deletes agent conversations that ENDED
 * or went silent more than a week ago, and nothing newer — an open terminal
 * heard from today and one ended yesterday both stay.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

import {
  AGENT_CONVERSATION_RETENTION_DAYS,
  pruneAgentConversations,
} from "./focus-session-reaper.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0354 = readFileSync(
  resolve(HERE, "../../../database/migrations/0354_agent_conversations.sql"),
  "utf8"
);
const q = <T>(text: string, params?: unknown[]) =>
  h.client!.query<T>(text, params);

beforeAll(async () => {
  await h.client!.exec(M0354);
  const row = (conv: string, seenDays: number, endedDays: number | null) =>
    q(
      `INSERT INTO agent_conversations (user_id, computer, harness, conversation_id, state, last_seen_at, ended_at)
       VALUES ('u', 'devbox', 'claude-code', $1, 'idle',
               now() - make_interval(days => $2),
               CASE WHEN $3::int IS NULL THEN NULL ELSE now() - make_interval(days => $3::int) END)`,
      [conv, seenDays, endedDays]
    );
  const old = AGENT_CONVERSATION_RETENTION_DAYS + 1;
  await row("open-today", 0, null);
  await row("ended-yesterday", 1, 1);
  await row("ended-long-ago", old, old);
  await row("silent-long-ago", old, null);
}, 60_000);

describe("pruneAgentConversations", () => {
  it("deletes what ended or went silent past the retention, nothing newer", async () => {
    expect(await pruneAgentConversations()).toBe(2);
    const left = await q<{ conversation_id: string }>(
      `SELECT conversation_id FROM agent_conversations ORDER BY conversation_id`
    );
    expect(left.rows.map((r) => r.conversation_id)).toEqual([
      "ended-yesterday",
      "open-today",
    ]);
    // Idempotent: a second sweep finds nothing.
    expect(await pruneAgentConversations()).toBe(0);
  });
});
