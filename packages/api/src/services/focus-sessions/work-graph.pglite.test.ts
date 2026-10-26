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
 *     the HUMAN door (`roster: true`).
 *
 * Stubbed: nothing on the read path except one switch that makes
 * `attachSessionEdges` throw, to prove a failed edge read is `unavailable`.
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
    failEdges: false,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client);
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

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { buildWorkGraph, WORK_GRAPH_CEILING } from "./work-graph.js";

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
};

async function session(
  id: string,
  user: string,
  status: string,
  opts: {
    hoursAgo?: number;
    closedHoursAgo?: number;
    workspaceId?: string;
    channelId?: string;
  } = {}
) {
  const ago = opts.hoursAgo ?? 0;
  await q(
    `insert into focus_sessions (id, user_id, goal, status, workspace_id, channel_id, expected_outputs, agent_ids, metadata, started_at, created_at, updated_at, closed_at)
     values ($1, $2, 'g', $3, $4, $5, '[]'::jsonb, '{}', '{}'::jsonb,
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
  extra: { roster?: boolean; windowHours?: number } = {}
) =>
  buildWorkGraph({
    userId: user,
    scope: { workspaceLens: undefined, projectLens: undefined },
    windowHours: extra.windowHours ?? 72,
    kind: "all",
    lens: "all",
    roster: extra.roster ?? false,
  });

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
