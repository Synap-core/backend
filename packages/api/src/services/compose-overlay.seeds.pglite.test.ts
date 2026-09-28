/**
 * OVERLAY SEEDS ADOPT, NEVER DUPLICATE (W4b) — through the ONE compose door
 * (`composeOntoBaseWorkspace`) that every overlay install reaches (Hub
 * `/packages/apply`, `market.install`, browser `createFromDefinition`, devplane
 * `applyDefinition` create-mode, the resolver's transitive compose), on PGlite
 * with the REAL EntityRepository / RelationRepository writes and the REAL
 * business-model definition from the workspace-templates SOURCE.
 *
 * Before W4b: the compose door applied schema only (seeds never landed), and
 * `applyDefinition` create-mode seeded the compose base WITHOUT a key (every
 * re-run duplicated the nine GRP questions).
 *
 * The seeds are the Génération / Rémunération / Partage set (founder decision
 * A, 2026-09-28), whose live rows are POD-LEVEL (workspace_id NULL, never
 * stamped to Foundation). The live-shape case below inserts exactly that and
 * asserts the real helper adopts all nine by title.
 *
 * Stubbed: the schema reconcile (`reconcileWorkspaceFromDefinition` — not what
 * this is about), the ledger write, the write gate, the event bus.
 * What this CANNOT see: production Postgres constraints (tables are generated
 * from the Drizzle definitions without indexes), the doors' own mapping of the
 * compose result (they only forward `reconcile.seeds`).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  const eventRepository = new Proxy(
    {},
    { get: (_t, k) => (k === "then" ? undefined : async () => undefined) }
  );
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository,
    reconcileWorkspaceFromDefinition: async () => ({}),
    WorkspaceRepository: class {
      mergeSettings = async () => ({});
    },
  };
});
vi.mock("../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: vi.fn(async () => undefined),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => {} }));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { composeOntoBaseWorkspace } from "./compose-overlay.js";

const here = dirname(fileURLToPath(import.meta.url));
const WT_DEFINE = join(
  here,
  "../../../../../synap-app/packages/workspace-templates/src/define.ts"
);

const U = randomUUID();
const OTHER = randomUUID();
const QUESTION = randomUUID();

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
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

let definition: Record<string, unknown>;
let seedTitles: string[];
let seedRelations: Array<{ sourceRef: string; targetRef: string }>;

/**
 * The founder's live pod-level GRP questions (read 2026-09-28, pod
 * antoinesrvt, all workspace_id NULL). Pinned HERE, independently of the
 * template, so a template title that drifts from the live row is caught by the
 * adoption assertion instead of silently seeding a second set.
 */
const LIVE_POD_LEVEL_GRP_TITLES = [
  "Porteur — what does the founder bring that cannot be hired, and what does the venture require of them personally?",
  "Value proposition — for whom is this indispensable, and what do they stop doing once they have it?",
  "Value fabrication — what is the chain that actually produces the value, and which link do we own?",
  "Revenue sources — who pays, for which unit, and why that unit rather than another?",
  "Volume and pricing — what volume at what price clears the cost base, and is that volume reachable in this market?",
  "Performance — which number tells us the model works, and what observation would falsify it?",
  "Stakeholders — who must say yes for this to exist, and what does each of them need in return?",
  "Conventions — which rules bind us, who enforces them, and which are mandatory rather than advisory?",
  "Ecosystem — what does the venture give back, and what breaks if we extract without returning?",
];

async function newWorkspace(): Promise<string> {
  const ws = randomUUID();
  await q(
    `insert into workspaces (id, name, owner_id, package_slug, settings) values ($1,'Foundation',$2,'foundation','{}'::jsonb)`,
    [ws, U]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), ws, U]
  );
  return ws;
}
async function insertQuestion(
  owner: string,
  ws: string | null,
  title: string,
  deleted = false
): Promise<void> {
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, deleted_at)
     values ($1,$2,$3,$4,'question',$5,'{}'::jsonb,$6)`,
    [randomUUID(), owner, ws, QUESTION, title, deleted ? new Date() : null]
  );
}
async function counts(): Promise<{ entities: number; relations: number }> {
  const e = await q<{ n: number }>(
    `select count(*)::int as n from entities where user_id = $1`,
    [U]
  );
  const r = await q<{ n: number }>(
    `select count(*)::int as n from relations where user_id = $1`,
    [U]
  );
  return { entities: e.rows[0]!.n, relations: r.rows[0]!.n };
}
const install = (ws: string) =>
  composeOntoBaseWorkspace({
    composeTargetWorkspaceId: ws,
    userId: U,
    definition: definition as never,
    overlay: { slug: "business-model", version: "0.13.0" },
  });

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  for (const u of [U, OTHER]) {
    await q(`insert into users (id, email) values ($1, $2)`, [
      u,
      `${u}@example.test`,
    ]);
  }
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
    [randomUUID(), U]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active) values ($1,'question','Question','kind','system','pod',true)`,
    [QUESTION]
  );

  const { toWorkspaceDefinition } = await import(/* @vite-ignore */ WT_DEFINE);
  definition = toWorkspaceDefinition("business-model").definition as Record<
    string,
    unknown
  >;
  const seeds = (definition.seedEntities ?? definition.suggestedEntities) as
    Array<{ profileSlug: string; title: string }> | undefined;
  seedTitles = (seeds ?? []).map((s) => s.title);
  seedRelations = (definition.suggestedRelations ?? []) as typeof seedRelations;
}, 60_000);

describe("composeOntoBaseWorkspace — overlay seeds adopt, never duplicate", () => {
  it("the real business-model overlay carries the nine G·R·P questions (non-vacuity)", () => {
    expect(seedTitles).toHaveLength(9);
    expect(seedTitles.some((t) => /^GRP #/.test(t))).toBe(false);
    expect(seedRelations.length).toBeGreaterThan(0);
  });

  it("the live pod-level set (workspace_id NULL) is ADOPTED by title: zero entities written", async () => {
    const ws = await newWorkspace();
    for (const t of LIVE_POD_LEVEL_GRP_TITLES) await insertQuestion(U, null, t);
    const before = await counts();

    const res = await install(ws);
    expect(res.seeds?.errors).toEqual([]);
    expect(res.seeds?.entitiesCreated).toBe(0);
    expect(res.seeds?.entitiesAdopted).toBe(9);
    const after = await counts();
    expect(after.entities).toBe(before.entities);
    // Every seeded rests_on edge lands between the ADOPTED live rows.
    expect(after.relations - before.relations).toBe(seedRelations.length);
    const orphan = await q<{ n: number }>(
      `select count(*)::int as n from relations r
         where r.user_id = $1
           and (r.source_entity_id not in (select id from entities where user_id=$1 and workspace_id is null)
             or r.target_entity_id not in (select id from entities where user_id=$1 and workspace_id is null))`,
      [U]
    );
    expect(orphan.rows[0]!.n).toBe(0);
    await q(`delete from relations where user_id = $1`, [U]);
    await q(`delete from entities where user_id = $1`, [U]);
  });

  it("installing twice onto a Foundation that already holds the questions writes ZERO entities", async () => {
    const ws = await newWorkspace();
    // The live shape: questions stamped Foundation, one already moved pod-wide
    // by reconcileEntityScope, one the user deleted.
    for (const t of seedTitles.slice(0, 7)) await insertQuestion(U, ws, t);
    await insertQuestion(U, null, seedTitles[7]!);
    await insertQuestion(U, ws, seedTitles[8]!, true);
    // Another user's same-titled question is NOT ours to adopt.
    await insertQuestion(OTHER, ws, seedTitles[0]!);
    const before = await counts();

    const first = await install(ws);
    expect(first.seeds?.entitiesCreated).toBe(0);
    expect(first.seeds?.entitiesAdopted).toBe(9);
    expect(first.seeds?.errors).toEqual([]);
    const afterFirst = await counts();
    expect(afterFirst.entities).toBe(before.entities);
    // Every seeded rests_on edge among the adopted questions, minus those that
    // name the user-deleted one (skipped, not re-created).
    const deleted = seedTitles[8]!;
    const expectedEdges = seedRelations.filter(
      (r) => r.sourceRef !== deleted && r.targetRef !== deleted
    ).length;
    expect(expectedEdges).toBeGreaterThan(0);
    expect(expectedEdges).toBeLessThan(seedRelations.length);
    expect(afterFirst.relations - before.relations).toBe(expectedEdges);

    const second = await install(ws);
    expect(second.seeds?.entitiesCreated).toBe(0);
    expect(second.seeds?.relationsCreated).toBe(0);
    expect(await counts()).toEqual(afterFirst);

    // The deleted one stays deleted.
    const live = await q<{ n: number }>(
      `select count(*)::int as n from entities where user_id=$1 and title=$2 and deleted_at is null`,
      [U, seedTitles[8]]
    );
    expect(live.rows[0]!.n).toBe(0);
  });

  it("an empty base gets the nine seeds once; a re-install adds nothing", async () => {
    // A clean pod for U (the previous case left a pod-wide question, which
    // would — correctly — be adopted here).
    await q(`delete from relations where user_id = $1`, [U]);
    await q(`delete from entities where user_id = $1`, [U]);
    const ws = await newWorkspace();
    const before = await counts();
    const first = await install(ws);
    expect(first.seeds?.errors).toEqual([]);
    expect(first.seeds?.entitiesCreated).toBe(9);
    const afterFirst = await counts();
    expect(afterFirst.entities - before.entities).toBe(9);

    await install(ws);
    expect(await counts()).toEqual(afterFirst);
  });
});
