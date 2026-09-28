/**
 * X1 — an UNLENSED `entities.list` (no input workspaceId, no header — what the
 * Hub `getEntities` forwarder and MCP `get_entities` send when the agent omits
 * `workspaceId`) must read facets at the FULL user floor ("all my
 * workspaces", the documented `undefined` semantics), not the explicit
 * pod-wide-only `null`.
 *
 * Live shape (GRP, 2026-09-28): the role `grp-interrogation` lives in the
 * Foundation space; the nine "GRP #n" questions carry it as a
 * Foundation-stamped facet. `get_entities(facetSlug)` with no workspaceId
 * returned 0 and lean rows had no facetSlugs, while the same call pinned to
 * Foundation returned 9.
 *
 * Pinned, through the real procedure + access floor on PGlite:
 *  - unlensed facetSlug ⇒ the 9 questions, each annotated with the role;
 *  - unlensed kind list ⇒ rows still carry the role in facetSlugs;
 *  - explicit `workspaceId: null` stays pod-wide-only (0) — the narrowing is
 *    a deliberate caller choice, not the absent-lens default;
 *  - another user's workspace-lensed facet never leaks into A's unlensed read.
 *
 * Cannot see: production Postgres, Typesense, the lean projection in
 * `read-lean.ts` (it forwards `facetSlugs` verbatim from these rows).
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

const A = randomUUID();
const B = randomUUID();
const FOUNDATION = randomUUID(); // A's
const BWS = randomUUID(); // B's
const QUESTION = randomUUID();
const ROLE = randomUUID(); // grp-interrogation, owned by Foundation
const QS = Array.from({ length: 9 }, () => randomUUID());
const B_Q = randomUUID(); // B's question in B's space, same role

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

async function list(
  input: Record<string, unknown>
): Promise<Array<{ id: string; facetSlugs?: string[] }>> {
  const res = (await entitiesRouter
    .createCaller({
      authenticated: true,
      userId: A,
      // What createHubProtocolCallerContext builds with no lens.
      workspaceId: null,
    } as never)
    .list(input as never)) as {
    items: Array<{ id: string; facetSlugs?: string[] }>;
  };
  return res.items;
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
    [FOUNDATION, A],
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
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id)
     values ($1,'question','Question','kind','system','pod',true,'{}'::jsonb,null),
            ($2,'grp-interrogation','GRP interrogation','role','workspace','workspace',true,'{}'::jsonb,$3)`,
    [QUESTION, ROLE, FOUNDATION]
  );
  const seed = async (id: string, owner: string, ws: string) => {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
       values ($1,$2,$3,$4,'question','GRP q','{}'::jsonb,'{}'::jsonb)`,
      [id, owner, ws, QUESTION]
    );
    await q(
      `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, properties, metadata)
       values ($1,$2,$3,$4,$5,'{}'::jsonb,'{}'::jsonb)`,
      [randomUUID(), id, ROLE, owner, ws]
    );
  };
  for (const id of QS) await seed(id, A, FOUNDATION);
  await seed(B_Q, B, BWS);
}, 120_000);

describe("entities.list — unlensed read keeps workspace-lensed roles", () => {
  it("unlensed facetSlug ⇒ the 9 questions, each wearing the role", async () => {
    const rows = await list({ facetSlug: "grp-interrogation" });
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(QS));
    for (const r of rows) expect(r.facetSlugs).toContain("grp-interrogation");
  });

  it("unlensed kind list annotates the role on each row", async () => {
    const rows = await list({ profileSlug: "question" });
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(QS));
    for (const r of rows) expect(r.facetSlugs).toContain("grp-interrogation");
  });

  it("explicit workspaceId:null stays pod-wide-only", async () => {
    expect(
      await list({ facetSlug: "grp-interrogation", workspaceId: null })
    ).toEqual([]);
  });

  it("pinned to Foundation matches the unlensed read", async () => {
    const rows = await list({
      facetSlug: "grp-interrogation",
      workspaceId: FOUNDATION,
    });
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(QS));
  });
});
