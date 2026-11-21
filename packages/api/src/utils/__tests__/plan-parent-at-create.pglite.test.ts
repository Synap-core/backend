/**
 * A PLAN CHILD IS BORN WITH ITS PARENT, like a direct `start_session` with
 * `parentSessionId` (r2 research c484c02e gap D, 21 Nov 2026 test: the 19 steps
 * of a plan under a root session did not land in the root's goal).
 *
 * Before: plan pass P1 created every session with no parent, and P2 wrote the
 * `spawned_from` edge after. `createFocusSession` derives the project (parent
 * rung), the goal (`inheritParentTrack`) and the space (parent rung) only from
 * a parent it is GIVEN at create, so a plan child got none of them.
 *
 * Real: `materializeCompositeGraph` (P1 parents first, P2 edges),
 * `buildPlanCallers`' session and link callers, `createFocusSession`, the
 * project and space ladders, `resolveTrackFiling`, `buildMaterializedRecord`
 * (what plan undo and the proposal's stamp read), on PGlite. Rows are read back.
 *
 * Stubbed, and why: governance (grants), room mint, realtime emit (as the
 * goal-inheritance suite); `recordSessionSpawn` because the real one holds its
 * own connection (`client-pg`), so it is replayed here on PGlite with the same
 * owner floor and the same `idx_links_unique_edge` no-op on repeat.
 *
 * Pinned:
 *  - an existing root in a goal: the plan child (`parentSessionId`) and the
 *    grandchild (`parentRef`, an in-plan parent) are born in the root's project
 *    AND goal;
 *  - one `spawned_from` row per child, and P2 reports it as THIS run's edge
 *    (not `preExisting`), so the materialized record lists it and plan undo
 *    deletes it.
 *
 * NOT covered: the real compensation run (`plan-compensation.pglite.test.ts`
 * proves a link id in the record is deleted), the proposed path of
 * `createFocusSession` (a plan session is created as the approver, never
 * proposed), the space rung (the plan pins the proposal's space; the ladder has
 * its own suite).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, { schema }),
    // The real producer's contract, on this PGlite: owner floor on the
    // parent, then an insert that is a no-op on repeat.
    recordSessionSpawn: async (input: {
      childSessionId: string;
      parentSessionId: string;
      userId: string;
      workspaceId?: string | null;
    }) => {
      if (input.childSessionId === input.parentSessionId) {
        return { linked: false, reason: "self_parent" };
      }
      const parent = await client.query(
        `select id from focus_sessions where id = $1 and user_id = $2`,
        [input.parentSessionId, input.userId]
      );
      if (parent.rows.length === 0) {
        return { linked: false, reason: "parent_not_found" };
      }
      await client.query(
        `insert into links (id, workspace_id, from_type, from_id, to_type, to_id, link_type, created_by, metadata)
         values (gen_random_uuid(), $1, 'session', $2, 'session', $3, 'spawned_from', $4, '{}'::jsonb)
         on conflict do nothing`,
        [
          input.workspaceId ?? null,
          input.childSessionId,
          input.parentSessionId,
          input.userId,
        ]
      );
      return { linked: true, suspendedIntentRecorded: false };
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

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { db } from "@synap/database";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { materializeCompositeGraph } from "../materialize-composite.js";
import { buildPlanCallers } from "../plan-callers.js";
import { buildMaterializedRecord } from "../../services/proposals/stamp-materialized.js";

const USER = "11111111-1111-4111-8111-111111111111";
const P = randomUUID();
const GOAL = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
type Row = { id: string; project_id: string | null; track_id: string | null };
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  for (const t of Object.values(schema)) {
    if (is(t, PgTable)) await h.client!.exec(ddlFor(t));
  }
  // The production unique key on an edge (`idx_links_unique_edge`).
  await h.client!.exec(
    `create unique index if not exists idx_links_unique_edge on links (from_type, from_id, to_type, to_id, link_type);`
  );
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'a@x.test', 'Antoine', 'human')`,
    [USER]
  );
  await q(
    `insert into projects (id, user_id, workspace_id, name, status, created_at, updated_at)
     values ($1, $2, null, 'Synap', 'active', now(), now())`,
    [P, USER]
  );
  await q(
    `insert into project_tracks (id, project_id, user_id, name, definition_snapshot, method_version, current_stage, status, created_at, updated_at)
     values ($1, $2, $3, 'Fund Synap to seed', '{}'::jsonb, '1', null, 'active', now(), now())`,
    [GOAL, P, USER]
  );
}, 120_000);

describe("a plan child is born with its parent (gap D)", () => {
  it("children of a root in a goal land in its project and goal; each spawned_from is this run's, once", async () => {
    const root = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, project_id, track_id, goal, status, origin, expected_outputs, criteria, metadata, agent_ids, created_at, updated_at, started_at)
       values ($1, $2, $3, $4, 'Fund Synap to seed', 'active', 'agent', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}', now(), now(), now())`,
      [root, USER, P, GOAL]
    );

    // Declared child-first on purpose: P1 orders parents before children.
    const plan: CompositeProposalOperation[] = [
      {
        op: "create_session",
        ref: "deck",
        goal: `Pitch deck ${randomUUID()}`,
        parentRef: "round",
      },
      {
        op: "create_session",
        ref: "round",
        goal: `Prepare the round ${randomUUID()}`,
        parentSessionId: root,
      },
    ];

    const result = await materializeCompositeGraph(
      plan,
      { create: vi.fn() },
      { create: vi.fn() },
      undefined,
      {
        planCallers: buildPlanCallers({
          database: db as never,
          userId: USER,
          sessionOwnerUserId: USER,
          workspaceId: null,
          entityCaller: { update: vi.fn() },
          proposal: { id: null, sessionId: null },
        }),
      }
    );

    const idOf = (ref: string) =>
      result.sessions.find((s) => s.ref === ref)!.sessionId;
    const round = idOf("round");
    const deck = idOf("deck");

    const rows = await q<Row>(
      `select id, project_id, track_id from focus_sessions where id = any($1)`,
      [[round, deck]]
    );
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r]));
    // The existing parent's goal, and through the in-plan parent, the same.
    expect(byId[round]).toMatchObject({ project_id: P, track_id: GOAL });
    expect(byId[deck]).toMatchObject({ project_id: P, track_id: GOAL });

    // One edge per child, never a second one.
    const edges = await q<{ id: string; from_id: string; to_id: string }>(
      `select id, from_id, to_id from links where link_type = 'spawned_from' and from_id = any($1)`,
      [[round, deck]]
    );
    const pairs = edges.rows.map((e) => `${e.from_id}>${e.to_id}`).sort();
    expect(pairs).toEqual([`${deck}>${round}`, `${round}>${root}`].sort());

    // P2 met each edge already written at create: still this run's edge, so
    // the record plan undo reads lists it (a `preExisting` one is never undone).
    const spawned = result.links.filter((l) => l.type === "spawned_from");
    expect(spawned).toHaveLength(2);
    for (const link of spawned) {
      expect(link.linkId).toBeTruthy();
      expect(link.preExisting).toBeUndefined();
    }
    const record = buildMaterializedRecord(result);
    expect([...(record.linkIds ?? [])].sort()).toEqual(
      edges.rows.map((e) => e.id).sort()
    );
  });
});
