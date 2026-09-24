/**
 * Project Path on PGlite — driven through the REAL service, the REAL tRPC
 * `projects.path` procedure and the REAL Hub `GET /projects/:projectId/path`.
 *
 * Real: `sessionListConditions`, the window-ranked batched readers,
 * `ownerPrivateVisibleWhere` / `userVisibleWhere`, and — for the seam — the
 * REAL `projectContinuationPacket`, whose `nextMove` every path row must equal.
 * Tables are generated from the Drizzle definitions.
 *
 * NOT covered: a failed batched section (the `unavailable` branch) and the
 * `hasOutputs` presence read against a `produced` edge (artifact rows only).
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
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const pg = drizzle(client, {
    schema: { focusSessions: actual.focusSessions as never },
  });
  return { ...actual, db: pg, getDb: async () => pg };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  db,
  focusSessions,
  proposals,
  users,
  chatTurns,
  workspaces,
  workspaceMembers,
  artifacts,
  links,
  entities,
  documents,
  views,
  automations,
  playbooks,
  projects,
  projectTracks,
  eq,
} from "@synap/database";
import { getProjectPath } from "./project-path.js";
import { attachNextMove } from "../focus-sessions/session-path-sections.js";
import { projectContinuationPacket } from "../focus-sessions/continuation-packet.js";
import { projectsRouter } from "../../routers/projects.js";
import { registerProjectsRoutes } from "../../routers/hub-protocol/rest/projects.js";
import type {
  HubHono,
  HubVariables,
} from "../../routers/hub-protocol/rest/_shared.js";

const USER = "user-1";
const STRANGER = "user-2";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const W_BUILDER = randomUUID();
const W_MARKETING = randomUUID();
const W_HIDDEN = randomUUID();
const PROJECT = randomUUID();
const TRACK_LIVE = randomUUID();
const STRANGERS_PROJECT = randomUUID();

const S = {
  a: randomUUID(), // Builder, blocked by b
  b: randomUUID(), // Marketing, a pending proposal, unblocks a
  c: randomUUID(), // no workspace, owes the human a slot, parent of e
  e: randomUUID(), // Builder, child of c, an output, declared slot done
  hidden: randomUUID(), // a workspace the user cannot see
  strangers: randomUUID(), // user-2's session in the same project
  otherProject: randomUUID(),
};

async function session(
  id: string,
  opts: {
    user?: string;
    workspaceId?: string | null;
    projectId?: string;
    goal: string;
    status?: string;
    minutesAgo: number;
    slots?: unknown[];
  }
) {
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, project_id, goal, status, expected_outputs, metadata, origin, created_at, updated_at, started_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, '{}'::jsonb, 'human',
       now() - make_interval(mins => $8::int), now(), now() - make_interval(mins => $8::int))`,
    [
      id,
      opts.user ?? USER,
      opts.workspaceId ?? null,
      opts.projectId ?? PROJECT,
      opts.goal,
      opts.status ?? "active",
      JSON.stringify(opts.slots ?? []),
      opts.minutesAgo,
    ]
  );
}

const edge = (from: string, to: string, linkType: string) =>
  q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
     values ($1, 'session', $2, 'session', $3, $4, '{}'::jsonb, now())`,
    [randomUUID(), from, to, linkType]
  );

const path = (over: Partial<Parameters<typeof getProjectPath>[0]> = {}) =>
  getProjectPath({
    userId: USER,
    projectId: PROJECT,
    lens: "default",
    limit: 50,
    offset: 0,
    ...over,
  });

beforeAll(async () => {
  for (const t of [
    focusSessions,
    proposals,
    users,
    chatTurns,
    workspaces,
    workspaceMembers,
    artifacts,
    links,
    entities,
    documents,
    views,
    automations,
    playbooks,
    projects,
    projectTracks,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await h.client!.exec(
    `create schema pgboss; create table pgboss.job (id uuid primary key default gen_random_uuid(), name text, state text, data jsonb);`
  );

  for (const [id, name] of [
    [W_BUILDER, "Builder"],
    [W_MARKETING, "Marketing"],
    [W_HIDDEN, "Secret"],
  ] as const) {
    await q(`insert into workspaces (id, name) values ($1, $2)`, [id, name]);
  }
  for (const ws of [W_BUILDER, W_MARKETING]) {
    await q(
      `insert into workspace_members (id, workspace_id, user_id) values ($1, $2, $3)`,
      [randomUUID(), ws, USER]
    );
  }
  await q(
    `insert into projects (id, user_id, workspace_id, name, description, status) values ($1, $2, null, 'Atlas', 'Ship the atlas', 'active'), ($3, $4, null, 'Theirs', null, 'active')`,
    [PROJECT, USER, STRANGERS_PROJECT, STRANGER]
  );
  // Two tracks: one a CHECK gate holds paused (its marker set), one archived
  // (the path omits it). Without `project_tracks` in the fixture every path
  // read answered `tracks: unavailable` and nothing below could see a track.
  await q(
    `insert into project_tracks (id, project_id, user_id, name, definition_snapshot, method_version, current_stage, status, metadata, created_at, updated_at) values
      ($1, $3, $4, 'Business model', $5::jsonb, '1', 'build', 'paused', $6::jsonb, now() - interval '2 days', now()),
      ($2, $3, $4, 'Old method', '{}'::jsonb, '1', null, 'archived', '{}'::jsonb, now() - interval '1 day', now())`,
    [
      TRACK_LIVE,
      randomUUID(),
      PROJECT,
      USER,
      JSON.stringify({
        stages: [
          { key: "discover", name: "Discover" },
          { key: "build", name: "Build" },
        ],
      }),
      JSON.stringify({ checkGate: { stageKey: "build", failing: ["x"] } }),
    ]
  );

  await session(S.a, {
    workspaceId: W_BUILDER,
    goal: "Wire billing",
    minutesAgo: 40,
  });
  await session(S.b, {
    workspaceId: W_MARKETING,
    goal: "Price the plans\nin detail",
    minutesAgo: 30,
  });
  await session(S.c, {
    goal: "Collect credentials",
    minutesAgo: 20,
    slots: [
      {
        kind: "credential",
        label: "Stripe key",
        owner: "human",
        why: "the live key",
        owedSince: "2026-09-01T00:00:00.000Z",
      },
    ],
  });
  await session(S.e, {
    workspaceId: W_BUILDER,
    goal: "Draft the brief",
    minutesAgo: 10,
    slots: [{ kind: "document", label: "Brief", status: "done" }],
  });
  await session(S.hidden, {
    workspaceId: W_HIDDEN,
    goal: "Hidden ws work",
    status: "closed",
    minutesAgo: 50,
  });
  await session(S.strangers, {
    user: STRANGER,
    workspaceId: W_BUILDER,
    goal: "Not yours",
    minutesAgo: 5,
  });
  await session(S.otherProject, {
    projectId: randomUUID(),
    goal: "Elsewhere",
    minutesAgo: 1,
  });

  await edge(S.a, S.b, "blocked_by");
  await edge(S.a, S.strangers, "blocked_by");
  await edge(S.strangers, S.b, "blocked_by");
  await edge(S.e, S.c, "spawned_from");
  await q(
    `insert into proposals (id, session_id, status, proposal_type, target_type, target_id, data, created_at, updated_at)
     values ($1, $2, 'pending', 'create', 'company', $3, $4::jsonb, now(), now())`,
    [randomUUID(), S.b, randomUUID(), JSON.stringify({ targetName: "Acme" })]
  );
  await q(
    `insert into artifacts (id, user_id, kind, ref_id, title, origin_kind, session_id, state, props, created_at, updated_at)
     values ($1, $2, 'document', $3, 'Brief v1', 'agent', $4, 'kept', '{}'::jsonb, now(), now())`,
    [randomUUID(), USER, randomUUID(), S.e]
  );
});

describe("getProjectPath", () => {
  it("returns the project's live tracks, READ OK, with why a paused one is held", async () => {
    const r = (await path())!;
    expect(r.tracks.status).toBe("ok");
    if (r.tracks.status !== "ok") return;
    expect(r.tracks.items.map((t) => t.id)).toEqual([TRACK_LIVE]);
    expect(r.tracks.items[0]).toMatchObject({
      status: "paused",
      pausedBy: "check",
      currentStage: "build",
    });
    expect(r.tracks.items[0]!.stages.map((s) => s.position)).toEqual([
      "done",
      "active",
    ]);
  });

  it("lists the user's project sessions across workspaces, newest started first, with workspace names", async () => {
    const r = (await path())!;
    expect(r.project).toMatchObject({
      id: PROJECT,
      name: "Atlas",
      description: "Ship the atlas",
    });
    expect(r.items.map((i) => i.id)).toEqual([S.e, S.c, S.b, S.a, S.hidden]);
    const byId = new Map(r.items.map((i) => [i.id, i]));
    expect(byId.get(S.a)!.workspace).toEqual({
      id: W_BUILDER,
      name: "Builder",
    });
    expect(byId.get(S.b)!.workspace).toEqual({
      id: W_MARKETING,
      name: "Marketing",
    });
    expect(byId.get(S.c)!.workspace).toBeNull();
    // A workspace the caller cannot see keeps its id, never its name.
    expect(byId.get(S.hidden)!.workspace).toEqual({ id: W_HIDDEN, name: null });
    expect(byId.get(S.b)!.displayTitle).toBe("Price the plans");
    expect(byId.get(S.a)!.kind).toBe("work");
  });

  it("never lists another user's session, even in the same project", async () => {
    const ids = (await path())!.items.map((i) => i.id);
    expect(ids).not.toContain(S.strangers);
    expect(ids).not.toContain(S.otherProject);
  });

  it("blockedBy and unblocks read both directions, owner-floored", async () => {
    const byId = new Map((await path())!.items.map((i) => [i.id, i]));
    expect(byId.get(S.a)!.blockedBy).toEqual({
      status: "ok",
      total: 1,
      items: [
        {
          id: S.b,
          title: "Price the plans",
          status: "active",
          statusLabel: expect.any(String),
        },
      ],
    });
    expect(byId.get(S.a)!.unblocks).toEqual({
      status: "ok",
      total: 0,
      items: [],
    });
    // The stranger's inbound edge onto b is not disclosed.
    expect(byId.get(S.b)!.unblocks).toEqual({
      status: "ok",
      total: 1,
      items: [
        {
          id: S.a,
          title: "Wire billing",
          status: "active",
          statusLabel: expect.any(String),
        },
      ],
    });
    expect(byId.get(S.b)!.blockedBy).toMatchObject({ total: 0 });
    expect(byId.get(S.c)!.childrenCount).toEqual({ status: "ok", total: 1 });
    expect(byId.get(S.e)!.parentCount).toEqual({ status: "ok", total: 1 });
    expect(byId.get(S.e)!.hasOutputs).toEqual({ status: "ok", value: true });
    expect(byId.get(S.a)!.hasOutputs).toEqual({ status: "ok", value: false });
  });

  it("SEAM (list door): attachNextMove gives every row the packet's nextMove and keeps the row's own blockedBy", async () => {
    // `focusSessions.list` rows already carry `blockedBy` as an ID LIST; the
    // work map asks for `nextMove` on top. The wrapper must add the rule's
    // answer and leave the list-shaped field alone.
    const rows = (await db.select().from(focusSessions)).filter(
      (r) => r.userId === USER
    );
    const listShaped = rows.map((r) => ({ ...r, blockedBy: ["list-shape"] }));
    const out = await attachNextMove(listShaped, {
      userId: USER,
      database: db,
    });
    expect(out).toHaveLength(rows.length);
    const kinds = new Set<string>();
    let pendingSeen = 0;
    for (const item of out) {
      const packet = await projectContinuationPacket(
        rows.find((x) => x.id === item.id)!,
        { database: db, userId: USER }
      );
      expect(item.nextMove, `nextMove for ${item.goal}`).toEqual(
        packet.nextMove
      );
      // The state mark's counts come from the SAME reads as the packet.
      const { owedSlots, pendingProposals } = packet.userMustDecide;
      expect(item.unitFacts, `unitFacts for ${item.goal}`).toEqual({
        owedFromYou: owedSlots.status === "ok" ? owedSlots.total : "unread",
        pendingDecisions:
          pendingProposals.status === "ok" ? pendingProposals.total : null,
      });
      expect(item.blockedBy).toEqual(["list-shape"]);
      kinds.add(item.nextMove.kind);
      pendingSeen += item.unitFacts.pendingDecisions ?? 0;
    }
    // Non-vacuity for the counts: at least one row carries a pending decision.
    expect(pendingSeen).toBeGreaterThan(0);
    // Non-vacuity: a blocked session and a pending proposal are both on the page.
    expect(kinds).toContain("waiting_on_session");
    expect(kinds).toContain("pending_proposal");
  });

  it("SEAM: every row's nextMove equals the continuation packet's for that session", async () => {
    const r = (await path())!;
    const rows = await db.select().from(focusSessions);
    const kinds = new Set<string>();
    for (const item of r.items) {
      const row = rows.find((x) => x.id === item.id)!;
      const packet = await projectContinuationPacket(row, {
        database: db,
        userId: USER,
      });
      expect(item.nextMove, `nextMove for ${item.displayTitle}`).toEqual(
        packet.nextMove
      );
      expect(item.blockedBy).toEqual(packet.blockedBy);
      kinds.add(item.nextMove.kind);
    }
    // Non-vacuity: the fixture exercises the rule's distinct branches.
    expect([...kinds].sort()).toEqual(
      [
        "none",
        "owed_slot",
        "pending_proposal",
        "ready_to_close",
        "waiting_on_session",
      ].sort()
    );
  });

  it("the workspace filter narrows rows and the summary", async () => {
    const all = (await path())!;
    expect(all.summary).toEqual({
      openSessions: { status: "ok", total: 4 },
      userMustDecide: { status: "ok", total: 2 },
    });
    const marketing = (await path({ workspaceIds: [W_MARKETING] }))!;
    expect(marketing.items.map((i) => i.id)).toEqual([S.b]);
    expect(marketing.summary).toEqual({
      openSessions: { status: "ok", total: 1 },
      userMustDecide: { status: "ok", total: 1 },
    });
  });

  it("returns null for a project the caller cannot see", async () => {
    expect(await path({ projectId: STRANGERS_PROJECT })).toBeNull();
  });

  it("pages by offset with hasMore", async () => {
    const first = (await path({ limit: 2 }))!;
    expect(first.items.map((i) => i.id)).toEqual([S.e, S.c]);
    expect(first.pagination).toEqual({ hasMore: true, limit: 2, offset: 0 });
    const second = (await path({ limit: 2, offset: 2 }))!;
    expect(second.items.map((i) => i.id)).toEqual([S.b, S.a]);
  });

  it("BATCHED: the query count does not grow with the page size", async () => {
    const spy = vi.spyOn(h.client!, "query");
    try {
      spy.mockClear();
      await path({ limit: 1 });
      const one = spy.mock.calls.length;
      spy.mockClear();
      await path({ limit: 50 });
      const five = spy.mock.calls.length;
      expect(one).toBeGreaterThan(5); // non-vacuity: the spy sees drizzle's queries
      expect(five).toBe(one);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the doors carry the same path", () => {
  it("tRPC projects.path", async () => {
    const caller = projectsRouter.createCaller({
      db,
      authenticated: true,
      userId: USER,
    } as never);
    const r = await caller.path({ projectId: PROJECT });
    expect(r.items.map((i) => i.id)).toEqual([S.e, S.c, S.b, S.a, S.hidden]);
    await expect(
      caller.path({ projectId: STRANGERS_PROJECT })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  function app(vars: Partial<HubVariables> = {}): HubHono {
    const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
    a.use("/*", async (c, next) => {
      c.set("userId", USER);
      c.set("scopes", ["hub-protocol.read"]);
      for (const [k, v] of Object.entries(vars)) c.set(k as never, v as never);
      await next();
    });
    registerProjectsRoutes(a);
    return a;
  }

  it("Hub GET /projects/:projectId/path", async () => {
    const res = await app().request(
      `/projects/${PROJECT}/path?workspaceIds=${W_BUILDER}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual([S.e, S.a]);
    expect(
      (await app().request(`/projects/${STRANGERS_PROJECT}/path`)).status
    ).toBe(404);
    expect((await app().request(`/projects/not-a-uuid/path`)).status).toBe(400);
  });

  it("a workspace-bound service key is pinned to its workspace on the Hub door", async () => {
    const bound = app({
      keyType: "service",
      keyWorkspaceId: W_MARKETING,
    } as never);
    const pinned = await bound.request(`/projects/${PROJECT}/path`);
    expect(pinned.status).toBe(200);
    expect(
      ((await pinned.json()) as { items: Array<{ id: string }> }).items.map(
        (i) => i.id
      )
    ).toEqual([S.b]);
    expect(
      (
        await bound.request(
          `/projects/${PROJECT}/path?workspaceIds=${W_BUILDER}`
        )
      ).status
    ).toBe(403);
  });
});

describe("children ordering matches the packet's inbound reader", () => {
  // Discriminating row: open-first-only ordering cuts the top 5 to the older
  // cancelled children and reads `undeclared`; open → closed → rest keeps the
  // closed child (evidence of work) and reads `ready_to_close`.
  it("a closed child behind PACKET_TOP_N cancelled ones still counts as evidence", async () => {
    const project = randomUUID();
    const parent = randomUUID();
    await q(
      `insert into projects (id, user_id, workspace_id, name, status) values ($1, $2, null, 'Evidence', 'active')`,
      [project, USER]
    );
    await session(parent, {
      projectId: project,
      goal: "Parent of detours",
      minutesAgo: 100,
    });
    for (let i = 0; i < 6; i++) {
      const child = randomUUID();
      await session(child, {
        projectId: randomUUID(),
        goal: `Dropped ${i}`,
        status: "cancelled",
        minutesAgo: 90 - i,
      });
      await edge(child, parent, "spawned_from");
    }
    const closed = randomUUID();
    await session(closed, {
      projectId: randomUUID(),
      goal: "Finished detour",
      status: "closed",
      minutesAgo: 1,
    });
    await edge(closed, parent, "spawned_from");

    const r = (await getProjectPath({
      userId: USER,
      projectId: project,
      lens: "default",
      limit: 50,
      offset: 0,
    }))!;
    expect(r.items).toHaveLength(1);
    const [row] = await db
      .select()
      .from(focusSessions)
      .where(eq(focusSessions.id, parent));
    const packet = await projectContinuationPacket(row!, {
      database: db,
      userId: USER,
    });
    expect(r.items[0]!.childrenCount).toEqual({ status: "ok", total: 7 });
    expect(r.items[0]!.nextMove).toEqual(packet.nextMove);
    expect(r.items[0]!.nextMove.kind).toBe("ready_to_close");
  });
});
