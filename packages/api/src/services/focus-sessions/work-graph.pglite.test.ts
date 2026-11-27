/**
 * The work graph on PGlite — the REAL `buildWorkGraph`: the shared WHERE
 * (`sessionListConditions`), the shared row projection, the real attach
 * helpers, against every table generated from the Drizzle definitions (so no
 * hand-kept list of "the tables this read touches" can fall behind it).
 *
 * Fixture rows sit where the candidate rules DISAGREE:
 *   - an OPEN session started 30 days ago — a "settled since" window alone, or
 *     "newest N", drops it;
 *   - a CANCELLED session settled 2 h ago — the list's `statusSince` windows
 *     cover `stale`/`closed` only, so a status-set window drops it;
 *   - a session CLOSED 5 days ago that an open window session is blocked by —
 *     outside the window, so it must come back as a FAR END, never be absent;
 *   - another person's session linked by a `blocked_by` edge — the far-end
 *     fetch must apply the floor, and the edge to it must not be drawn;
 *   - another person's session whose room seats this person — readable only on
 *     the HUMAN door (`roster: true`);
 *   - a session in space A blocked by the same person's session in space B —
 *     an unbound key gets B as a far end, a key BOUND to A must not;
 *   - a wave (root → child → grandchild) beside an unrelated session, one PR
 *     recorded by two of its sessions, a paused grandchild with a hold, and a
 *     child filed into a goal — `focus` must keep the wave or the goal only,
 *     and the PR, hold and goal must come back once each;
 *   - PIVOT: sessions that follow a playbook each way a session can (its own
 *     `playbook_id`; only through its goal's method; both), beside the ones
 *     that must NOT match (another playbook, another goal's method, a session
 *     that RELEASED the playbook and kept only its `template_id`); sessions on
 *     a thing (subject, worker target) beside one on another thing; a goal
 *     with a staged method; a live runner on an agent's session.
 *
 *   - PATH: a pathway (B4) — a root whose steps wait on decisions (one open
 *     and asked, one answered, one the reader cannot see), on a goal, and
 *     serve a goal; a step closed 60 days ago; a goal waiting on a goal; a
 *     step about a thing.
 *
 * Stubbed: nothing on the read path except two switches that make
 * `attachSessionEdges` / `readGraphThings` throw, to prove a failed read is
 * `unavailable`.
 * `@synap/database`'s own client module is routed onto the same PGlite, so
 * the lineage read inside that package runs for real too.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    prReaders: [] as { lens?: unknown }[],
    failEdges: false,
    failThings: false,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        // The schema too: the goal reads behind `serves` (`readServes`) go
        // through the access layer's relational `findMany`.
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
    // The lineage read (`getParentSessionIds`) lives inside @synap/database
    // and imports `db` from its client module, not from the package entry:
    // route that onto the same PGlite, so the REAL `spawned_from` read runs.
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const pg = await h.init();
  return { ...actual, db: pg, getDb: async () => pg };
});

vi.mock("../dev-loop/pr-state.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../dev-loop/pr-state.js")>();
  return {
    ...actual,
    readPullRequestStates: async (
      ...args: Parameters<typeof actual.readPullRequestStates>
    ) => {
      h.prReaders.push(args[1] as { lens?: unknown });
      return actual.readPullRequestStates(...args);
    },
  };
});

vi.mock("./session-blocked-by.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./session-blocked-by.js")>();
  return {
    ...actual,
    attachSessionEdges: async (
      ...args: Parameters<typeof actual.attachSessionEdges>
    ) => {
      if (h.failEdges) throw new Error("links read failed (test)");
      return actual.attachSessionEdges(...args);
    },
  };
});

vi.mock("./work-graph-nodes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./work-graph-nodes.js")>();
  return {
    ...actual,
    readGraphThings: async (
      ...args: Parameters<typeof actual.readGraphThings>
    ) => {
      if (h.failThings) throw new Error("entities read failed (test)");
      return actual.readGraphThings(...args);
    },
  };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  buildWorkGraph,
  toWorkGraphAppNode,
  WORK_GRAPH_CEILING,
} from "./work-graph.js";

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

const USER = "user-graph";
const OTHER = "user-other";
const BIG = "user-big";
const WS = randomUUID();
const BOUND = "user-bound";
const WS_A = randomUUID();
const WS_B = randomUUID();

const S = {
  openOld: randomUUID(), // active, started and last touched 30 d ago
  closedRecent: randomUUID(), // closed 1 h ago
  cancelledRecent: randomUUID(), // cancelled 2 h ago, no closed_at
  staleRecent: randomUUID(), // stale, touched 3 h ago
  staleOld: randomUUID(), // stale, touched 10 d ago
  closedOld: randomUUID(), // closed 5 d ago — out of a 72 h window
  blocker: randomUUID(), // closed 5 d ago; openOld is blocked by it (far end)
  child: randomUUID(), // active; spawned from openOld
  othersBlocker: randomUUID(), // OTHER's session; openOld "blocked by" it
  shared: randomUUID(), // OTHER's session whose room seats USER
  inA: randomUUID(), // BOUND's session in WS_A, blocked by inB
  inB: randomUUID(), // BOUND's session in WS_B (far end of inA)
  root: randomUUID(), // WAVE's root; records PR #7
  waveChild: randomUUID(), // spawned from root; records PR #7 too; in TRACK
  grandchild: randomUUID(), // spawned from waveChild; paused, with a hold
  unrelated: randomUUID(), // WAVE's session outside the wave
};
const WAVE = "user-wave";
const PROJECT = randomUUID();
const TRACK = randomUUID();
const PR_URL = "https://github.com/Synap-core/backend/pull/7";

async function session(
  id: string,
  user: string,
  status: string,
  opts: {
    hoursAgo?: number;
    closedHoursAgo?: number;
    workspaceId?: string;
    channelId?: string;
    trackId?: string;
    outputs?: unknown[];
  } = {}
) {
  const ago = opts.hoursAgo ?? 0;
  await q(
    `insert into focus_sessions (id, user_id, goal, status, workspace_id, channel_id, track_id, expected_outputs, agent_ids, metadata, started_at, created_at, updated_at, closed_at)
     values ($1, $2, 'g', $3, $4, $5, $8, $9::jsonb, '{}', '{}'::jsonb,
             now() - make_interval(hours => $6::int), now() - make_interval(hours => $6::int), now() - make_interval(hours => $6::int),
             case when $7::int is null then null else now() - make_interval(hours => $7::int) end)`,
    [
      id,
      user,
      status,
      opts.workspaceId ?? null,
      opts.channelId ?? null,
      ago,
      opts.closedHoursAgo ?? null,
      opts.trackId ?? null,
      JSON.stringify(opts.outputs ?? []),
    ]
  );
}

const link = (from: string, to: string, linkType: string) =>
  q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
     values ($1, 'session', $2, 'session', $3, $4, '{}'::jsonb, now())`,
    [randomUUID(), from, to, linkType]
  );

const graph = (
  user: string,
  extra: {
    roster?: boolean;
    windowHours?: number;
    workspaceLens?: string;
    boundWorkspaceId?: string;
    focus?: Parameters<typeof buildWorkGraph>[0]["focus"];
    playbookId?: string;
    subjectEntityId?: string;
  } = {}
) =>
  buildWorkGraph({
    userId: user,
    scope: { workspaceLens: extra.workspaceLens, projectLens: undefined },
    windowHours: extra.windowHours ?? 72,
    kind: "all",
    lens: "all",
    roster: extra.roster ?? false,
    boundWorkspaceId: extra.boundWorkspaceId,
    focus: extra.focus,
    playbookId: extra.playbookId,
    subjectEntityId: extra.subjectEntityId,
  });

// PIVOT: the playbook and subject narrows, the goal's method, the runner.
const PIVOT = "user-pivot";
const PLAYBOOK = randomUUID();
const OTHER_PLAYBOOK = randomUUID();
const PIVOT_PROJECT = randomUUID();
const METHOD_TRACK = randomUUID(); // a goal whose method is PLAYBOOK
const OTHER_TRACK = randomUUID(); // a goal whose method is OTHER_PLAYBOOK
const THING = randomUUID();
const OTHER_THING = randomUUID();
const AGENT = "agent-pivot";
const MACHINE = "machine-pivot";
const P = {
  run: randomUUID(), // run from PLAYBOOK, at its stage "review", agent runs it
  viaGoal: randomUUID(), // no playbook of its own; filed in METHOD_TRACK
  both: randomUUID(), // run from PLAYBOOK AND filed in OTHER_TRACK
  released: randomUUID(), // template_id PLAYBOOK, playbook_id NULL (released)
  otherGoal: randomUUID(), // filed in OTHER_TRACK only
  otherRun: randomUUID(), // run from OTHER_PLAYBOOK
  onThing: randomUUID(), // subject THING
  worker: randomUUID(), // a worker targeting THING
  onOther: randomUUID(), // subject OTHER_THING
};

async function pivotSession(
  id: string,
  opts: {
    playbookId?: string;
    templateId?: string;
    trackId?: string;
    trackStage?: string;
    subjectEntityId?: string;
    currentStage?: string;
    stages?: unknown[];
    agentIds?: string[];
  } = {}
) {
  await q(
    `insert into focus_sessions (id, user_id, goal, status, playbook_id, template_id, track_id, track_stage, subject_entity_id, current_stage, stages, expected_outputs, agent_ids, metadata, started_at, created_at, updated_at)
     values ($1, $2, 'g', 'active', $3, $4, $5, $6, $7, $8, $9::jsonb, '[]'::jsonb, $10, '{}'::jsonb, now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour')`,
    [
      id,
      PIVOT,
      opts.playbookId ?? null,
      opts.templateId ?? null,
      opts.trackId ?? null,
      opts.trackStage ?? null,
      opts.subjectEntityId ?? null,
      opts.currentStage ?? null,
      JSON.stringify(opts.stages ?? []),
      opts.agentIds ?? [],
    ]
  );
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable => is(v, PgTable)
  );
  // Non-vacuity: the schema walk saw the tables this read joins.
  const names = tables.map((t) => getTableConfig(t).name);
  expect(names).toEqual(
    expect.arrayContaining(["focus_sessions", "links", "channel_members"])
  );
  for (const t of tables) await h.client!.exec(ddlFor(t));

  await session(S.openOld, USER, "active", { hoursAgo: 24 * 30 });
  await session(S.closedRecent, USER, "closed", {
    hoursAgo: 5,
    closedHoursAgo: 1,
  });
  await session(S.cancelledRecent, USER, "cancelled", { hoursAgo: 2 });
  await session(S.staleRecent, USER, "stale", { hoursAgo: 3 });
  await session(S.staleOld, USER, "stale", { hoursAgo: 24 * 10 });
  await session(S.closedOld, USER, "closed", {
    hoursAgo: 24 * 6,
    closedHoursAgo: 24 * 5,
  });
  await session(S.blocker, USER, "closed", {
    hoursAgo: 24 * 6,
    closedHoursAgo: 24 * 5,
  });
  await session(S.child, USER, "active", { hoursAgo: 1 });
  await session(S.othersBlocker, OTHER, "active", { hoursAgo: 1 });
  await link(S.openOld, S.blocker, "blocked_by");
  await link(S.openOld, S.othersBlocker, "blocked_by");
  await link(S.child, S.openOld, "spawned_from");

  // OTHER's session, in a workspace USER is a member of, whose own minted room
  // seats USER as a human — readable by USER on the human door only.
  const room = randomUUID();
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'editor')`,
    [randomUUID(), WS, USER]
  );
  await q(`insert into users (id, email, user_type) values ($1, $2, 'human')`, [
    USER,
    `${USER}@test`,
  ]);
  await q(
    `insert into channels (id, context_object_type, context_object_id) values ($1, 'focus_session', $2)`,
    [room, S.shared]
  );
  await q(
    `insert into channel_members (id, channel_id, member_id, member_kind, role) values ($1, $2, $3, 'human', 'member')`,
    [randomUUID(), room, USER]
  );
  await session(S.shared, OTHER, "active", {
    hoursAgo: 1,
    workspaceId: WS,
    channelId: room,
  });

  await session(S.inA, BOUND, "active", { hoursAgo: 1, workspaceId: WS_A });
  await session(S.inB, BOUND, "active", { hoursAgo: 1, workspaceId: WS_B });
  await link(S.inA, S.inB, "blocked_by");

  // WAVE: a wave, one PR two sessions recorded, a hold, a goal.
  const pr = (key: string) => ({
    key,
    kind: "pull_request",
    label: "backend#7 feat: the thing",
    status: "pending",
    ref: { url: PR_URL },
  });
  await q(`insert into projects (id, name, user_id) values ($1, 'p', $2)`, [
    PROJECT,
    WAVE,
  ]);
  await q(
    `insert into project_tracks (id, project_id, user_id, name, status) values ($1, $2, $3, 'Ship the thing', 'active')`,
    [TRACK, PROJECT, WAVE]
  );
  await session(S.root, WAVE, "active", {
    hoursAgo: 2,
    outputs: [
      pr("pr-backend-7"),
      { key: "notes", kind: "document", label: "Notes" },
    ],
  });
  await session(S.waveChild, WAVE, "active", {
    hoursAgo: 1,
    trackId: TRACK,
    outputs: [pr("pr-7")],
  });
  await session(S.grandchild, WAVE, "paused", { hoursAgo: 1 });
  await session(S.unrelated, WAVE, "active", { hoursAgo: 1 });
  await link(S.waveChild, S.root, "spawned_from");
  await link(S.grandchild, S.waveChild, "spawned_from");
  const holdId = randomUUID();
  await q(
    `insert into lifecycle_transition_outbox (transition_id, transition, emit_context, delivered, attempts, created_at)
     values ($1, $2::jsonb, '{}'::jsonb, '{}', 0, now())`,
    [
      holdId,
      JSON.stringify({
        transitionId: holdId,
        subjectType: "focus_session",
        subjectId: S.grandchild,
        to: "paused",
        category: "paused",
        userId: WAVE,
        workspaceId: null,
        recordedAt: new Date().toISOString(),
        hold: {
          on: "person",
          reason: "waits on the review",
          resumeTo: "active",
          since: new Date().toISOString(),
        },
      }),
    ]
  );

  // PIVOT.
  await q(`insert into projects (id, name, user_id) values ($1, 'p', $2)`, [
    PIVOT_PROJECT,
    PIVOT,
  ]);
  await q(
    `insert into project_tracks (id, project_id, user_id, name, status, playbook_id, current_stage, definition_snapshot)
     values ($1, $2, $3, 'Ship by method', 'active', $4, 'build', $5::jsonb),
            ($6, $2, $3, 'Another method', 'active', $7, null, '{}'::jsonb)`,
    [
      METHOD_TRACK,
      PIVOT_PROJECT,
      PIVOT,
      PLAYBOOK,
      JSON.stringify({
        stages: [
          { key: "shape", name: "Shape it", category: "plan" },
          { key: "build", name: "Build it" },
          { key: "ship", name: "Ship it" },
        ],
      }),
      OTHER_TRACK,
      OTHER_PLAYBOOK,
    ]
  );
  await pivotSession(P.run, {
    playbookId: PLAYBOOK,
    templateId: PLAYBOOK,
    currentStage: "review",
    stages: [
      { key: "draft", name: "Draft" },
      { key: "review", name: "Review it" },
    ],
    agentIds: [AGENT],
  });
  await pivotSession(P.viaGoal, {
    trackId: METHOD_TRACK,
    trackStage: "build",
  });
  await pivotSession(P.both, { playbookId: PLAYBOOK, trackId: OTHER_TRACK });
  await pivotSession(P.released, { templateId: PLAYBOOK });
  await pivotSession(P.otherGoal, { trackId: OTHER_TRACK });
  await pivotSession(P.otherRun, { playbookId: OTHER_PLAYBOOK });
  await pivotSession(P.onThing, { subjectEntityId: THING });
  await pivotSession(P.worker);
  await pivotSession(P.onOther, { subjectEntityId: OTHER_THING });
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
     values ($1, 'session', $2, 'entity', $3, 'targets', '{"role":"worker_target"}'::jsonb, now())`,
    [randomUUID(), P.worker, THING]
  );
  // The agent on P.run, hosted by a machine, running now in Claude Code.
  await q(
    `insert into users (id, email, name, user_type, agent_type, host_user_id) values
       ($1, 'm@x.test', 'devbox', 'agent', 'machine', null),
       ($2, 'a@x.test', 'Claude Code', 'agent', 'claude-code', $1)`,
    [MACHINE, AGENT]
  );
  await q(
    `insert into session_runners (session_id, client_key, user_id, agent_user_id, harness, conversation_id, machine_user_id, process_key, process_host, state, state_since, state_reported_at, model, first_seen_at, last_seen_at)
     values ($1, $2, $3, $4, 'claude-code', 'conv-pivot', $5, 'devbox:4242:1761600000000', 'devbox', 'busy', now() - interval '20 seconds', now() - interval '20 seconds', 'claude-opus-4', now() - interval '5 minutes', now() - interval '10 seconds')`,
    [
      P.run,
      `key:${randomUUID()}|conv:claude-code:conv-pivot`,
      PIVOT,
      AGENT,
      MACHINE,
    ]
  );

  // BIG: one more than the ceiling of OPEN work, plus 3 recently closed.
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, agent_ids, metadata, started_at, created_at, updated_at)
     select gen_random_uuid(), $1, 'g', 'active', '[]'::jsonb, '{}', '{}'::jsonb,
            now() - make_interval(mins => i), now(), now()
     from generate_series(1, $2::int) as i`,
    [BIG, WORK_GRAPH_CEILING + 1]
  );
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, agent_ids, metadata, started_at, created_at, updated_at, closed_at)
     select gen_random_uuid(), $1, 'g', 'closed', '[]'::jsonb, '{}', '{}'::jsonb, now(), now(), now(), now()
     from generate_series(1, 3)`,
    [BIG]
  );
}, 60_000);

describe("buildWorkGraph — the window", () => {
  it("holds open work whatever its age, plus every status settled in the window", async () => {
    const g = await graph(USER);
    const inWindow = g.nodes.filter((n) => n.inWindow).map((n) => n.id);
    expect(inWindow).toEqual(
      expect.arrayContaining([
        S.openOld,
        S.closedRecent,
        S.cancelledRecent,
        S.staleRecent,
        S.child,
      ])
    );
    expect(inWindow).not.toContain(S.staleOld);
    expect(inWindow).not.toContain(S.closedOld);
    expect(g.window.hours).toBe(72);
    expect(g.window.truncated).toBe(false);
    expect(g.window.omitted).toBe(0);
  });

  it("returns the far end of an edge, off-window, and draws the edge", async () => {
    const g = await graph(USER);
    const far = g.nodes.find((n) => n.id === S.blocker);
    expect(far?.inWindow).toBe(false);
    expect(g.edges).toContainEqual({
      kind: "blocked_by",
      from: S.openOld,
      to: S.blocker,
    });
    expect(g.edges).toContainEqual({
      kind: "spawned_from",
      from: S.child,
      to: S.openOld,
    });
    // A node carries the list's projection, next move included.
    const open = g.nodes.find((n) => n.id === S.openOld)!;
    expect(open.kind).toBe("work");
    expect(typeof open.nextMove.kind).toBe("string");
    expect(open.viewerRole).toBe("owner");
    expect(g.sections.blockedBy).toEqual({ status: "ok" });
    expect(g.sections.farEnds).toEqual({ status: "ok" });
  });
});

describe("buildWorkGraph — honest truncation", () => {
  it("cuts at the ceiling, keeps open work first, and counts what it left out", async () => {
    const g = await graph(BIG);
    const inWindow = g.nodes.filter((n) => n.inWindow);
    expect(inWindow).toHaveLength(WORK_GRAPH_CEILING);
    expect(inWindow.every((n) => n.status === "active")).toBe(true);
    expect(g.window.truncated).toBe(true);
    // 1 open session past the ceiling + the 3 closed ones behind it.
    expect(g.window.omitted).toBe(4);
    expect(g.window.ceiling).toBe(WORK_GRAPH_CEILING);
  });
});

describe("buildWorkGraph — who has it (sessions cockpit C5)", () => {
  it("every node carries the holder, read for the whole graph at once — 500 nodes too", async () => {
    // The row-by-row convergence with `readSessionHolder` is pinned in
    // `session-holder.pglite.test.ts`; here, that the graph attaches it.
    for (const user of [USER, BIG]) {
      const g = await graph(user);
      expect(g.nodes.length).toBeGreaterThan(0);
      for (const n of g.nodes) {
        expect({ id: n.id, holder: n.holder.status }).toEqual({
          id: n.id,
          holder: "ok",
        });
      }
    }
    // An ended session is held by nobody, because it ended.
    const g = await graph(USER);
    const closed = g.nodes.find((n) => n.id === S.closedRecent)!;
    expect(closed.holder).toMatchObject({
      status: "ok",
      holder: { kind: "nobody", reason: "ended" },
    });
  });
});

describe("buildWorkGraph — the owner / roster floor", () => {
  it("never returns another person's session, as a node or as a far end", async () => {
    const g = await graph(USER);
    const ids = g.nodes.map((n) => n.id);
    expect(ids).not.toContain(S.othersBlocker);
    expect(ids).not.toContain(S.shared);
    // The edge to an unreadable session is not drawn.
    expect(
      g.edges.some(
        (e) => e.to === S.othersBlocker || e.from === S.othersBlocker
      )
    ).toBe(false);
    expect(g.nodes.every((n) => n.userId === USER)).toBe(true);
  });

  it("adds the sessions whose room seats the person on the human door, as a member", async () => {
    const g = await graph(USER, { roster: true });
    const shared = g.nodes.find((n) => n.id === S.shared);
    expect(shared?.viewerRole).toBe("member");
    expect(g.nodes.map((n) => n.id)).not.toContain(S.othersBlocker);
  });
});

describe("buildWorkGraph — a workspace-bound key", () => {
  it("an unbound key's far ends cross spaces: the edge never points into the void", async () => {
    const g = await graph(BOUND, { workspaceLens: WS_A });
    expect(g.nodes.find((n) => n.id === S.inB)?.inWindow).toBe(false);
    expect(g.edges).toContainEqual({
      kind: "blocked_by",
      from: S.inA,
      to: S.inB,
    });
  });

  it("a key bound to A gets no far end in B, and no edge to it", async () => {
    const g = await graph(BOUND, {
      workspaceLens: WS_A,
      boundWorkspaceId: WS_A,
    });
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain(S.inA);
    expect(ids).not.toContain(S.inB);
    expect(g.nodes.every((n) => n.workspaceId === WS_A)).toBe(true);
    expect(g.edges.some((e) => e.to === S.inB || e.from === S.inB)).toBe(false);
    expect(g.sections.farEnds).toEqual({ status: "ok" });
  });
});

describe("buildWorkGraph — PR facts under a workspace-bound key", () => {
  it("reads the PR states under the bound workspace, and under none for an unbound key", async () => {
    h.prReaders.length = 0;
    await graph(WAVE, { boundWorkspaceId: WS_A });
    expect(h.prReaders.length).toBeGreaterThan(0);
    expect(h.prReaders.every((r) => r.lens === WS_A)).toBe(true);
    h.prReaders.length = 0;
    await graph(WAVE);
    expect(h.prReaders.every((r) => r.lens === undefined)).toBe(true);
  });
});

describe("buildWorkGraph — a failed sub-read", () => {
  it("reads `unavailable`, draws no edge of that kind, and keeps the nodes", async () => {
    h.failEdges = true;
    try {
      const g = await graph(USER);
      expect(g.sections.blockedBy).toEqual({
        status: "unavailable",
        reason: expect.any(String),
      });
      expect(g.edges.some((e) => e.kind === "blocked_by")).toBe(false);
      expect(g.nodes.map((n) => n.id)).toContain(S.openOld);
      // Other reads still answer.
      expect(g.sections.waitsOnOutputs).toEqual({ status: "ok" });
    } finally {
      h.failEdges = false;
    }
  });
});

describe("buildWorkGraph — one goal or one wave", () => {
  it("a wave keeps the root and every session spawned under it, nothing else", async () => {
    const g = await graph(WAVE, { focus: { rootSessionId: S.root } });
    const inWindow = g.nodes.filter((n) => n.inWindow).map((n) => n.id);
    expect(inWindow.sort()).toEqual([S.root, S.waveChild, S.grandchild].sort());
    expect(g.nodes.map((n) => n.id)).not.toContain(S.unrelated);
  });

  it("a goal keeps its sessions; the parent comes back only as a far end", async () => {
    const g = await graph(WAVE, { focus: { trackId: TRACK } });
    expect(g.nodes.filter((n) => n.inWindow).map((n) => n.id)).toEqual([
      S.waveChild,
    ]);
    expect(g.nodes.find((n) => n.id === S.root)?.inWindow).toBe(false);
    expect(g.nodes.map((n) => n.id)).not.toContain(S.unrelated);
  });

  it("another person's wave root gives nothing", async () => {
    const g = await graph(USER, { focus: { rootSessionId: S.root } });
    expect(g.nodes).toEqual([]);
  });
});

describe("buildWorkGraph — PRs, holds and goals", () => {
  it("draws a PR once, with every session that recorded it, and no guessed state", async () => {
    const g = await graph(WAVE);
    expect(g.pullRequests).toEqual([
      {
        id: "synap-core/backend#7",
        url: PR_URL,
        label: "backend#7 feat: the thing",
        sessions: expect.arrayContaining([
          { sessionId: S.root, key: "pr-backend-7", state: "open" },
          { sessionId: S.waveChild, key: "pr-7", state: "open" },
        ]),
      },
    ]);
    expect(g.pullRequests[0]!.sessions).toHaveLength(2);
    // No dev-loop fact recorded: no `prState`, never a guessed "Open".
    expect(g.pullRequests[0]).not.toHaveProperty("prState");
    expect(g.sections.pullRequests).toEqual({ status: "ok" });
  });

  it("carries a paused session's standing hold", async () => {
    const g = await graph(WAVE);
    expect(g.holds).toEqual([
      expect.objectContaining({
        sessionId: S.grandchild,
        status: "paused",
        hold: expect.objectContaining({ on: "person", resumeTo: "active" }),
      }),
    ]);
    expect(g.sections.holds).toEqual({ status: "ok" });
  });

  it("names the goals its sessions serve, under the track floor", async () => {
    const mine = await graph(WAVE);
    expect(mine.goals).toEqual([
      {
        id: TRACK,
        name: "Ship the thing",
        status: "active",
        projectId: PROJECT,
        // A goal that follows no method says so, never a guessed stage.
        playbookId: null,
        currentStage: null,
        stages: [],
      },
    ]);
    expect(mine.sections.goals).toEqual({ status: "ok" });
    // USER holds none of WAVE's sessions, so no goal of theirs either.
    const theirs = await graph(USER);
    expect(theirs.goals).toEqual([]);
  });
});

describe("buildWorkGraph — by playbook (founder decision D2)", () => {
  const inWindowIds = (g: Awaited<ReturnType<typeof graph>>) =>
    g.nodes
      .filter((n) => n.inWindow)
      .map((n) => n.id)
      .sort();

  it("keeps the sessions run from it OR filed in a goal whose method it is, and nothing else", async () => {
    const g = await graph(PIVOT, { playbookId: PLAYBOOK });
    expect(inWindowIds(g)).toEqual([P.run, P.viaGoal, P.both].sort());
    // Another playbook, another goal's method, a RELEASED session (template
    // id kept, playbook id cleared), and sessions with none: all out.
    const ids = g.nodes.map((n) => n.id);
    for (const out of [P.released, P.otherGoal, P.otherRun, P.onThing]) {
      expect(ids).not.toContain(out);
    }
  });

  it("says which way each node follows it: its own playbook first, else its goal", async () => {
    const g = await graph(PIVOT, { playbookId: PLAYBOOK });
    const match = Object.fromEntries(
      g.nodes.map((n) => [n.id, n.playbookMatch])
    );
    expect(match[P.run]).toBe("session");
    expect(match[P.both]).toBe("session");
    expect(match[P.viaGoal]).toBe("goal");
    // A goal-filed node carries what places it on the goal's stages.
    const viaGoal = g.nodes.find((n) => n.id === P.viaGoal)!;
    expect(viaGoal.trackId).toBe(METHOD_TRACK);
    expect(viaGoal.trackStage).toBe("build");
  });

  it("without the narrow, no node claims a match", async () => {
    const g = await graph(PIVOT);
    expect(g.nodes.length).toBeGreaterThan(0);
    for (const n of g.nodes) expect(n).not.toHaveProperty("playbookMatch");
  });
});

describe("buildWorkGraph — by thing", () => {
  it("keeps the sessions on the thing: its subject, or a worker targeting it", async () => {
    const g = await graph(PIVOT, { subjectEntityId: THING });
    expect(
      g.nodes
        .filter((n) => n.inWindow)
        .map((n) => n.id)
        .sort()
    ).toEqual([P.onThing, P.worker].sort());
    expect(g.nodes.map((n) => n.id)).not.toContain(P.onOther);
  });
});

describe("buildWorkGraph — a goal carries its method", () => {
  it("names the method, the stage it is at, and every stage placed against it", async () => {
    const g = await graph(PIVOT);
    const goal = g.goals.find((x) => x.id === METHOD_TRACK);
    expect(goal).toEqual({
      id: METHOD_TRACK,
      name: "Ship by method",
      status: "active",
      projectId: PIVOT_PROJECT,
      playbookId: PLAYBOOK,
      currentStage: "build",
      stages: [
        { key: "shape", name: "Shape it", category: "plan", position: "done" },
        { key: "build", name: "Build it", category: null, position: "active" },
        {
          key: "ship",
          name: "Ship it",
          category: null,
          position: "not_started",
        },
      ],
    });
    // A method with no pinned stages: the method, no stages.
    expect(g.goals.find((x) => x.id === OTHER_TRACK)).toMatchObject({
      playbookId: OTHER_PLAYBOOK,
      currentStage: null,
      stages: [],
    });
  });
});

describe("buildWorkGraph — where the holder runs", () => {
  it("the holder names the runner its word came from: harness, model, computer, state", async () => {
    const g = await graph(PIVOT);
    const run = g.nodes.find((n) => n.id === P.run)!;
    expect(run.holder).toMatchObject({
      status: "ok",
      holder: {
        kind: "agent",
        waitKind: "agent_work",
        source: { from: "runner", state: "busy" },
        runner: {
          harness: "claude-code",
          model: "claude-opus-4",
          machineUserId: MACHINE,
          processHost: "devbox",
          state: "busy",
          live: true,
        },
      },
    });
    // No agent, no runner: none, never a guessed one.
    const viaGoal = g.nodes.find((n) => n.id === P.viaGoal)!;
    expect(viaGoal.holder).toMatchObject({
      status: "ok",
      holder: { kind: "nobody", runner: null },
    });
  });
});

// ── PATH: a pathway (B4) ────────────────────────────────────────────────────
const PATH = "user-path";
const PATH_PROJECT = randomUUID();
const G = {
  filed: randomUUID(), // stepA is filed in it; it waits on `blocker`
  blocker: randomUUID(), // stepA and `filed` wait on it
  served: randomUUID(), // stepA serves it (criterion `seed-closed`)
};
const R = {
  root: randomUUID(), // the pathway's root; asks the open decision
  old: randomUUID(), // a step closed 60 days ago
  stepA: randomUUID(), // waits on D.open, D.hidden and G.blocker; serves G.served
  stepB: randomUUID(), // waits on D.done; about THING_PATH
};
const D = {
  open: randomUUID(), // proposed, asked in R.root
  done: randomUUID(), // accepted, "Yes go" chosen
  hidden: randomUUID(), // OTHER's: the reader cannot see it
};
const THING_PATH = randomUUID();

const linkAny = (
  fromType: string,
  from: string,
  toType: string,
  to: string,
  linkType: string,
  metadata: Record<string, unknown> = {}
) =>
  q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, now())`,
    [
      randomUUID(),
      fromType,
      from,
      toType,
      to,
      linkType,
      JSON.stringify(metadata),
    ]
  );

const entity = (
  id: string,
  user: string,
  type: string,
  title: string,
  status: string,
  category: string,
  properties: Record<string, unknown>
) =>
  q(
    `insert into entities (id, user_id, type, title, status, status_category, properties, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, now(), now())`,
    [id, user, type, title, status, category, JSON.stringify(properties)]
  );

describe("buildWorkGraph — a pathway (B4)", () => {
  beforeAll(async () => {
    await q(`insert into projects (id, name, user_id) values ($1, 'p', $2)`, [
      PATH_PROJECT,
      PATH,
    ]);
    for (const [id, name] of [
      [G.filed, "Close the seed"],
      [G.blocker, "Build the deck"],
      [G.served, "Fund Synap"],
    ] as const) {
      await q(
        `insert into project_tracks (id, project_id, user_id, name, status) values ($1, $2, $3, $4, 'active')`,
        [id, PATH_PROJECT, PATH, name]
      );
    }
    await session(R.root, PATH, "active", {
      hoursAgo: 24 * 90,
      outputs: [
        {
          key: "seed-or-not",
          kind: "decision",
          label: "Seed or not",
          owner: "human",
          blockedReason: "decision",
          status: "pending",
          decisionId: D.open,
        },
      ],
    });
    await session(R.old, PATH, "closed", {
      hoursAgo: 24 * 61,
      closedHoursAgo: 24 * 60,
    });
    await session(R.stepA, PATH, "active", { hoursAgo: 1, trackId: G.filed });
    await session(R.stepB, PATH, "active", { hoursAgo: 1 });
    await q(`update focus_sessions set subject_entity_id = $1 where id = $2`, [
      THING_PATH,
      R.stepB,
    ]);
    for (const step of [R.old, R.stepA, R.stepB])
      await link(step, R.root, "spawned_from");

    await entity(
      D.open,
      PATH,
      "decision",
      "Raise a seed?",
      "proposed",
      "open",
      {
        decisionStatus: "proposed",
        decisionOptions: [
          { label: "Raise a seed" },
          { label: "Bootstrap", recommended: true },
        ],
        sourceSessionId: R.root,
      }
    );
    await entity(D.done, PATH, "decision", "Go?", "accepted", "done", {
      decisionStatus: "accepted",
      decisionOptions: [{ label: "Yes go" }, { label: "Not now" }],
      recommendedOption: "Yes go",
      chosenOption: "Yes go",
    });
    await entity(D.hidden, OTHER, "decision", "Theirs", "proposed", "open", {
      decisionStatus: "proposed",
    });
    await entity(THING_PATH, PATH, "task", "Term sheet", "todo", "open", {});

    await linkAny("session", R.stepA, "entity", D.open, "blocked_by");
    await linkAny("session", R.stepA, "entity", D.hidden, "blocked_by");
    await linkAny("session", R.stepA, "track", G.blocker, "blocked_by");
    await linkAny("session", R.stepA, "track", G.served, "serves", {
      criterionKey: "seed-closed",
    });
    await linkAny("session", R.stepB, "entity", D.done, "blocked_by");
    await linkAny("track", G.filed, "track", G.blocker, "blocked_by");
  });

  it("keeps every step of a wave whatever its age, and says the window is lifted", async () => {
    const wave = await graph(PATH, { focus: { rootSessionId: R.root } });
    expect(
      wave.nodes
        .filter((n) => n.inWindow)
        .map((n) => n.id)
        .sort()
    ).toEqual([R.root, R.old, R.stepA, R.stepB].sort());
    expect(wave.window.allSettled).toBe(true);
    expect(wave.window.truncated).toBe(false);
    // Without a focus the settle window still holds: the old step is out.
    const fleet = await graph(PATH);
    expect(fleet.nodes.map((n) => n.id)).not.toContain(R.old);
    expect(fleet.window.allSettled).toBe(false);
  });

  it("draws a step's waits on a decision and a goal, a goal's wait on a goal, and what a step serves", async () => {
    const g = await graph(PATH, { focus: { rootSessionId: R.root } });
    expect(g.edges).toEqual(
      expect.arrayContaining([
        { kind: "blocked_by", from: R.stepA, to: D.open, toKind: "entity" },
        { kind: "blocked_by", from: R.stepA, to: G.blocker, toKind: "track" },
        { kind: "blocked_by", from: R.stepB, to: D.done, toKind: "entity" },
        {
          kind: "blocked_by",
          from: G.filed,
          fromKind: "track",
          to: G.blocker,
          toKind: "track",
        },
        {
          kind: "serves",
          from: R.stepA,
          to: G.served,
          toKind: "track",
          criterionKey: "seed-closed",
        },
        // Session to session edges are unchanged: no kind named.
        { kind: "spawned_from", from: R.stepA, to: R.root },
      ])
    );
    // A decision the reader cannot see: no node, no edge, never its title.
    expect(g.edges.some((e) => e.to === D.hidden)).toBe(false);
    expect(g.decisions.map((d) => d.id)).not.toContain(D.hidden);
    // Every edge end is a node the read holds.
    const held = new Set([
      ...g.nodes.map((n) => `session:${n.id}`),
      ...g.goals.map((x) => `track:${x.id}`),
      ...g.decisions.map((x) => `entity:${x.id}`),
      ...g.entities.map((x) => `entity:${x.id}`),
    ]);
    for (const e of g.edges) {
      expect(held.has(`${e.fromKind ?? "session"}:${e.from}`)).toBe(true);
      expect(held.has(`${e.toKind ?? "session"}:${e.to}`)).toBe(true);
    }
    // The goals at the far end of a goal edge come back, one hop.
    expect(g.goals.map((x) => x.id).sort()).toEqual(
      [G.filed, G.blocker, G.served].sort()
    );
    for (const k of ["crossKind", "serves", "decisions", "entities"] as const)
      expect(g.sections[k]).toEqual({ status: "ok" });
  });

  it("carries each decision's options, marks and the person's answer", async () => {
    const g = await graph(PATH, { focus: { rootSessionId: R.root } });
    const open = g.decisions.find((d) => d.id === D.open);
    expect(open).toEqual({
      id: D.open,
      title: "Raise a seed?",
      status: "proposed",
      category: "open",
      options: [
        {
          key: "Raise a seed",
          label: "Raise a seed",
          description: null,
          recommended: false,
          chosen: false,
        },
        {
          key: "Bootstrap",
          label: "Bootstrap",
          description: null,
          recommended: true,
          chosen: false,
        },
      ],
      recommendedOption: "Bootstrap",
      chosenOption: null,
      answer: "asked",
      askSessionId: R.root,
      sourceSessionId: R.root,
    });
    expect(g.decisions.find((d) => d.id === D.done)).toMatchObject({
      status: "accepted",
      category: "done",
      chosenOption: "Yes go",
      answer: "answered",
      askSessionId: null,
    });
    // A step's subject is a node too.
    expect(g.entities).toEqual([
      {
        id: THING_PATH,
        title: "Term sheet",
        kind: "task",
        status: "todo",
        category: "open",
      },
    ]);
  });

  it("a failed decision read is `unavailable`, never an empty pathway", async () => {
    h.failThings = true;
    try {
      const g = await graph(PATH, { focus: { rootSessionId: R.root } });
      const unavailable = { status: "unavailable", reason: expect.any(String) };
      expect(g.sections.decisions).toEqual(unavailable);
      expect(g.sections.entities).toEqual(unavailable);
      expect(g.decisions).toEqual([]);
      // No line to a decision it could not read; the rest still draws.
      expect(g.edges.some((e) => e.toKind === "entity")).toBe(false);
      expect(g.edges).toContainEqual(
        expect.objectContaining({ from: R.stepA, to: G.blocker })
      );
      expect(g.sections.crossKind).toEqual({ status: "ok" });
    } finally {
      h.failThings = false;
    }
  });
});

describe("buildWorkGraph — a step's readiness facts", () => {
  const RDY = "user-readiness";
  const T = {
    planned: randomUUID(), // forming, plannedFor 2099-01
    notDone: randomUUID(), // closed with required work open (closedNotDone)
    done: randomUUID(), // closed with nothing recorded open
    plain: randomUUID(), // active, no facts to say
    old: randomUUID(), // cancelled; a blocker that was REPLACED
    next: randomUUID(), // closed; replaces `old` (off-window: a far end)
    waiter: randomUUID(), // forming, blocked by `old`
  };

  beforeAll(async () => {
    await session(T.planned, RDY, "forming", { hoursAgo: 1 });
    await q(`update focus_sessions set metadata = $1::jsonb where id = $2`, [
      JSON.stringify({ plannedFor: "2099-01", dueBy: "not a date" }),
      T.planned,
    ]);
    await session(T.notDone, RDY, "closed", { hoursAgo: 3, closedHoursAgo: 1 });
    await q(
      `update focus_sessions set verification_report = $1::jsonb where id = $2`,
      [JSON.stringify({ closedNotDone: { reason: "x" } }), T.notDone]
    );
    await session(T.done, RDY, "closed", { hoursAgo: 3, closedHoursAgo: 1 });
    await session(T.plain, RDY, "active", { hoursAgo: 1 });
    await session(T.old, RDY, "cancelled", {
      hoursAgo: 24 * 20,
      closedHoursAgo: 24 * 19,
    });
    await session(T.next, RDY, "closed", {
      hoursAgo: 24 * 18,
      closedHoursAgo: 24 * 17,
    });
    await session(T.waiter, RDY, "forming", { hoursAgo: 1 });
    await link(T.waiter, T.old, "blocked_by");
    await link(T.next, T.old, "replaces");
  });

  it("carries plannedFor, dueBy and closedAs only when they say something", async () => {
    const g = await graph(RDY);
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    // A valid plannedFor rides; an invalid dueBy is left out.
    expect(byId.get(T.planned)?.plannedFor).toBe("2099-01");
    expect(byId.get(T.planned)).not.toHaveProperty("dueBy");
    expect(byId.get(T.planned)).not.toHaveProperty("closedAs");
    // The close-anyway record is `not_done`; a plain close is `done`.
    expect(byId.get(T.notDone)?.closedAs).toBe("not_done");
    expect(byId.get(T.done)?.closedAs).toBe("done");
    // A cancelled step ended not done.
    expect(byId.get(T.old)?.closedAs).toBe("not_done");
    expect(byId.get(T.plain)).not.toHaveProperty("closedAs");
    expect(byId.get(T.plain)).not.toHaveProperty("plannedFor");
  });

  it("draws the replacement into a declared blocker, and brings the replacement as a far end", async () => {
    const g = await graph(RDY);
    expect(g.edges).toContainEqual({
      kind: "replaces",
      from: T.next,
      to: T.old,
    });
    const next = g.nodes.find((n) => n.id === T.next);
    expect(next).toBeDefined();
    expect(next?.closedAs).toBe("done");
    expect(g.sections.blockedBy).toEqual({ status: "ok" });
  });

  it("the tRPC wire keeps the three facts", async () => {
    const g = await graph(RDY);
    const wire = toWorkGraphAppNode(g.nodes.find((n) => n.id === T.planned)!);
    expect(wire.plannedFor).toBe("2099-01");
    const closed = toWorkGraphAppNode(g.nodes.find((n) => n.id === T.notDone)!);
    expect(closed.closedAs).toBe("not_done");
  });
});
