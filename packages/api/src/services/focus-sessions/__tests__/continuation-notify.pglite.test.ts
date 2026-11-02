/**
 * The two packet sections phase B's surfaces read for the session room (plan
 * d679e92c C9, W3-notify): `devboxJobs` and `muted`, driven through the REAL
 * `projectContinuationPacket` on PGlite (every schema table, columns only;
 * harness copied from `continuation-sections.pglite.test.ts`).
 *
 * Discriminating rows:
 *  - devboxJobs: two runs of one job (only the NEWEST is the item, `runs: 2`),
 *    a CI run on the same session (not a devbox job), a devbox run of ANOTHER
 *    session (a rule that ignores the session reads it), and a run naming this
 *    session but posted by ANOTHER person in no space (the events read floor
 *    must drop it).
 *  - muted: the viewer muted S.lane only; S.quiet is the same person's other
 *    session (a rule reading "any mute" calls it muted).
 *  - failures: the section's table renamed away → `unavailable`, never
 *    "no jobs" / "not muted".
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
  const pg = await h.init();
  return { ...actual, db: pg, getDb: async () => pg };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { db, focusSessions, eq } from "@synap/database";
import { projectContinuationPacket } from "../continuation-packet.js";

const OWNER = "user-owner";
const OTHER = "user-other";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const S = { lane: randomUUID(), quiet: randomUUID() };

async function session(id: string) {
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, project_id, title, goal, status, expected_outputs, metadata, origin, created_at, updated_at, started_at)
     values ($1, $2, null, null, $3, 'Ship it', 'active', '[]'::jsonb, '{}'::jsonb, 'human', now(), now(), now())`,
    [id, OWNER, `Session ${id.slice(0, 4)}`]
  );
}

async function ciFinished(opts: {
  sessionId: string;
  workflow: string;
  status: string;
  minutesAgo: number;
  userId?: string;
  gates?: unknown[];
}) {
  const at = new Date(Date.now() - opts.minutesAgo * 60_000).toISOString();
  await q(
    `insert into events (id, type, user_id, data, timestamp) values ($1, 'ci.finished', $2, $3::jsonb, $4::timestamptz)`,
    [
      randomUUID(),
      opts.userId ?? OWNER,
      JSON.stringify({
        sha: "f38508a1",
        repo: "Synap-core/browser",
        status: opts.status,
        workflow: opts.workflow,
        source: "devbox-gate",
        sessionId: opts.sessionId,
        gates: opts.gates ?? [{ id: "browser-file", status: "green" }],
        ingestedAt: at,
      }),
      at,
    ]
  );
}

async function packetFor(id: string, viewer = OWNER) {
  const [row] = await db
    .select()
    .from(focusSessions)
    .where(eq(focusSessions.id, id));
  return projectContinuationPacket(row!, { database: db, userId: viewer });
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await q(
    `insert into users (id, user_type) values ($1, 'human'), ($2, 'human')`,
    [OWNER, OTHER]
  );
  await session(S.lane);
  await session(S.quiet);
  await ciFinished({
    sessionId: S.lane,
    workflow: "devbox w3notify",
    status: "success",
    minutesAgo: 30,
  });
  await ciFinished({
    sessionId: S.lane,
    workflow: "devbox w3notify",
    status: "failure",
    minutesAgo: 10,
    gates: [
      { id: "be-file", status: "red" },
      { id: "be-jobs-tsc", status: "green" },
    ],
  });
  await ciFinished({
    sessionId: S.lane,
    workflow: "devbox w3notify-h",
    status: "success",
    minutesAgo: 20,
  });
  await ciFinished({
    sessionId: S.lane,
    workflow: "CI",
    status: "success",
    minutesAgo: 5,
  });
  // Older than the session by more than a day: outside the read's bound
  // (the read is pruned by time, so it never scans a session's whole past).
  await ciFinished({
    sessionId: S.lane,
    workflow: "devbox before-start",
    status: "success",
    minutesAgo: 3 * 24 * 60,
  });
  await ciFinished({
    sessionId: S.quiet,
    workflow: "devbox other-lane",
    status: "success",
    minutesAgo: 5,
  });
  await ciFinished({
    sessionId: S.lane,
    workflow: "devbox not-yours",
    status: "success",
    minutesAgo: 1,
    userId: OTHER,
  });
  await q(
    `insert into notification_preferences (id, user_id, workspace_id, push_prefs) values ($1, $2, null, $3::jsonb)`,
    [randomUUID(), OWNER, JSON.stringify({ mutedSessions: [S.lane] })]
  );
}, 120_000);

describe("continuation packet — devbox jobs", () => {
  it("one item per job of THIS session, its newest run first, under the events floor, from a day before it began", async () => {
    const packet = await packetFor(S.lane);
    expect(packet.devboxJobs).toEqual({
      status: "ok",
      total: 2,
      items: [
        {
          job: "w3notify",
          repo: "Synap-core/browser",
          sha: "f38508a1",
          status: "failure",
          verdict: "failed",
          gates: [
            { id: "be-file", status: "red" },
            { id: "be-jobs-tsc", status: "green" },
          ],
          url: null,
          at: expect.any(String),
          runs: 2,
        },
        expect.objectContaining({
          job: "w3notify-h",
          verdict: "passed",
          runs: 1,
        }),
      ],
    });
  });

  it("another session's jobs are its own", async () => {
    const packet = await packetFor(S.quiet);
    expect(packet.devboxJobs).toMatchObject({
      status: "ok",
      total: 1,
      items: [{ job: "other-lane" }],
    });
  });
});

describe("continuation packet — muted", () => {
  it("the viewer's mute of THIS session, and only this one", async () => {
    expect((await packetFor(S.lane)).muted).toEqual({
      status: "ok",
      muted: true,
    });
    expect((await packetFor(S.quiet)).muted).toEqual({
      status: "ok",
      muted: false,
    });
  });
});

describe("continuation packet — a failed read is unavailable, never empty", () => {
  async function withTableGone<T>(table: string, run: () => Promise<T>) {
    await h.client!.exec(`alter table ${table} rename to ${table}_gone;`);
    try {
      return await run();
    } finally {
      await h.client!.exec(`alter table ${table}_gone rename to ${table};`);
    }
  }

  it("muted: the preferences read failing", async () => {
    const packet = await withTableGone("notification_preferences", () =>
      packetFor(S.lane)
    );
    expect(packet.muted).toEqual({
      status: "unavailable",
      reason: expect.any(String),
    });
    expect(packet.devboxJobs?.status).toBe("ok");
  });

  it("devboxJobs: the events read failing", async () => {
    const packet = await withTableGone("events", () => packetFor(S.lane));
    expect(packet.devboxJobs).toEqual({
      status: "unavailable",
      reason: expect.any(String),
    });
    expect(packet.muted).toEqual({ status: "ok", muted: true });
  });
});
