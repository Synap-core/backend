/**
 * The stopped-session door (decision E1) on PGlite: a session no agent moved
 * for 7 days, owing only its agent's confirm / choose asks, goes `stale`; those
 * asks are stamped `session_ended` (never deleted) and its room's open question
 * is closed `session_ended`. Its twins one fact away are left untouched:
 *   - an `act` slot beside the asks (the person still has to DO it);
 *   - an agent post 2 days ago (the agent is still around);
 *   - already `stale` (the reaper's mark is not re-stamped).
 *
 * Negative control: without the door (the pre-rule reaper) the stopped
 * session stays `active` with its asks owed forever.
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
      schema: { focusSessions: actual.focusSessions as never },
    }),
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  chatTurns,
  events,
  focusSessions,
  messages,
  proposals,
} from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";
import { staleStoppedSession } from "../stale-stopped-session.js";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const DAY = 24 * 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const CONFIRM = {
  kind: "decision",
  label: "Ship it?",
  owner: "human",
  blockedReason: "decision",
  owedSince: ago(12 * DAY),
  askedBy: "agent-1",
  ask: { mode: "confirm" },
};
const CHOOSE = {
  ...CONFIRM,
  label: "Which OS?",
  ask: { mode: "choose", options: [{ label: "A" }, { label: "B" }] },
};
const ACT = { ...CONFIRM, label: "Plug the USB in", ask: { mode: "act" } };

async function session(p: {
  slots: unknown[];
  status?: string;
  agentPostAt?: string;
}): Promise<{ id: string; channel: string }> {
  const id = randomUUID();
  const channel = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, metadata, channel_id, started_at, created_at, updated_at)
     values ($1, 'u1', 'g', $2, $3::jsonb, '{}'::jsonb, $4, $5, $5, $6)`,
    [
      id,
      p.status ?? "active",
      JSON.stringify(p.slots),
      channel,
      ago(20 * DAY),
      NOW.toISOString(),
    ]
  );
  // The agent's open question in the room, 12 days ago.
  await q(
    `insert into messages (id, channel_id, author_type, timestamp, metadata) values ($1, $2, 'ai_agent', $3, $4::jsonb)`,
    [
      randomUUID(),
      channel,
      p.agentPostAt ?? ago(12 * DAY),
      JSON.stringify({ roomPost: { kind: "question" } }),
    ]
  );
  return { id, channel };
}

const row = async (id: string) =>
  (
    await q<{ status: string; expected_outputs: ExpectedOutput[] }>(
      `select status, expected_outputs from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!;
const questionClosed = async (channel: string) =>
  (
    await q<{ closed: unknown }>(
      `select metadata->'roomPost'->'closed' as closed from messages where channel_id = $1`,
      [channel]
    )
  ).rows[0]!.closed;

describe("staleStoppedSession — a session that stopped on its own asks", () => {
  beforeAll(async () => {
    for (const t of [focusSessions, messages, chatTurns, proposals, events]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
  }, 120_000);
  afterAll(async () => h.client?.close());

  it("stales it, retires its confirm / choose asks session_ended, closes its open question", async () => {
    const s = await session({
      slots: [CONFIRM, CHOOSE, { label: "Done", status: "done" }],
    });
    const r = await staleStoppedSession({ sessionId: s.id, now: NOW });
    expect(r).toEqual({ sessionId: s.id, retiredSlots: 2, closedQuestions: 1 });
    const after = await row(s.id);
    expect(after.status).toBe("stale");
    // Receipts, never deletes: every slot is still there.
    expect(after.expected_outputs).toHaveLength(3);
    for (const slot of after.expected_outputs.slice(0, 2)) {
      expect(slot.retiredReason).toBe("session_ended");
      expect(slot.retiredAt).toBe(NOW.toISOString());
      expect(slot.owner).toBe("human");
    }
    expect(after.expected_outputs[2]!.retiredAt).toBeUndefined();
    expect(await questionClosed(s.channel)).toMatchObject({
      reason: "session_ended",
    });
  });

  it("never when the person still has to DO something", async () => {
    const s = await session({ slots: [CONFIRM, ACT] });
    expect(await staleStoppedSession({ sessionId: s.id, now: NOW })).toBeNull();
    const after = await row(s.id);
    expect(after.status).toBe("active");
    expect(after.expected_outputs.every((o) => o.retiredAt === undefined)).toBe(
      true
    );
    expect(await questionClosed(s.channel)).toBeNull();
  });

  it("never when an agent posted in the last 7 days", async () => {
    const s = await session({ slots: [CONFIRM], agentPostAt: ago(2 * DAY) });
    expect(await staleStoppedSession({ sessionId: s.id, now: NOW })).toBeNull();
    expect((await row(s.id)).status).toBe("active");
  });

  it("never re-stamps a session the reaper already staled", async () => {
    const s = await session({ slots: [CONFIRM], status: "stale" });
    expect(await staleStoppedSession({ sessionId: s.id, now: NOW })).toBeNull();
  });
});
