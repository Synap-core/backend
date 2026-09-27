/**
 * ONE placement ladder for a pod-scope kind across the create doors (FX-B1,
 * RV2 S8) — through the REAL `entities.create` and `entities.batchCreate`
 * procedures and the REAL placement door on PGlite. Governance, audit, side
 * effects and search indexing are stubbed.
 *
 * Decided model: a pod-scope kind is pod-wide. Before this, the same `person`
 * landed three ways: capture left it pod-wide, single create let a rung-2
 * ontology signal (a role enabled in one workspace) stamp it, and bulk create
 * pinned it to the request's workspace header.
 *
 * Pinned:
 *  - single create of a person carrying a CRM-only role, in the CRM lens ⇒
 *    pod-wide (the role facet may keep its lens; the KIND does not);
 *  - bulk create of a person under the CRM header ⇒ pod-wide;
 *  - bulk create of a WORKSPACE-scope kind under the header ⇒ still CRM;
 *  - an explicit targetWorkspaceId still pins a pod-scope kind.
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
      append: async () => ({ id: randomUUID() }),
      emitCompleted: async () => undefined,
    },
  };
});
vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async () => ({ allowed: true })),
  previewPermissionDecision: vi.fn(async () => ({ decision: "allow" })),
  proposedMessageFor: vi.fn(() => "proposed"),
  isJoinGate: vi.fn(() => false),
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => {} }));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { entitiesRouter } from "./entities.js";

const A = randomUUID();
const CRM = randomUUID();
const OPS = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    let def = "";
    if (c.name === "created_at" || c.name === "updated_at")
      def = " default now()";
    else if (
      c.hasDefault &&
      c.default !== undefined &&
      typeof c.default !== "object"
    ) {
      const d = c.default as unknown;
      def =
        typeof d === "string"
          ? ` default '${d.replace(/'/g, "''")}'`
          : ` default ${String(d)}`;
    } else if (c.hasDefault && type === "jsonb") def = ` default '{}'::jsonb`;
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);
const caller = (workspaceId: string | null) =>
  entitiesRouter.createCaller({
    authenticated: true,
    userId: A,
    workspaceId,
  } as never);

async function homeOf(id: string): Promise<string | null> {
  const { rows } = await q(`select workspace_id from entities where id = $1`, [
    id,
  ]);
  return (rows[0] as { workspace_id: string | null }).workspace_id;
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(`insert into users (id, email) values ($1, 'a@x.test')`, [A]);
  for (const [ws, name] of [
    [CRM, "CRM"],
    [OPS, "Operations"],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, workspace_type, settings) values ($1,$2,$3,'team','{}'::jsonb)`,
      [ws, name, A]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, A]
    );
  }
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints, applicable_kinds)
     values (gen_random_uuid(),'person','Person','kind','system','pod',null,true,'{}'::jsonb,null),
            (gen_random_uuid(),'deal','Deal','kind','system','workspace',null,true,'{}'::jsonb,null),
            (gen_random_uuid(),'crm-lead','Lead','role','workspace','workspace',$1,true,'{}'::jsonb,'{person}')`,
    [CRM]
  );
}, 120_000);

describe("create doors place a pod-scope kind on ONE ladder", () => {
  it("single create: a CRM-only role does not stamp the person", async () => {
    const res = (await caller(CRM).create({
      profileSlug: "person",
      title: "Ada Placement",
      facets: [{ profileSlug: "crm-lead" }],
    } as never)) as { id: string };
    expect(await homeOf(res.id)).toBeNull();
  });

  it("bulk create: the header does not stamp a pod-scope kind", async () => {
    const res = await caller(CRM).batchCreate({
      entities: [
        { refKey: "p1", profileSlug: "person", title: "Bo Bulk" },
        { refKey: "d1", profileSlug: "deal", title: "Bulk deal" },
      ],
    });
    expect(res.errors).toEqual([]);
    expect(await homeOf(res.entityIds.p1!)).toBeNull();
    // A workspace-scope kind keeps its process home.
    expect(await homeOf(res.entityIds.d1!)).toBe(CRM);
  });

  it("an explicit targetWorkspaceId still pins a pod-scope kind", async () => {
    const res = (await caller(CRM).create({
      profileSlug: "person",
      title: "Cy Pinned",
      targetWorkspaceId: OPS,
    } as never)) as { id: string };
    expect(await homeOf(res.id)).toBe(OPS);
  });
});
