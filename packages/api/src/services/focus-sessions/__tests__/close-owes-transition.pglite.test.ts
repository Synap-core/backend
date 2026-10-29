/**
 * THE CLOSE DOOR OWES THE SESSION'S TRANSITION (status-flow W2), through the
 * REAL `completeFocusSession` and the REAL `setSessionStatus` on one PGlite:
 * one `focus_session.transition.completed` owed per close, in the shape and
 * with the actor the close names, and the `focus_session.closed` event still
 * emitted beside it (its reactors read it).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const closeEmits = vi.hoisted(
  () => [] as Array<{ subjectType: string; action: string }>
);
const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: await h.init(), getDb: async () => h.init() };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async (p: { subjectType: string; action: string }) => {
    closeEmits.push(p);
  },
}));
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: async () => ({ granted: true }),
}));
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => undefined,
}));
vi.mock("../../proposals/expire-lapsed-proposals.js", () => ({
  expireSessionEphemerals: async () => 0,
}));

import type { PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  lifecycleTransitionOutbox,
  links,
  playbookRuns,
  playbooks,
  proposals,
} from "@synap/database";
import { completeFocusSession } from "../complete-session.js";
import { pgliteTableDdl } from "../../../__tests__/pglite-ddl.js";

const USER = "user-close-tr";
const AGENT = "agent-close-tr";
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  await h.init();
  // The tables the close door reads beside the session (the close-stamps
  // suite's set).
  for (const t of [
    focusSessions,
    lifecycleTransitionOutbox,
    links,
    playbookRuns,
    playbooks,
    proposals,
  ])
    await h.client!.exec(pgliteTableDdl(t as unknown as PgTable));
}, 120_000);

async function session(status = "active"): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs) values ($1, $2, 'g', $3, '[]'::jsonb)`,
    [id, USER, status]
  );
  return id;
}
const owed = async (id: string) =>
  (
    await q<{ transition: Record<string, unknown> }>(
      `select transition from lifecycle_transition_outbox where transition->>'subjectId' = $1`,
      [id]
    )
  ).rows.map((r) => r.transition);
const closedEmits = (): number =>
  closeEmits.filter(
    (e) => e.subjectType === "focus_session" && e.action === "closed"
  ).length;

describe("the close door owes the session's transition", () => {
  it("a person's close: one transition, active → closed (done), and focus_session.closed still fires", async () => {
    const id = await session();
    const before = closedEmits();
    const res = await completeFocusSession({ sessionId: id, userId: USER });
    expect(res?.session.status).toBe("closed");
    expect(await owed(id)).toEqual([
      expect.objectContaining({
        subjectType: "focus_session",
        subjectId: id,
        from: "active",
        to: "closed",
        fromCategory: "active",
        category: "done",
        actorKind: "human",
        userId: USER,
        agentUserId: null,
      }),
    ]);
    expect(closedEmits()).toBe(before + 1);
  });

  it("an agent key's close names the agent", async () => {
    const id = await session("paused");
    await completeFocusSession({
      sessionId: id,
      userId: USER,
      agentUserId: AGENT,
    });
    expect(await owed(id)).toEqual([
      expect.objectContaining({
        from: "paused",
        to: "closed",
        actorKind: "agent",
        userId: USER,
        agentUserId: AGENT,
      }),
    ]);
  });

  it("an automatic close (the jobs closer slot's actor) names the system; a cancel is lost", async () => {
    const id = await session("stale");
    await completeFocusSession({
      sessionId: id,
      userId: USER,
      terminalStatus: "cancelled",
      cancelReason: "abandoned",
      actor: { kind: "system", userId: USER },
    });
    expect(await owed(id)).toEqual([
      expect.objectContaining({
        from: "stale",
        fromCategory: "paused",
        to: "cancelled",
        category: "lost",
        actorKind: "system",
        reason: "abandoned",
      }),
    ]);
  });

  it("closing an already-closed session owes nothing and emits nothing", async () => {
    const id = await session("closed");
    const before = closedEmits();
    await completeFocusSession({ sessionId: id, userId: USER });
    expect(await owed(id)).toEqual([]);
    expect(closedEmits()).toBe(before);
  });
});
