/**
 * `entities.list` in a WORKSPACE lens, filtered to a POD-SCOPE kind, includes
 * that kind's pod-wide rows (FX-B1, RV2 MUST-FIX 3) — through the REAL
 * procedure, the real access floor (`entityLensWhere` → `accessScopeWhere`)
 * and the real slug lookup, on PGlite.
 *
 * Why: a pod-scope kind (person, company, task…) is by definition visible in
 * every space. The W2b conversions re-null stamped persons/companies, and the
 * old scoped default (omitted ⇒ `includePodWide: false`) then emptied relay
 * People, CRM contact search and the ops calendar.
 *
 * Pinned:
 *  - omitted `includePodWide` + pod-scope kind ⇒ this workspace's rows ∪ the
 *    caller's visible pod-wide rows; never another workspace's rows, never a
 *    pod-wide row the caller cannot see;
 *  - explicit `includePodWide: false` ⇒ stamped-only (the escape hatch);
 *  - a WORKSPACE-scope kind (deal) keeps the scoped default;
 *  - an unfiltered list keeps the scoped default (2026-06-15 decision).
 *
 * What this cannot see: production Postgres (tables from Drizzle definitions),
 * Typesense, facet rows (none seeded here).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

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
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: {
      append: async () => undefined,
      emitCompleted: async () => undefined,
    },
  };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => {} }));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { entitiesRouter } from "./entities.js";

const A = randomUUID();
const B = randomUUID();
const CRM = randomUUID(); // A's
const OPS = randomUUID(); // A's
const BWS = randomUUID(); // B's
const PERSON = randomUUID();
const DEAL = randomUUID();

const P_POD = randomUUID(); // A's pod-wide person
const P_CRM = randomUUID(); // person stamped CRM
const P_OPS = randomUUID(); // person stamped OPS
const P_B_POD = randomUUID(); // B's pod-wide person (A has no grant)
const D_CRM = randomUUID(); // deal stamped CRM
const D_POD = randomUUID(); // legacy pod-wide deal

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
        : c.name === "is_active"
          ? " default true"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

async function list(input: Record<string, unknown>): Promise<Set<string>> {
  const res = (await entitiesRouter
    .createCaller({
      authenticated: true,
      userId: A,
      workspaceId: CRM,
    } as never)
    .list(input as never)) as { items: Array<{ id: string }> };
  return new Set(res.items.map((e) => e.id));
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  for (const u of [A, B]) {
    await q(`insert into users (id, email) values ($1, $2)`, [
      u,
      `${u}@example.test`,
    ]);
  }
  for (const [ws, owner] of [
    [CRM, A],
    [OPS, A],
    [BWS, B],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,'w',$2,'{}'::jsonb)`,
      [ws, owner]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, owner]
    );
  }
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints)
     values ($1,'person','Person','kind','system','pod',true,'{}'::jsonb),
            ($2,'deal','Deal','kind','system','workspace',true,'{}'::jsonb)`,
    [PERSON, DEAL]
  );
  for (const [id, owner, ws, kind, type] of [
    [P_POD, A, null, PERSON, "person"],
    [P_CRM, A, CRM, PERSON, "person"],
    [P_OPS, A, OPS, PERSON, "person"],
    [P_B_POD, B, null, PERSON, "person"],
    [D_CRM, A, CRM, DEAL, "deal"],
    [D_POD, A, null, DEAL, "deal"],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
       values ($1,$2,$3,$4,$5,'e','{}'::jsonb,'{}'::jsonb)`,
      [id, owner, ws, kind, type]
    );
  }
}, 120_000);

describe("entities.list — pod-scope kinds in a workspace lens", () => {
  it("omitted includePodWide + pod-scope kind ⇒ this workspace ∪ visible pod-wide rows", async () => {
    const ids = await list({ profileSlug: "person" });
    expect(ids).toEqual(new Set([P_CRM, P_POD]));
    expect(ids.has(P_OPS)).toBe(false); // another workspace
    expect(ids.has(P_B_POD)).toBe(false); // not A's to see
  });

  it("explicit includePodWide:false ⇒ stamped-only", async () => {
    expect(
      await list({ profileSlug: "person", includePodWide: false })
    ).toEqual(new Set([P_CRM]));
  });

  it("a workspace-scope kind keeps the scoped default", async () => {
    expect(await list({ profileSlug: "deal" })).toEqual(new Set([D_CRM]));
    expect(await list({ profileSlug: "deal", includePodWide: true })).toEqual(
      new Set([D_CRM, D_POD])
    );
  });

  it("an unfiltered workspace list keeps the scoped default", async () => {
    expect(await list({})).toEqual(new Set([P_CRM, D_CRM]));
  });
});
