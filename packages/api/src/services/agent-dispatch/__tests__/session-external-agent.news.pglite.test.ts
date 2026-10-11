/**
 * The session's external agent carries its LAST SIGN OF LIFE and, only for a
 * binding that cannot be polled, the silence window after which it reads
 * "No news" (`resolveExternalAgentView`).
 *
 * Real: the tables and `readSessionExternalAgent`. Stubbed: the binding read
 * (a binding WITH or WITHOUT a `status` verb is the variable under test).
 *
 * Rules out:
 *   - a post from BEFORE the hand-off counted as news (a stale room);
 *   - a HUMAN post counted as the agent's news;
 *   - another room's agent post counted;
 *   - a pollable binding served a quiet window (it would go quiet while the
 *     poll still knows it is working);
 *   - news only from the BOUND agent (a routine reports as its connector).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
  verbs: {} as Record<string, string>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});
vi.mock("../agent-binding.js", () => ({
  AgentBindingError: class extends Error {},
  resolveAgentBinding: async () => ({
    toolId: "t",
    workspaceId: null,
    provider: "claude-code-routines",
    protocol: "vendor",
    supports: { push: false, inputRequired: true, cancel: false },
    verbs: h.verbs,
  }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  playbookRuns,
  users,
  proposals,
  focusSessions,
  messages,
} from "@synap/database";
import { EXTERNAL_AGENT_QUIET_AFTER_MS } from "@synap-core/types/agents";
import { readSessionExternalAgent } from "../session-external-agent.js";

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

const AGENT = randomUUID();
const STARTED = "2026-10-11T10:00:00.000Z";

async function sessionWithRun(): Promise<{ sessionId: string; room: string }> {
  const sessionId = randomUUID();
  const room = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, channel_id) values ($1, 'u1', 'g', 'active', $2)`,
    [sessionId, room]
  );
  await q(
    `insert into playbook_runs (id, session_id, status, started_at, external_agent) values ($1, $2, 'running', $3, $4::jsonb)`,
    [
      randomUUID(),
      sessionId,
      STARTED,
      JSON.stringify({
        agentUserId: AGENT,
        toolId: "t",
        provider: "claude-code-routines",
        externalId: "cc_1",
        status: "running",
        startedAt: STARTED,
      }),
    ]
  );
  return { sessionId, room };
}
async function post(room: string, at: string, authorType = "ai_agent") {
  await q(
    `insert into messages (id, channel_id, author_type, timestamp) values ($1, $2, $3, $4)`,
    [randomUUID(), room, authorType, at]
  );
}

describe("readSessionExternalAgent — last sign of life + quiet window", () => {
  beforeAll(async () => {
    for (const t of [playbookRuns, users, proposals, focusSessions, messages]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
  }, 120_000);
  afterAll(async () => {
    await h.client?.close();
  });

  it("no agent post since the start ⇒ lastNewsAt is the start (a stale earlier post, a human's and another room's ignored)", async () => {
    h.verbs = { start: "s", send: "x" };
    const { sessionId, room } = await sessionWithRun();
    await post(room, "2026-10-11T09:00:00.000Z"); // before the hand-off
    await post(room, "2026-10-11T11:00:00.000Z", "human");
    await post(randomUUID(), "2026-10-11T11:30:00.000Z"); // another room
    const ext = await readSessionExternalAgent(sessionId);
    expect(ext?.lastNewsAt).toBe(STARTED);
    expect(ext?.quietAfterMs).toBe(EXTERNAL_AGENT_QUIET_AFTER_MS);
  });

  it("the newest AGENT post in the room since the start is the news (any agent identity)", async () => {
    h.verbs = { start: "s", send: "x" };
    const { sessionId, room } = await sessionWithRun();
    await post(room, "2026-10-11T10:20:00.000Z");
    await post(room, "2026-10-11T10:45:00.000Z");
    const ext = await readSessionExternalAgent(sessionId);
    expect(ext?.lastNewsAt).toBe("2026-10-11T10:45:00.000Z");
  });

  it("a binding WITH a status verb is pollable ⇒ no quiet window", async () => {
    h.verbs = { start: "s", send: "x", status: "st" };
    const { sessionId } = await sessionWithRun();
    expect(
      (await readSessionExternalAgent(sessionId))?.quietAfterMs
    ).toBeNull();
  });
});
