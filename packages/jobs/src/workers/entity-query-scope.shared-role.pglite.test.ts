/**
 * The automation `query` node's pod-wide branch honours founder decision B
 * (2026-09-27), on PGlite through the REAL `entityQueryVisibilityWhere`: a
 * pod-wide entity wearing a live pod-wide facet is visible to a run owner only
 * when the facet's ROLE is granted to a space the owner belongs to (and the
 * owner is a pod member) — the SAME builder the api floor uses
 * (`podSharedEntityIdsFor`). The owner's own rows are unchanged (solo pod).
 *
 * What this CANNOT see: production Postgres constraints (tables are generated
 * from the Drizzle definitions without FKs/NOT NULL/enums).
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
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  entities,
  entityFacets,
  profiles,
  profileWorkspaceAccess,
  podMembers,
  workspaceMembers,
  workspaces,
} from "@synap/database/schema";
import { db } from "@synap/database";
import { entityQueryVisibilityWhere } from "./entity-query-scope.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const OWNER = "qb-owner";
const GRANTED = "qb-granted";
const OUTSIDER = "qb-outsider";
const RUN_WS = randomUUID();
const WS_A = randomUUID();
const WS_B = randomUUID();
const ROLE = randomUUID();
const E_SHARED = randomUUID();

async function visibleTo(ownerId: string): Promise<string[]> {
  const rows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(entityQueryVisibilityWhere({ workspaceId: RUN_WS, ownerId }));
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  for (const t of [
    entities,
    entityFacets,
    profiles,
    profileWorkspaceAccess,
    podMembers,
    workspaceMembers,
    workspaces,
  ] as PgTable[]) {
    await h.client!.exec(ddlFor(t));
  }
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner'),($3,$4,'member'),($5,$6,'member')`,
    [randomUUID(), OWNER, randomUUID(), GRANTED, randomUUID(), OUTSIDER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'editor'),($4,$5,$6,'editor')`,
    [randomUUID(), WS_A, GRANTED, randomUUID(), WS_B, OUTSIDER]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope) values ($1,'client','Client','role','shared')`,
    [ROLE]
  );
  await q(
    `insert into profile_workspace_access (profile_id, workspace_id) values ($1,$2)`,
    [ROLE, WS_A]
  );
  await q(
    `insert into entities (id, user_id, workspace_id, title) values ($1,$2,null,'Person')`,
    [E_SHARED, OWNER]
  );
  await q(
    `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id) values ($1,$2,$3,$4,null)`,
    [randomUUID(), E_SHARED, ROLE, OWNER]
  );
}, 60_000);

describe("entityQueryVisibilityWhere — decision B", () => {
  it("owner (solo view) sees its own pod-wide entity", async () => {
    expect(await visibleTo(OWNER)).toEqual([E_SHARED]);
  });
  it("a run owner in a space the role is granted to sees the shared entity", async () => {
    expect(await visibleTo(GRANTED)).toEqual([E_SHARED]);
  });
  it("a pod member NOT in a granted space does not", async () => {
    expect(await visibleTo(OUTSIDER)).toEqual([]);
  });
});
