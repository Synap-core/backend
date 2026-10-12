/**
 * STAGE WORKER runs through the real spine (`runPlaybook`) on PGlite (work
 * model L4). The set read is REAL (`listThingsInStatus`, the board's own base
 * set, on SQL); the session row and its target edges are counted as ROWS,
 * never inferred from the return value.
 *
 *  - per_moment: N things in the status → ONE session, no subject, N
 *    `worker_target` edges with no result; things already in flight are not
 *    taken again; 0 things → no session row; a `count` under its threshold
 *    (things not in flight) → `below_threshold`, no session.
 *  - the gate: backlog AT max → `approvals_backlog` (max − 1 proceeds — the
 *    row that rules out `>`); today's irreversible sends at the ceiling →
 *    `volume_ceiling`; a per_thing subject that left the status →
 *    `stale_transition`.
 *
 * Mocked, each proven elsewhere: the three enablement counts (their SQL:
 * `@synap/database` `worker-enablement.pglite.test.ts`), the playbook
 * resolver, and `notifySessionNeedsYou` — which runs right after the target
 * edges are written and throws a sentinel, so "a batch was born" is observed.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 180_000 });

const BORN = "WORKER_TEST: the batch session was born";
const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  pending: 0,
  sends: 0,
  inFlight: [] as string[],
  subjectProfile: { profileSlug: "deal" } as Record<string, unknown>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, {
    schema: {
      entities: actual.entities as never,
      entityFacets: actual.entityFacets as never,
      profiles: actual.profiles as never,
      workspaces: actual.workspaces as never,
      workspaceMembers: actual.workspaceMembers as never,
      focusSessions: actual.focusSessions as never,
    },
  });
  const mocked = {
    ...actual,
    getDb: async () => db,
    countWorkerPendingApprovals: vi.fn(async () => h.pending),
    countWorkerIrreversibleSendsToday: vi.fn(async () => h.sends),
    listWorkerTargetsInFlight: vi.fn(async () => h.inFlight),
  };
  Object.defineProperty(mocked, "db", { get: () => db, enumerable: true });
  return mocked;
});

vi.mock("../playbook-lifecycle.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../playbook-lifecycle.js")>();
  return {
    ...actual,
    resolveRunnablePlaybook: vi.fn(async () => ({
      id: PLAYBOOK,
      name: "Review deals",
      metadata: {},
      inputStrategy: null,
      goalTemplate: "Review them",
      subjectProfile: h.subjectProfile,
    })),
    instantiateSession: vi.fn(
      async (i: { subjectId?: string | null; metadata?: unknown }) => {
        const id = randomUUID();
        await h.client!.query(
          `insert into focus_sessions (id, user_id, goal, status, playbook_id, subject_entity_id, metadata)
           values ($1, $2, 'g', 'active', $3, $4, $5::jsonb)`,
          [
            id,
            USER,
            PLAYBOOK,
            i.subjectId ?? null,
            JSON.stringify(i.metadata ?? {}),
          ]
        );
        return { id, workspaceId: WS, expectedOutputs: [] };
      }
    ),
  };
});
vi.mock("../../focus-sessions/notify-needs-you.js", () => ({
  notifySessionNeedsYou: vi.fn(async () => {
    throw new Error(BORN);
  }),
}));

import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  entities,
  relations,
  entityFacets,
  events,
  links,
  workspaces,
  workspaceMembers,
  projectMembers,
  podMembers,
  users,
  profiles,
  profileWorkspaceAccess,
  focusSessions,
  profileProperties,
  propertyDefs,
} from "@synap/database";
import { runPlaybook } from "../run-playbook.js";

const USER = "user-1";
const WS = "44444444-4444-4444-8444-444444444444";
const DEAL = "11111111-1111-4111-8111-111111111111";
const PLAYBOOK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AUTOMATION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  for (const t of [
    entities,
    relations,
    entityFacets,
    events,
    links,
    workspaces,
    workspaceMembers,
    projectMembers,
    podMembers,
    users,
    profiles,
    profileWorkspaceAccess,
    focusSessions,
    profileProperties,
    propertyDefs,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  // The real unique edge (`idx_links_unique_edge`) — createLinks upserts on it.
  await h.client!.exec(
    `create unique index on links (from_type, from_id, to_type, to_id, link_type)`
  );
  await q(`insert into users (id, email) values ($1, 'u@example.test')`, [
    USER,
  ]);
  await q(
    `insert into workspaces (id, name, owner_id) values ($1, 'Sales', $2)`,
    [WS, USER]
  );
  await q(
    `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`,
    [WS, USER]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values ($1, 'deal', 'Deal', 'kind', 'workspace')`,
    [DEAL]
  );
});

beforeEach(async () => {
  await h.client!.exec(
    "delete from entities; delete from focus_sessions; delete from links;"
  );
  h.pending = 0;
  h.sends = 0;
  h.inFlight = [];
  h.subjectProfile = { profileSlug: "deal" };
  await h.client!.exec(
    "delete from profile_properties; delete from property_defs;"
  );
});

/** Declare `property` as the deal kind's lifecycle (the column is the truth). */
async function declareLifecycle(property: string): Promise<void> {
  const def = randomUUID();
  await q(
    `insert into property_defs (id, slug, value_type, constraints)
     values ($1, $2, 'string', $3::jsonb)`,
    [
      def,
      property,
      JSON.stringify({
        enumOptions: [
          { key: "draft", category: "open" },
          { key: "review", category: "active" },
        ],
      }),
    ]
  );
  await q(
    `insert into profile_properties (profile_id, property_def_id, is_lifecycle)
     values ($1, $2, true)`,
    [DEAL, def]
  );
}

async function deal(
  status: string | null,
  properties: Record<string, unknown> = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, workspace_id, type, profile_id, title, status, properties)
     values ($1, $2, $3, 'deal', $4, $5, $6, $7::jsonb)`,
    [
      id,
      USER,
      WS,
      DEAL,
      `Deal ${id.slice(0, 4)}`,
      status,
      JSON.stringify(properties),
    ]
  );
  return id;
}

const worker = (o: Record<string, unknown> = {}) => ({
  key: "count:review",
  size: "per_moment" as const,
  profileSlug: "deal",
  status: "review",
  automationId: AUTOMATION,
  ...o,
});
const fire = (
  w: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) =>
  runPlaybook({
    playbookId: PLAYBOOK,
    workspaceId: WS,
    userId: USER,
    worker: w,
    ...extra,
  } as never).then(
    (r) => ({ skipped: r.skipped ?? null }),
    (e: Error) => ({ error: e.message })
  );

async function sessions() {
  return (
    await q<{
      id: string;
      subject_entity_id: string | null;
      metadata: unknown;
    }>(`select id, subject_entity_id, metadata from focus_sessions`)
  ).rows;
}
async function targetEdges() {
  return (
    await q<{
      from_id: string;
      to_id: string;
      metadata: Record<string, unknown>;
    }>(
      `select from_id, to_id, metadata from links where link_type = 'targets' and to_type = 'entity'`
    )
  ).rows;
}

describe("per_moment — ONE session over the things in the status", () => {
  it("N things → one subject-less session + N worker_target edges, no result", async () => {
    const a = await deal("review");
    const b = await deal("review");
    await deal("draft");
    expect(await fire(worker())).toEqual({ error: BORN });
    const rows = await sessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subject_entity_id).toBeNull();
    expect(rows[0]!.metadata).toMatchObject({
      // profileSlug: the lifecycle process-sync settles targets on (F10).
      worker: { key: "count:review", size: "per_moment", profileSlug: "deal" },
    });
    const edges = await targetEdges();
    expect(edges.map((e) => e.to_id).sort()).toEqual([a, b].sort());
    for (const e of edges) {
      expect(e.from_id).toBe(rows[0]!.id);
      expect(e.metadata).toEqual({ role: "worker_target" });
    }
  });

  it("things already in flight for this enablement are not taken again", async () => {
    const a = await deal("review");
    const b = await deal("review");
    h.inFlight = [a];
    expect(await fire(worker())).toEqual({ error: BORN });
    expect((await targetEdges()).map((e) => e.to_id)).toEqual([b]);
  });

  it("0 things → no session, no edge (a quiet moment)", async () => {
    await deal("draft");
    expect(await fire(worker())).toEqual({ skipped: "no-subject" });
    expect(await sessions()).toHaveLength(0);
    expect(await targetEdges()).toHaveLength(0);
  });

  it("a count under its threshold → below_threshold, no session; at it → born", async () => {
    await deal("review");
    await deal("review");
    expect(await fire(worker({ minCount: 3 }))).toEqual({
      skipped: "below_threshold",
    });
    expect(await sessions()).toHaveLength(0);
    await deal("review");
    expect(await fire(worker({ minCount: 3 }))).toEqual({ error: BORN });
    expect(await sessions()).toHaveLength(1);
  });

  /**
   * backend F11: a count above its threshold must not start a session over
   * each later entry. The threshold counts things NOT in flight. Rows rule
   * out: counting the in-flight things (1 fresh would run); subtracting every
   * in-flight id, including one that already LEFT the status (2 fresh would
   * read as 1 and never run).
   */
  it("a count's threshold counts the things not already being worked", async () => {
    const a = await deal("review");
    const b = await deal("review");
    await deal("review");
    const gone = await deal("draft");
    h.inFlight = [a, b, gone];
    expect(await fire(worker({ minCount: 2 }))).toEqual({
      skipped: "below_threshold",
    });
    expect(await sessions()).toHaveLength(0);
    await deal("review");
    expect(await fire(worker({ minCount: 2 }))).toEqual({ error: BORN });
  });
});

describe("the gate — before any session exists", () => {
  it("backlog AT max → approvals_backlog; one under proceeds", async () => {
    await deal("review");
    h.pending = 5;
    expect(await fire(worker({ maxPendingApprovals: 5 }))).toEqual({
      skipped: "approvals_backlog",
    });
    expect(await sessions()).toHaveLength(0);
    h.pending = 4;
    expect(await fire(worker({ maxPendingApprovals: 5 }))).toEqual({
      error: BORN,
    });
  });

  it("today's irreversible sends at the ceiling → volume_ceiling", async () => {
    await deal("review");
    h.sends = 50;
    expect(await fire(worker())).toEqual({ skipped: "volume_ceiling" });
    expect(await sessions()).toHaveLength(0);
  });

  it("per_thing: a subject that left the status → stale_transition", async () => {
    await declareLifecycle("stage");
    const moved = await deal("draft");
    expect(
      await fire(worker({ size: "per_thing", key: "enters_status:review" }), {
        subjectId: moved,
      })
    ).toEqual({ skipped: "stale_transition" });
    expect(await sessions()).toHaveLength(0);
  });
});

/**
 * arch F4: a kind with NO declared lifecycle has a NULL status column. The
 * stale check reads the playbook's `statusProperty` on the thing instead —
 * reading the column skipped every fire of such a worker for good.
 */
describe("per_thing stale check on a kind with no declared lifecycle", () => {
  const perThing = worker({ size: "per_thing", key: "enters_status:review" });

  it("still in the status (in properties, column NULL) → the run goes on", async () => {
    h.subjectProfile = { profileSlug: "deal", statusProperty: "stage" };
    const still = await deal(null, { stage: "review" });
    const r = await fire(perThing, { subjectId: still });
    expect(r).not.toEqual({ skipped: "stale_transition" });
  });

  it("moved on in properties → stale_transition", async () => {
    h.subjectProfile = { profileSlug: "deal", statusProperty: "stage" };
    const moved = await deal(null, { stage: "draft" });
    expect(await fire(perThing, { subjectId: moved })).toEqual({
      skipped: "stale_transition",
    });
  });

  it("no statusProperty to read → passes", async () => {
    const thing = await deal(null, {});
    const r = await fire(perThing, { subjectId: thing });
    expect(r).not.toEqual({ skipped: "stale_transition" });
  });
});
