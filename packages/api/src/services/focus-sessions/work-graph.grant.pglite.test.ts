/**
 * The work graph for a key NARROWED by its grant (Operations view, founder
 * decision D1, 17 Nov 2026) — the REAL `buildWorkGraph` on PGlite, the grant
 * set as the key-auth doors set it (`runWithGrant`), the reach the REST door
 * computes (`workGraphReach`).
 *
 * Rows rule out: a floor that ignores the grant (the space-B sessions, in the
 * window and at the far end of an edge), an omission said nowhere (the count),
 * an edge drawn to a session the key does not read, and a part read past the
 * grant served as if it were whole (each section said withheld). The control
 * (no grant) rules out a narrowing that also strips a person's graph.
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

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { runWithGrant } from "@synap/database";
import { buildWorkGraph, WORK_GRAPH_WITHHELD_REASON } from "./work-graph.js";
import { workGraphReach } from "../../access/grant-door-fence.js";

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

const USER = "user-ops";
const WS_A = randomUUID(); // the space the app was given
const WS_B = randomUUID(); // a space it was not
const PR_URL = "https://github.com/Synap-core/backend/pull/9";

const S = {
  root: randomUUID(), // in A; records PR #9
  child: randomUUID(), // in A; spawned from root, blocked by hidden
  hidden: randomUUID(), // in B: never returned to the app, counted
  hiddenToo: randomUUID(), // in B, unrelated
};

async function session(
  id: string,
  workspaceId: string,
  opts: { outputs?: unknown[]; title?: string } = {}
) {
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, workspace_id, expected_outputs, agent_ids, metadata, started_at, created_at, updated_at)
     values ($1, $2, 'g', $3, 'active', $4, $5::jsonb, '{}', '{}'::jsonb, now(), now(), now())`,
    [
      id,
      USER,
      opts.title ?? "s",
      workspaceId,
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

/** A pod app: a session read pinned to space A (every app's grant is pinned). */
const APP = (...extra: string[]) =>
  ({
    scopes: [{ permissions: ["session.read", ...extra], workspaceIds: [WS_A] }],
    clientId: null,
  }) as never;

const graph = (grant?: never) => {
  const build = () =>
    buildWorkGraph({
      userId: USER,
      scope: { workspaceLens: undefined, projectLens: undefined },
      windowHours: 72,
      kind: "all",
      lens: "all",
      roster: false,
      reach: workGraphReach(grant ?? null),
    });
  return grant ? runWithGrant(grant, build) : build();
};

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable => is(v, PgTable)
  );
  for (const t of tables) await h.client!.exec(ddlFor(t));
  await session(S.root, WS_A, {
    title: "Wave root",
    outputs: [
      {
        key: "pr-backend-9",
        kind: "pull_request",
        label: "backend#9",
        status: "pending",
        ref: { url: PR_URL },
      },
    ],
  });
  await session(S.child, WS_A);
  await session(S.hidden, WS_B, { title: "Hidden in B" });
  await session(S.hiddenToo, WS_B, { title: "Also hidden" });
  await link(S.child, S.root, "spawned_from");
  await link(S.child, S.hidden, "blocked_by");
});

describe("the work graph for a key narrowed by its grant (a pod app, D1)", () => {
  it("returns the sessions its grant reads and counts the ones it does not", async () => {
    const g = await graph(APP());
    expect(g.nodes.map((n) => n.id).sort()).toEqual([S.child, S.root].sort());
    // The two sessions in B, each counted once (one is also the far end of
    // an edge: it is not counted twice).
    expect(g.window.omittedByGrant).toBe(2);
    expect(g.window.omitted).toBe(2);
    expect(g.window.truncated).toBe(true);
    expect(JSON.stringify(g)).not.toContain("Hidden in B");
    expect(JSON.stringify(g)).not.toContain(S.hidden);
  });

  it("draws the edges between two sessions it reads, never one to a session it does not", async () => {
    const g = await graph(APP());
    expect(g.edges).toEqual([
      { kind: "spawned_from", from: S.child, to: S.root },
    ]);
  });

  it("withholds every part that reads past its grant, and says so", async () => {
    const g = await graph(APP());
    const withheld = { status: "unavailable", reason: WORK_GRAPH_WITHHELD_REASON };
    expect(g.sections.waitsOnOutputs).toEqual(withheld);
    expect(g.sections.interactions).toEqual(withheld);
    expect(g.sections.pullRequests).toEqual(withheld);
    expect(g.sections.goals).toEqual(withheld);
    expect(g.sections.blockedBy).toEqual({ status: "ok" });
    for (const n of g.nodes) {
      expect(n.nextMove).toMatchObject({ kind: "unknown", actor: "none" });
      expect(n.unitFacts.owedFromYou).toBeNull();
      expect(n.unitFacts.pendingDecisions).toBeNull();
      expect(n.holder).toEqual(withheld);
    }
    // The PR the root recorded is listed, with no recorded facts.
    expect(g.pullRequests).toHaveLength(1);
    expect(g.pullRequests[0]).toMatchObject({ url: PR_URL });
    expect(g.pullRequests[0]!.prState).toBeUndefined();
  });

  it("reads the holder when the key reads the person's agents", async () => {
    const g = await graph(APP("agent.read"));
    for (const n of g.nodes) expect(n.holder.status).toBe("ok");
  });

  it("CONTROL: the person reads the whole graph, nothing omitted by a grant", async () => {
    const g = await graph();
    expect(g.nodes.map((n) => n.id).sort()).toEqual(
      [S.child, S.root, S.hidden, S.hiddenToo].sort()
    );
    expect(g.window.omittedByGrant).toBe(0);
    expect(g.edges).toEqual(
      expect.arrayContaining([
        { kind: "spawned_from", from: S.child, to: S.root },
        { kind: "blocked_by", from: S.child, to: S.hidden },
      ])
    );
    expect(g.sections.interactions).toEqual({ status: "ok" });
    expect(g.sections.pullRequests).toEqual({ status: "ok" });
  });
});
