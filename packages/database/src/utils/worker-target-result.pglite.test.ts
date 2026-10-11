/**
 * WORKER TARGET RESULT, on real Postgres (PGlite) through the real drizzle
 * statements: first verdict wins, the session close stamps only what is still
 * open, and nothing but a worker target ever gets a result.
 *
 * Each row names what it rules out:
 *   - a second verdict overwriting the first (the `result IS NULL` guard);
 *   - an `input` edge (another population) getting a result;
 *   - another session's edge on the same thing being stamped;
 *   - the close stamping a target that already had a verdict;
 *   - a closed session's open target counted as in flight.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("../client-pg.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client);
  return { db: h.db, getDb: async () => h.db };
});

import {
  listOpenWorkerTargetSessions,
  listSessionWorkerTargets,
  stampOpenWorkerTargets,
  stampWorkerTargetResult,
} from "./worker-target-result.js";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function session(status = "active"): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, status, channel_id) values ($1, 'u-1', $2, null)`,
    [id, status]
  );
  return id;
}

async function edge(
  sessionId: string,
  entityId: string,
  metadata: Record<string, unknown> = { role: "worker_target" }
): Promise<void> {
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata)
     values ($1, 'session', $2, 'entity', $3, 'targets', $4::jsonb)`,
    [randomUUID(), sessionId, entityId, JSON.stringify(metadata)]
  );
}

const meta = async (sessionId: string, entityId: string) =>
  (
    await q<{ metadata: Record<string, unknown> }>(
      `select metadata from links where from_id = $1 and to_id = $2`,
      [sessionId, entityId]
    )
  ).rows[0]!.metadata;

beforeAll(async () => {
  await h.client!.exec(`
    create table focus_sessions (id uuid primary key, user_id text, status text, channel_id uuid);
    create table links (
      id uuid primary key, workspace_id uuid, from_type text, from_id text,
      to_type text, to_id text, link_type text,
      metadata jsonb not null default '{}'::jsonb, created_by text,
      created_at timestamptz default now()
    );
  `);
}, 60_000);

beforeEach(async () => {
  await h.client!.exec(`delete from links; delete from focus_sessions;`);
});

describe("stampWorkerTargetResult", () => {
  it("FIRST VERDICT WINS: a second stamp is refused and changes nothing", async () => {
    const s = await session();
    const x = randomUUID();
    await edge(s, x);

    expect(
      await stampWorkerTargetResult({
        sessionId: s,
        entityId: x,
        result: "skipped",
        reason: "moved_by_person",
        transitionEventId: "t-1",
      })
    ).toBe(true);
    expect(
      await stampWorkerTargetResult({
        sessionId: s,
        entityId: x,
        result: "done",
      })
    ).toBe(false);

    const m = await meta(s, x);
    expect(m).toMatchObject({
      role: "worker_target",
      result: "skipped",
      reason: "moved_by_person",
      transitionEventId: "t-1",
    });
    expect(typeof m.at).toBe("string");
  });

  it("never stamps an INPUT edge, nor another session's target of the same thing", async () => {
    const s = await session();
    const other = await session();
    const x = randomUUID();
    await edge(s, x, { role: "input", via: "capture" });
    await edge(other, x);

    expect(
      await stampWorkerTargetResult({
        sessionId: s,
        entityId: x,
        result: "done",
      })
    ).toBe(false);
    expect(await meta(s, x)).toEqual({ role: "input", via: "capture" });
    expect((await meta(other, x)).result).toBeUndefined();
  });

  it("leaves out absent keys rather than storing nulls", async () => {
    const s = await session();
    const x = randomUUID();
    await edge(s, x);
    await stampWorkerTargetResult({
      sessionId: s,
      entityId: x,
      result: "done",
    });
    const m = await meta(s, x);
    expect(m).not.toHaveProperty("reason");
    expect(m).not.toHaveProperty("transitionEventId");
  });
});

describe("stampOpenWorkerTargets (the session close)", () => {
  it("stamps only the targets still open, and keeps every earlier verdict", async () => {
    const s = await session();
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    await edge(s, a);
    await edge(s, b);
    await edge(s, c, { role: "input" });
    await stampWorkerTargetResult({
      sessionId: s,
      entityId: a,
      result: "done",
    });

    const stamped = await stampOpenWorkerTargets({
      sessionId: s,
      result: "skipped",
      reason: "session_closed",
    });
    expect(stamped).toEqual([b]);
    expect((await meta(s, a)).result).toBe("done");
    expect(await meta(s, b)).toMatchObject({
      result: "skipped",
      reason: "session_closed",
    });
    expect((await meta(s, c)).result).toBeUndefined();

    const targets = await listSessionWorkerTargets(s);
    expect(targets.map((t) => [t.entityId, t.result]).sort()).toEqual(
      [
        [a, "done"],
        [b, "skipped"],
      ].sort()
    );
  });
});

describe("listOpenWorkerTargetSessions", () => {
  it("lists in-flight sessions with an open target on the thing — not settled, not closed", async () => {
    const x = randomUUID();
    const open = await session("active");
    const settled = await session("active");
    const closed = await session("closed");
    await edge(open, x);
    await edge(settled, x);
    await edge(closed, x);
    await stampWorkerTargetResult({
      sessionId: settled,
      entityId: x,
      result: "done",
    });

    const rows = await listOpenWorkerTargetSessions(x);
    expect(rows.map((r) => r.sessionId)).toEqual([open]);
  });
});
