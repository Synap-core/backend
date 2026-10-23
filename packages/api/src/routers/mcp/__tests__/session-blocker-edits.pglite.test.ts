/**
 * `synap_update_session` `addBlockedBySessionIds` / `removeBlockedBySessionIds`
 * — an agent declares MID-FLIGHT "this session now waits on that one", and
 * undoes it (how it re-plans when a blocker was dropped). Reachability, not
 * shape: the REAL handler, the REAL dependency doors (owner floor, cycle walk,
 * governed delete) and the edges read back from PGlite.
 *
 * Real: `sessionHandlers.synap_update_session`, `addCreateTimeBlockers` →
 * `validateSessionBlocker` (owner floor + `closesDependencyCycle`) →
 * `addSessionBlocker`, `removeSessionBlockers` → `governedRemoveDependencyLink`
 * (session read floor + write floor). Tables are generated from the Drizzle
 * definitions.
 *
 * Stubbed, and why:
 *  - `checkPermissionOrPropose` — the governance membrane is its own suite;
 *    here it grants or proposes on demand so both paths are reachable, and
 *    every call is captured so the FILING is asserted (link/create|delete, in
 *    the blocked session's workspace, the agent attributed).
 *  - `updateFocusSession` — the field patch has its own suites; captured so a
 *    blocker-only call is proven NEVER to reach the update membrane.
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

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions, links, proposals } from "@synap/database";

const { sessionHandlers } = await import("../handlers/session.js");

const USER = "user-1";
const OTHER = "user-2";
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

async function seedSession(
  user: string,
  projectId: string | null = null
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, project_id, expected_outputs, agent_ids, metadata, created_at, updated_at, started_at)
     values ($1, $2, 'work', 'active', $3, '[]'::jsonb, '{}', '{}'::jsonb, now(), now(), now())`,
    [id, user, projectId]
  );
  return id;
}

const blockersOf = (sessionId: string) =>
  q<{ to_id: string }>(
    `select to_id from links where link_type = 'blocked_by' and from_type = 'session' and from_id = $1 order by to_id`,
    [sessionId]
  ).then((r) => r.rows.map((x) => x.to_id));

async function call(
  args: Record<string, unknown>,
  agentUserId?: string
): Promise<Record<string, unknown>> {
  const res = await sessionHandlers.synap_update_session!({
    toolName: "synap_update_session",
    args,
    userId: USER,
    agentUserId,
    apiKeyScopes: ["mcp.read", "mcp.write"],
  } as never);
  const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
  return JSON.parse(text) as Record<string, unknown>;
}

describe("synap_update_session — blockers on a running session", () => {
  beforeAll(async () => {
    for (const t of [focusSessions, links, proposals]) {
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
    h.perm = async () => ({ granted: true });
  });

  it("adds a blocker mid-flight: the edge exists, reported `linked`, and nothing else is touched", async () => {
    const work = await seedSession(USER);
    const prereq = await seedSession(USER);
    const out = await call({
      sessionId: work,
      addBlockedBySessionIds: [prereq],
    });
    expect(out.blockerLinks).toEqual([
      { blockerSessionId: prereq, status: "linked", inserted: 1 },
    ]);
    expect(await blockersOf(work)).toEqual([prereq]);
    // A blocker-only call never reaches the update membrane.
    expect(h.updates).toHaveLength(0);
  });

  it("refuses a blocker that is not the caller's, per id, while the owned one lands", async () => {
    const work = await seedSession(USER);
    const mine = await seedSession(USER);
    const theirs = await seedSession(OTHER);
    const out = await call({
      sessionId: work,
      addBlockedBySessionIds: [mine, theirs],
    });
    expect(out.blockerLinks).toEqual([
      { blockerSessionId: mine, status: "linked", inserted: 1 },
      { blockerSessionId: theirs, status: "failed", reason: "not_found" },
    ]);
    expect(await blockersOf(work)).toEqual([mine]);
  });

  it("refuses an edge that would close a CYCLE — directly or through another session — and writes nothing", async () => {
    const a = await seedSession(USER);
    const b = await seedSession(USER);
    const c = await seedSession(USER);
    // b waits on c, c waits on a.
    await call({ sessionId: b, addBlockedBySessionIds: [c] });
    await call({ sessionId: c, addBlockedBySessionIds: [a] });
    const out = await call({ sessionId: a, addBlockedBySessionIds: [b] });
    expect(out.blockerLinks).toEqual([
      { blockerSessionId: b, status: "failed", reason: "cycle" },
    ]);
    expect(await blockersOf(a)).toEqual([]);
  });

  it("removes a blocker (re-plan): `removed`, the edge is gone; again: `absent`, never a pretend removal", async () => {
    const work = await seedSession(USER);
    const dropped = await seedSession(USER);
    await call({ sessionId: work, addBlockedBySessionIds: [dropped] });
    const first = await call({
      sessionId: work,
      removeBlockedBySessionIds: [dropped],
    });
    expect(first.blockerRemovals).toEqual([
      { blockerSessionId: dropped, status: "removed" },
    ]);
    expect(await blockersOf(work)).toEqual([]);
    const again = await call({
      sessionId: work,
      removeBlockedBySessionIds: [dropped],
    });
    expect(again.blockerRemovals).toEqual([
      { blockerSessionId: dropped, status: "absent" },
    ]);
  });

  it("re-plans onto a retry in ONE call: removes the dropped blocker and adds the new one", async () => {
    const work = await seedSession(USER);
    const dropped = await seedSession(USER);
    const retry = await seedSession(USER);
    await call({ sessionId: work, addBlockedBySessionIds: [dropped] });
    const out = await call({
      sessionId: work,
      addBlockedBySessionIds: [retry],
      removeBlockedBySessionIds: [dropped],
    });
    expect(out.blockerLinks).toMatchObject([{ status: "linked" }]);
    expect(out.blockerRemovals).toEqual([
      { blockerSessionId: dropped, status: "removed" },
    ]);
    expect(await blockersOf(work)).toEqual([retry]);
  });

  it("an AGENT's add and remove go through governance: deferred ⇒ `proposed`, nothing written or removed", async () => {
    const work = await seedSession(USER);
    const kept = await seedSession(USER);
    const prereq = await seedSession(USER);
    await call({ sessionId: work, addBlockedBySessionIds: [kept] });
    h.permCalls.length = 0;
    h.perm = async () => ({ granted: false, proposalId: "prop-1" });
    const out = await call(
      {
        sessionId: work,
        addBlockedBySessionIds: [prereq],
        removeBlockedBySessionIds: [kept],
      },
      AGENT
    );
    expect(out.blockerLinks).toEqual([
      { blockerSessionId: prereq, status: "proposed", proposalId: "prop-1" },
    ]);
    expect(out.blockerRemovals).toEqual([
      { blockerSessionId: kept, status: "proposed", proposalId: "prop-1" },
    ]);
    expect(await blockersOf(work)).toEqual([kept]);
    expect(
      h.permCalls.map((c) => [c.subjectType, c.action, c.agentUserId])
    ).toEqual([
      ["link", "create", AGENT],
      ["link", "delete", AGENT],
    ]);
    expect(h.permCalls[1]!.data).toMatchObject({
      fromType: "session",
      fromId: work,
      toType: "session",
      toId: kept,
      linkType: "blocked_by",
    });
  });

  it("the URL lens's `projectId` (equal to the session's own) is not a field update; a different one is", async () => {
    const project = randomUUID();
    const work = await seedSession(USER, project);
    const prereq = await seedSession(USER);
    await call({
      sessionId: work,
      projectId: project,
      workspaceId: randomUUID(),
      addBlockedBySessionIds: [prereq],
    });
    expect(h.updates).toHaveLength(0);
    const other = randomUUID();
    const out = await call({
      sessionId: work,
      projectId: other,
      removeBlockedBySessionIds: [prereq],
    });
    expect(h.updates).toEqual([
      expect.objectContaining({ sessionId: work, projectId: other }),
    ]);
    expect(out).toMatchObject({
      status: "updated",
      blockerRemovals: [{ blockerSessionId: prereq, status: "removed" }],
    });
  });

  it("refuses malformed or contradictory lists whole — NOTHING WAS CHANGED", async () => {
    const work = await seedSession(USER);
    const prereq = await seedSession(USER);
    expect(
      await call({ sessionId: work, addBlockedBySessionIds: ["not-a-uuid"] })
    ).toMatchObject({ error: expect.stringMatching(/NOTHING WAS CHANGED/) });
    expect(
      await call({
        sessionId: work,
        addBlockedBySessionIds: [prereq],
        removeBlockedBySessionIds: [prereq],
      })
    ).toMatchObject({ error: expect.stringMatching(/in both/) });
    expect(await blockersOf(work)).toEqual([]);
  });

  it("a session that is not the caller's is not found, and nothing is written", async () => {
    const theirs = await seedSession(OTHER);
    const prereq = await seedSession(OTHER);
    expect(
      await call({ sessionId: theirs, addBlockedBySessionIds: [prereq] })
    ).toMatchObject({ error: expect.stringMatching(/not found/) });
    expect(await blockersOf(theirs)).toEqual([]);
  });
});
