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
}, 60_000);

describe("composeOntoBaseWorkspace — overlay seeds adopt, never duplicate", () => {
  it("the real business-model overlay carries the nine GRP questions (non-vacuity)", () => {
    expect(seedTitles).toHaveLength(9);
    expect(seedTitles.every((t) => /^GRP #\d: /.test(t))).toBe(true);
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
    // The 7 seeded rests_on edges among the adopted live questions.
    expect(afterFirst.relations - before.relations).toBe(7);

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
