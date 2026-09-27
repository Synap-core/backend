/**
 * The `events` VisibilityRule on the event READ DOORS (2026-09-27).
 *
 * `events.search` had a "system admin" branch: anyone who owned ANY workspace
 * searched every user's events pod-wide, and its `workspaceId` was checked but
 * never applied. `events.count` and the `system.*` event doors had no floor at
 * all. Every door now passes `eventVisibleWhere` to the REAL
 * `EventRepository` SQL, which runs here on PGlite — nothing is stubbed between
 * the door and the rows.
 *
 * Cast: ALICE owns WA, BOB owns WB; in the shared WS Alice is an admin, Bob an
 * editor.
 *   - BOB_WB        Bob, in WB (column)                   → Alice: hidden
 *   - BOB_WB_JSON   Bob, WB in data->>'workspaceId' only  → Alice: hidden
 *   - BOB_JUNK      Bob, data->>'workspaceId' not a uuid  → Alice: hidden, no throw
 *   - BOB_PERSONAL  Bob, no workspace                     → Alice: hidden
 *   - BOB_PRIVATE_S Bob, in WS, subject = Bob's private session → Alice: hidden
 *   - BOB_ROSTER    Bob, in WS, inside session S_ROSTER (Alice seated as a
 *                   human) → Alice's human door: visible; her agent key: hidden
 *   - BOB_WS        Bob, in WS                            → Alice: visible
 *   - ALICE_WA      Alice, in WA                          → Alice: visible
 *   - ALICE_PERSONAL Alice, no workspace                  → Alice: visible
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  repo: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, {
    schema: {
      workspaceMembers: actual.workspaceMembers as never,
      workspaces: actual.workspaces as never,
      events: actual.events as never,
    },
  });
  // The REAL repository over PGlite: `unsafe(sql, params)` is the one
  // postgres.js method its query wrapper uses.
  const Repo = actual.EventRepository as new (sql: unknown) => unknown;
  const repo = new Repo({
    unsafe: async (sql: string, params: unknown[]) =>
      (await client.query(sql, params)).rows,
  });
  h.repo = repo;
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: repo,
    getEventRepository: () => repo,
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { eventsRouter } from "../routers/events.js";
import { systemRouter } from "../routers/system.js";
import { auditRouter } from "../routers/audit.js";
import { events } from "@synap/database/schema";
import { AccessContext, scopedDb } from "./index.js";

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
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const ALICE = "alice-ev";
const BOB = "bob-ev";
const WA = randomUUID();
const WB = randomUUID();
const WS = randomUUID();
const S_PRIVATE = randomUUID(); // Bob's session, no roster
const S_ROSTER = randomUUID(); // Bob's session, Alice seated as a human
const ROOM = randomUUID();

const E = {
  BOB_WB: randomUUID(),
  BOB_WB_JSON: randomUUID(),
  BOB_JUNK: randomUUID(),
  BOB_PERSONAL: randomUUID(),
  BOB_PRIVATE_S: randomUUID(),
  BOB_ROSTER: randomUUID(),
  BOB_WS: randomUUID(),
  ALICE_WA: randomUUID(),
  ALICE_PERSONAL: randomUUID(),
};
const nameOf = new Map<string, string>(
  Object.entries(E).map(([k, v]) => [v, k])
);

const human = (userId: string) => ({ authenticated: true, userId }) as never;
const agentKey = (userId: string) =>
  ({
    authenticated: true,
    userId,
    agentUserId: `agent-of-${userId}`,
    isHubProtocol: true,
  }) as never;

const names = (rows: Array<{ id: string }>) =>
  rows.map((r) => nameOf.get(r.id) ?? r.id).sort();

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const n of [
    "events",
    "workspaces",
    "workspace_members",
    "focus_sessions",
  ])
    expect(byName.has(n)).toBe(true);
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  for (const u of [ALICE, BOB]) {
    await q(`insert into users (id, user_type) values ($1, 'human')`, [u]);
    // Alice administers WS (the audit door's gate); Bob is an editor there.
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, $4)`,
      [randomUUID(), WS, u, u === ALICE ? "admin" : "editor"]
    );
  }
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'A',$2,'{}'::jsonb),($3,'B',$4,'{}'::jsonb),($5,'S',$2,'{}'::jsonb)`,
    [WA, ALICE, WB, BOB, WS]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'),($4,$5,$6,'owner')`,
    [randomUUID(), WA, ALICE, randomUUID(), WB, BOB]
  );
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, goal, status, metadata, expected_outputs, channel_id, created_at, updated_at, started_at)
     values ($1, $2, $3, 'Private', 'active', '{}'::jsonb, '[]'::jsonb, null, now(), now(), now()),
            ($4, $2, $3, 'Shared', 'active', '{}'::jsonb, '[]'::jsonb, $5, now(), now(), now())`,
    [S_PRIVATE, BOB, WS, S_ROSTER, ROOM]
  );
  await q(
    `insert into channels (id, user_id, workspace_id, channel_type, context_object_type, context_object_id, created_at, updated_at)
     values ($1, $2, $3, 'group', 'focus_session', $4, now(), now())`,
    [ROOM, BOB, WS, S_ROSTER]
  );
  for (const m of [BOB, ALICE]) {
    await q(
      `insert into channel_members (id, channel_id, member_id, member_kind, role) values ($1, $2, $3, 'human', 'member')`,
      [randomUUID(), ROOM, m]
    );
  }

  const ev = (
    id: string,
    userId: string,
    workspaceId: string | null,
    data: Record<string, unknown> = {},
    extra: { subjectType?: string; subjectId?: string; sessionId?: string } = {}
  ) =>
    q(
      `insert into events (id, timestamp, type, subject_id, subject_type, data, user_id, workspace_id, session_id, correlation_id)
       values ($1, now(), 'entity.created', $2, $3, $4::jsonb, $5, $6, $7, $8)`,
      [
        id,
        extra.subjectId ?? randomUUID(),
        extra.subjectType ?? "entity",
        JSON.stringify(data),
        userId,
        workspaceId,
        extra.sessionId ?? null,
        CORRELATION,
      ]
    );
  await ev(E.BOB_WB, BOB, WB);
  await ev(E.BOB_WB_JSON, BOB, null, { workspaceId: WB });
  await ev(E.BOB_JUNK, BOB, null, { workspaceId: "not-a-uuid" });
  await ev(E.BOB_PERSONAL, BOB, null);
  await ev(
    E.BOB_PRIVATE_S,
    BOB,
    WS,
    {},
    { subjectType: "focus_session", subjectId: S_PRIVATE }
  );
  await ev(E.BOB_ROSTER, BOB, WS, {}, { sessionId: S_ROSTER });
  await ev(E.BOB_WS, BOB, WS);
  await ev(E.ALICE_WA, ALICE, WA);
  await ev(E.ALICE_PERSONAL, ALICE, null);
});

// Every event shares one correlation id, so a trace would reach them all.
const CORRELATION = randomUUID();

const ALICE_HUMAN = ["ALICE_PERSONAL", "ALICE_WA", "BOB_ROSTER", "BOB_WS"];
const ALICE_AGENT = ["ALICE_PERSONAL", "ALICE_WA", "BOB_WS"];

describe("events.search — the events VisibilityRule, no admin branch", () => {
  const search = async (ctx: never, input: Record<string, unknown> = {}) =>
    (await eventsRouter
      .createCaller(ctx)
      .search({ limit: 100, offset: 0, ...input })) as Array<{ id: string }>;

  it("Alice owns a workspace and still never finds Bob's events outside WS", async () => {
    expect(names(await search(human(ALICE)))).toEqual(ALICE_HUMAN);
  });

  it("Bob sees his own events, the shared WS ones, and his sessions", async () => {
    expect(names(await search(human(BOB)))).toEqual(
      [
        "BOB_JUNK",
        "BOB_PERSONAL",
        "BOB_PRIVATE_S",
        "BOB_ROSTER",
        "BOB_WB",
        "BOB_WB_JSON",
        "BOB_WS",
      ].sort()
    );
  });

  it("workspaceId narrows, and never grants", async () => {
    expect(names(await search(human(ALICE), { workspaceId: WB }))).toEqual([]);
    expect(names(await search(human(ALICE), { workspaceId: WS }))).toEqual([
      "BOB_ROSTER",
      "BOB_WS",
    ]);
    expect(names(await search(human(ALICE), { workspaceId: WA }))).toEqual([
      "ALICE_WA",
    ]);
  });

  it("userId narrows to that actor within the floor", async () => {
    expect(names(await search(human(ALICE), { userId: BOB }))).toEqual([
      "BOB_ROSTER",
      "BOB_WS",
    ]);
  });

  it("an agent key reads within its user's scope, sessions owner-only", async () => {
    expect(names(await search(agentKey(ALICE)))).toEqual(ALICE_AGENT);
  });
});

describe("events.count — the same floor", () => {
  const count = async (ctx: never, input: Record<string, unknown> = {}) =>
    (await eventsRouter.createCaller(ctx).count(input)).count;

  it("counts only visible events; workspaceId narrows", async () => {
    expect(await count(human(ALICE))).toBe(ALICE_HUMAN.length);
    expect(await count(human(ALICE), { workspaceId: WB })).toBe(0);
    expect(await count(human(ALICE), { workspaceId: WS })).toBe(2);
    expect(await count(agentKey(ALICE))).toBe(ALICE_AGENT.length);
  });
});

describe("system.* event doors — the same floor", () => {
  const sys = (ctx: never) => systemRouter.createCaller(ctx);

  it("searchEvents returns and counts only visible events", async () => {
    const r = await sys(human(ALICE)).searchEvents({ limit: 100, offset: 0 });
    expect(names(r.events)).toEqual(ALICE_HUMAN);
    expect(r.pagination.total).toBe(ALICE_HUMAN.length);
    const narrowed = await sys(human(ALICE)).searchEvents({
      limit: 100,
      offset: 0,
      workspaceId: WB,
    });
    expect(narrowed.events).toEqual([]);
  });

  it("getRecentEvents: a userId filter cannot reach Bob's private events", async () => {
    const r = await sys(human(ALICE)).getRecentEvents({
      limit: 100,
      userId: BOB,
    });
    expect(names(r.events)).toEqual(["BOB_ROSTER", "BOB_WS"]);
  });

  it("getEventTrace: an invisible event is NOT_FOUND; the trace is floored", async () => {
    await expect(
      sys(human(ALICE)).getEventTrace({ eventId: E.BOB_WB })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const r = await sys(human(ALICE)).getEventTrace({ eventId: E.BOB_WS });
    expect(r.relatedEvents.map((e) => nameOf.get(e.eventId)).sort()).toEqual(
      ALICE_HUMAN.filter((n) => n !== "BOB_WS")
    );
  });

  it("getDashboardMetrics lists only visible events", async () => {
    const r = await sys(human(ALICE)).getDashboardMetrics();
    expect(names(r.latestEvents)).toEqual(ALICE_HUMAN);
  });
});

describe("the registered `events` rule (scopedDb)", () => {
  const read = (access: AccessContext) =>
    scopedDb(access).findMany(events, {}) as Promise<Array<{ id: string }>>;

  it("an operator reads what the doors return; a lens only narrows", async () => {
    const alice = AccessContext.operator({ userId: ALICE });
    expect(names(await read(alice))).toEqual(ALICE_HUMAN);
    expect(names(await read(alice.withLens(WS)))).toEqual([
      "BOB_ROSTER",
      "BOB_WS",
    ]);
    expect(names(await read(alice.withLens(WB)))).toEqual([]);
    expect(names(await read(alice.withLens(null)))).toEqual(["ALICE_PERSONAL"]);
  });

  it("an agent reads owner-only sessions", async () => {
    const agent = AccessContext.agent({
      userId: ALICE,
      agentUserId: "agent-of-alice",
    });
    expect(names(await read(agent))).toEqual(ALICE_AGENT);
  });
});

describe("audit.listForWorkspace — the admin gate sits ON the floor", () => {
  it("WS's owner gets WS events, but not a colleague's private session", async () => {
    const r = await auditRouter
      .createCaller({
        authenticated: true,
        userId: ALICE,
        workspaceId: WS,
      } as never)
      .listForWorkspace({ limit: 100, offset: 0 });
    expect(names(r.events)).toEqual(["BOB_ROSTER", "BOB_WS"]);
    expect(r.total).toBe(2);
  });
});
