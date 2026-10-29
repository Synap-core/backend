/**
 * THE STATUS WATCHER (status-flow W6) on real SQL (PGlite, every table):
 *
 *   - late: an invoice past the date its step is bound to raises ONCE — not
 *     again an hour later — and again after it clears and recurs (a move out
 *     and back is a new episode);
 *   - approaching: within the default window before the date;
 *   - stuck: past the step's `stuckAfterDays`, from the latest move's
 *     `occurredAt` (the board's own read); a thing that moved yesterday is not;
 *   - hold review due: a paused thing whose hold's `reviewBy` passed;
 *   - each event is `<subject>.signal.completed`, carries its goal and
 *     project (Q6.3), and is fanned out to the automation matcher;
 *   - owner: the thing's owner when a person, else its goal's owner (Q4.2);
 *   - the signal shows up in needs-you (`signals.count`, the real read).
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
  return {
    ...actual,
    db: pg,
    getDb: async () => pg,
    eventRepository: { append: async () => undefined },
    // The log row, written to the same table (a duplicate (id, timestamp)
    // throws 23505 exactly like the real one).
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
vi.mock("../../projects/project-needs-you.js", () => ({
  listSessionsAwaitingReview: async () => ({ sessions: [], truncated: false }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { runStatusWatcher, signalWords } from "../watcher.js";
import { signalsRouter } from "../../../routers/signals.js";

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
const DAY = 86_400_000;
const NOW = new Date();
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

async function thing(o: {
  id: string;
  profile: string;
  status: string;
  owner?: string;
  title: string;
  properties?: Record<string, unknown>;
  createdDaysAgo?: number;
}) {
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, title, status, properties, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, now() - ($8 || ' days')::interval, now())`,
    [
      o.id,
      o.owner ?? ME,
      W,
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
  await thing({
    id: I_HELD,
    profile: INVOICE,
    status: "disputed",
    title: "Invoice 104",
    properties: { dueDate: day(-40) },
  });
  // Its pause: a hold whose review date passed two days ago.
  const holdAt = new Date(NOW.getTime() - 10 * DAY).toISOString();
  await q(
    `insert into lifecycle_transition_outbox (transition_id, transition, created_at) values ($1, $2::jsonb, $3)`,
    [
      randomUUID(),
      JSON.stringify({
        transitionId: randomUUID(),
        subjectType: "entity",
        subjectId: I_HELD,
        entityId: I_HELD,
        facetId: null,
        role: null,
        to: "disputed",
        category: "paused",
        userId: ME,
        workspaceId: W,
        recordedAt: holdAt,
        hold: {
          on: "external",
          reason: "Client disputes the amount",
          reviewBy: new Date(NOW.getTime() - 2 * DAY).toISOString(),
          since: holdAt,
          resumeTo: "sent",
        },
      }),
      holdAt,
    ]
  );

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
  await thing({
    id: D_FRESH,
    profile: DEAL,
    status: "negotiating",
    title: "Globex",
  });
  await moved(D_FRESH, 1);
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, project_id, track_id, subject_entity_id, goal, status, origin, expected_outputs, metadata, started_at, created_at, updated_at)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, 'Renew ACME', 'active', 'agent', '[]'::jsonb, '{}'::jsonb, now(), now(), now())`,
    [AGENT, W, P, G, D_STUCK]
  );
});

describe("the status watcher", () => {
  it("raises late, approaching, stuck and hold-review once each, with goal and project", async () => {
    const r = await runStatusWatcher(NOW);
    expect(r).toMatchObject({ noticed: 4, raised: 4, unowned: 0 });
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
    });
    expect(bySubject.has(I_FAR)).toBe(false);
    expect(bySubject.has(D_FRESH)).toBe(false);
    for (const e of raised) expect(e.type).toBe("entity.signal.completed");
    // Fanned out to the automation matcher, as `entity.signal`.
    const signals = h.fannedOut.filter((p) => p.action === "signal");
    expect(signals.map((p) => p.subjectType)).toEqual(Array(4).fill("entity"));
    expect(signals.every((p) => p.workspaceId === W && p.eventId)).toBe(true);
  });

  it("does not raise the same episode again an hour later", async () => {
    const before = (await signalEvents()).length;
    const r = await runStatusWatcher(at(1));
    expect(r).toMatchObject({ noticed: 4, raised: 0 });
    expect(await signalEvents()).toHaveLength(before);
  });

  it("raises again after the late state clears and recurs", async () => {
    // Clears: paid.
    await q(`update entities set status = 'paid' where id = $1`, [I_LATE]);
    expect(await runStatusWatcher(at(2))).toMatchObject({
      noticed: 3,
      raised: 0,
    });
    // Recurs: back to sent (a new stay in the step), the date still passed.
    await q(`update entities set status = 'sent' where id = $1`, [I_LATE]);
    await moved(I_LATE, -2 / 24);
    expect(await runStatusWatcher(at(3))).toMatchObject({ raised: 1 });
    const late = await signalEvents(I_LATE);
    expect(late.map((e) => e.data.signal)).toEqual(["late", "late"]);
  });

  it("tells the thing's owner, else its goal's owner", async () => {
    const notes = await q<{ user_id: string; type: string; title: string }>(
      `select user_id, type, title from notifications order by created_at`
    );
    const to = (title: string) =>
      notes.rows.filter((n) => n.title === title).map((n) => n.user_id);
    expect(to("Invoice 101 is late")).toEqual([ME, ME]);
    // An agent's thing: its goal's owner (the owner seat, not the starter).
    expect(to("ACME renewal has been negotiating for 5 days")).toEqual([
      GOAL_OWNER,
    ]);
    expect(notes.rows.every((n) => n.type === "entity.signal")).toBe(true);
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

  it("says it in words", () => {
    expect(
      signalWords(
        {
          signal: "approaching",
          statusLabel: "Sent",
          facts: {
            property: "dueDate",
            date: "2026-10-31",
            dueAt: "2026-11-01T00:00:00.000Z",
          },
        },
        "Invoice 102",
        new Date("2026-10-29T10:00:00.000Z")
      )
    ).toEqual({
      headline: "Invoice 102 is due in 2 days",
      detail: "Its due date is 2026-10-31 and it is still sent.",
    });
  });
});
