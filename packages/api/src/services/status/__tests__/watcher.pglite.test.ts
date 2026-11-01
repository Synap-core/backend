/**
 * THE STATUS WATCHER on real SQL (PGlite, every table): each kind of signal
 * (late, approaching, stuck from the latest move's `occurredAt`, hold review
 * due for a thing, a goal and a session) is raised once, not again an hour
 * later, and again after it clears and recurs; it carries its goal and
 * project and is fanned out; old news is not pushed; it is told only to a
 * person who owns the thing or its goal and can read it; it shows up in
 * needs-you (`signals.count`, the real read); a bad hold row is skipped.
 * DEV WORK: a PR left green, a PR left red, a red main nobody owns, each on
 * the session that owns it, in-app first, escalated once, in the session's
 * change feed.
 *
 * Stubbed: `getEffectiveLifecycle` (its own suites prove it), the event log
 * writer (to the same PGlite `events` table), Expo, the socket, and the
 * review-session read the needs-you count makes (as its own suite does).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const INVOICE = "11111111-1111-4111-8111-111111111111";
const DEAL = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  tables: [] as unknown[],
  fannedOut: [] as Array<Record<string, unknown>>,
  pushes: [] as Array<Record<string, unknown>>,
  statusPushes: [] as Array<Record<string, unknown>>,
  db: null as unknown as Record<string, unknown>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { is } = await import("drizzle-orm");
  const { PgTable } = await import("drizzle-orm/pg-core");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.tables = Object.values(actual).filter((v) => is(v, PgTable));
  const schema = await import("@synap/database/schema");
  const pg = drizzle(client, { schema });
  h.db = pg as unknown as Record<string, unknown>;
  return {
    ...actual,
    db: pg,
    getDb: async () => pg,
    eventRepository: { append: async () => undefined },
    // The log row, written to the same PGlite `events` table.
    EventRepository: class {
      async append(e: Record<string, unknown>) {
        await client.query(
          `insert into events (id, type, subject_id, subject_type, data, user_id, workspace_id, source, timestamp)
           values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
          [
            e.id,
            e.type,
            e.subjectId,
            e.subjectType,
            JSON.stringify(e.data),
            e.userId,
            e.workspaceId ?? null,
            e.source,
            (e.timestamp as Date).toISOString(),
          ]
        );
        return { id: e.id };
      }
    },
    ProfileResolutionService: class extends (actual.ProfileResolutionService as new (
      db: unknown
    ) => object) {
      async getEffectiveLifecycle(profileId: string) {
        if (profileId === INVOICE) {
          return {
            propertySlug: "status",
            options: [
              { key: "draft", category: "open" },
              { key: "sent", category: "active", dateBinding: "dueDate" },
              { key: "disputed", category: "paused" },
              { key: "paid", category: "done" },
            ],
            unclassified: [],
          };
        }
        if (profileId === DEAL) {
          return {
            propertySlug: "stage",
            options: [
              { key: "lead", category: "open" },
              { key: "negotiating", category: "active", stuckAfterDays: 3 },
              { key: "won", category: "done" },
            ],
            unclassified: [],
          };
        }
        return null;
      }
    },
  };
});

vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async (p: Record<string, unknown>) => {
    h.fannedOut.push(p);
  },
}));
vi.mock("../../../notifications/expo-push.js", () => ({
  sendExpoPush: async (input: Record<string, unknown>) => {
    h.pushes.push(input);
    return { sent: 1, revoked: 0, failed: 0 };
  },
}));
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
// The realtime push of a raised signal (its audience and wire have their own
// suite, status-realtime.pglite.test.ts): recorded here, so a raise that
// stops pushing goes red.
vi.mock("../status-realtime.js", () => ({
  pushStatusSignal: async (s: Record<string, unknown>) => {
    h.statusPushes.push(s);
  },
}));
vi.mock("../../projects/project-needs-you.js", () => ({
  listSessionsAwaitingReview: async () => ({ sessions: [], truncated: false }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { shortDate } from "@synap-core/types/lens";
import { WORK_CLOCK } from "@synap-core/types/work-clock";
import { runStatusWatcher, signalWords } from "../watcher.js";
import { signalsRouter } from "../../../routers/signals.js";
import { listSessionChanges } from "../../focus-sessions/session-changes.js";

const ME = "user-me";
const AGENT = "user-agent";
const GOAL_OWNER = "user-goal-owner";
const W = randomUUID();
const P = randomUUID();
const G = randomUUID();
const I_LATE = randomUUID();
const I_SOON = randomUUID();
const I_FAR = randomUUID();
const I_HELD = randomUUID();
const D_STUCK = randomUUID();
const D_FRESH = randomUUID();
const D_AGENT_GOAL = randomUUID();
const D_HIDDEN = randomUUID();
const I_BAD = randomUUID();
const I_EDGE = randomUUID();
const I_RETRY = randomUUID();
const G_HELD = randomUUID();
const G_AGENT = randomUUID();
const S_HELD = randomUUID();
const W_PRIVATE = randomUUID();
const DAY = 86_400_000;
// Noon UTC today: a fixed time of day, so the date-horizon case below (a due
// time whose local date is a day later than its UTC one) always falls inside.
const NOW = new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00.000Z`);
const day = (offset: number) =>
  new Date(NOW.getTime() + offset * DAY).toISOString().slice(0, 10);

const q = <T>(sql: string, params: unknown[] = []) =>
  h.client!.query<T>(sql, params);

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    const d = c.default as unknown;
    let def = "";
    if (d !== undefined && typeof d !== "object" && typeof d !== "function") {
      def =
        typeof d === "string"
          ? ` default '${d.replace(/'/g, "''")}'`
          : ` default ${d}`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${def}`;
  });
  const pk = getTableConfig(table).primaryKeys[0];
  const pkCols = pk
    ? pk.columns.map((c) => `"${c.name}"`)
    : cfg.columns.filter((c) => c.primary).map((c) => `"${c.name}"`);
  const schema = cfg.schema ? `"${cfg.schema}".` : "";
  return `create table if not exists ${schema}"${cfg.name}" (${columns.join(", ")}${
    pkCols.length ? `, primary key (${pkCols.join(", ")})` : ""
  });`;
}

/** A recorded move INTO the thing's current step, `daysAgo` back. */
async function moved(entityId: string, daysAgo: number) {
  const at = new Date(NOW.getTime() - daysAgo * DAY).toISOString();
  await q(
    `insert into events (id, type, subject_id, subject_type, data, user_id, workspace_id, timestamp)
     values ($1, 'entity.transition.completed', $2, 'entity', $3::jsonb, $4, $5, $6)`,
    [
      randomUUID(),
      entityId,
      JSON.stringify({ role: null, occurredAt: at, recordedAt: at }),
      ME,
      W,
      at,
    ]
  );
}

/** A current hold on a paused subject, its review date `reviewDays` from now. */
async function hold(
  subjectType: string,
  subjectId: string,
  to: string,
  reviewDays: number,
  o: {
    entityId?: string;
    workspaceId?: string;
    reason?: string;
    reviewBy?: string;
  }
) {
  const since = new Date(NOW.getTime() - 10 * DAY).toISOString();
  await q(
    `insert into lifecycle_transition_outbox (transition_id, transition, created_at) values ($1, $2::jsonb, $3)`,
    [
      randomUUID(),
      JSON.stringify({
        transitionId: randomUUID(),
        subjectType,
        subjectId,
        ...(o.entityId
          ? { entityId: o.entityId, facetId: null, role: null }
          : {}),
        to,
        category: "paused",
        userId: ME,
        workspaceId: o.workspaceId ?? null,
        recordedAt: since,
        hold: {
          on: "external",
          reason: o.reason ?? null,
          reviewBy:
            o.reviewBy ??
            new Date(NOW.getTime() + reviewDays * DAY).toISOString(),
          since,
          resumeTo: "active",
        },
      }),
      since,
    ]
  );
}

/** A goal-filed session about the thing (its goal, by the subject spine). */
async function workedToward(entityId: string, trackId: string, ws: string) {
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, project_id, track_id, subject_entity_id, goal, status, origin, expected_outputs, metadata, started_at, created_at, updated_at)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, 'Work it', 'active', 'agent', '[]'::jsonb, '{}'::jsonb, now(), now(), now())`,
    [AGENT, ws, P, trackId, entityId]
  );
}

async function thing(o: {
  id: string;
  profile: string;
  status: string;
  owner?: string;
  title: string;
  properties?: Record<string, unknown>;
  createdDaysAgo?: number;
  workspaceId?: string;
}) {
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, title, status, properties, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, now() - ($8 || ' days')::interval, now())`,
    [
      o.id,
      o.owner ?? ME,
      o.workspaceId ?? W,
      o.profile,
      o.title,
      o.status,
      JSON.stringify(o.properties ?? {}),
      String(o.createdDaysAgo ?? 20),
    ]
  );
}

const signalEvents = (subjectId?: string) =>
  q<{ type: string; data: Record<string, unknown>; timestamp: string }>(
    `select type, data, timestamp from events where type like '%.signal.completed'${
      subjectId ? ` and subject_id = $1` : ""
    } order by timestamp`,
    subjectId ? [subjectId] : []
  ).then((r) => r.rows);

const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

beforeAll(async () => {
  for (const t of h.tables) {
    const cfg = getTableConfig(t as PgTable);
    if (cfg.schema)
      await h.client!.exec(`create schema if not exists "${cfg.schema}";`);
    await h.client!.exec(ddlFor(t as PgTable));
  }
  await q(
    `insert into users (id, name, email, user_type, timezone) values
       ($1, 'Me', 'me@x.io', 'human', 'UTC'),
       ($2, 'Agent', 'agent@x.io', 'agent', 'UTC'),
       ($3, 'Goal owner', 'go@x.io', 'human', 'UTC')`,
    [ME, AGENT, GOAL_OWNER]
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1, 'Sales', $2, '{}'::jsonb)`,
    [W, ME]
  );
  for (const [user, role] of [
    [ME, "owner"],
    [GOAL_OWNER, "editor"],
  ])
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values (gen_random_uuid(), $1, $2, $3)`,
      [W, user, role]
    );
  for (const [id, slug] of [
    [INVOICE, "invoice"],
    [DEAL, "deal"],
  ]) {
    await q(
      `insert into profiles (id, slug, display_name, profile_kind, entity_scope, is_active) values ($1, $2, $2, 'kind', 'workspace', true)`,
      [id, slug]
    );
    await q(
      `insert into profile_properties (profile_id, property_def_id, is_lifecycle) values ($1, gen_random_uuid(), true)`,
      [id]
    );
  }
  await q(
    `insert into projects (id, user_id, workspace_id, name, status, created_at, updated_at) values ($1, $2, null, 'Sales push', 'active', now(), now())`,
    [P, ME]
  );
  await q(
    `insert into project_tracks (id, project_id, user_id, name, definition_snapshot, method_version, status, criteria, created_at, updated_at)
     values ($1, $2, $3, 'Close Q4', '{}'::jsonb, '1', 'active', '[]'::jsonb, now(), now())`,
    [G, P, ME]
  );
  await q(
    `insert into track_participants (id, track_id, principal_kind, principal_id, role) values (gen_random_uuid(), $1, 'person', $2, 'owner')`,
    [G, GOAL_OWNER]
  );

  // Invoices: one late, one due in two days, one far out, one paused.
  await thing({
    id: I_LATE,
    profile: INVOICE,
    status: "sent",
    title: "Invoice 101",
    properties: { dueDate: day(-5) },
  });
  await thing({
    id: I_SOON,
    profile: INVOICE,
    status: "sent",
    title: "Invoice 102",
    properties: { dueDate: day(2) },
  });
  await thing({
    id: I_FAR,
    profile: INVOICE,
    status: "sent",
    title: "Invoice 103",
    properties: { dueDate: day(30) },
  });
  // Due 3 days from now minus an hour, written with a +14:00 offset: its
  // local date is a day after the UTC day it falls due on.
  await thing({
    id: I_EDGE,
    profile: INVOICE,
    status: "sent",
    title: "Invoice 107",
    properties: { dueDate: `${day(4)}T01:00:00+14:00` },
  });
  await thing({
    id: I_HELD,
    profile: INVOICE,
    status: "disputed",
    title: "Invoice 104",
    properties: { dueDate: day(-40) },
  });
  // Its pause: a hold whose review date passed two days ago.
  await hold("entity", I_HELD, "disputed", -2, {
    entityId: I_HELD,
    workspaceId: W,
    reason: "Client disputes the amount",
  });
  // A hold written around the doors, its review date in no stamp shape: it
  // is skipped, and must not fail the watcher's read.
  await thing({
    id: I_BAD,
    profile: INVOICE,
    status: "disputed",
    title: "Invoice 105",
  });
  await hold("entity", I_BAD, "disputed", 0, {
    entityId: I_BAD,
    reviewBy: "next tuesday",
  });
  // A paused goal and a paused session, both past their review date.
  await q(
    `insert into project_tracks (id, project_id, user_id, name, definition_snapshot, method_version, status, criteria, created_at, updated_at)
     values ($1, $2, $3, 'Hire a designer', '{}'::jsonb, '1', 'paused', '[]'::jsonb, now(), now())`,
    [G_HELD, P, ME]
  );
  await hold("track", G_HELD, "paused", -2, { reason: "Budget freeze" });
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, goal, title, status, origin, expected_outputs, metadata, started_at, created_at, updated_at)
     values ($1, $2, $3, 'Draft the brief', 'Draft the brief', 'paused', 'human', '[]'::jsonb, '{}'::jsonb, now(), now(), now())`,
    [S_HELD, ME, W]
  );
  await hold("focus_session", S_HELD, "paused", -3, {});

  // Deals: one in talks for 5 days (stuck after 3), one moved in yesterday.
  // The stuck one was captured by an agent and is worked toward goal G.
  await thing({
    id: D_STUCK,
    profile: DEAL,
    status: "negotiating",
    owner: AGENT,
    title: "ACME renewal",
  });
  await moved(D_STUCK, 5);
  await workedToward(D_STUCK, G, W);
  await thing({
    id: D_FRESH,
    profile: DEAL,
    status: "negotiating",
    title: "Globex",
  });
  await moved(D_FRESH, 1);
  // An agent's deal whose goal was started by an agent (no owner seat): the
  // goal's owner is that agent, so nobody is told.
  await q(
    `insert into project_tracks (id, project_id, user_id, name, definition_snapshot, method_version, status, criteria, created_at, updated_at)
     values ($1, $2, $3, 'Agent goal', '{}'::jsonb, '1', 'active', '[]'::jsonb, now(), now())`,
    [G_AGENT, P, AGENT]
  );
  await thing({
    id: D_AGENT_GOAL,
    profile: DEAL,
    status: "negotiating",
    owner: AGENT,
    title: "Initech",
  });
  await moved(D_AGENT_GOAL, 6);
  await workedToward(D_AGENT_GOAL, G_AGENT, W);
  // An agent's deal in a space the goal's owner is not in: they cannot read
  // it, so nobody is told.
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1, 'Private', $2, '{}'::jsonb)`,
    [W_PRIVATE, ME]
  );
  await thing({
    id: D_HIDDEN,
    profile: DEAL,
    status: "negotiating",
    owner: AGENT,
    title: "Umbrella",
    workspaceId: W_PRIVATE,
  });
  await moved(D_HIDDEN, 6);
  await workedToward(D_HIDDEN, G, W_PRIVATE);
});

describe("the status watcher", () => {
  it("raises each kind of signal once, placed in its goal and project", async () => {
    const r = await runStatusWatcher(NOW);
    expect(r).toMatchObject({ noticed: 9, raised: 9, unowned: 2 });
    const raised = await signalEvents();
    const bySubject = new Map(raised.map((e) => [String(e.data.subjectId), e]));
    expect(bySubject.get(I_LATE)?.data).toMatchObject({
      signal: "late",
      status: "sent",
      category: "active",
      lifecycleProfile: "invoice",
      property: "dueDate",
      ownerId: ME,
    });
    expect(bySubject.get(I_SOON)?.data.signal).toBe("approaching");
    // A positive offset never hides a thing that is nearly due.
    expect(bySubject.get(I_EDGE)?.data.signal).toBe("approaching");
    expect(bySubject.get(I_HELD)?.data).toMatchObject({
      signal: "hold_review_due",
      status: "disputed",
      category: "paused",
      holdReason: "Client disputes the amount",
    });
    // Stuck from the latest move's occurredAt, and placed in its goal.
    expect(bySubject.get(D_STUCK)?.data).toMatchObject({
      signal: "stuck",
      afterDays: 3,
      forDays: 5,
      trackId: G,
      projectId: P,
      ownerId: GOAL_OWNER,
    });
    // A goal's and a session's pause.
    expect(bySubject.get(G_HELD)).toMatchObject({
      type: "track.signal.completed",
      data: {
        signal: "hold_review_due",
        trackId: G_HELD,
        projectId: P,
        ownerId: ME,
      },
    });
    expect(bySubject.get(S_HELD)).toMatchObject({
      type: "focus_session.signal.completed",
      data: { signal: "hold_review_due", ownerId: ME },
    });
    for (const id of [I_FAR, D_FRESH, I_BAD])
      expect(bySubject.has(id)).toBe(false);
    // Fanned out to the automation matcher, one per episode.
    const signals = h.fannedOut.filter((p) => p.action === "signal");
    expect(signals.map((p) => p.subjectType).sort()).toEqual(
      [...Array(7).fill("entity"), "focus_session", "track"].sort()
    );
    expect(signals.every((p) => p.eventId)).toBe(true);
    // Pushed in realtime once per episode, to its readers (status-realtime).
    expect(
      h.statusPushes
        .map((p) => `${p.subjectType}:${p.subjectId}:${p.signal}`)
        .sort()
    ).toEqual(
      raised
        .map(
          (e) => `${e.data.subjectType}:${e.data.subjectId}:${e.data.signal}`
        )
        .sort()
    );
    expect(h.statusPushes).toHaveLength(9);
  });

  it("pushes only fresh news: a signal that began over a day ago lands in-app only", async () => {
    // Only the approaching invoices began within the day (their window
    // opened under a day ago); the late, stuck and review-due ones are
    // backlog. (Invoice 107's words count days by its own date, in UTC.)
    expect(h.pushes.map((p) => p.title).sort()).toEqual([
      "Invoice 102 is due in 2 days",
      "Invoice 107 is due in 4 days",
    ]);
    const rows = await q<{ n: number }>(
      `select count(*)::int as n from notifications where type like '%.signal' and status = 'unread'`
    );
    expect(rows.rows[0]!.n).toBe(7);
  });

  it("does not raise the same episode again an hour later", async () => {
    const before = (await signalEvents()).length;
    const r = await runStatusWatcher(at(1));
    expect(r).toMatchObject({ noticed: 9, raised: 0 });
    expect(await signalEvents()).toHaveLength(before);
  });

  it("raises again after the late state clears and recurs", async () => {
    // Clears: paid.
    await q(`update entities set status = 'paid' where id = $1`, [I_LATE]);
    expect(await runStatusWatcher(at(2))).toMatchObject({
      noticed: 8,
      raised: 0,
    });
    // Recurs: back to sent (a new stay in the step), the date still passed.
    await q(`update entities set status = 'sent' where id = $1`, [I_LATE]);
    await moved(I_LATE, -2 / 24);
    expect(await runStatusWatcher(at(3))).toMatchObject({ raised: 1 });
    const late = await signalEvents(I_LATE);
    expect(late.map((e) => e.data.signal)).toEqual(["late", "late"]);
  });

  it("tells a person who owns the thing or its goal and can read it — nobody else", async () => {
    const notes = await q<{ user_id: string; type: string; title: string }>(
      `select user_id, type, title from notifications order by created_at`
    );
    const to = (title: string) =>
      notes.rows.filter((n) => n.title === title).map((n) => n.user_id);
    expect(to("Invoice 101 is late")).toEqual([ME, ME]);
    // An agent's thing: its goal's owner (the owner seat, not the starter).
    expect(to("ACME renewal has been in Negotiating for 5 days")).toEqual([
      GOAL_OWNER,
    ]);
    // A goal owned by an agent, and a goal owner who cannot read the thing.
    expect(to("Initech has been in Negotiating for 6 days")).toEqual([]);
    expect(to("Umbrella has been in Negotiating for 6 days")).toEqual([]);
    const events = await signalEvents();
    for (const id of [D_AGENT_GOAL, D_HIDDEN]) {
      expect(
        events.find((e) => e.data.subjectId === id)?.data.ownerId
      ).toBeNull();
    }
    expect(to("Hire a designer has been paused longer than planned")).toEqual([
      ME,
    ]);
    expect(to("Draft the brief has been paused longer than planned")).toEqual([
      ME,
    ]);
    expect([...new Set(notes.rows.map((n) => n.type))].sort()).toEqual([
      "entity.signal",
      "session.signal",
      "track.signal",
    ]);
  });

  it("shows up in needs-you", async () => {
    const ctx = {
      db: null,
      authenticated: true,
      userId: GOAL_OWNER,
      workspaceId: null,
    } as never;
    const count = await signalsRouter.createCaller(ctx).count({} as never);
    expect(count.notifications).toBe(1);
    expect(count.needsYou).toBeGreaterThanOrEqual(1);
  });
});

describe("the status watcher, when a tick fails half-way", () => {
  it("gives back every claim it did not raise, so the next tick raises it; a thing that entered its step after its date counts from then", async () => {
    // Late by its date, but it entered "sent" three hours after NOW: it is
    // fresh news, not backlog.
    await thing({
      id: I_RETRY,
      profile: INVOICE,
      status: "sent",
      title: "Invoice 106",
      properties: { dueDate: day(-5) },
    });
    await moved(I_RETRY, -3 / 24);
    const db = h.db;
    const real = db.selectDistinctOn;
    db.selectDistinctOn = () => {
      throw new Error("places down");
    };
    try {
      await expect(runStatusWatcher(at(4))).rejects.toThrow("places down");
    } finally {
      db.selectDistinctOn = real;
    }
    h.pushes.length = 0;
    // A new push day: ME already had today's 3 (the cap is its own suite).
    await q(`update notifications set pushed_at = null`);
    expect(await runStatusWatcher(at(5))).toMatchObject({ raised: 1 });
    const [late] = await signalEvents(I_RETRY);
    expect(late?.data).toMatchObject({
      signal: "late",
      beganAt: new Date(NOW.getTime() + 3 * 3_600_000).toISOString(),
    });
    expect(h.pushes.map((p) => p.title)).toEqual(["Invoice 106 is late"]);
  });
});

describe("signalWords", () => {
  const NOW_W = new Date("2026-10-29T10:00:00.000Z");
  const words = (c: Parameters<typeof signalWords>[0]) =>
    signalWords(c, "Invoice 102", NOW_W);

  it("late and approaching: the date in words, the status label, a next step", () => {
    expect(
      words({
        signal: "late",
        statusLabel: "Sent",
        facts: { property: "dueDate", date: "2026-10-20" },
      })
    ).toEqual({
      headline: "Invoice 102 is late",
      detail: `The due date was ${shortDate("2026-10-20")} and the status is still Sent. Update it or move it on.`,
    });
    const due = (date: string) =>
      words({
        signal: "approaching",
        statusLabel: "Sent",
        facts: { property: "dueDate", date },
      }).headline;
    expect(due("2026-10-29")).toBe("Invoice 102 is due today");
    expect(due("2026-10-30")).toBe("Invoice 102 is due tomorrow");
    expect(due("2026-10-31")).toBe("Invoice 102 is due in 2 days");
  });

  it("stuck: one day is a day", () => {
    expect(
      words({
        signal: "stuck",
        statusLabel: "Negotiating",
        facts: { forDays: 1, afterDays: 1 },
      })
    ).toEqual({
      headline: "Invoice 102 has been in Negotiating for 1 day",
      detail:
        "This step usually moves on within 1 day. Move it on, or pause it with a reason.",
    });
  });

  it("hold review: since when, and why, then what to do", () => {
    expect(
      words({
        signal: "hold_review_due",
        statusLabel: "Disputed",
        facts: {
          pausedSince: "2026-10-01T09:00:00.000Z",
          holdReason: "Client disputes the amount",
        },
      })
    ).toEqual({
      headline: "Invoice 102 has been paused longer than planned",
      detail: `Paused since ${shortDate("2026-10-01")}: Client disputes the amount. Resume it, or note what it is still waiting on.`,
    });
  });
});

describe("the status watcher, on dev work standing still", () => {
  const T1 = at(6);
  const HOUR = 3_600_000;
  const before = (ms: number) => new Date(T1.getTime() - ms).toISOString();
  const S_GREEN = randomUUID();
  const S_RED = randomUUID();
  const S_CULPRIT = randomUUID();
  const S_ESCALATED = randomUUID();
  const S_NOT_POSTERS = randomUUID();
  const S_OWNS_BROWSER = randomUUID();
  const S_STALE_OWNER = randomUUID();
  const S_PAUSED = randomUUID();
  const S_QUIET = randomUUID();
  const S_OLD_CULPRIT = randomUUID();
  const S_R = [randomUUID(), randomUUID(), randomUUID()];
  const BE = "Synap-core/backend";
  const CLI = "Synap-core/synap-cli";
  const AB = "Synap-core/app-bases";
  const RELAY = "Synap-core/relay-app";

  const session = (
    id: string,
    title: string,
    owner = ME,
    status = "active",
    startedAt: string | null = null
  ) =>
    q(
      `insert into focus_sessions (id, user_id, workspace_id, goal, title, status, origin, expected_outputs, metadata, started_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, 'agent', '[]'::jsonb, '{}'::jsonb, coalesce($7::timestamptz, now()), now(), now())`,
      // goal (text) and title (varchar) each get their own parameter: one
      // parameter in both makes Postgres deduce two types for it.
      [id, owner, W, title, title, status, startedAt]
    );
  const pr = (
    number: number,
    podSessionId: string,
    over: Record<string, unknown> = {},
    repo = BE
  ) => ({
    number,
    title: `PR ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    headSha: `${String(number)}${"a".repeat(40 - String(number).length)}`,
    draft: false,
    author: "agent",
    updatedAt: before(WORK_CLOCK.stale + HOUR),
    mergeable: "clean",
    checks: "green",
    podSessionId,
    autoMerge: false,
    ...over,
  });
  const escalated = { updatedAt: before(WORK_CLOCK.stuck + HOUR) };
  const fact = (
    type: string,
    when: Date,
    subject: string,
    data: Record<string, unknown>
  ) =>
    q(
      `insert into events (id, type, subject_id, subject_type, data, user_id, workspace_id, source, timestamp)
       values ($1, $2, $3, 'repo', $4::jsonb, $5, $6, 'observation', $7)`,
      [
        randomUUID(),
        type,
        subject,
        JSON.stringify(data),
        ME,
        W,
        when.toISOString(),
      ]
    );
  const snapshotAt = (when: Date, data: Record<string, unknown>) =>
    fact("dev.repo_snapshot", when, String(data.repo), data);
  const titlesTo = async (sessionId: string) =>
    (
      await q<{ title: string }>(
        `select title from notifications where source_id = $1 order by created_at`,
        [sessionId]
      )
    ).rows.map((r) => r.title);
  const redMain = (prNumber: number, sha: string, sinceMs: number) => ({
    sha: "b".repeat(40),
    health: "red",
    source: "github-checks",
    redSince: { sha: sha.repeat(40), prNumber, at: before(sinceMs) },
    reason: "typecheck: proposalType",
  });
  const greenMain = {
    sha: "b".repeat(40),
    health: "ok",
    source: "github-checks",
  };

  beforeAll(async () => {
    await session(S_GREEN, "Ship the dev watcher");
    await session(S_RED, "Fix the feed");
    await session(S_CULPRIT, "Land the types", ME, "closed");
    await session(S_ESCALATED, "An old PR");
    // A session the snapshot's poster may not read: its PR says nothing.
    await session(S_NOT_POSTERS, "Someone else's", GOAL_OWNER);
    // An open session that owns browser's red main (started after it).
    await session(S_OWNS_BROWSER, "main red: browser tsc @1234abcd");
    // An active owner of an EARLIER red of synap-cli: it owns nothing now.
    await session(
      S_STALE_OWNER,
      "main red: synap-cli tsc @00000000",
      ME,
      "active",
      before(WORK_CLOCK.quiet + 3 * HOUR)
    );
    // Held on purpose: never told.
    await session(S_PAUSED, "Held work", ME, "paused");
    await session(S_QUIET, "Waits for main");
    await session(S_OLD_CULPRIT, "Landed last week", ME, "closed");
    for (const [i, id] of S_R.entries()) await session(id, `Relay ${i}`);

    await snapshotAt(T1, {
      repo: BE,
      observedAt: T1.toISOString(),
      visibility: "public",
      main: greenMain,
      prs: [
        pr(539, S_GREEN),
        pr(540, S_RED, { checks: "red" }),
        // Red because main is: not this PR's red.
        pr(541, S_RED, { checks: "red", redInheritedFromMain: true }),
        pr(542, S_NOT_POSTERS),
        pr(543, S_PAUSED, escalated),
        // Past the escalate rung a while: escalated, fresh news, pushed.
        pr(600, S_ESCALATED, escalated),
      ],
      mergedToday: [],
    });
    await snapshotAt(T1, {
      repo: CLI,
      observedAt: T1.toISOString(),
      visibility: "public",
      main: redMain(530, "c", WORK_CLOCK.quiet + HOUR),
      // Green while main is red: the queue holds it for main.
      prs: [pr(77, S_QUIET, {}, CLI)],
      mergedToday: [
        {
          number: 530,
          title: "feat(types)",
          url: `https://github.com/${CLI}/pull/530`,
          mergedAt: before(2 * HOUR),
          podSessionId: S_CULPRIT,
        },
      ],
    });
    await snapshotAt(T1, {
      repo: "Synap-core/browser",
      observedAt: T1.toISOString(),
      visibility: "private",
      main: {
        sha: "d".repeat(40),
        health: "red",
        source: "devbox-baseline",
        redSince: {
          sha: "e".repeat(40),
          prNumber: 12,
          at: before(WORK_CLOCK.stale - HOUR),
        },
      },
      prs: [],
      mergedToday: [
        {
          number: 12,
          title: "x",
          url: "https://github.com/Synap-core/browser/pull/12",
          mergedAt: before(30 * HOUR),
          podSessionId: S_CULPRIT,
        },
      ],
    });
    // The culprit merged before today: only its dev.pr_merged fact names it.
    await fact("dev.pr_merged", new Date(T1.getTime() - 50 * HOUR), "pr", {
      repo: AB,
      number: 90,
      url: `https://github.com/${AB}/pull/90`,
      title: "feat: the old change",
      sessionId: S_OLD_CULPRIT,
    });
    await snapshotAt(T1, {
      repo: AB,
      observedAt: T1.toISOString(),
      visibility: "private",
      main: redMain(90, "f", WORK_CLOCK.quiet + HOUR),
      prs: [],
      mergedToday: [],
    });
    await snapshotAt(T1, {
      repo: RELAY,
      observedAt: T1.toISOString(),
      visibility: "private",
      main: greenMain,
      prs: S_R.map((id, i) => pr(i + 1, id, escalated, RELAY)),
      mergedToday: [],
    });
  });

  it("raises each on the session that owns it: the agent first, the person on escalation, one per repo at three", async () => {
    h.pushes.length = 0;
    await q(`update notifications set pushed_at = null`);
    const r = await runStatusWatcher(T1);
    expect(r.unrouted).toBe(0);
    const raised = (await signalEvents()).filter((e) =>
      String(e.data.signal).match(/^(pr_|main_)/)
    );
    expect(
      raised
        .map((e) => [e.data.signal, e.data.subjectId, e.data.escalated])
        .sort()
    ).toEqual(
      [
        ["pr_green_unmerged", S_GREEN, false],
        ["pr_red_idle", S_RED, false],
        // synap-cli: an older `main red:` session does not own this red.
        ["main_red_unowned", S_CULPRIT, false],
        // app-bases: its culprit found through the dev.pr_merged fact.
        ["main_red_unowned", S_OLD_CULPRIT, false],
        ["pr_green_unmerged", S_ESCALATED, true],
        ...S_R.map((id) => ["pr_green_unmerged", id, true]),
      ].sort()
    );
    for (const e of raised) {
      expect(e.type).toBe("focus_session.signal.completed");
      expect(e.data.ownerId).toBe(ME);
    }
    // D-R3: a first raise is the agent's — no person is told.
    for (const id of [S_GREEN, S_RED, S_CULPRIT, S_OLD_CULPRIT]) {
      expect(await titlesTo(id)).toEqual([]);
    }
    expect(await titlesTo(S_ESCALATED)).toEqual([
      "PR 600 is green and not merged",
    ]);
    // D-R2: three escalated PRs of one repo read as one signal.
    for (const id of S_R) {
      expect(await titlesTo(id)).toEqual(["relay-app: 3 PRs are stuck"]);
    }
    // Nothing for a session the poster cannot read, a held one, a green PR
    // while its main is red, a red that is main's, or a main with an owner.
    for (const id of [S_NOT_POSTERS, S_PAUSED, S_QUIET]) {
      expect(await signalEvents(id)).toEqual([]);
    }
    expect(raised.filter((e) => e.data.repo === "synap-core/browser")).toEqual(
      []
    );
    // Only escalations are pushed, and a folded repo once.
    expect(h.pushes.map((p) => p.title).sort()).toEqual(
      ["PR 600 is green and not merged", "relay-app: 3 PRs are stuck"].sort()
    );
  });

  it("does not raise the same episode again, and escalates once when it still stands", async () => {
    await runStatusWatcher(new Date(T1.getTime() + HOUR));
    const once = (await signalEvents(S_GREEN)).filter(
      (e) => e.data.signal === "pr_green_unmerged"
    );
    expect(once).toHaveLength(1);
    // Past the escalate rung, the same PR and head: raised once more.
    const later = new Date(T1.getTime() + WORK_CLOCK.stuck - WORK_CLOCK.stale);
    await runStatusWatcher(later);
    await runStatusWatcher(new Date(later.getTime() + HOUR));
    const twice = (await signalEvents(S_GREEN)).filter(
      (e) => e.data.signal === "pr_green_unmerged"
    );
    expect(twice.map((e) => e.data.escalated)).toEqual([false, true]);
    // Now backend has three escalated at once (539, 540, 600): one signal.
    expect(await titlesTo(S_GREEN)).toEqual(["backend: 3 PRs are stuck"]);
  });

  it("an open `main red: <repo>` session owns the red: nothing is raised; once it closes, it is", async () => {
    await q(`update focus_sessions set status = 'closed' where id = $1`, [
      S_OWNS_BROWSER,
    ]);
    await runStatusWatcher(new Date(T1.getTime() + 2 * HOUR));
    const browser = (await signalEvents(S_CULPRIT)).filter(
      (e) => e.data.repo === "synap-core/browser"
    );
    expect(browser.map((e) => e.data.signal)).toEqual(["main_red_unowned"]);
  });

  it("reaches the agent through the session's change feed, with the words its person reads", async () => {
    const page = await listSessionChanges({
      sessionId: S_GREEN,
      userId: ME,
      kinds: new Set(["signal_raised"] as const),
    });
    expect(page?.events).toEqual([
      expect.objectContaining({
        kind: "signal_raised",
        signal: expect.objectContaining({
          signal: "pr_green_unmerged",
          // The words lead with the work; the PR's name follows.
          headline: "PR 539 is green and not merged",
          detail: expect.stringContaining("backend#539 passed its checks"),
          escalated: false,
          url: `https://github.com/${BE}/pull/539`,
        }),
      }),
      expect.objectContaining({
        kind: "signal_raised",
        signal: expect.objectContaining({ escalated: true }),
      }),
    ]);
  });
});
