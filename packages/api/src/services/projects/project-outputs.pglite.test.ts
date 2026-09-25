/**
 * Wave A2 on PGlite — `projects.outputs`, the per-project REVIEW count of THE
 * needs-you rule, path-row `unitFacts`, and `focusSessions.list`'s
 * project-path population + open-first order. Driven through the REAL
 * services, the REAL tRPC procedures and the REAL Hub route.
 *
 * Fixture (one project, one live track):
 *   W1   work, active, IN the track — a produced edge (entity) + a document
 *        artifact → `ready_to_close` (outputs, nothing owed)
 *   W2   work, closed — a view artifact
 *   RT   RUN filed in the track (playbook origin + track) — in the population
 *   RU   RUN with no track (automation) — OUT of the population; its artifact is
 *        the NEWEST, so an unfiltered read would put it first
 *   REV  work, active, its declared slot done → `ready_to_close`
 *   OWE  work, active, owes the human a slot → needs you for OWED, not REVIEW
 *   DR   an agent DRAFT (triage-pending) with a done slot and an artifact —
 *        the pod says `ready_to_close`, the rule says "not yours"
 *   STR  another user's session in the same project, with an artifact
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
  return {
    ...actual,
    db: pg,
    getDb: async () => pg,
    // Lineage reads the package-internal `db` (not this export), so it would
    // reach a real Postgres; lineage is not under test here.
    getParentSessionIds: async () => new Map<string, string>(),
  };
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
  sessionEvaluations,
} from "@synap/database";
import { sessionNeedsYou, tallyNeedsYou } from "@synap-core/types/units";
import { AccessContext } from "../../access/index.js";
import {
  listProjectOutputs,
  PROJECT_OUTPUTS_SESSION_SCAN,
} from "./project-outputs.js";
import { countProjectSessionsAwaitingReview } from "./project-needs-you.js";
import { getProjectPath } from "./project-path.js";
import { listSessionOutputs } from "../focus-sessions/session-outputs.js";
import { projectsRouter } from "../../routers/projects.js";
import { focusSessionsRouter } from "../../routers/focus-sessions.js";
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
const PROJECT = randomUUID();
const PROJECT2 = randomUUID(); // the open-first window fixture
const STRANGERS_PROJECT = randomUUID();
const TRACK = randomUUID();
const PLAYBOOK = randomUUID();
const AUTOMATION = randomUUID();
const ENTITY = randomUUID();
const FILED_ENTITY = randomUUID();

const S = {
  w1: randomUUID(),
  w2: randomUUID(),
  rt: randomUUID(),
  ru: randomUUID(),
  rev: randomUUID(),
  owe: randomUUID(),
  dr: randomUUID(),
  str: randomUUID(),
  oldOpen: randomUUID(),
  c1: randomUUID(),
  c2: randomUUID(),
};

const DONE_SLOT = [{ kind: "document", label: "Brief", status: "done" }];
const OWED_SLOT = [
  {
    kind: "credential",
    label: "Stripe key",
    owner: "human",
    owedSince: "2026-09-01T00:00:00.000Z",
  },
];

async function session(
  id: string,
  opts: {
    user?: string;
    projectId?: string;
    goal: string;
    status?: string;
    minutesAgo: number;
    slots?: unknown[];
    origin?: string;
    metadata?: Record<string, unknown>;
    trackId?: string | null;
    playbookId?: string | null;
  }
) {
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, project_id, goal, status, expected_outputs, metadata, origin, track_id, playbook_id, created_at, updated_at, started_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11,
       now() - make_interval(mins => $12::int), now(), now() - make_interval(mins => $12::int))`,
    [
      id,
      opts.user ?? USER,
      W_BUILDER,
      opts.projectId ?? PROJECT,
      opts.goal,
      opts.status ?? "active",
      JSON.stringify(opts.slots ?? []),
      JSON.stringify(opts.metadata ?? {}),
      opts.origin ?? "human",
      opts.trackId ?? null,
      opts.playbookId ?? null,
      opts.minutesAgo,
    ]
  );
}

async function artifact(
  sessionId: string,
  kind: string,
  title: string,
  minutesAgo: number,
  refId: string = randomUUID()
) {
  await q(
    `insert into artifacts (id, user_id, kind, ref_id, title, origin_kind, session_id, state, props, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'agent', $6, 'kept', '{}'::jsonb,
       now() - make_interval(mins => $7::int), now())`,
    [randomUUID(), USER, kind, refId, title, sessionId, minutesAgo]
  );
}

const access = (userId = USER) => AccessContext.operator({ userId });

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
    sessionEvaluations,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await h.client!.exec(
    `create schema pgboss; create table pgboss.job (id uuid primary key default gen_random_uuid(), name text, state text, data jsonb);`
  );
  await q(`insert into workspaces (id, name) values ($1, 'Builder')`, [
    W_BUILDER,
  ]);
  await q(
    `insert into workspace_members (id, workspace_id, user_id) values ($1, $2, $3)`,
    [randomUUID(), W_BUILDER, USER]
  );
  await q(
    `insert into projects (id, user_id, workspace_id, name, status) values
      ($1, $2, null, 'Atlas', 'active'),
      ($3, $2, null, 'Window', 'active'),
      ($4, $5, null, 'Theirs', 'active')`,
    [PROJECT, USER, PROJECT2, STRANGERS_PROJECT, STRANGER]
  );
  await q(
    `insert into project_tracks (id, project_id, user_id, name, definition_snapshot, method_version, current_stage, status, metadata, created_at, updated_at)
     values ($1, $2, $3, 'Business model', '{"stages":[]}'::jsonb, '1', null, 'active', '{}'::jsonb, now(), now())`,
    [TRACK, PROJECT, USER]
  );
  await q(
    `insert into entities (id, user_id, title) values ($1, $2, 'Pricing sheet'), ($3, $2, 'Filed, not produced')`,
    [ENTITY, USER, FILED_ENTITY]
  );

  await session(S.w1, {
    goal: "Price the plans",
    minutesAgo: 60,
    trackId: TRACK,
  });
  // W1 was filed at the track's "pricing" stage (0274); RT at none.
  await q(`update focus_sessions set track_stage = 'pricing' where id = $1`, [
    S.w1,
  ]);
  await session(S.w2, {
    goal: "Map the market",
    minutesAgo: 70,
    status: "closed",
  });
  await session(S.rt, {
    goal: "Run the method step",
    minutesAgo: 50,
    origin: "playbook",
    playbookId: PLAYBOOK,
    trackId: TRACK,
  });
  await session(S.ru, {
    goal: "Nightly sync",
    minutesAgo: 40,
    origin: "automation",
    metadata: { automationId: AUTOMATION },
  });
  await session(S.rev, {
    goal: "Draft the brief",
    minutesAgo: 30,
    slots: DONE_SLOT,
  });
  await session(S.owe, {
    goal: "Collect credentials",
    minutesAgo: 20,
    slots: OWED_SLOT,
  });
  await session(S.dr, {
    goal: "Agent suggestion",
    minutesAgo: 15,
    origin: "agent",
    slots: DONE_SLOT,
  });
  await session(S.str, { user: STRANGER, goal: "Not yours", minutesAgo: 10 });

  // Outputs. Newest → oldest among the population: rt(5) w1-doc(10) w2(20) w1-entity(30).
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
     values ($1, 'session', $2, 'entity', $3, 'produced', '{}'::jsonb, now() - interval '30 minutes')`,
    [randomUUID(), S.w1, ENTITY]
  );
  await artifact(S.w1, "document", "Brief v1", 10);
  await artifact(S.w2, "view", "Market map", 20);
  await artifact(S.rt, "document", "Step output", 5);
  await artifact(S.ru, "document", "Sync log", 1); // untracked run: never listed
  await artifact(S.dr, "document", "Draft output", 2); // draft: never listed
  await artifact(S.str, "document", "Stranger's", 3); // another user: never listed
  // An entity merely FILED in the project is Context, not an output (P2).
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
     values ($1, 'entity', $2, 'project', $3, 'belongs_to_project', '{}'::jsonb, now())`,
    [randomUUID(), FILED_ENTITY, PROJECT]
  );

  // The open-first window fixture: one OLD open session, two NEWER closed ones.
  await session(S.oldOpen, {
    projectId: PROJECT2,
    goal: "Long-running",
    minutesAgo: 5000,
  });
  await session(S.c1, {
    projectId: PROJECT2,
    goal: "Closed one",
    minutesAgo: 10,
    status: "closed",
  });
  await session(S.c2, {
    projectId: PROJECT2,
    goal: "Closed two",
    minutesAgo: 20,
    status: "closed",
  });
});

describe("projects.outputs (P1 + P2)", () => {
  it("lists the path sessions' outputs, newest first, each with its door and producer", async () => {
    const r = (await listProjectOutputs({
      access: access(),
      projectId: PROJECT,
      limit: 50,
    }))!;
    expect(r.items.map((i) => [i.sessionId, i.kind, i.title])).toEqual([
      [S.rt, "document", "Step output"],
      [S.w1, "document", "Brief v1"],
      [S.w2, "view", "Market map"],
      // The live title from the entities table, not the edge's id.
      [S.w1, "entity", "Pricing sheet"],
    ]);
    const entity = r.items[3]!;
    expect(entity).toMatchObject({
      ref: { kind: "entity", id: ENTITY },
      sessionTitle: "Price the plans",
      trackId: TRACK,
      trackStage: "pricing",
    });
    expect(r.items.find((i) => i.sessionId === S.w2)!.trackId).toBeNull();
    expect(r.items.find((i) => i.sessionId === S.rt)!.trackStage).toBeNull();
    expect(r.nextCursor).toBeNull();
    expect(r.truncated).toBe(false);
  });

  it("BOUNDED: scans the most recently active sessions only, and says so with `truncated`", async () => {
    const BIG = randomUUID();
    const OLDEST = randomUUID();
    await q(
      `insert into projects (id, user_id, workspace_id, name, status) values ($1, $2, null, 'Big', 'active')`,
      [BIG, USER]
    );
    await session(OLDEST, {
      projectId: BIG,
      goal: "Least recently active",
      minutesAgo: 9000,
    });
    await q(
      `update focus_sessions set updated_at = now() - interval '30 days' where id = $1`,
      [OLDEST]
    );
    await artifact(OLDEST, "document", "Old output", 1);
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, project_id, goal, status, expected_outputs, metadata, origin, created_at, updated_at, started_at)
       select gen_random_uuid(), $1, $2, $3, 'Filler ' || g, 'active', '[]'::jsonb, '{}'::jsonb, 'human', now(), now(), now()
       from generate_series(1, $4::int) g`,
      [USER, W_BUILDER, BIG, PROJECT_OUTPUTS_SESSION_SCAN]
    );
    const r = (await listProjectOutputs({
      access: access(),
      projectId: BIG,
      limit: 50,
    }))!;
    expect(r.truncated).toBe(true);
    expect(r.items.map((i) => i.sessionId)).not.toContain(OLDEST);
  });

  it("excludes untracked runs, drafts, other users' sessions and merely-filed entities", async () => {
    const r = (await listProjectOutputs({
      access: access(),
      projectId: PROJECT,
      limit: 50,
    }))!;
    const sessions = new Set(r.items.map((i) => i.sessionId));
    for (const out of [S.ru, S.dr, S.str]) expect(sessions).not.toContain(out);
    expect(r.items.map((i) => i.ref.id)).not.toContain(FILED_ENTITY);
  });

  it("SEAM: each session's items are exactly what focusSessions.outputs joins for it", async () => {
    const r = (await listProjectOutputs({
      access: access(),
      projectId: PROJECT,
      limit: 50,
    }))!;
    for (const sid of [S.w1, S.w2, S.rt]) {
      const one = (await listSessionOutputs({
        db,
        userId: USER,
        sessionId: sid,
      }))!;
      expect(
        r.items
          .filter((i) => i.sessionId === sid)
          .map((i) => `${i.kind}:${i.ref.id}`)
          .sort()
      ).toEqual(one.outputs.map((o) => `${o.kind}:${o.refId}`).sort());
    }
  });

  it("narrows to one track", async () => {
    const r = (await listProjectOutputs({
      access: access(),
      projectId: PROJECT,
      trackId: TRACK,
      limit: 50,
    }))!;
    expect(r.items.map((i) => i.sessionId)).toEqual([S.rt, S.w1, S.w1]);
  });

  it("narrows to one track STAGE", async () => {
    const r = (await listProjectOutputs({
      access: access(),
      projectId: PROJECT,
      trackId: TRACK,
      trackStage: "pricing",
      limit: 50,
    }))!;
    expect(r.items.map((i) => i.sessionId)).toEqual([S.w1, S.w1]);
  });

  it("pages by cursor without repeating or skipping", async () => {
    const first = (await listProjectOutputs({
      access: access(),
      projectId: PROJECT,
      limit: 3,
    }))!;
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    const second = (await listProjectOutputs({
      access: access(),
      projectId: PROJECT,
      limit: 3,
      cursor: first.nextCursor!,
    }))!;
    expect(second.items.map((i) => i.title)).toEqual(["Pricing sheet"]);
    expect(second.nextCursor).toBeNull();
    await expect(
      listProjectOutputs({
        access: access(),
        projectId: PROJECT,
        limit: 3,
        cursor: "nope",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("returns null for a project the caller cannot see; tRPC 404s; Hub 200/404", async () => {
    expect(
      await listProjectOutputs({
        access: access(),
        projectId: STRANGERS_PROJECT,
        limit: 5,
      })
    ).toBeNull();
    const caller = projectsRouter.createCaller({
      db,
      authenticated: true,
      userId: USER,
    } as never);
    expect((await caller.outputs({ projectId: PROJECT })).items).toHaveLength(
      4
    );
    await expect(
      caller.outputs({ projectId: STRANGERS_PROJECT })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
    app.use("/*", async (c, next) => {
      c.set("userId", USER);
      c.set("scopes", ["hub-protocol.read"]);
      await next();
    });
    registerProjectsRoutes(app);
    const ok = await app.request(
      `/projects/${PROJECT}/outputs?trackId=${TRACK}&limit=2`
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      items: Array<{ sessionId: string }>;
      nextCursor: string | null;
    };
    expect(body.items.map((i) => i.sessionId)).toEqual([S.rt, S.w1]);
    expect(body.nextCursor).not.toBeNull();
    expect(
      (await app.request(`/projects/${STRANGERS_PROJECT}/outputs`)).status
    ).toBe(404);
    const bad = await app.request(`/projects/${PROJECT}/outputs?cursor=nope`);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Invalid cursor" });
  });
});

describe("THE needs-you rule over the project (N1)", () => {
  it("path rows carry the rule's facts; the three populations count and the draft does not", async () => {
    const r = (await getProjectPath({
      userId: USER,
      projectId: PROJECT,
      lens: "all",
      limit: 50,
      offset: 0,
    }))!;
    const byId = new Map(r.items.map((i) => [i.id, i]));
    expect(byId.get(S.rev)!.unitFacts).toMatchObject({
      awaitingReview: true,
      draft: false,
    });
    expect(byId.get(S.owe)!.unitFacts).toMatchObject({
      owedFromYou: 1,
      awaitingReview: false,
    });
    // The pod's move for the draft IS "ready_to_close" — the rule still says no.
    expect(byId.get(S.dr)!.nextMove.kind).toBe("ready_to_close");
    expect(byId.get(S.dr)!.unitFacts).toMatchObject({
      awaitingReview: true,
      draft: true,
    });
    expect(sessionNeedsYou(byId.get(S.dr)!.unitFacts)).toBe(false);

    const tally = tallyNeedsYou(r.items.map((i) => i.unitFacts));
    // owed: OWE's slot. review: W1 (outputs), RT (outputs), REV (slot done).
    expect(tally).toMatchObject({
      owed: 1,
      decisions: 0,
      review: 3,
      sessions: 4,
    });
  });

  it("the server's per-project REVIEW count equals the rule's review population", async () => {
    expect(
      await countProjectSessionsAwaitingReview({
        userId: USER,
        projectId: PROJECT,
      })
    ).toEqual({ review: 3, truncated: false });
    // Owner-floored like the path: the stranger's OWN session (it produced an
    // output, so it is `ready_to_close`) counts for them, and is not among
    // the user's three above.
    expect(
      await countProjectSessionsAwaitingReview({
        userId: STRANGER,
        projectId: PROJECT,
      })
    ).toEqual({ review: 1, truncated: false });
  });
});

describe("focusSessions.list — the path's population and the open-first window", () => {
  const caller = () =>
    focusSessionsRouter.createCaller({
      db,
      authenticated: true,
      userId: USER,
    } as never);

  it("includeTrackedRuns returns EXACTLY the project path's session set", async () => {
    const listed = await caller().list({
      projectId: PROJECT,
      includeTrackedRuns: true,
      limit: 50,
    });
    const path = (await getProjectPath({
      userId: USER,
      projectId: PROJECT,
      lens: "default",
      limit: 50,
      offset: 0,
    }))!;
    expect(listed.map((s) => s.id).sort()).toEqual(
      path.items.map((i) => i.id).sort()
    );
    expect(listed.map((s) => s.id)).toContain(S.rt);
    expect(listed.map((s) => s.id)).not.toContain(S.ru);
    // Without the flag the tracked run is not "work".
    const workOnly = await caller().list({ projectId: PROJECT, limit: 50 });
    expect(workOnly.map((s) => s.id)).not.toContain(S.rt);
  });

  it("refuses includeTrackedRuns with a kind other than work", async () => {
    await expect(
      caller().list({
        projectId: PROJECT,
        includeTrackedRuns: true,
        kind: "run",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("open_first keeps an old OPEN session on a page newer settled rows would fill", async () => {
    const byStart = await caller().list({ projectId: PROJECT2, limit: 2 });
    expect(byStart.map((s) => s.id)).toEqual([S.c1, S.c2]); // the vanishing bar
    const openFirst = await caller().list({
      projectId: PROJECT2,
      limit: 2,
      order: "open_first",
    });
    expect(openFirst.map((s) => s.id)).toEqual([S.oldOpen, S.c1]);
  });
});
