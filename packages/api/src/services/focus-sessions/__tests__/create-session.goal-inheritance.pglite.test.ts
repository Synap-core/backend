/**
 * GOAL INHERITANCE (structural plan S5, founder Q6): a sub-session is born in
 * its parent's goal, on the same parent rung that gives it the project, so the
 * session page, the goal's lists and Plan agree. Creation only; the caller's
 * own `trackId`, or a project the parent's goal is not in, wins.
 *
 * Real: `createFocusSession`, the project ladder (`resolveSessionProjectPlacement`,
 * rung 2 reads the parent's project), `resolveTrackFiling` and the
 * `project_tracks` VisibilityRule, on PGlite. Rows are read back.
 * Stubbed: governance (grants, or proposes on demand), the lineage edge
 * writer (`recordSessionSpawn`, its own suite), room mint, realtime emit.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  propose: false,
  permCalls: [] as Array<Record<string, unknown>>,
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
    recordSessionSpawn: async () => ({
      linked: true,
      suspendedIntentRecorded: false,
    }),
  };
});
vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
      h.permCalls.push(opts);
      return h.propose
        ? { proposalId: randomUUID(), proposalType: "create" }
        : { granted: true };
    },
  };
});
vi.mock("../ensure-session-channel.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ensureSessionChannel: async () => null };
});
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitHubRealtimeEvent: () => undefined };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { createFocusSession } from "../create-session.js";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const AGENT = "22222222-2222-4222-8222-222222222222";
const P = randomUUID();
const P2 = randomUUID();
const GOAL = randomUUID();
const GOAL2 = randomUUID();
const CLOSED_GOAL = randomUUID();

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
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function project(id: string, name: string) {
  await q(
    `insert into projects (id, user_id, workspace_id, name, status, created_at, updated_at)
     values ($1, $2, null, $3, 'active', now(), now())`,
    [id, USER, name]
  );
}
async function goal(
  id: string,
  projectId: string,
  name: string,
  status: string
) {
  await q(
    `insert into project_tracks (id, project_id, user_id, name, definition_snapshot, method_version, current_stage, status, created_at, updated_at)
     values ($1, $2, $3, $4, '{}'::jsonb, '1', null, $5, now(), now())`,
    [id, projectId, USER, name, status]
  );
}
async function parent(opts: {
  owner?: string;
  projectId: string | null;
  trackId: string | null;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, project_id, track_id, goal, status, origin, expected_outputs, criteria, metadata, agent_ids, created_at, updated_at, started_at)
     values ($1, $2, $3, $4, 'Security root', 'active', 'agent', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}', now(), now(), now())`,
    [id, opts.owner ?? USER, opts.projectId, opts.trackId]
  );
  return id;
}

const child = (over: Record<string, unknown>) =>
  createFocusSession({
    userId: USER,
    agentUserId: AGENT,
    goal: `Security slice ${randomUUID()}`,
    matchTemplate: false,
    forceCreate: true,
    ...over,
  }) as Promise<{
    status: string;
    session?: { id: string; projectId: string | null; trackId: string | null };
  }>;

const rowOf = async (id: string) =>
  (
    await q<{ project_id: string | null; track_id: string | null }>(
      `select project_id, track_id from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!;

beforeAll(async () => {
  for (const t of Object.values(schema)) {
    if (is(t, PgTable)) await h.client!.exec(ddlFor(t));
  }
  await q(
    `insert into users (id, email, name, user_type) values
      ($1, 'a@x.test', 'Antoine', 'human'),
      ($2, 'g@x.test', 'Agent', 'agent'),
      ($3, 'o@x.test', 'Other', 'human')`,
    [USER, AGENT, OTHER]
  );
  await project(P, "Synap");
  await project(P2, "Brand");
  await goal(GOAL, P, "Security", "active");
  await goal(GOAL2, P, "Onboarding", "active");
  await goal(CLOSED_GOAL, P, "Old security", "completed");
}, 120_000);

beforeEach(() => {
  h.propose = false;
  h.permCalls = [];
});

describe("a sub-session inherits its parent's goal at creation (S5, Q6)", () => {
  it("parent in a goal: the child is born in the same project AND the same goal", async () => {
    const root = await parent({ projectId: P, trackId: GOAL });
    const res = await child({ parentSessionId: root });
    expect(res.status).toBe("created");
    expect(await rowOf(res.session!.id)).toEqual({
      project_id: P,
      track_id: GOAL,
    });
  });

  it("an explicit project equal to the parent's still inherits the goal", async () => {
    const root = await parent({ projectId: P, trackId: GOAL });
    const res = await child({ parentSessionId: root, projectId: P });
    expect((await rowOf(res.session!.id)).track_id).toBe(GOAL);
  });

  it("the caller's explicit trackId wins over the parent's goal", async () => {
    const root = await parent({ projectId: P, trackId: GOAL });
    const res = await child({ parentSessionId: root, trackId: GOAL2 });
    expect(await rowOf(res.session!.id)).toEqual({
      project_id: P,
      track_id: GOAL2,
    });
  });

  it("an explicit project the parent's goal is not in wins: no goal", async () => {
    const root = await parent({ projectId: P, trackId: GOAL });
    const res = await child({ parentSessionId: root, projectId: P2 });
    expect(await rowOf(res.session!.id)).toEqual({
      project_id: P2,
      track_id: null,
    });
  });

  it("a parent in a CLOSED goal: the child inherits nothing, and is still created", async () => {
    const root = await parent({ projectId: P, trackId: CLOSED_GOAL });
    const res = await child({ parentSessionId: root });
    expect(res.status).toBe("created");
    expect(await rowOf(res.session!.id)).toEqual({
      project_id: P,
      track_id: null,
    });
  });

  it("a parent with no goal gives none; another person's parent gives no goal", async () => {
    const plain = await parent({ projectId: P, trackId: null });
    const a = await child({ parentSessionId: plain });
    expect((await rowOf(a.session!.id)).track_id).toBeNull();

    const foreign = await parent({ owner: OTHER, projectId: P, trackId: GOAL });
    const b = await child({ parentSessionId: foreign });
    expect((await rowOf(b.session!.id)).track_id).toBeNull();
  });

  it("PROPOSED path: the inherited goal rides the proposal (so approval files it)", async () => {
    h.propose = true;
    const root = await parent({ projectId: P, trackId: GOAL });
    const res = await child({ parentSessionId: root });
    expect(res.status).toBe("proposed");
    const create = h.permCalls.find((c) => c.action === "create")!;
    expect(create.data).toMatchObject({ trackId: GOAL, parentSessionId: root });
    expect(create.projectId).toBe(P);
  });
});
