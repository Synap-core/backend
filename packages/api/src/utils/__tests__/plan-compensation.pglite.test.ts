/**
 * A PLAN THAT FAILS PART-WAY LEAVES NOTHING BEHIND — on a real Postgres (PGlite).
 *
 * Driven through the real `materializeCompositeGraph` and the REAL
 * compensation half of `buildPlanCallers`: sessions through the ONE close door
 * (`cancelSession` → `completeFocusSession`), then `buildMaterializedRecord` →
 * `creationsPlanFromRecord` → `revertProposalCreations` → `safeRevert`. The
 * CREATE doors are stubbed to insert rows the way their doors do — the undo is
 * what is under test, not `createFocusSession` / `projects.create`.
 *
 * Pinned:
 *  - every applied row is retired: the project archived, the sessions
 *    cancelled, both session edges deleted, the entity soft-deleted;
 *  - the project is NOT counted "in use" by the plan's OWN sessions and edges
 *    (the exclusion added to `inspectProject`) — without it a plan could never
 *    compensate its own project;
 *  - a project something OUTSIDE the plan started using mid-apply is left in
 *    place and NAMED as not compensated, never silently kept.
 *
 * STATED LIMIT of the retry case: the create doors here are stubs that mint a
 * fresh id per call, exactly as the real doors do (`createFocusSession` and
 * `ProjectRepository.create` take no caller id) — so it proves compensation
 * leaves nothing a retry collides with, not the real doors' id minting.
 *
 * NOT covered here: the real create doors' side effects that compensation
 * cannot undo (a session's minted channel, realtime / audit events,
 * `belongs_to_project` relations written by `entities.create`) — see the
 * report in `utils/plan-callers.ts`.
 */

import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});
vi.mock("../domain-mutation.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordDomainMutation: vi.fn(async () => null),
}));
vi.mock("../property-relation-sync.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  syncRelationToPropertyOnDelete: vi.fn(async () => undefined),
}));
// The close door's collaborators — stubbed exactly as the reversibility pglite
// suite does (governance, fan-out, pg-boss, the read-only guard).
vi.mock("../permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBoss: () => ({ cancel: async () => undefined }),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
}));
vi.mock("../../lib/event-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logEvent: vi.fn(async () => undefined),
}));
vi.mock("../domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: vi.fn(),
}));
vi.mock(
  "../../services/proposals/expire-lapsed-proposals.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    expireSessionEphemerals: vi.fn(async () => 0),
  })
);
vi.mock("../audit-log.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditLog: vi.fn(async () => undefined),
}));
vi.mock("../split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  entities,
  relations,
  entityFacets,
  links,
  focusSessions,
  projects,
  proposals,
  chatTurns,
  playbookRuns,
  type db as DatabaseHandle,
} from "@synap/database";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import {
  CompositePlanApplyError,
  materializeCompositeGraph,
  type PlanCallers,
} from "../materialize-composite.js";
import { buildPlanCallers } from "../plan-callers.js";

const USER = "user-1";
type Database = typeof DatabaseHandle;

/** CREATE TABLE from the drizzle definition (same helper as the reversibility pglite suites). */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

async function freshDb() {
  const client = new PGlite();
  for (const table of [
    entities,
    relations,
    entityFacets,
    links,
    focusSessions,
    projects,
    proposals,
    chatTurns,
    playbookRuns,
  ]) {
    await client.exec(ddlFor(table as unknown as PgTable));
  }
  await client.exec(`
    create schema pgboss;
    create table pgboss.job (id uuid primary key, name text not null, state text not null, data jsonb);
  `);
  const database = drizzle(client, {
    schema: { proposals, focusSessions, chatTurns, playbookRuns },
  }) as unknown as Database;
  holder.db = database;
  return { client, database };
}

const plan: CompositeProposalOperation[] = [
  { op: "create_entity", ref: "acme", profileSlug: "company", title: "Acme" },
  { op: "create_project", ref: "p1", name: "Acme onboarding" },
  { op: "create_session", ref: "s0", goal: "root", projectRef: "p1" },
  {
    op: "create_session",
    ref: "s1",
    goal: "spec",
    parentRef: "s0",
    projectRef: "p1",
  },
  { op: "create_link", type: "blocked_by", fromRef: "s1", toRef: "s0" },
  {
    op: "create_document",
    ref: "spec",
    title: "Spec",
    content: "# Spec",
    sessionRef: "s1",
  },
];

/** Stub create doors that write real rows; the REAL compensation from the factory. */
function callersFor(
  client: PGlite,
  database: Database,
  onDocument: () => Promise<void>
): {
  callers: PlanCallers;
  entityCaller: { create: (i: { title: string }) => Promise<{ id: string }> };
} {
  const real = buildPlanCallers({
    database,
    userId: USER,
    sessionOwnerUserId: USER,
    workspaceId: null,
    entityCaller: { update: vi.fn() },
    proposal: { id: null, sessionId: null },
  });
  const entityCaller = {
    create: async (input: { title: string }) => {
      const id = randomUUID();
      await client.query(
        `insert into entities (id, user_id, type, title, properties) values ($1, $2, 'company', $3, '{}'::jsonb)`,
        [id, USER, input.title]
      );
      return { id };
    },
  };
  const callers: PlanCallers = {
    projectCaller: {
      create: async ({ name }) => {
        const id = randomUUID();
        await client.query(
          `insert into projects (id, user_id, name, status) values ($1, $2, $3, 'active')`,
          [id, USER, name]
        );
        return { id, linked: false };
      },
      setSubject: async () => undefined,
    },
    sessionCaller: {
      create: async ({ goal, projectId }) => {
        const id = randomUUID();
        await client.query(
          `insert into focus_sessions (id, user_id, goal, status, project_id) values ($1, $2, $3, 'active', $4)`,
          [id, USER, goal, projectId]
        );
        return { id };
      },
    },
    linkCaller: {
      create: async ({ type, fromSessionId, toSessionId }) => {
        const id = randomUUID();
        await client.query(
          `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata) values ($1, 'session', $2, 'session', $3, $4, '{}'::jsonb)`,
          [id, fromSessionId, toSessionId, type]
        );
        return { linkId: id, preExisting: false };
      },
    },
    documentCaller: {
      create: async () => {
        await onDocument();
        throw new Error("storage is down");
      },
    },
    compensate: real.compensate,
  };
  return { callers, entityCaller };
}

describe("connected plan compensation (real undo engine)", () => {
  it("a step failing LAST rolls back every row the plan had applied", async () => {
    const { client, database } = await freshDb();
    const { callers, entityCaller } = callersFor(
      client,
      database,
      async () => {}
    );

    const err = (await materializeCompositeGraph(
      plan,
      entityCaller,
      { create: vi.fn() },
      undefined,
      { planCallers: callers }
    ).catch((e) => e)) as CompositePlanApplyError;

    expect(err).toBeInstanceOf(CompositePlanApplyError);
    expect(err.steps).toEqual([
      expect.objectContaining({
        op: "create_document",
        ref: "spec",
        reason: "storage is down",
      }),
    ]);
    expect(err.compensation.notCompensated).toEqual([]);
    expect(Object.keys(err.compensation.undone).sort()).toEqual([
      "entity",
      "link",
      "project",
      "session",
    ]);

    const project = await client.query<{ status: string }>(
      `select status from projects`
    );
    expect(project.rows.map((r) => r.status)).toEqual(["archived"]);
    const sessions = await client.query<{ status: string }>(
      `select status from focus_sessions`
    );
    expect(sessions.rows.map((r) => r.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    const edges = await client.query(`select id from links`);
    expect(edges.rows).toHaveLength(0);
    const entity = await client.query<{ deleted_at: Date | null }>(
      `select deleted_at from entities`
    );
    expect(entity.rows[0]!.deleted_at).not.toBeNull();
  });

  it("a RETRY after a rolled-back approval mints fresh rows — it never collides with the retired ones", async () => {
    const { client, database } = await freshDb();
    let failDocument = true;
    const { callers, entityCaller } = callersFor(
      client,
      database,
      async () => {}
    );
    // The same doors, but the document step succeeds on the second attempt.
    const retryCallers: PlanCallers = {
      ...callers,
      documentCaller: {
        create: async () => {
          if (failDocument) throw new Error("storage is down");
          return { id: randomUUID() };
        },
      },
    };

    const first = await materializeCompositeGraph(
      plan,
      entityCaller,
      { create: vi.fn() },
      undefined,
      { planCallers: retryCallers }
    ).catch((e) => e);
    expect(first).toBeInstanceOf(CompositePlanApplyError);
    const retired = await client.query<{ id: string }>(
      `select id from focus_sessions where status = 'cancelled'`
    );
    const retiredProject = await client.query<{ id: string }>(
      `select id from projects where status = 'archived'`
    );
    expect(retired.rows).toHaveLength(2);

    failDocument = false;
    const second = await materializeCompositeGraph(
      plan,
      entityCaller,
      { create: vi.fn() },
      undefined,
      { planCallers: retryCallers }
    );

    const retiredIds = new Set([
      ...retired.rows.map((r) => r.id),
      ...retiredProject.rows.map((r) => r.id),
    ]);
    const freshIds = [
      ...second.sessions.map((x) => x.sessionId),
      ...second.projects.map((x) => x.projectId),
    ];
    expect(freshIds).toHaveLength(3);
    expect(freshIds.filter((id) => retiredIds.has(id))).toEqual([]);
    // The retired rows stay retired; the retry's rows are live.
    const live = await client.query<{ n: number }>(
      `select count(*)::int as n from focus_sessions where status = 'active'`
    );
    expect(live.rows[0]!.n).toBe(2);
    const stillCancelled = await client.query<{ n: number }>(
      `select count(*)::int as n from focus_sessions where status = 'cancelled'`
    );
    expect(stillCancelled.rows[0]!.n).toBe(2);
  });

  it("a project somebody ELSE started using mid-apply is left in place and NAMED, not silently kept", async () => {
    const { client, database } = await freshDb();
    const { callers, entityCaller } = callersFor(client, database, async () => {
      // An unrelated session filed into the new project while the plan ran.
      await client.query(
        `insert into focus_sessions (id, user_id, goal, status, project_id)
         select $1, $2, 'someone else', 'active', id from projects limit 1`,
        [randomUUID(), USER]
      );
    });

    const err = (await materializeCompositeGraph(
      plan,
      entityCaller,
      { create: vi.fn() },
      undefined,
      { planCallers: callers }
    ).catch((e) => e)) as CompositePlanApplyError;

    expect(err).toBeInstanceOf(CompositePlanApplyError);
    expect(err.compensation.notCompensated).toEqual([
      expect.objectContaining({
        kind: "project",
        reason: "something else uses the project",
      }),
    ]);
    expect(err.message).toMatch(/could not be rolled back/);
    // The plan's OWN sessions are still retired — through the close door.
    const planSessions = await client.query<{ status: string }>(
      `select status from focus_sessions where goal in ('root', 'spec')`
    );
    expect(planSessions.rows.map((r) => r.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    const project = await client.query<{ status: string }>(
      `select status from projects`
    );
    expect(project.rows.map((r) => r.status)).toEqual(["active"]);
  });
});
