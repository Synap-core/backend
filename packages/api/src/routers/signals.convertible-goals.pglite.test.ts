/**
 * The "Make them goals" card in the needs-you union (founder decision D-3,
 * 2026-10-26), against real SQL (PGlite, every table) through the REAL
 * signals read — the entities `listConvertibleGoals` reads, unioned and
 * counted by `signals.list` / `signals.count`:
 *
 *  - the viewer's readable `goal` / `objective` / `okr` entities (kind = the
 *    profile slug, else the legacy `type`) are ONE `convertible-goals` row at
 *    the floor, each with the visible projects it is filed in, and
 *    `convertible` is a part of THE number;
 *  - an entity already made a goal (`promoted_to` a track), a deleted one,
 *    another kind, and one the viewer cannot read are not on it;
 *  - under a space lens there is no card;
 *  - a viewer with nothing to convert has no card: empty, not a failure
 *    (`list` throws when a blocking half failed, so every page read here
 *    also proves the half read).
 *
 * Stubbed: the review and access-request halves (their own suites), so the
 * numbers here are the card's and nothing else's.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  tables: [] as unknown[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { is } = await import("drizzle-orm");
  const { PgTable } = await import("drizzle-orm/pg-core");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const tables = Object.entries(actual).filter(([, v]) => is(v, PgTable));
  h.tables = tables.map(([, v]) => v);
  const schema = await import("@synap/database/schema");
  const pg = drizzle(client, { schema });
  return { ...actual, db: pg, getDb: async () => pg };
});

vi.mock("../services/projects/project-needs-you.js", () => ({
  listSessionsAwaitingReview: async () => ({ sessions: [], truncated: false }),
}));
vi.mock("../services/signals/access-requests.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listPendingIssuers: async () => ({ rows: [], truncated: false }),
  listPendingAppRequests: async () => ({ rows: [], truncated: false }),
  listPendingKeyRequests: async () => ({ rows: [], truncated: false }),
}));
// The broken-connection half: pinned by its own PGlite suite
// (`broken-connections.pglite.test.ts`); none here.
vi.mock("../services/signals/broken-connections.js", () => ({
  listBrokenConnections: async () => ({ rows: [], truncated: false }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { signalsRouter } from "./signals.js";
import { listConvertibleGoals } from "../services/signals/convertible-goals.js";
import { AccessContext } from "../access/index.js";

const ME = "user-me";
const OTHER = "user-other";
const NOBODY = "user-nothing";
const LIFE = randomUUID();
const FOREIGN = randomUUID();
const GOAL_PROFILE = randomUUID();
const TASK_PROFILE = randomUUID();
const MY_PROJECT = randomUUID();
const HIDDEN_PROJECT = randomUUID();
const E = {
  goal: randomUUID(),
  objective: randomUUID(),
  converted: randomUUID(),
  deleted: randomUUID(),
  task: randomUUID(),
  foreign: randomUUID(),
};

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def = [
      "created_at",
      "updated_at",
      "timestamp",
      "started_at",
    ].includes(c.name)
      ? " default now()"
      : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  const schema = cfg.schema ? `"${cfg.schema}".` : "";
  return `create table if not exists ${schema}"${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const ctxOf = (userId: string) =>
  ({ db: null, authenticated: true, userId, workspaceId: null }) as never;

async function entity(o: {
  id: string;
  userId: string;
  workspaceId: string;
  profileId: string | null;
  type: string;
  title: string;
  ageDays: number;
  deleted?: boolean;
}) {
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, created_at, updated_at, deleted_at)
     values ($1,$2,$3,$4,$5,$6,'{}'::jsonb, now() - ($7 || ' days')::interval, now(), $8)`,
    [
      o.id,
      o.userId,
      o.workspaceId,
      o.profileId,
      o.type,
      o.title,
      String(o.ageDays),
      o.deleted ? new Date() : null,
    ]
  );
}

beforeAll(async () => {
  for (const t of h.tables) {
    const cfg = getTableConfig(t as PgTable);
    if (cfg.schema)
      await h.client!.exec(`create schema if not exists "${cfg.schema}";`);
    await h.client!.exec(ddlFor(t as PgTable));
  }
  await q(
    `insert into users (id, name, email, user_type) values ($1,'Me','me@x.io','human'), ($2,'Other','o@x.io','human'), ($3,'Nobody','n@x.io','human')`,
    [ME, OTHER, NOBODY]
  );
  for (const [id, name, owner] of [
    [LIFE, "Life OS", ME],
    [FOREIGN, "Their space", OTHER],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [id, name, owner]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values (gen_random_uuid(),$1,$2,'owner')`,
      [id, owner]
    );
  }
  await q(
    `insert into profiles (id, slug, scope, entity_scope) values ($1,'goal','system','workspace'), ($2,'task','system','workspace')`,
    [GOAL_PROFILE, TASK_PROFILE]
  );
  // Convertible: a Life OS goal (profile slug), and an objective known only
  // by its legacy `type` (no profile).
  await entity({
    id: E.goal,
    userId: ME,
    workspaceId: LIFE,
    profileId: GOAL_PROFILE,
    type: "goal",
    title: "Run a marathon",
    ageDays: 30,
  });
  await entity({
    id: E.objective,
    userId: ME,
    workspaceId: LIFE,
    profileId: null,
    type: "objective",
    title: "Grow revenue",
    ageDays: 60,
  });
  // Not convertible: already a goal, deleted, another kind, not mine to read.
  await entity({
    id: E.converted,
    userId: ME,
    workspaceId: LIFE,
    profileId: GOAL_PROFILE,
    type: "goal",
    title: "Already a goal",
    ageDays: 10,
  });
  await q(
    `insert into links (id, workspace_id, from_type, from_id, to_type, to_id, link_type)
     values (gen_random_uuid(), $1, 'entity', $2, 'track', $3, 'promoted_to')`,
    [LIFE, E.converted, randomUUID()]
  );
  await entity({
    id: E.deleted,
    userId: ME,
    workspaceId: LIFE,
    profileId: GOAL_PROFILE,
    type: "goal",
    title: "Deleted",
    ageDays: 5,
    deleted: true,
  });
  await entity({
    id: E.task,
    userId: ME,
    workspaceId: LIFE,
    profileId: TASK_PROFILE,
    type: "goal",
    title: "A task whose legacy type says goal",
    ageDays: 5,
  });
  await entity({
    id: E.foreign,
    userId: OTHER,
    workspaceId: FOREIGN,
    profileId: GOAL_PROFILE,
    type: "goal",
    title: "Their goal",
    ageDays: 5,
  });
  // The goal is filed in a project I see and in one I do not.
  await q(
    `insert into projects (id, user_id, workspace_id, name, status, sample) values ($1,$2,$3,'Health','active',false), ($4,$5,$6,'Hidden','active',false)`,
    [MY_PROJECT, ME, LIFE, HIDDEN_PROJECT, OTHER, FOREIGN]
  );
  for (const p of [MY_PROJECT, HIDDEN_PROJECT])
    await q(
      `insert into relations (id, user_id, source_entity_id, target_entity_id, type) values (gen_random_uuid(),$1,$2,$3,'belongs_to_project')`,
      [ME, E.goal, p]
    );
});

describe("the Make them goals card in needs-you (real read)", () => {
  it("is ONE convertible-goals row at the floor: only the readable, never-converted goal kinds, newest first", async () => {
    const { signals } = (await signalsRouter
      .createCaller(ctxOf(ME))
      .list({ lens: "needs-you" })) as unknown as {
      signals: Array<Record<string, unknown>>;
    };
    const cards = signals.filter((s) => s.kind === "convertible-goals");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      title: "1 goal and 1 objective from Life OS can become goals",
      target: null,
      convertible: {
        truncated: false,
        entities: [
          {
            entityId: E.goal,
            title: "Run a marathon",
            kind: "goal",
            spaceName: "Life OS",
            // The hidden project is never named.
            projectIds: [MY_PROJECT],
          },
          {
            entityId: E.objective,
            title: "Grow revenue",
            kind: "objective",
            spaceName: "Life OS",
            projectIds: [],
          },
        ],
      },
    });
  });

  it("`convertible` is a part of THE number at the floor: one card, not one per entity", async () => {
    const count = await signalsRouter.createCaller(ctxOf(ME)).count({});
    expect(count.convertible).toBe(1);
    expect(count.needsYou).toBe(
      count.decisions +
        count.notifications +
        count.blocked +
        count.review +
        count.captures +
        count.requests +
        count.invites +
        count.convertible
    );
  });

  it("under a space lens there is no card and no count", async () => {
    const caller = signalsRouter.createCaller(ctxOf(ME));
    expect((await caller.count({ workspaceId: LIFE })).convertible).toBe(0);
    const { signals } = (await caller.list({
      lens: "needs-you",
      workspaceId: LIFE,
    })) as { signals: Array<{ kind: string }> };
    expect(signals.some((s) => s.kind === "convertible-goals")).toBe(false);
  });

  it("is access-scoped: each viewer sees only the entities they can read", async () => {
    const theirs = await listConvertibleGoals({
      access: AccessContext.operator({ userId: OTHER }),
    });
    expect(theirs.rows.map((r) => r.entityId)).toEqual([E.foreign]);
  });

  it("a viewer with nothing to convert has no card — empty, never a failure", async () => {
    expect(
      await listConvertibleGoals({
        access: AccessContext.operator({ userId: NOBODY }),
      })
    ).toEqual({ rows: [], truncated: false, newestAt: null });
    const caller = signalsRouter.createCaller(ctxOf(NOBODY));
    expect((await caller.count({})).convertible).toBe(0);
    const page = (await caller.list({ lens: "needs-you" })) as unknown as {
      signals: Array<{ kind: string }>;
    };
    expect(page.signals.some((s) => s.kind === "convertible-goals")).toBe(
      false
    );
  });
});
