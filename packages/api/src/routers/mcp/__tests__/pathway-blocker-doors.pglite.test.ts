/**
 * The cross-kind `blocked_by` doors on MCP (pathway research c484c02e, gaps C
 * and D): `synap_update_session` `addBlockedByEntityIds` / `addBlockedByTrackIds`
 * (+ the removes) and `synap_update_track` `addBlockedByTrackIds` (+ remove).
 * Reachability, not shape: the REAL handlers, the REAL governed dependency
 * door (`governedDependencyLink` / `governedRemoveDependencyLink`: cycle walk,
 * THE store write and delete) and the edges read back from PGlite.
 *
 * Stubbed, and why:
 *  - `checkPermissionOrPropose` — the governance membrane has its own suite;
 *    it grants or proposes on demand, and every call is captured so the
 *    FILING is asserted (link/create|delete, the agent attributed).
 *  - `checkLinkEndpointsVisible` / `checkLinkEndpointVisible` /
 *    `assertWorkspaceWrite` — the endpoint and write floors have their own
 *    suites (`link-endpoint-visibility.pglite`, `dependency-links.test.ts`);
 *    an id in `h.hidden` is refused so the per-id refusal is driven.
 *  - `updateFocusSession` / `setTrackDirection` — the field patches have
 *    their own suites; captured so a blocker-only call is proven NEVER to
 *    reach them.
 *  - `recordDomainMutation` — the event spine's own connection.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
  perm: (async () => ({ granted: true })) as (
    opts: Record<string, unknown>
  ) => Promise<unknown>,
  permCalls: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  trackSets: [] as Array<Record<string, unknown>>,
  hidden: new Set<string>(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: (opts: Record<string, unknown>) => {
      h.permCalls.push(opts);
      return h.perm(opts);
    },
  };
});

vi.mock("../../hub-protocol/rest/link-endpoint-visibility.js", () => ({
  checkLinkEndpointsVisible: async (edge: { toId: string }) =>
    h.hidden.has(edge.toId)
      ? { status: 404 as const, error: "Entity not found" }
      : null,
  checkLinkEndpointVisible: async () => null,
}));

vi.mock("../../../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: async () => undefined,
}));

vi.mock("../../../utils/domain-mutation.js", () => ({
  recordDomainMutation: async () => null,
}));

vi.mock("../../../services/focus-sessions/update-session.js", async (orig) => {
  const actual =
    await orig<
      typeof import("../../../services/focus-sessions/update-session.js")
    >();
  return {
    ...actual,
    updateFocusSession: async (params: Record<string, unknown>) => {
      h.updates.push(params);
      return { status: "updated", session: { id: params.sessionId } };
    },
  };
});

vi.mock("../../../services/tracks/tracks-service.js", async (orig) => {
  const actual =
    await orig<typeof import("../../../services/tracks/tracks-service.js")>();
  return {
    ...actual,
    setTrackDirection: async (params: Record<string, unknown>) => {
      h.trackSets.push(params);
      return {
        status: "proposed",
        proposalId: "prop-track-1",
        proposalType: "track.update",
        message: "proposed",
        reviewUrl: "https://pod/open/x",
      };
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  links,
  proposals,
  projects,
  projectTracks,
} from "@synap/database";
import type { McpToolHandler } from "../handlers/shared.js";

const { sessionHandlers } = await import("../handlers/session.js");
const { trackHandlers } = await import("../handlers/track.js");

const USER = "user-1";
const AGENT = "agent-1";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function seedSession(user: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, agent_ids, metadata, created_at, updated_at, started_at)
     values ($1, $2, 'work', 'active', '[]'::jsonb, '{}', '{}'::jsonb, now(), now(), now())`,
    [id, user]
  );
  return id;
}

/** Every `blocked_by` edge out of a unit, as `<kind>:<id>`, sorted. */
const waitsOn = (fromType: string, fromId: string) =>
  q<{ to_type: string; to_id: string }>(
    `select to_type, to_id from links where link_type = 'blocked_by' and from_type = $1 and from_id = $2 order by to_type, to_id`,
    [fromType, fromId]
  ).then((r) => r.rows.map((x) => `${x.to_type}:${x.to_id}`));

async function call(
  tool: "synap_update_session" | "synap_update_track",
  args: Record<string, unknown>,
  agentUserId?: string
): Promise<Record<string, unknown>> {
  const handlers =
    tool === "synap_update_session" ? sessionHandlers : trackHandlers;
  const res = await (handlers as Record<string, McpToolHandler>)[tool]!({
    toolName: tool,
    args,
    userId: USER,
    agentUserId,
    apiKeyScopes: ["mcp.read", "mcp.write"],
  } as never);
  const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
  return JSON.parse(text) as Record<string, unknown>;
}

beforeAll(async () => {
  // `projects` / `project_tracks`: the door reads a goal end's home space.
  for (const t of [focusSessions, links, proposals, projects, projectTracks]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  // `insertDependencyEdge`'s ON CONFLICT target needs its unique index.
  await h.client!.exec(
    `create unique index idx_links_unique_edge on links (from_type, from_id, to_type, to_id, link_type);`
  );
}, 120_000);

afterAll(async () => {
  await h.client?.close();
});

beforeEach(async () => {
  await h.client!.exec(
    "delete from focus_sessions; delete from links; delete from proposals;"
  );
  h.permCalls.length = 0;
  h.updates.length = 0;
  h.trackSets.length = 0;
  h.hidden.clear();
  h.perm = async () => ({ granted: true });
});

describe("synap_update_session — a step waits on a decision or a goal", () => {
  it("adds session → entity and session → goal edges beside a session blocker, each reported per id; nothing else is touched", async () => {
    const work = await seedSession(USER);
    const prereq = await seedSession(USER);
    const decision = randomUUID();
    const goal = randomUUID();
    const out = await call("synap_update_session", {
      sessionId: work,
      addBlockedBySessionIds: [prereq],
      addBlockedByEntityIds: [decision],
      addBlockedByTrackIds: [goal],
    });
    expect(out.blockerLinks).toEqual([
      { blockerSessionId: prereq, status: "linked", inserted: 1 },
      { blockerEntityId: decision, status: "linked", inserted: 1 },
      { blockerTrackId: goal, status: "linked", inserted: 1 },
    ]);
    expect(await waitsOn("session", work)).toEqual(
      [`entity:${decision}`, `session:${prereq}`, `track:${goal}`].sort()
    );
    expect(h.updates).toHaveLength(0);
  });

  it("a refused id is reported `failed` with its reason while the other lands", async () => {
    const work = await seedSession(USER);
    const seen = randomUUID();
    const hidden = randomUUID();
    h.hidden.add(hidden);
    const out = await call("synap_update_session", {
      sessionId: work,
      addBlockedByEntityIds: [seen, hidden],
    });
    expect(out.blockerLinks).toEqual([
      { blockerEntityId: seen, status: "linked", inserted: 1 },
      {
        blockerEntityId: hidden,
        status: "failed",
        reason: "not_found",
        message: "Entity not found",
      },
    ]);
    expect(await waitsOn("session", work)).toEqual([`entity:${seen}`]);
  });

  it("re-plans: removes a decision blocker (`removed`, then `absent`) and a goal blocker", async () => {
    const work = await seedSession(USER);
    const decision = randomUUID();
    const goal = randomUUID();
    await call("synap_update_session", {
      sessionId: work,
      addBlockedByEntityIds: [decision],
      addBlockedByTrackIds: [goal],
    });
    const first = await call("synap_update_session", {
      sessionId: work,
      removeBlockedByEntityIds: [decision],
      removeBlockedByTrackIds: [goal],
    });
    expect(first.blockerRemovals).toEqual([
      { blockerEntityId: decision, status: "removed" },
      { blockerTrackId: goal, status: "removed" },
    ]);
    expect(await waitsOn("session", work)).toEqual([]);
    const again = await call("synap_update_session", {
      sessionId: work,
      removeBlockedByEntityIds: [decision],
    });
    expect(again.blockerRemovals).toEqual([
      { blockerEntityId: decision, status: "absent" },
    ]);
  });

  it("an AGENT's cross-kind edge is judged as link/create and may be proposed; nothing is written", async () => {
    const work = await seedSession(USER);
    const decision = randomUUID();
    h.perm = async () => ({ granted: false, proposalId: "prop-1" });
    const out = await call(
      "synap_update_session",
      { sessionId: work, addBlockedByEntityIds: [decision] },
      AGENT
    );
    expect(out.blockerLinks).toEqual([
      { blockerEntityId: decision, status: "proposed", proposalId: "prop-1" },
    ]);
    expect(await waitsOn("session", work)).toEqual([]);
    expect(h.permCalls).toHaveLength(1);
    expect(h.permCalls[0]).toMatchObject({
      subjectType: "link",
      action: "create",
      agentUserId: AGENT,
      data: {
        fromType: "session",
        fromId: work,
        toType: "entity",
        toId: decision,
        linkType: "blocked_by",
      },
    });
  });

  it("refuses a malformed or contradictory list whole — NOTHING WAS CHANGED", async () => {
    const work = await seedSession(USER);
    const decision = randomUUID();
    expect(
      await call("synap_update_session", {
        sessionId: work,
        addBlockedByEntityIds: ["not-a-uuid"],
      })
    ).toMatchObject({ error: expect.stringMatching(/NOTHING WAS CHANGED/) });
    expect(
      await call("synap_update_session", {
        sessionId: work,
        addBlockedByEntityIds: [decision],
        removeBlockedByEntityIds: [decision],
      })
    ).toMatchObject({ error: expect.stringMatching(/in both/) });
    expect(await waitsOn("session", work)).toEqual([]);
  });
});

describe("synap_update_track — a goal waits on a goal", () => {
  it("adds goal → goal, refuses the edge that would close a cycle, and never reaches the field patch", async () => {
    const g1 = randomUUID();
    const g2 = randomUUID();
    const first = await call("synap_update_track", {
      trackId: g1,
      addBlockedByTrackIds: [g2],
    });
    expect(first).toEqual({
      trackId: g1,
      blockerLinks: [{ blockerTrackId: g2, status: "linked", inserted: 1 }],
    });
    expect(await waitsOn("track", g1)).toEqual([`track:${g2}`]);

    const cycle = await call("synap_update_track", {
      trackId: g2,
      addBlockedByTrackIds: [g1],
    });
    expect(cycle.blockerLinks).toEqual([
      expect.objectContaining({
        blockerTrackId: g1,
        status: "failed",
        reason: "cycle",
      }),
    ]);
    expect(await waitsOn("track", g2)).toEqual([]);
    expect(h.trackSets).toHaveLength(0);
  });

  it("removes it again, and a field edit in the same call still goes to the field door", async () => {
    const g1 = randomUUID();
    const g2 = randomUUID();
    await call("synap_update_track", {
      trackId: g1,
      addBlockedByTrackIds: [g2],
    });
    const out = await call("synap_update_track", {
      trackId: g1,
      direction: "Fund the seed round",
      removeBlockedByTrackIds: [g2],
    });
    expect(h.trackSets).toEqual([
      expect.objectContaining({
        trackId: g1,
        direction: "Fund the seed round",
      }),
    ]);
    expect(out).toMatchObject({
      status: "proposed",
      blockerRemovals: [{ blockerTrackId: g2, status: "removed" }],
    });
    expect(await waitsOn("track", g1)).toEqual([]);
  });

  it("CONTROL: with nothing to change it is refused, and nothing is written", async () => {
    expect(
      await call("synap_update_track", { trackId: randomUUID() })
    ).toMatchObject({ error: expect.stringMatching(/something to change/) });
    expect(h.permCalls).toHaveLength(0);
  });
});
