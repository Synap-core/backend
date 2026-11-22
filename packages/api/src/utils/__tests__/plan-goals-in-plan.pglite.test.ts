/**
 * GOALS IN THE ONE PLAN (pathway plan 368179d7, P7): a capture plan starts
 * its goals through THE start-goal door and files its sessions IN them, in
 * one apply; a plan that does not apply drops the goals it started.
 *
 * Before: a plan had no goal op. A goal was a separate `start_track` that an
 * agent's call could only file as a proposal with no id, so a 19-step plan
 * needed 20 more calls to file its steps in their goals (feedback 3b31c596
 * item 5).
 *
 * Real, on PGlite: `materializeCompositeGraph` (goals parents-first before the
 * sessions, goal → goal edges once every goal exists), `buildPlanCallers`'
 * goal caller (`startTrack`: placement `serves`, owner seed, live-name rule),
 * the governed dependency door (`addUnitBlockers` → `governedDependencyLink`,
 * approved by the plan), `createFocusSession` with the goal AT create,
 * `buildMaterializedRecord`, and the compensation (`cancelSession`, then
 * `setTrackStatus` to `archived` / `mistake`). Rows are read back.
 *
 * Stubbed, and why: governance (`checkPermissionOrPropose` grants: the apply
 * runs as the approving person), the room mint and the realtime/side-effect
 * emits (no bus here), the link endpoint visibility read (its own suite), the
 * workspace write floor (a pod-personal project, its own suite).
 *
 * NOT covered: the proposal approval wrapper (`apply-approval.ts` wires the
 * same factory), a goal handed back LIVE by name (the unit suite pins it),
 * a kind step (the unit suite pins the order; the kind writer is the
 * `profile/create` executor's, covered by its own suite).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 120_000 });

const migration = (f: string) =>
  readFileSync(
    fileURLToPath(
      new URL(`../../../../database/migrations/${f}`, import.meta.url)
    ),
    "utf8"
  );

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return {
    ...actual,
    db,
    getDb: async () => db,
    EventRepository: class {
      async append() {}
    },
  };
});
vi.mock("../permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: async () => ({ granted: true }),
}));
vi.mock(
  "../../services/focus-sessions/ensure-session-channel.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    ensureSessionChannel: async () => null,
  })
);
vi.mock("../domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: () => undefined,
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => {},
}));
vi.mock("../../routers/hub-protocol/rest/link-endpoint-visibility.js", () => ({
  checkLinkEndpointsVisible: async () => null,
  checkLinkEndpointVisible: async () => null,
}));
vi.mock("../domain-mutation.js", () => ({
  recordDomainMutation: async () => null,
}));
vi.mock("../workspace-write-access.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertWorkspaceWrite: async () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { db } from "@synap/database";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import {
  CompositePlanApplyError,
  materializeCompositeGraph,
} from "../materialize-composite.js";
import { buildPlanCallers } from "../plan-callers.js";
import { buildMaterializedRecord } from "../../services/proposals/stamp-materialized.js";

const USER = "11111111-1111-4111-8111-111111111111";
const P = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]")
      ? t
      : BASIC.test(t)
        ? t.replace(/\(.*\)/, "")
        : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.name === "metadata" ||
            c.name === "settings" ||
            c.name === "properties"
          ? " default '{}'::jsonb"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  for (const t of tables) {
    const name = getTableConfig(t).name;
    // The REAL shapes for these two come from their migrations below.
    if (name === "project_tracks" || name === "track_participants") continue;
    await h.client!.exec(ddlFor(t));
  }
  await h.client!.exec(`
    create table project_tracks (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references projects(id) on delete cascade,
      user_id text not null,
      playbook_id uuid references playbooks(id) on delete set null,
      name text not null,
      definition_snapshot jsonb not null default '{}'::jsonb,
      method_version text not null default '1',
      current_stage text,
      status text not null default 'active'
        check (status in ('active','paused','completed','archived')),
      params jsonb not null default '{}'::jsonb,
      stage_history jsonb not null default '[]'::jsonb,
      direction text,
      kpi jsonb,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  for (const f of [
    "0317_project_tracks_live_name_unique.sql",
    "0344_track_lifecycle_and_verdict.sql",
    "0345_track_goal_content.sql",
    "0348_track_participants.sql",
    "0349_track_verdict_retired.sql",
    "0350_track_goal_loop.sql",
  ]) {
    await h.client!.exec(migration(f));
  }
  await h.client!.exec(
    `create unique index if not exists idx_links_unique_edge on links (from_type, from_id, to_type, to_id, link_type)`
  );
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'a@x.test', 'Antoine', 'human')`,
    [USER]
  );
  await q(
    `insert into projects (id, user_id, workspace_id, name, status) values ($1, $2, null, 'Synap', 'active')`,
    [P, USER]
  );
}, 180_000);

const callers = () =>
  buildPlanCallers({
    database: db as never,
    userId: USER,
    sessionOwnerUserId: USER,
    workspaceId: null,
    entityCaller: { update: vi.fn() },
    proposal: { id: randomUUID(), sessionId: null },
  });

/** Goals by name, with their status and verdict. */
async function goals(names: string[]) {
  const rows = await q<{
    id: string;
    name: string;
    status: string;
    verdict: string | null;
  }>(
    `select id, name, status, verdict from project_tracks where name = any($1)`,
    [names]
  );
  return Object.fromEntries(rows.rows.map((r) => [r.name, r]));
}

describe("goals in the one plan (P7)", () => {
  it("starts the goals, places one under another, makes one wait on another, and files the session IN its goal", async () => {
    const tag = randomUUID().slice(0, 8);
    const [company, seed, preseed] = [
      `Fund Synap ${tag}`,
      `Seed round ${tag}`,
      `Pre-seed ${tag}`,
    ];
    const plan: CompositeProposalOperation[] = [
      // Declared out of order on purpose: the session first, the child goal
      // before its parent, the blocker last.
      {
        op: "create_session",
        ref: "deck",
        goal: `Write the deck ${tag}`,
        trackRef: "seed",
      },
      {
        op: "create_track",
        ref: "seed",
        name: seed,
        projectId: P,
        parentRef: "company",
        blockedByRefs: ["preseed"],
      },
      { op: "create_track", ref: "company", name: company, projectId: P },
      { op: "create_track", ref: "preseed", name: preseed, projectId: P },
    ];

    const result = await materializeCompositeGraph(
      plan,
      { create: vi.fn() },
      { create: vi.fn() },
      undefined,
      { planCallers: callers() }
    );

    const born = await goals([company, seed, preseed]);
    expect(Object.keys(born).sort()).toEqual([company, preseed, seed].sort());
    for (const g of Object.values(born)) expect(g.status).toBe("active");

    // The session is born IN its goal (and so in the goal's project).
    const deckId = result.sessions.find((s) => s.ref === "deck")!.sessionId;
    const [deck] = (
      await q<{ track_id: string | null; project_id: string | null }>(
        `select track_id, project_id from focus_sessions where id = $1`,
        [deckId]
      )
    ).rows;
    expect(deck).toEqual({ track_id: born[seed].id, project_id: P });

    // Where it sits and what it waits on: one edge each, through the doors.
    const edges = await q<{
      id: string;
      to_id: string;
      link_type: string;
    }>(
      `select id, to_id, link_type from links where from_type = 'track' and from_id = $1 order by link_type`,
      [born[seed].id]
    );
    expect(edges.rows.map((e) => [e.link_type, e.to_id])).toEqual([
      ["blocked_by", born[preseed].id],
      ["serves", born[company].id],
    ]);

    // The record plan undo reads names the goals and the goal → goal edge.
    const record = buildMaterializedRecord(result);
    expect([...(record.trackIds ?? [])].sort()).toEqual(
      [born[company].id, born[seed].id, born[preseed].id].sort()
    );
    expect(record.linkIds).toContain(
      edges.rows.find((e) => e.link_type === "blocked_by")!.id
    );
  });

  it("a plan that does not apply drops the goals it started (status archived, verdict mistake)", async () => {
    const tag = randomUUID().slice(0, 8);
    const name = `Doomed goal ${tag}`;
    const plan: CompositeProposalOperation[] = [
      { op: "create_track", ref: "g", name, projectId: P },
      { op: "create_session", ref: "s", goal: `Step ${tag}`, trackRef: "g" },
      // A blocker that is not the owner's session: the edge door refuses it,
      // after the goal and the session applied.
      {
        op: "create_link",
        type: "blocked_by",
        fromRef: "s",
        toSessionId: randomUUID(),
      },
    ];

    const error = await materializeCompositeGraph(
      plan,
      { create: vi.fn() },
      { create: vi.fn() },
      undefined,
      { planCallers: callers() }
    ).catch((e) => e);

    expect(error).toBeInstanceOf(CompositePlanApplyError);
    const failed = error as CompositePlanApplyError;
    expect(failed.steps[0].op).toBe("create_link");
    expect(failed.compensation.notCompensated).toEqual([]);
    const born = await goals([name]);
    expect(born[name]).toMatchObject({
      status: "archived",
      verdict: "mistake",
    });
    expect(failed.compensation.undone.track).toEqual([born[name].id]);
    // Its name is free again: a corrected plan can start it.
    const live = await q<{ n: number }>(
      `select count(*)::int as n from project_tracks where project_id = $1 and name = $2 and status in ('active','paused')`,
      [P, name]
    );
    expect(live.rows[0].n).toBe(0);
  });
});
