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
 * emits (no bus here), the link endpoint visibility read (its own suite;
 * replaced by "the row exists"), the workspace write floor (a pod-personal
 * project, its own suite).
 *
 * Also (B3 part 2): a step waiting on a decision (an entity) and on a goal,
 * through THE governed dependency door; a re-plan's `update_session` through
 * THE session update door and `remove_link`; a failed re-plan put back.
 *
 * NOT covered: the proposal approval wrapper (`apply-approval.ts` wires the
 * same factory), a goal handed back LIVE by name (the unit suite pins it).
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
// Visibility has its own suite; here an endpoint is visible iff its row
// exists (a goal or a decision the door must not find stays "not found").
vi.mock("../../routers/hub-protocol/rest/link-endpoint-visibility.js", () => ({
  checkLinkEndpointsVisible: async (edge: { toType: string; toId: string }) => {
    const table =
      edge.toType === "track"
        ? "project_tracks"
        : edge.toType === "entity"
          ? "entities"
          : "focus_sessions";
    const found = await h.client!.query(
      `select 1 from ${table} where id::text = $1`,
      [edge.toId]
    );
    return found.rows.length > 0
      ? null
      : { status: 404 as const, error: "Not found" };
  },
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

  it("a step waits on a decision and a goal; a re-plan edits an existing step and drops one of its blockers", async () => {
    const tag = randomUUID().slice(0, 8);
    const [step, oldBlocker, decision] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    for (const [id, goal] of [
      [step, `Pitch funds ${tag}`],
      [oldBlocker, `Old blocker ${tag}`],
    ]) {
      await q(
        `insert into focus_sessions (id, user_id, project_id, goal, status, origin, expected_outputs, criteria, metadata, agent_ids, created_at, updated_at, started_at)
         values ($1, $2, $3, $4, 'active', 'agent', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}', now(), now(), now())`,
        [id, USER, P, goal]
      );
    }
    await q(
      `insert into links (id, from_type, from_id, to_type, to_id, link_type, created_by, metadata)
       values (gen_random_uuid(), 'session', $1, 'session', $2, 'blocked_by', $3, '{}'::jsonb)`,
      [step, oldBlocker, USER]
    );
    await q(
      `insert into entities (id, user_id, type, title, properties) values ($1, $2, 'decision', 'Lead investor', '{}'::jsonb)`,
      [decision, USER]
    );
    const goalName = `Close the round ${tag}`;
    const plan: CompositeProposalOperation[] = [
      {
        op: "update_session",
        ref: "pitch",
        sessionId: step,
        patch: { goal: `Pitch ten funds ${tag}` },
      },
      {
        op: "remove_link",
        type: "blocked_by",
        fromSessionId: step,
        toSessionId: oldBlocker,
      },
      {
        op: "create_link",
        type: "blocked_by",
        fromRef: "pitch",
        toEntityId: decision,
      },
      { op: "create_track", ref: "close", name: goalName, projectId: P },
      { op: "create_session", ref: "term", goal: `Term sheet ${tag}` },
      {
        op: "create_link",
        type: "blocked_by",
        fromRef: "term",
        toTrackRef: "close",
      },
    ];

    const result = await materializeCompositeGraph(
      plan,
      { create: vi.fn() },
      { create: vi.fn() },
      undefined,
      { planCallers: callers() }
    );

    const born = await goals([goalName]);
    const term = result.sessions.find((s) => s.ref === "term")!.sessionId;
    const waits = async (from: string) =>
      (
        await q<{ to_type: string; to_id: string }>(
          `select to_type, to_id from links where link_type = 'blocked_by' and from_type = 'session' and from_id = $1 order by to_type`,
          [from]
        )
      ).rows.map((r) => `${r.to_type}:${r.to_id}`);
    // The old blocker is gone, the decision is in; the new step waits on the goal.
    expect(await waits(step)).toEqual([`entity:${decision}`]);
    expect(await waits(term)).toEqual([`track:${born[goalName].id}`]);
    const [row] = (
      await q<{ goal: string }>(
        `select goal from focus_sessions where id = $1`,
        [step]
      )
    ).rows;
    expect(row.goal).toBe(`Pitch ten funds ${tag}`);
    expect(result.sessionUpdates?.[0]).toMatchObject({
      sessionId: step,
      before: { goal: `Pitch funds ${tag}` },
      after: { goal: `Pitch ten funds ${tag}` },
    });

    // The same re-plan that FAILS at its last step puts everything back.
    const tag2 = randomUUID().slice(0, 8);
    const failing: CompositeProposalOperation[] = [
      {
        op: "update_session",
        ref: "pitch",
        sessionId: step,
        patch: { goal: `Pitch twenty funds ${tag2}` },
      },
      {
        op: "remove_link",
        type: "blocked_by",
        fromSessionId: step,
        toEntityId: decision,
      },
      {
        op: "create_link",
        type: "blocked_by",
        fromRef: "pitch",
        toTrackRef: "g2",
      },
      { op: "create_track", ref: "g2", name: `Doomed ${tag2}`, projectId: P },
      // Not the owner's session: the session edge door refuses it.
      {
        op: "create_link",
        type: "blocked_by",
        fromRef: "pitch",
        toSessionId: randomUUID(),
      },
    ];
    const error = await materializeCompositeGraph(
      failing,
      { create: vi.fn() },
      { create: vi.fn() },
      undefined,
      { planCallers: callers() }
    ).catch((e) => e);
    expect(error).toBeInstanceOf(CompositePlanApplyError);
    expect(
      (error as CompositePlanApplyError).compensation.notCompensated
    ).toEqual([]);
    // The step, its blockers and the doomed goal are as they were before.
    expect(await waits(step)).toEqual([`entity:${decision}`]);
    const [after] = (
      await q<{ goal: string }>(
        `select goal from focus_sessions where id = $1`,
        [step]
      )
    ).rows;
    expect(after.goal).toBe(`Pitch ten funds ${tag}`);
    expect((await goals([`Doomed ${tag2}`]))[`Doomed ${tag2}`]).toMatchObject({
      status: "archived",
      verdict: "mistake",
    });
  });

  it("a step blocked ONLY by a decision is born forming, and the arm option lands on the edge (P4, P5)", async () => {
    const tag = randomUUID().slice(0, 8);
    const decision = randomUUID();
    await q(
      `insert into entities (id, user_id, type, title, properties) values ($1, $2, 'decision', 'Lead investor', $3::jsonb)`,
      [
        decision,
        USER,
        JSON.stringify({
          decisionOptions: [{ label: "Fund A" }, { label: "Fund B" }],
        }),
      ]
    );
    const result = await materializeCompositeGraph(
      [
        {
          op: "create_session",
          ref: "term",
          goal: `Term sheet ${tag}`,
          projectId: P,
        },
        {
          op: "create_link",
          type: "blocked_by",
          fromRef: "term",
          toEntityId: decision,
          option: "Fund A",
        },
      ],
      { create: vi.fn() },
      { create: vi.fn() },
      undefined,
      { planCallers: callers() }
    );
    const term = result.sessions.find((s) => s.ref === "term")!.sessionId;
    const row = await q<{ status: string }>(
      `select status from focus_sessions where id = $1`,
      [term]
    );
    expect(row.rows[0].status).toBe("forming");
    const edge = await q<{ option: string | null }>(
      `select metadata->>'option' as option from links where link_type = 'blocked_by' and from_id = $1 and to_id = $2`,
      [term, decision]
    );
    expect(edge.rows).toEqual([{ option: "Fund A" }]);
  });

  it("an option the existing decision does not list fails the plan at the governed door", async () => {
    const tag = randomUUID().slice(0, 8);
    const decision = randomUUID();
    await q(
      `insert into entities (id, user_id, type, title, properties) values ($1, $2, 'decision', 'Lead investor', $3::jsonb)`,
      [
        decision,
        USER,
        JSON.stringify({ decisionOptions: [{ label: "Fund A" }] }),
      ]
    );
    const error = await materializeCompositeGraph(
      [
        {
          op: "create_session",
          ref: "term",
          goal: `Term sheet ${tag}`,
          projectId: P,
        },
        {
          op: "create_link",
          type: "blocked_by",
          fromRef: "term",
          toEntityId: decision,
          option: "Fund Z",
        },
      ],
      { create: vi.fn() },
      { create: vi.fn() },
      undefined,
      { planCallers: callers() }
    ).catch((err) => err);
    expect(error).toBeInstanceOf(CompositePlanApplyError);
    expect(String((error as Error).message)).toMatch(/Fund Z|not an option/);
  });

  it("a goal that is still a proposal is named as such, not just 'not found'", async () => {
    const { addUnitBlockers } =
      await import("../../services/links/unit-blockers.js");
    const step = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, project_id, goal, status, origin, expected_outputs, criteria, metadata, agent_ids, created_at, updated_at, started_at)
       values ($1, $2, $3, 'Wait on a pending goal', 'active', 'agent', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}', now(), now(), now())`,
      [step, USER, P]
    );
    const [pendingGoal, unknownGoal, proposalId] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    // What `start_track` files for an agent: a track/create proposal under
    // the id it answers as `pendingTrackId`.
    await q(
      `insert into proposals (id, target_type, target_id, status, data) values ($1, 'track', $2, 'pending', '{}'::jsonb)`,
      [proposalId, pendingGoal]
    );
    const reports = await addUnitBlockers({
      from: { type: "session", id: step },
      kind: "track",
      ids: [pendingGoal, unknownGoal],
      userId: USER,
      door: "test",
    });
    const byId = Object.fromEntries(reports.map((r) => [r.blockerTrackId, r]));
    expect(byId[pendingGoal]).toMatchObject({
      status: "failed",
      reason: "not_found",
      message: expect.stringContaining(`still a proposal (${proposalId})`),
    });
    // An id nobody filed keeps the door's own answer.
    expect(byId[unknownGoal]).toMatchObject({
      status: "failed",
      reason: "not_found",
    });
    expect(
      (byId[unknownGoal] as { message?: string }).message ?? ""
    ).not.toContain("still a proposal");
  });
});
