/**
 * WAIT EPISODES on real SQL (PGlite, every table, the 0386 indexes): the
 * status watcher's tick opens one episode per wait THE waiting-on collector
 * finds — a paused thing's hold, a session's open sub-session — keeps it
 * single across ticks, closes it on the first tick the wait is gone, and opens
 * a new one when the wait recurs. The first tick sends no push and writes no
 * notification (an episode is history). A ref names what is waited on, with
 * its wait kind.
 *
 * Stubbed: `getEffectiveLifecycle` (no lifecycle under test), the fan-out,
 * Expo, the socket.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  pushes: [] as unknown[],
  fannedOut: [] as unknown[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    getDb: async () => h.db,
    ProfileResolutionService: class extends (actual.ProfileResolutionService as new (
      db: unknown
    ) => object) {
      async getEffectiveLifecycle() {
        return null;
      }
    },
  };
  Object.defineProperty(mocked, "db", {
    get: () => h.db,
    enumerable: true,
  });
  return mocked;
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async (p: unknown) => {
    h.fannedOut.push(p);
  },
}));
vi.mock("../../../notifications/expo-push.js", () => ({
  sendExpoPush: async (input: unknown) => {
    h.pushes.push(input);
    return { sent: 1, revoked: 0, failed: 0 };
  },
}));
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@synap/database/schema";
import { readWaitEpisodes } from "@synap/database";
import {
  allSchemaTables,
  pgliteTableDdl,
} from "../../../__tests__/pglite-ddl.js";
import { runStatusWatcher } from "../watcher.js";

const M0386 = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../database/migrations/0386_status_wait_episode.sql"
  ),
  "utf8"
);

const ME = "user-me";
const W = randomUUID();
const KIND = randomUUID();
const THING = randomUUID();
const S_WORK = randomUUID();
const S_CHILD = randomUUID();
const NOW = new Date("2026-10-31T12:00:00.000Z");
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

let client: PGlite;
const q = <T>(sql: string, params: unknown[] = []) =>
  client.query<T>(sql, params);

async function session(id: string, title: string, status = "active") {
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, title, goal, status, origin, expected_outputs, metadata, started_at, created_at, updated_at)
     values ($1, $2, $3, $4, 'Do it', $5, 'user', '[]'::jsonb, '{}'::jsonb, now(), now(), now())`,
    [id, ME, W, title, status]
  );
}

const episodes = () =>
  q<{
    subject_type: string;
    subject_id: string;
    wait_kind: string;
    on: string | null;
    reason: string | null;
    ref: { kind: string; id?: string; label: string } | null;
    opened_at: string;
    closed_at: string | null;
  }>(
    `select subject_type, subject_id, wait_kind, "on", reason, ref, opened_at, closed_at
       from status_wait_episode order by opened_at, wait_kind`
  ).then((r) => r.rows);

const openOf = async (subjectId: string) =>
  (await episodes()).filter(
    (e) => e.subject_id === subjectId && e.closed_at === null
  );

beforeAll(async () => {
  client = new PGlite();
  for (const t of allSchemaTables()) await client.exec(pgliteTableDdl(t));
  // The open-episode unique index the writer's ON CONFLICT relies on.
  await client.exec(M0386);
  h.db = drizzle(client, { schema });

  await q(
    `insert into users (id, name, email, user_type, timezone) values ($1, 'Me', 'me@x.io', 'human', 'UTC')`,
    [ME]
  );
  await q(
    `insert into workspaces (id, owner_id, name, workspace_type) values ($1, $2, 'Sales', 'personal')`,
    [W, ME]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), W, ME]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, entity_scope, is_active) values ($1, 'invoice', 'invoice', 'kind', 'workspace', true)`,
    [KIND]
  );
  // A paused thing, its hold on a person, reviewed only next week (no signal).
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, title, status, properties, created_at, updated_at)
     values ($1, $2, $3, $4, 'Invoice 9', 'disputed', '{}'::jsonb, now(), now())`,
    [THING, ME, W, KIND]
  );
  const since = new Date(NOW.getTime() - 86_400_000).toISOString();
  await q(
    `insert into lifecycle_transition_outbox (transition_id, transition, created_at) values ($1, $2::jsonb, $3)`,
    [
      randomUUID(),
      JSON.stringify({
        transitionId: randomUUID(),
        subjectType: "entity",
        subjectId: THING,
        entityId: THING,
        facetId: null,
        role: null,
        to: "disputed",
        category: "paused",
        userId: ME,
        workspaceId: W,
        recordedAt: since,
        hold: {
          on: "person",
          reason: "Ana's numbers",
          reviewBy: new Date(NOW.getTime() + 7 * 86_400_000).toISOString(),
          since,
          resumeTo: "sent",
        },
      }),
      since,
    ]
  );
  // A session waiting on its open sub-session.
  await session(S_WORK, "Close the quarter");
  await session(S_CHILD, "Lane B");
  await q(
    `insert into links (id, created_by, from_type, from_id, to_type, to_id, link_type, created_at)
     values ($1, $2, 'session', $3, 'session', $4, 'spawned_from', now())`,
    [randomUUID(), ME, S_CHILD, S_WORK]
  );
});

describe("wait episodes, written by the status watcher's tick", () => {
  it("the first tick opens one episode per wait, in-app only: no push, no notification", async () => {
    const r = await runStatusWatcher(NOW);
    expect(r.waitEpisodes).toMatchObject({ opened: 2, closed: 0, unread: 0 });
    const open = await episodes();
    expect(
      open.map((e) => [e.subject_type, e.subject_id, e.wait_kind, e.on])
    ).toEqual(
      expect.arrayContaining([
        ["entity", THING, "answer", "person"],
        ["focus_session", S_WORK, "another_work", null],
      ])
    );
    expect(open).toHaveLength(2);
    const child = open.find((e) => e.subject_id === S_WORK)!;
    expect(child.ref).toMatchObject({ kind: "session", id: S_CHILD });
    expect(child.reason).toBe("another_work");
    expect(new Date(child.opened_at).toISOString()).toBe(NOW.toISOString());
    // History, not a signal: nothing pushed, nothing in the bell.
    expect(h.pushes).toEqual([]);
    expect(
      (await q<{ n: number }>(`select count(*)::int as n from notifications`))
        .rows[0]!.n
    ).toBe(0);
    expect(r.raised).toBe(0);
  });

  it("stays single across ticks", async () => {
    const r = await runStatusWatcher(at(1));
    expect(r.waitEpisodes).toMatchObject({ opened: 0, closed: 0 });
    expect(await episodes()).toHaveLength(2);
  });

  it("closes on the first tick its wait is gone; the other stays open", async () => {
    await q(`update focus_sessions set status = 'completed' where id = $1`, [
      S_CHILD,
    ]);
    const r = await runStatusWatcher(at(2));
    expect(r.waitEpisodes).toMatchObject({ opened: 0, closed: 1 });
    const closed = (await episodes()).find((e) => e.subject_id === S_WORK)!;
    expect(new Date(closed.closed_at!).toISOString()).toBe(at(2).toISOString());
    expect(await openOf(THING)).toHaveLength(1);

    // The thing resumes: its hold no longer stands, its episode closes.
    await q(`update entities set status = 'sent' where id = $1`, [THING]);
    expect((await runStatusWatcher(at(3))).waitEpisodes).toMatchObject({
      opened: 0,
      closed: 1,
    });
    expect(await openOf(THING)).toEqual([]);
  });

  it("a wait that recurs opens a NEW episode; the reader lists both", async () => {
    await q(`update focus_sessions set status = 'active' where id = $1`, [
      S_CHILD,
    ]);
    expect((await runStatusWatcher(at(4))).waitEpisodes).toMatchObject({
      opened: 1,
    });
    const listed = await readWaitEpisodes(h.db as never, [
      { subjectType: "focus_session", subjectId: S_WORK },
    ]);
    expect(listed.map((e) => [e.waitKind, e.openedAt, e.closedAt])).toEqual([
      ["another_work", NOW.toISOString(), at(2).toISOString()],
      ["another_work", at(4).toISOString(), null],
    ]);
    expect(h.pushes).toEqual([]);
  });
});
