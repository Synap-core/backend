/**
 * THE CLOSE STAMPS UNFINISHED WORKER TARGETS — through the REAL close door
 * (`completeFocusSession`) and the REAL result writer (`@synap/database`
 * `stampOpenWorkerTargets`), both on one PGlite.
 *
 * "Unfinished" is a mark (`skipped` / `session_closed`), never an absence. The
 * rows rule out: the close not stamping at all; the close overwriting a target
 * that already had a verdict; the close touching an `input` edge.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

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
  emitSideEffects: async () => undefined,
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
  links,
  playbookRuns,
  playbooks,
  proposals,
} from "@synap/database";
import { completeFocusSession } from "../complete-session.js";
import { pgliteTableDdl } from "../../../__tests__/pglite-ddl.js";

const USER = "user-close-1";
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  await h.init();
  for (const t of [focusSessions, links, playbookRuns, playbooks, proposals])
    await h.client!.exec(pgliteTableDdl(t as unknown as PgTable));
}, 120_000);

async function edge(
  sessionId: string,
  entityId: string,
  metadata: Record<string, unknown>
) {
  await q(
    `insert into links (from_type, from_id, to_type, to_id, link_type, metadata)
     values ('session', $1, 'entity', $2, 'targets', $3::jsonb)`,
    [sessionId, entityId, JSON.stringify(metadata)]
  );
}

const metaOf = async (sessionId: string, entityId: string) =>
  (
    await q<{ metadata: Record<string, unknown> }>(
      `select metadata from links where from_id = $1 and to_id = $2`,
      [sessionId, entityId]
    )
  ).rows[0]!.metadata;

describe("closing a worker session", () => {
  it("stamps the open targets skipped/session_closed and keeps every earlier verdict", async () => {
    const sessionId = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, goal, status, expected_outputs) values ($1, $2, 'Follow up the leads', 'active', '[]'::jsonb)`,
      [sessionId, USER]
    );
    const [open, done, input] = [randomUUID(), randomUUID(), randomUUID()];
    await edge(sessionId, open, { role: "worker_target" });
    await edge(sessionId, done, { role: "worker_target", result: "done" });
    await edge(sessionId, input, { role: "input", via: "capture" });

    const res = await completeFocusSession({ sessionId, userId: USER });
    expect(res?.session.status).toBe("closed");

    expect(await metaOf(sessionId, open)).toMatchObject({
      role: "worker_target",
      result: "skipped",
      reason: "session_closed",
    });
    expect(await metaOf(sessionId, done)).toEqual({
      role: "worker_target",
      result: "done",
    });
    expect(await metaOf(sessionId, input)).toEqual({
      role: "input",
      via: "capture",
    });
  });
});
