/**
 * `lifecycle.board` / `lifecycle.get` against real SQL (PGlite), work model L3:
 *  - a KIND groups by `entities.status`, options in declared order;
 *  - a ROLE groups by `entity_facets.status`, and its time in column reads
 *    the ROLE's transitions only (a kind move on the same entity is not it);
 *  - done/lost count only what entered within the window; `total` does not;
 *  - a value no option declares (and no status at all) lands in ONE explicit
 *    `__unclassified` column — never dropped;
 *  - W17: below ~10 live things / no worker → `list`;
 *  - the shared grouping still answers `entities.groupByFacetStatus`;
 *  - no declared lifecycle / unknown slug THROW (never empty columns).
 * Only `getEffectiveLifecycle` is stubbed (its own suites prove it).
 */
import { describe, it, expect, vi } from "vitest";

// PGlite under a loaded machine: each case builds a fresh database.
vi.setConfig({ testTimeout: 120_000 });
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));

const DEAL = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const NOTE = "33333333-3333-4333-8333-333333333333";

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    getDb: async () => holder.db,
    ProfileResolutionService: class extends (actual.ProfileResolutionService as new (
      db: unknown
    ) => object) {
      async getEffectiveLifecycle(profileId: string) {
        if (profileId === DEAL)
          return {
            propertySlug: "commercialStage",
            options: [
              { key: "draft", category: "open" },
              { key: "negotiating", category: "active", label: "In talks" },
              { key: "won", category: "done" },
              { key: "lost", category: "lost" },
            ],
            unclassified: [],
          };
        if (profileId === CLIENT)
          return {
            propertySlug: "clientStatus",
            options: [
              { key: "onboarding", category: "active" },
              { key: "churned", category: "lost", humanOnly: true },
            ],
            unclassified: [],
          };
        return null;
      }
    },
  };
  // The backlog count reads the pod's own client (proven on SQL in
  // database `worker-enablement.pglite.test.ts`); zero here.
  (mocked as Record<string, unknown>).countWorkerPendingApprovals = async () =>
    0;
  (mocked as Record<string, unknown>).countWorkerPendingApprovalsBulk = async (
    ids: readonly string[]
  ) => new Map(ids.map((id) => [id, 0]));
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
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
  profileProperties,
  profileWorkspaceAccess,
  playbooks,
  skills,
  automations,
  type db as DatabaseHandle,
} from "@synap/database";

const USER = "user-1";
type Database = typeof DatabaseHandle;

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

async function freshDb() {
  const client = new PGlite();
  for (const table of [
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
    profileProperties,
    profileWorkspaceAccess,
    playbooks,
    skills,
    automations,
  ]) {
    await client.exec(ddlFor(table as unknown as PgTable));
  }
  await client.exec(
    `insert into users (id, email) values ('${USER}', '${USER}@example.test')`
  );
  await client.exec(
    `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values
      ('${DEAL}', 'deal', 'Deal', 'kind', 'workspace'),
      ('${CLIENT}', 'client', 'Client', 'role', 'workspace'),
      ('${NOTE}', 'note', 'Note', 'kind', 'workspace')`
  );
  // DEAL and CLIENT declare a lifecycle (the link the list's filter reads);
  // NOTE does not.
  await client.exec(
    `insert into profile_properties (profile_id, property_def_id, is_lifecycle) values
      ('${DEAL}', gen_random_uuid(), true),
      ('${CLIENT}', gen_random_uuid(), true)`
  );
  const database = drizzle(client, {
    schema: { entities, entityFacets, profiles, workspaces, workspaceMembers },
  }) as unknown as Database;
  holder.db = database;
  return client;
}

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

async function thing(
  client: PGlite,
  o: { status: string | null; title: string; createdDaysAgo: number }
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into entities (id, user_id, type, profile_id, title, status, created_at, properties)
     values ($1, $2, 'deal', $3, $4, $5, $6, '{}'::jsonb)`,
    [id, USER, DEAL, o.title, o.status, ago(o.createdDaysAgo)]
  );
  return id;
}
async function moved(
  client: PGlite,
  entityId: string,
  o: { to: string; daysAgo: number; role?: string | null }
) {
  await client.query(
    `insert into events (id, timestamp, type, subject_id, subject_type, data, user_id)
     values (gen_random_uuid(), $1, 'entity.transition.completed', $2, 'entity', $3::jsonb, $4)`,
    [
      ago(o.daysAgo),
      entityId,
      JSON.stringify({ to: o.to, role: o.role ?? null }),
      USER,
    ]
  );
}

async function lifecycleCaller() {
  const { lifecycleRouter } = await import("./lifecycle.js");
  return lifecycleRouter.createCaller({
    db: holder.db,
    authenticated: true,
    userId: USER,
    workspaceId: null,
  } as never);
}

describe("lifecycle.board — a kind", () => {
  it("columns in declared order, done/lost windowed, strays in one unclassified column", async () => {
    const client = await freshDb();
    const oldDraft = await thing(client, {
      status: "draft",
      title: "Old draft",
      createdDaysAgo: 20,
    });
    await thing(client, {
      status: "draft",
      title: "New draft",
      createdDaysAgo: 2,
    });
    const talks = await thing(client, {
      status: "negotiating",
      title: "Talks",
      createdDaysAgo: 40,
    });
    await moved(client, talks, { to: "negotiating", daysAgo: 3 });
    const wonRecent = await thing(client, {
      status: "won",
      title: "Won recently",
      createdDaysAgo: 50,
    });
    await moved(client, wonRecent, { to: "won", daysAgo: 5 });
    const wonOld = await thing(client, {
      status: "won",
      title: "Won long ago",
      createdDaysAgo: 200,
    });
    await moved(client, wonOld, { to: "won", daysAgo: 90 });
    await thing(client, {
      status: "weird",
      title: "Undeclared",
      createdDaysAgo: 1,
    });
    await thing(client, {
      status: null,
      title: "No status",
      createdDaysAgo: 1,
    });

    const caller = await lifecycleCaller();
    const board = await caller.board({ profileSlug: "deal" });

    expect(board.lifecycle).toMatchObject({
      profileSlug: "deal",
      profileKind: "kind",
      property: "commercialStage",
    });
    expect(
      board.lifecycle.options.map((o) => [o.key, o.label, o.tone])
    ).toEqual([
      ["draft", "Draft", "textSecondary"],
      ["negotiating", "In talks", "primary"],
      ["won", "Won", "success"],
      ["lost", "Lost", "error"],
    ]);
    expect(board.columns.map((c) => [c.key, c.count])).toEqual([
      ["draft", 2],
      ["negotiating", 1],
      ["won", 1], // the 90-day-old win is outside the 30-day window
      ["lost", 0],
      ["__unclassified", 2],
    ]);
    const unclassified = board.columns.find((c) => c.key === "__unclassified")!;
    expect(unclassified.items.map((i) => i.status).sort()).toEqual(
      ["weird", null].sort()
    );
    // Time in column: longest first; a move reads the transition, no move
    // reads creation and says so (enteredAt null).
    const draft = board.columns[0]!;
    expect(draft.items[0]!.id).toBe(oldDraft);
    expect(draft.items[0]!.enteredAt).toBeNull();
    expect(draft.items[0]!.facetId).toBeNull(); // a kind board has no facet
    expect(board.columns[1]!.items[0]!.enteredAt).not.toBeNull();
    expect(board.doneWindowed).toBe(1);
    expect(board.lostWindowed).toBe(0);
    expect(board.total).toBe(7); // unwindowed: the old win counts here
    expect(board.live).toBe(5);
    expect(board.hasWorker).toBe(false);
    expect(board.suggestedShape).toBe("list");
  });

  it("a wider window brings the old win back", async () => {
    const client = await freshDb();
    const wonOld = await thing(client, {
      status: "won",
      title: "Won long ago",
      createdDaysAgo: 200,
    });
    await moved(client, wonOld, { to: "won", daysAgo: 90 });
    const caller = await lifecycleCaller();
    const board = await caller.board({
      profileSlug: "deal",
      window: { days: 120 },
    });
    expect(board.doneWindowed).toBe(1);
  });

  it("no declared lifecycle and an unknown slug THROW — never empty columns", async () => {
    await freshDb();
    const caller = await lifecycleCaller();
    await expect(caller.board({ profileSlug: "note" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await expect(caller.board({ profileSlug: "nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("lifecycle.get returns the declaration with words and marks resolved", async () => {
    await freshDb();
    const caller = await lifecycleCaller();
    const l = await caller.get({ profileSlug: "client" });
    expect(l).toMatchObject({ profileKind: "role", property: "clientStatus" });
    expect(l.options[1]).toMatchObject({
      key: "churned",
      category: "lost",
      humanOnly: true,
    });
  });
});

describe("lifecycle.board — a role", () => {
  it("groups by the FACET status; time in column reads the role's moves only", async () => {
    const client = await freshDb();
    const a = await thing(client, {
      status: "won",
      title: "Acme",
      createdDaysAgo: 30,
    });
    const b = await thing(client, {
      status: "draft",
      title: "Beta",
      createdDaysAgo: 30,
    });
    for (const [entityId, status] of [
      [a, "onboarding"],
      [b, "onboarding"],
    ] as const) {
      await client.query(
        `insert into entity_facets (id, entity_id, profile_id, user_id, status, created_at)
         values (gen_random_uuid(), $1, $2, $3, $4, $5)`,
        [entityId, CLIENT, USER, status, ago(10)]
      );
    }
    // A KIND move on Acme is not the role's move; Beta's role move is.
    await moved(client, a, { to: "won", daysAgo: 1 });
    await moved(client, b, { to: "onboarding", daysAgo: 2, role: "client" });

    const caller = await lifecycleCaller();
    const board = await caller.board({ profileSlug: "client" });
    const onboarding = board.columns.find((c) => c.key === "onboarding")!;
    expect(onboarding.count).toBe(2);
    const byId = new Map(onboarding.items.map((i) => [i.id, i]));
    expect(byId.get(a)!.enteredAt).toBeNull();
    expect(byId.get(b)!.enteredAt).not.toBeNull();
    // A role board names each thing's FACET: the row a role move targets.
    for (const item of onboarding.items) {
      expect(item.facetId).toMatch(/^[0-9a-f-]{36}$/);
    }
    // Longest in column first: Acme since the facet (10d), Beta since 2d.
    expect(onboarding.items[0]!.id).toBe(a);

    // The shared grouping still answers the kanban primitive, newest first.
    const { entitiesRouter } = await import("./entities.js");
    const entitiesCaller = entitiesRouter.createCaller({
      db: holder.db,
      authenticated: true,
      userId: USER,
      workspaceId: null,
    } as never);
    const grouped = await entitiesCaller.groupByFacetStatus({
      roleSlug: "client",
    });
    expect(grouped.groups).toEqual([
      { status: "onboarding", count: 2, ids: expect.arrayContaining([a, b]) },
    ]);
  });
});

describe("lifecycle.board — one column, paged (Show all N)", () => {
  it("pages ONE column in the board's own order; counts stay the board's", async () => {
    const client = await freshDb();
    // Five drafts, created 50..10 days ago: the oldest is longest in column.
    const drafts: string[] = [];
    for (let i = 0; i < 5; i++) {
      drafts.push(
        await thing(client, {
          status: "draft",
          title: `Draft ${i}`,
          createdDaysAgo: 50 - i * 10,
        })
      );
    }
    await thing(client, {
      status: "negotiating",
      title: "Talks",
      createdDaysAgo: 3,
    });
    const caller = await lifecycleCaller();

    const first = await caller.board({
      profileSlug: "deal",
      column: "draft",
      limit: 2,
    });
    expect(first.columns.map((c) => c.key)).toEqual(["draft"]);
    expect(first.columns[0]!.count).toBe(5);
    expect(first.columns[0]!.items.map((i) => i.id)).toEqual(
      drafts.slice(0, 2)
    );
    expect(first.columns[0]!.items.every((i) => i.status === "draft")).toBe(
      true
    );
    expect(first.live).toBe(6); // aggregates are the whole board's
    expect(first.nextCursor).toBe("2");

    const second = await caller.board({
      profileSlug: "deal",
      column: "draft",
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.columns[0]!.items.map((i) => i.id)).toEqual(
      drafts.slice(2, 4)
    );
    const last = await caller.board({
      profileSlug: "deal",
      column: "draft",
      limit: 2,
      cursor: second.nextCursor!,
    });
    expect(last.columns[0]!.items.map((i) => i.id)).toEqual([drafts[4]]);
    expect(last.nextCursor).toBeNull();

    // A whole board carries no cursor.
    expect((await caller.board({ profileSlug: "deal" })).nextCursor).toBeNull();
  });

  it("the unclassified column pages every undeclared value (null included); an unknown column is refused", async () => {
    const client = await freshDb();
    await thing(client, { status: "weird", title: "W", createdDaysAgo: 3 });
    await thing(client, { status: null, title: "N", createdDaysAgo: 2 });
    await thing(client, { status: "draft", title: "D", createdDaysAgo: 1 });
    const caller = await lifecycleCaller();
    const page = await caller.board({
      profileSlug: "deal",
      column: "__unclassified",
    });
    expect(page.columns[0]!.count).toBe(2);
    expect(page.columns[0]!.items.map((i) => i.status).sort()).toEqual(
      ["weird", null].sort()
    );
    await expect(
      caller.board({ profileSlug: "deal", column: "nope" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("a done column pages only what entered within the window", async () => {
    const client = await freshDb();
    const recent = await thing(client, {
      status: "won",
      title: "R",
      createdDaysAgo: 50,
    });
    await moved(client, recent, { to: "won", daysAgo: 2 });
    const old = await thing(client, {
      status: "won",
      title: "O",
      createdDaysAgo: 200,
    });
    await moved(client, old, { to: "won", daysAgo: 90 });
    const caller = await lifecycleCaller();
    const page = await caller.board({ profileSlug: "deal", column: "won" });
    expect(page.columns[0]!.items.map((i) => i.id)).toEqual([recent]);
  });
});

describe("lifecycle.list — the pipelines in scope", () => {
  it("kinds AND roles with a declared lifecycle and a live thing; undeclared and all-terminal are not pipelines", async () => {
    const client = await freshDb();
    const a = await thing(client, {
      status: "draft",
      title: "A",
      createdDaysAgo: 3,
    });
    await thing(client, { status: "won", title: "B", createdDaysAgo: 3 });
    await client.query(
      `insert into entity_facets (id, entity_id, profile_id, user_id, status, created_at)
       values (gen_random_uuid(), $1, $2, $3, 'churned', now())`,
      [a, CLIENT, USER]
    );
    // A note has no lifecycle: never a pipeline, however many notes exist.
    await client.query(
      `insert into entities (id, user_id, type, profile_id, title, status, properties)
       values (gen_random_uuid(), $1, 'note', $2, 'N', null, '{}'::jsonb)`,
      [USER, NOTE]
    );
    const caller = await lifecycleCaller();
    const list = await caller.list({});
    // The client role's only facet is churned (lost): no live thing ⇒ absent.
    expect(list).toEqual([
      {
        profileSlug: "deal",
        profileKind: "kind",
        label: "Deal",
        live: 1,
        total: 2,
      },
    ]);

    await client.query(
      `insert into entity_facets (id, entity_id, profile_id, user_id, status, created_at)
       values (gen_random_uuid(), $1, $2, $3, 'onboarding', now())`,
      [a, CLIENT, USER]
    );
    const withRole = await caller.list({});
    expect(
      withRole.map((l) => [l.profileSlug, l.profileKind, l.live, l.total])
    ).toEqual([
      ["client", "role", 1, 2],
      ["deal", "kind", 1, 2],
    ]);
  });
});

describe("listThingsInStatus — the worker's set is the board's column", () => {
  it("a kind: same count as the board column; exclusion pages but still counts; onlyIds asks about one thing", async () => {
    const client = await freshDb();
    const old = await thing(client, {
      status: "draft",
      title: "Old draft",
      createdDaysAgo: 20,
    });
    const young = await thing(client, {
      status: "draft",
      title: "New draft",
      createdDaysAgo: 2,
    });
    const talks = await thing(client, {
      status: "negotiating",
      title: "Talks",
      createdDaysAgo: 5,
    });
    const caller = await lifecycleCaller();
    const board = await caller.board({ profileSlug: "deal" });
    const { listThingsInStatus } =
      await import("../services/lifecycle/status-groups.js");

    const set = await listThingsInStatus({
      profileSlug: "deal",
      status: "draft",
      userId: USER,
      workspaceId: null,
      limit: 10,
    });
    expect(set.total).toBe(board.columns.find((c) => c.key === "draft")!.count);
    expect(set.total).toBe(2);
    // Longest in the column first — the board's own order.
    expect(set.items.map((i) => i.id)).toEqual([old, young]);

    const rest = await listThingsInStatus({
      profileSlug: "deal",
      status: "draft",
      userId: USER,
      workspaceId: null,
      limit: 10,
      excludeIds: [old],
    });
    expect(rest.items.map((i) => i.id)).toEqual([young]);
    expect(rest.total).toBe(2);

    const isDraft = (id: string) =>
      listThingsInStatus({
        profileSlug: "deal",
        status: "draft",
        userId: USER,
        workspaceId: null,
        limit: 1,
        onlyIds: [id],
      });
    expect((await isDraft(young)).items).toHaveLength(1);
    expect((await isDraft(talks)).items).toHaveLength(0);

    await expect(
      listThingsInStatus({
        profileSlug: "nope",
        userId: USER,
        workspaceId: null,
        limit: 1,
      })
    ).rejects.toThrow(/not a kind or role/);
  });

  it("a role: reads the FACET status, not the entity's", async () => {
    const client = await freshDb();
    const a = await thing(client, {
      status: "won",
      title: "Acme",
      createdDaysAgo: 30,
    });
    await client.query(
      `insert into entity_facets (id, entity_id, profile_id, user_id, status, created_at)
       values (gen_random_uuid(), $1, $2, $3, 'onboarding', $4)`,
      [a, CLIENT, USER, ago(3)]
    );
    const { listThingsInStatus } =
      await import("../services/lifecycle/status-groups.js");
    const set = await listThingsInStatus({
      profileSlug: "client",
      status: "onboarding",
      userId: USER,
      workspaceId: null,
      limit: 10,
    });
    expect(set.items.map((i) => i.id)).toEqual([a]);
    expect(set.items[0]!.facetId).toMatch(/^[0-9a-f-]{36}$/);
    const none = await listThingsInStatus({
      profileSlug: "client",
      status: "won",
      userId: USER,
      workspaceId: null,
      limit: 10,
    });
    expect(none.total).toBe(0);
  });
});

describe("lifecycle.board — hasWorker reads the LIVE enablements covering the filter", () => {
  const WS = "55555555-5555-4555-8555-555555555555";
  const PB = "66666666-6666-4666-8666-666666666666";
  const PROJ = "77777777-7777-4777-8777-777777777777";
  const OTHER = "88888888-8888-4888-8888-888888888888";

  async function seed(client: PGlite) {
    await client.query(
      `insert into workspaces (id, name, owner_id) values ($1, 'Sales', $2)`,
      [WS, USER]
    );
    await client.query(
      `insert into playbooks (id, name, status, workspace_id, created_by, goal_template, subject_profile)
       values ($1, 'Review', 'active', $2, $3, 'g', $4::jsonb)`,
      [
        PB,
        WS,
        USER,
        JSON.stringify({
          profileSlug: "deal",
          activators: [
            { on: "enters_status", status: "negotiating", mode: "propose" },
          ],
        }),
      ]
    );
  }
  /** One enablement = one rule row + its compiled automation (the edge). */
  async function rule(
    client: PGlite,
    o: { template: string; key: string; draft?: boolean }
  ) {
    const ruleId = randomUUID();
    const automationId = randomUUID();
    await client.query(
      `insert into skills (id, user_id, name, category, metadata) values ($1, '${USER}', 'rule', 'rule', $2::jsonb)`,
      [
        ruleId,
        JSON.stringify({
          rule: {
            v: 1,
            intent: "x",
            scope: { kind: "workspace", workspaceId: WS },
            seed: { template: o.template, key: o.key, hash: "h" },
            behaviours: [],
            ...(o.draft ? { draft: true } : {}),
          },
        }),
      ]
    );
    await client.query(
      `insert into automations (id, name, status, created_by) values ($1, 'a', $2, $3)`,
      [automationId, o.draft ? "archived" : "active", USER]
    );
    await client.query(
      `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata)
       values (gen_random_uuid(), 'skill', $1, 'automation', $2, 'activates', '{}'::jsonb)`,
      [ruleId, automationId]
    );
  }

  it("the space-wide enablement counts; once PAUSED it does not (a declared activator alone is not a worker)", async () => {
    const client = await freshDb();
    await seed(client);
    await rule(client, {
      template: `playbook-activator:${PB}`,
      key: "enters_status:negotiating",
      draft: true,
    });
    const caller = await lifecycleCaller();
    expect((await caller.board({ profileSlug: "deal" })).hasWorker).toBe(false);
    await client.query(`delete from skills`);
    await rule(client, {
      template: `playbook-activator:${PB}`,
      key: "enters_status:negotiating",
    });
    expect((await caller.board({ profileSlug: "deal" })).hasWorker).toBe(true);
  });

  it("a PROJECT enablement covers that project's board only", async () => {
    const client = await freshDb();
    await seed(client);
    await rule(client, {
      template: `playbook-worker:${PB}`,
      key: `enters_status:negotiating@project:${PROJ}`,
    });
    const caller = await lifecycleCaller();
    expect(
      (await caller.board({ profileSlug: "deal", projectId: PROJ })).hasWorker
    ).toBe(true);
    expect(
      (await caller.board({ profileSlug: "deal", projectId: OTHER })).hasWorker
    ).toBe(false);
    // workers.list — the same reader, as the track page reads it.
    const { listEnabledWorkers } =
      await import("../services/playbooks/workers.js");
    const workers = await listEnabledWorkers({ userId: USER });
    expect(workers).toEqual([
      expect.objectContaining({
        playbookId: PB,
        activatorKey: "enters_status:negotiating",
        scope: "project",
        projectId: PROJ,
        trackId: null,
        state: "running",
        size: "per_thing",
        mode: "propose",
        maxPendingApprovals: 20,
      }),
    ]);
  });
});
