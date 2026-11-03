/**
 * EVERY devbox job of a session (its test runs), driven through the REAL
 * `focusSessions.devboxJobs` procedure and the REAL `focusSessions.get` on
 * PGlite (wave RF4 lane F, founder decision D-M5 of 2026-11-02: "Add one
 * backend read: like the PR list's; then Show all on both surfaces").
 *
 * The packet's `devboxJobs` lists the first DEVBOX_JOBS_TOP_N; the read lists
 * every one, from the SAME reader (`readSessionDevboxJobs`), under the same
 * read floor as `get`. A failed read throws on the read and is `unavailable`
 * on the packet, never "no jobs".
 *
 * Real: both procedures, `readSessionDevboxJobs` (the dev-fact rule and the
 * events read floor), `projectContinuationPacket`. Wrapped, not replaced:
 * `readSessionDevboxJobs`, so one flag can force a FAILED read.
 * Stubbed: `getParentSessionId(s)` (lineage lives on its own connection).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  failJobsRead: false,
}));

vi.mock(
  "../services/focus-sessions/session-notify.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../services/focus-sessions/session-notify.js")
      >();
    return {
      ...actual,
      readSessionDevboxJobs: async (
        ...args: Parameters<typeof actual.readSessionDevboxJobs>
      ) => {
        if (h.failJobsRead) throw new Error("events read exploded");
        return actual.readSessionDevboxJobs(...args);
      },
    };
  }
);

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
    getParentSessionId: async () => null,
    getParentSessionIds: async () => new Map(),
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { db } from "@synap/database";
import { focusSessionsRouter } from "./focus-sessions.js";
import { DEVBOX_JOBS_TOP_N } from "../services/focus-sessions/session-notify.js";
import { allSchemaTables } from "../__tests__/pglite-ddl.js";

const USER = "user-1";
const OTHER = "user-2";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const caller = (userId: string) =>
  focusSessionsRouter.createCaller({
    db,
    authenticated: true,
    userId,
  } as never);

async function session(owner: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, metadata, created_at, updated_at, started_at)
     values ($1, $2, 'Ship the read', 'active', '[]'::jsonb, '{}'::jsonb, now(), now(), now())`,
    [id, owner]
  );
  return id;
}

/** A `ci.finished` fact as the devbox posts it, `minutesAgo` before now. */
async function run(
  sessionId: string,
  owner: string,
  minutesAgo: number,
  data: Record<string, unknown>
): Promise<void> {
  await q(
    `insert into events (id, timestamp, type, subject_id, subject_type, data, user_id)
     values ($1, now() - ($2 || ' minutes')::interval, 'ci.finished', $3, 'ci_run', $4::jsonb, $5)`,
    [
      randomUUID(),
      String(minutesAgo),
      randomUUID(),
      JSON.stringify({
        sessionId,
        repo: "Synap-core/browser",
        sha: "f38508a1",
        status: "success",
        source: "devbox-gate",
        gates: [{ id: "browser-file", status: "green" }],
        ...data,
      }),
      owner,
    ]
  );
}

const JOBS = DEVBOX_JOBS_TOP_N + 7;
const jobName = (i: number) => `lane-${String(i).padStart(2, "0")}`;

/** JOBS distinct jobs (newest = lane-00), a rerun, and two rows that are not jobs. */
async function seedJobs(sessionId: string): Promise<void> {
  for (let i = 0; i < JOBS; i++) {
    await run(sessionId, USER, 10 + i, { workflow: `devbox ${jobName(i)}` });
  }
  // An older run of lane-00: folded into its item (runs: 2), never a 2nd item.
  await run(sessionId, USER, 200, {
    workflow: `devbox ${jobName(0)}`,
    status: "failure",
  });
  // Malformed (no sha) and a CI workflow: skipped by the same rule.
  await run(sessionId, USER, 5, { workflow: "devbox broken", sha: null });
  await run(sessionId, USER, 6, { workflow: "CI" });
}

describe("focusSessions.devboxJobs: every test run of a session", () => {
  beforeAll(async () => {
    for (const t of allSchemaTables()) {
      await h.client!.exec(ddlFor(t));
    }
    await h.client!.exec(
      `create schema pgboss; create table pgboss.job (id uuid primary key default gen_random_uuid(), name text, state text, data jsonb);`
    );
  });
  beforeEach(async () => {
    h.failJobsRead = false;
    await h.client!.exec("delete from focus_sessions; delete from events;");
  });

  it("lists every job beyond the packet's cap, newest first, malformed rows skipped", async () => {
    const id = await session(USER);
    await seedJobs(id);

    const read = await caller(USER).devboxJobs({ sessionId: id });
    expect(read.status).toBe("ok");
    expect(read.total).toBe(JOBS);
    expect(read.items.map((j) => j.job)).toEqual(
      Array.from({ length: JOBS }, (_, i) => jobName(i))
    );
    expect(read.items[0]).toMatchObject({
      job: jobName(0),
      repo: "Synap-core/browser",
      status: "success",
      verdict: "passed",
      runs: 2,
    });
  });

  it("the packet's section and the read agree: same total, the packet's items are the read's first few", async () => {
    const id = await session(USER);
    await seedJobs(id);

    const read = await caller(USER).devboxJobs({ sessionId: id });
    const { continuation } = await caller(USER).get({ id });
    const packet = continuation.devboxJobs;
    expect(packet?.status).toBe("ok");
    if (packet?.status !== "ok") throw new Error(String(packet?.status));
    expect(packet.total).toBe(read.total);
    expect(packet.items).toHaveLength(DEVBOX_JOBS_TOP_N);
    expect(packet.items).toEqual(read.items.slice(0, DEVBOX_JOBS_TOP_N));
  });

  it("no jobs is an empty ok list", async () => {
    const id = await session(USER);
    expect(await caller(USER).devboxJobs({ sessionId: id })).toEqual({
      status: "ok",
      total: 0,
      items: [],
    });
  });

  it("another user's session is refused (NOT_FOUND), whatever jobs it has", async () => {
    const id = await session(OTHER);
    await run(id, OTHER, 10, { workflow: "devbox theirs" });
    await expect(
      caller(USER).devboxJobs({ sessionId: id })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The owner reads it: the refusal is the floor, not an empty table.
    expect((await caller(OTHER).devboxJobs({ sessionId: id })).total).toBe(1);
  });

  it("a failed read throws on the read and is unavailable on the packet, never 'no jobs'", async () => {
    const id = await session(USER);
    await seedJobs(id);
    h.failJobsRead = true;
    await expect(caller(USER).devboxJobs({ sessionId: id })).rejects.toThrow(
      /exploded/
    );
    const { continuation } = await caller(USER).get({ id });
    expect(continuation.devboxJobs?.status).toBe("unavailable");
  });
});
