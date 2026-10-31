/**
 * orient's `handedToYou` (plan v2 S7 + S8, "computers and adjuncts"): the
 * sessions the person HANDED to an agent, read back out of PGlite through the
 * real orient read (`buildStartHere`).
 *
 * Asserted:
 *   - a session the agent STARTED itself is never listed, though it is on the
 *     roster: by the stored `metadata.startedByAgentId`, and for a row from
 *     before that stamp by the client key it was started with (`agent:<id>`,
 *     or one of the agent's own keys); a session another agent started and
 *     handed to it is listed;
 *   - a stale session handed to it comes back after the open ones, marked
 *     `resume`, when it went stale in the last 7 days, with `quietSince` = its
 *     last activity (the liveness rule), else the moment it went stale;
 *   - a stale session that went stale longer ago, or that it started itself,
 *     is not listed.
 *
 * Stubbed: nothing on the read path; every @synap/database table is created.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

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
  const db = drizzle(client, {
    schema: {
      focusSessions: actual.focusSessions as never,
      users: actual.users as never,
      apiKeys: actual.apiKeys as never,
    },
  });
  const mocked = { ...actual, getDb: async () => db };
  Object.defineProperty(mocked, "db", { get: () => db, enumerable: true });
  return mocked;
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { PgTable as PgTableClass } from "drizzle-orm/pg-core";
import * as database from "@synap/database";
import { buildStartHere } from "../start-here.js";

const USER = "11111111-1111-4111-8111-111111111111";
/** Interactive Claude Code and its worker: ONE identity. */
const AGENT = "22222222-2222-4222-8222-222222222222";
const AGENT_B = "33333333-3333-4333-8333-333333333333";
const AGENT_KEY = "44444444-4444-4444-8444-444444444444";
const AGENT_B_KEY = "55555555-5555-4555-8555-555555555555";
const CHANNEL = "66666666-6666-4666-8666-666666666666";

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const ids = {
  handed: randomUUID(),
  handedByB: randomUUID(),
  startedStamped: randomUUID(),
  startedLegacyKey: randomUUID(),
  startedLegacyAgent: randomUUID(),
  staleActive: randomUUID(),
  staleQuiet: randomUUID(),
  staleOld: randomUUID(),
  staleStartedHere: randomUUID(),
};

async function session(p: {
  id: string;
  status?: string;
  startedAt: Date;
  agentIds?: string[];
  metadata?: Record<string, unknown>;
  channelId?: string | null;
}) {
  await q(
    `insert into focus_sessions (id, user_id, goal, status, agent_ids, metadata, started_at, channel_id, expected_outputs)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, '[]'::jsonb)`,
    [
      p.id,
      USER,
      `goal ${p.id.slice(0, 4)}`,
      p.status ?? "active",
      p.agentIds ?? [AGENT],
      JSON.stringify(p.metadata ?? {}),
      p.startedAt.toISOString(),
      p.channelId ?? null,
    ]
  );
}

/** The move to `stale`, as the one status write records it. */
async function wentStale(sessionId: string, at: Date) {
  await q(
    `insert into events (id, type, subject_id, subject_type, data, user_id, session_id, timestamp)
     values ($1, 'focus_session.transition.completed', $2, 'focus_session', $3::jsonb, $4, $5, $6)`,
    [
      randomUUID(),
      sessionId,
      JSON.stringify({ from: "active", to: "stale" }),
      USER,
      sessionId,
      at.toISOString(),
    ]
  );
}

const handedTo = async (agentUserId: string) => {
  const s = await buildStartHere({
    caller: {} as never,
    userId: USER,
    agentUserId,
    pending: { status: "unavailable" },
    learnMoreSkill: "system/synap/concepts",
  });
  return s.handedToYou as {
    items: Array<{ id: string; resume?: true; quietSince?: string | null }>;
  };
};

const staleQuietAt = ago(1);
const staleActiveAt = ago(2);
const lastWordAt = ago(3);

beforeAll(async () => {
  const seen = new Set<string>();
  for (const t of Object.values(database)) {
    if (!is(t, PgTableClass)) continue;
    const name = getTableConfig(t as PgTable).name;
    if (seen.has(name)) continue;
    seen.add(name);
    await h.client!.exec(ddlFor(t as PgTable));
  }
  expect(seen.size).toBeGreaterThan(50);
  await q(
    `insert into users (id, email, name, user_type) values
      ($1, 'a@x.test', 'Antoine', 'human'),
      ($2, 'cc@x.test', 'Claude Code', 'agent'),
      ($3, 'cx@x.test', 'Codex', 'agent')`,
    [USER, AGENT, AGENT_B]
  );
  await q(
    `insert into api_keys (id, user_id, key_type, is_active, linked_user_id) values
      ($1, $2, 'hub_inbound', true, $4), ($3, $5, 'hub_inbound', true, $4)`,
    [AGENT_KEY, AGENT, AGENT_B_KEY, USER, AGENT_B]
  );

  // Open work, newest first by start.
  await session({ id: ids.handed, startedAt: ago(0.1) });
  await session({
    id: ids.handedByB,
    startedAt: ago(0.2),
    agentIds: [AGENT_B, AGENT],
    metadata: {
      startedByAgentId: AGENT_B,
      clientKey: `key:${AGENT_B_KEY}|conv:claude-code:b`,
    },
  });
  await session({
    id: ids.startedStamped,
    startedAt: ago(0.3),
    metadata: { startedByAgentId: AGENT },
  });
  // Started before the stamp existed: only the client key says who.
  await session({
    id: ids.startedLegacyKey,
    startedAt: ago(0.4),
    metadata: { clientKey: `key:${AGENT_KEY}|conv:claude-code:x` },
  });
  await session({
    id: ids.startedLegacyAgent,
    startedAt: ago(0.5),
    metadata: { clientKey: `agent:${AGENT}` },
  });

  // Stale work, newer start than every open one: open work still comes first.
  await session({
    id: ids.staleActive,
    status: "stale",
    startedAt: ago(0.05),
    channelId: CHANNEL,
  });
  await wentStale(ids.staleActive, staleActiveAt);
  await q(
    `insert into messages (id, channel_id, user_id, role, author_type, content, timestamp)
     values ($1, $2, $3, 'assistant', 'ai_agent', 'still on it', $4)`,
    [randomUUID(), CHANNEL, AGENT, lastWordAt.toISOString()]
  );
  await session({ id: ids.staleQuiet, status: "stale", startedAt: ago(5) });
  await wentStale(ids.staleQuiet, staleQuietAt);
  await session({ id: ids.staleOld, status: "stale", startedAt: ago(20) });
  await wentStale(ids.staleOld, ago(10));
  await session({
    id: ids.staleStartedHere,
    status: "stale",
    startedAt: ago(1),
    metadata: { startedByAgentId: AGENT },
  });
  await wentStale(ids.staleStartedHere, ago(0.5));
});

afterAll(async () => {
  await h.client?.close();
});

describe("handedToYou leaves out what the agent started itself (S8)", () => {
  it("lists work handed to it, never a session it started, stamped or legacy", async () => {
    const listed = (await handedTo(AGENT)).items.map((i) => i.id);
    expect(listed).toContain(ids.handed);
    expect(listed).toContain(ids.handedByB);
    expect(listed).not.toContain(ids.startedStamped);
    expect(listed).not.toContain(ids.startedLegacyKey);
    expect(listed).not.toContain(ids.startedLegacyAgent);
    expect(listed).not.toContain(ids.staleStartedHere);
  });

  it("the agent that started and handed a session does not see it", async () => {
    const listed = (await handedTo(AGENT_B)).items.map((i) => i.id);
    expect(listed).not.toContain(ids.handedByB);
  });
});

describe("handedToYou brings recently stale work back to resume (S7)", () => {
  it("open work first, then stale work of the last 7 days marked resume", async () => {
    const items = (await handedTo(AGENT)).items;
    expect(items.map((i) => i.id)).toEqual([
      ids.handed,
      ids.handedByB,
      ids.staleActive,
      ids.staleQuiet,
    ]);
    expect(items[0]).not.toHaveProperty("resume");
    expect(items[0]).not.toHaveProperty("quietSince");
  });

  it("quietSince is its last activity, else when it went stale", async () => {
    const items = (await handedTo(AGENT)).items;
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get(ids.staleActive)).toMatchObject({
      resume: true,
      quietSince: lastWordAt.toISOString(),
    });
    expect(byId.get(ids.staleQuiet)).toMatchObject({
      resume: true,
      quietSince: staleQuietAt.toISOString(),
    });
  });

  it("a session that went stale more than 7 days ago is not listed", async () => {
    const listed = (await handedTo(AGENT)).items.map((i) => i.id);
    expect(listed).not.toContain(ids.staleOld);
  });
});
