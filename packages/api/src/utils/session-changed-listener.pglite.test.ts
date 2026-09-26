/**
 * Live session updates — migration 0277's row trigger → the ONE listener →
 * `focus_session:updated`, on a REAL Postgres (PGlite supports LISTEN/NOTIFY).
 *
 * Real: the migration SQL file (applied twice), the trigger functions, NOTIFY
 * delivery, the listener's coalescing window and the bridge body builder.
 *
 * Stubbed, and why:
 *  - `sessionReaderIds` — the audience RULE (owner + human seats the session
 *    read predicate admits: minted-room stamp, users.user_type, workspace
 *    floor) is owned and pglite-tested against the full schema in
 *    routers/focus-sessions.shared-read.pglite.test.ts ("the fan-out audience
 *    is exactly the readers"). Here it is a spy, and the test asserts the
 *    listener pushes to EXACTLY what it returns, for exactly this session —
 *    i.e. that the push audience is wired to the read rule, not re-derived.
 *  - `fetch` — the realtime bridge is another process; captured so the exact
 *    bodies (event, userId room, id-only data) are asserted.
 *  - postgres.js `sql.listen` — adapted to PGlite's `listen` through the
 *    listener's `NotifySource` seam (the one line that differs in production).
 *
 * The writes are plain `db.update(focusSessions)` — the shape of the ~35 writers
 * that never emitted by hand (update-session, complete-session, advance-stage,
 * jobs, …). The point of the trigger is that WHICH writer does not matter.
 *
 * Tables are minimal hand DDL (only the columns the trigger + audience read);
 * the full 0000..0277 chain is not replayed here.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    listen: (
      channel: string,
      cb: (payload: string) => void
    ) => Promise<() => Promise<void>>;
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
      schema: {
        focusSessions: actual.focusSessions as never,
      },
    }),
  };
});

vi.mock("../access/session-visibility.js", () => ({
  sessionReaderIds: vi.fn(),
}));

import { db, eq, focusSessions } from "@synap/database";
import { sessionReaderIds } from "../access/session-visibility.js";
import {
  startSessionChangedListener,
  SESSION_CHANGED_CHANNEL,
  type NotifySource,
} from "./session-changed-listener.js";

const MIGRATION = readFileSync(
  fileURLToPath(
    new URL(
      "../../../database/migrations/0277_focus_session_changed_notify.sql",
      import.meta.url
    )
  ),
  "utf8"
);

const OWNER = "user-owner";
const ROSTER = "user-roster";
const WINDOW_MS = 60;

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const pgliteSource: NotifySource = {
  listen: async (channel, onNotify, onListen) => {
    const unsub = await h.client!.listen(channel, onNotify);
    onListen?.();
    return { unlisten: () => unsub() };
  },
  notify: async (channel, payload) => {
    await q("select pg_notify($1, $2)", [channel, payload]);
  },
};

type Body = {
  event: string;
  userId?: string;
  workspaceId?: string;
  data: unknown;
};
let fetchMock: ReturnType<typeof vi.fn>;
const bodies = (): Body[] =>
  (fetchMock.mock.calls as Array<[string, { body: string }]>).map((c) =>
    JSON.parse(c[1].body)
  );
const settle = () => new Promise((r) => setTimeout(r, WINDOW_MS * 3));

async function session() {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal) values ($1, $2, 'SECRET GOAL')`,
    [id, OWNER]
  );
  return id;
}

const readers = vi.mocked(sessionReaderIds);

let stop: (() => Promise<void>) | null = null;

beforeAll(async () => {
  await h.client!.exec(`
    create table focus_sessions (
      id uuid primary key default gen_random_uuid(),
      user_id text not null,
      channel_id uuid,
      goal text,
      progress integer default 0
    );
    create table session_evaluations (
      id uuid primary key default gen_random_uuid(),
      session_id uuid not null references focus_sessions(id) on delete cascade,
      criterion_key text, verdict text
    );
  `);
  await h.client!.exec(MIGRATION);
});

beforeEach(async () => {
  readers.mockReset();
  readers.mockResolvedValue([OWNER]);
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal("fetch", fetchMock);
  ({ stop } = await startSessionChangedListener({
    source: pgliteSource,
    windowMs: WINDOW_MS,
    heartbeatMs: 60_000,
  }));
});

afterEach(async () => {
  await stop?.();
  vi.unstubAllGlobals();
});

describe("migration 0277", () => {
  it("is idempotent — applied twice, each trigger exists exactly once", async () => {
    await expect(h.client!.exec(MIGRATION)).resolves.toBeDefined();
    const { rows } = await q<{ tgname: string }>(
      `select tgname from pg_trigger where not tgisinternal
         and tgname in ('trg_focus_sessions_changed_notify', 'trg_session_evaluations_changed_notify')
       order by tgname`
    );
    expect(rows.map((r) => r.tgname)).toEqual([
      "trg_focus_sessions_changed_notify",
      "trg_session_evaluations_changed_notify",
    ]);
  });
});

describe("row trigger → listener → focus_session:updated", () => {
  it("an UPDATE by a writer that never emitted pushes id-only to exactly the session's readers", async () => {
    const id = await session();
    await settle();
    fetchMock.mockClear();
    readers.mockClear();
    readers.mockResolvedValue([OWNER, ROSTER]);

    await db
      .update(focusSessions)
      .set({ progress: 40 } as never)
      .where(eq(focusSessions.id, id));
    await settle();

    // The audience is the read rule's answer for THIS session — nothing added.
    expect(readers.mock.calls).toEqual([[id]]);
    const sent = bodies();
    expect(sent.map((b) => b.event)).toEqual([
      "focus_session:updated",
      "focus_session:updated",
    ]);
    expect(sent.map((b) => b.userId).sort()).toEqual([ROSTER, OWNER].sort());
    for (const b of sent) {
      expect(b.workspaceId).toBeUndefined();
      expect(b.data).toEqual({ id, sessionId: id });
    }
    expect(JSON.stringify(sent)).not.toContain("SECRET GOAL");
  });

  it("a failed audience read pushes nothing (never a guessed audience)", async () => {
    const id = await session();
    await settle();
    fetchMock.mockClear();
    readers.mockRejectedValue(new Error("db down"));

    await q(`update focus_sessions set progress = 1 where id = $1`, [id]);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an INSERT pushes to the owner", async () => {
    await session();
    await settle();
    expect(bodies().map((b) => b.userId)).toEqual([OWNER]);
  });

  it("a burst of N updates to one session coalesces into ONE emit per member", async () => {
    const id = await session();
    await settle();
    fetchMock.mockClear();

    for (let i = 0; i < 5; i++) {
      await q(`update focus_sessions set progress = $2 where id = $1`, [id, i]);
    }
    await settle();
    expect(bodies()).toHaveLength(1);
    expect(bodies()[0]).toMatchObject({
      userId: OWNER,
      data: { sessionId: id },
    });
  });

  it("a session_evaluations row pushes its SESSION", async () => {
    const id = await session();
    await settle();
    fetchMock.mockClear();

    await q(
      `insert into session_evaluations (session_id, criterion_key, verdict) values ($1, 'c1', 'pass')`,
      [id]
    );
    await settle();
    expect(bodies()).toHaveLength(1);
    expect(bodies()[0].data).toEqual({ id, sessionId: id });
  });

  it("a rolled-back write pushes nothing (NOTIFY fires at COMMIT)", async () => {
    const id = await session();
    await settle();
    fetchMock.mockClear();

    await h.client!.exec(
      `begin; update focus_sessions set progress = 9 where id = '${id}'; rollback;`
    );
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("heartbeat", () => {
  it("re-LISTENs when the ping does not come back (a silently dropped LISTEN)", async () => {
    await stop?.();
    let listens = 0;
    // A source whose LISTEN "succeeds" but never delivers — the postgres.js
    // failure mode after a swallowed re-LISTEN.
    const deaf: NotifySource = {
      listen: async () => {
        listens++;
        return { unlisten: async () => undefined };
      },
      notify: async () => undefined,
    };
    const l = await startSessionChangedListener({
      source: deaf,
      windowMs: WINDOW_MS,
      heartbeatMs: 20,
    });
    await new Promise((r) => setTimeout(r, 90));
    await l.stop();
    expect(listens).toBeGreaterThanOrEqual(2);
  });

  it("does NOT re-LISTEN while pings come back", async () => {
    await stop?.();
    let listens = 0;
    const counting: NotifySource = {
      listen: async (ch, fn, onListen) => {
        listens++;
        return pgliteSource.listen(ch, fn, onListen);
      },
      notify: pgliteSource.notify,
    };
    const l = await startSessionChangedListener({
      source: counting,
      windowMs: WINDOW_MS,
      heartbeatMs: 20,
    });
    await new Promise((r) => setTimeout(r, 120));
    await l.stop();
    expect(listens).toBe(1);
    expect(SESSION_CHANGED_CHANNEL).toBe("focus_session_changed");
  });
});
