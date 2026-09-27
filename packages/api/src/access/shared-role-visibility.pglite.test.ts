/**
 * SHARED-ROLE VISIBILITY — founder decision B (2026-09-27), on PGlite through
 * the REAL readers:
 *   - the `entities` VisibilityRule (`scopedDb` → `accessScopeWhere`, facetLens)
 *     and the POD lens (`accessScopeWhere({ workspaceLens: null })`);
 *   - the `entityFacets` VisibilityRule (`scopedDb`);
 *   - `facetVisibilityConditions` (FacetRepository / graph / ask / helpers);
 *   - the `documents` VisibilityRule + `loadReadableDocument` (a document
 *     follows its entity — `podSharedDocumentWhere`);
 *   - `isFacetVisibleForLens` + `resolveViewerSharedRoleIds` (proposal review).
 *
 * The rule: a pod-wide entity wearing a LIVE pod-wide facet is readable by a
 * POD MEMBER only when the facet's ROLE is granted to a space that member
 * belongs to (a `profile_workspace_access` row, or the role's own owning
 * workspace). Never by every pod member. The owner floor is unchanged, so a
 * solo pod reads exactly what it read before.
 *
 * Users:
 *   OWNER    — pod owner, authored everything.
 *   GRANTED  — pod member, member of WS_A (client is granted to WS_A).
 *   OUTSIDER — pod member, member of WS_B only (owns-role grant for ROLE_B).
 *   NONPOD   — member of WS_A but NO pod_members row → nothing shared.
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
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  h.db = db;
  return { ...actual, db, getDb: async () => db };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { entities, entityFacets, documents } from "@synap/database/schema";
import {
  db,
  and,
  isNull,
  facetVisibilityConditions,
  isFacetVisibleForLens,
  resolveViewerSharedRoleIds,
} from "@synap/database";
import { AccessContext, scopedDb } from "./index.js";
import { accessScopeWhere } from "../utils/project-scope.js";
import { loadReadableDocument } from "../utils/document-edit-access.js";

const OWNER = "vis-b-owner";
const GRANTED = "vis-b-granted";
const OUTSIDER = "vis-b-outsider";
const NONPOD = "vis-b-nonpod";

const WS_A = randomUUID();
const WS_B = randomUUID();
const ROLE_CLIENT = randomUUID(); // shared, granted to WS_A
const ROLE_SYS = randomUUID(); // system, granted nowhere
const ROLE_B = randomUUID(); // shared, OWNED by WS_B (no grant row)

const E_CLIENT = randomUUID();
const E_SYS = randomUUID();
const E_B = randomUUID();
const E_DETACHED = randomUUID();
const D_CLIENT = randomUUID();
const D_SYS = randomUUID();
const D_B = randomUUID();
const D_DETACHED = randomUUID();
const F_CLIENT = randomUUID();
const F_SYS = randomUUID();
const F_B = randomUUID();
const F_DETACHED = randomUUID();

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

const idsOf = (rows: Array<{ id: string }>) =>
  [...new Set(rows.map((r) => r.id))].sort();
const seen = async (userId: string, table: object) =>
  idsOf(
    await scopedDb(AccessContext.operator({ userId })).findMany<{ id: string }>(
      table
    )
  );
const podLens = async (userId: string) =>
  idsOf(
    await db
      .select({ id: entities.id })
      .from(entities)
      .where(
        accessScopeWhere({
          workspaceIdColumn: entities.workspaceId,
          entityIdColumn: entities.id,
          ownerColumn: entities.userId,
          userId,
          workspaceLens: null,
          facetLens: true,
        })
      )
  );
const facetsVia = async (userId: string) =>
  idsOf(
    await db
      .select({ id: entityFacets.id })
      .from(entityFacets)
      .where(
        and(
          ...facetVisibilityConditions({ userId }),
          isNull(entityFacets.deletedAt)
        )
      )
  );
async function readable(userId: string, docId: string): Promise<boolean> {
  try {
    await loadReadableDocument(userId, docId);
    return true;
  } catch {
    return false;
  }
}

const sorted = (...ids: string[]) => [...ids].sort();

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  for (const u of [OWNER, GRANTED, OUTSIDER, NONPOD]) {
    await q(`insert into users (id, email) values ($1, $2)`, [
      u,
      `${u}@x.test`,
    ]);
  }
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner'),($3,$4,'member'),($5,$6,'member')`,
    [randomUUID(), OWNER, randomUUID(), GRANTED, randomUUID(), OUTSIDER]
  );
  await q(
    `insert into workspaces (id, name, owner_id) values ($1,'A',$3),($2,'B',$3)`,
    [WS_A, WS_B, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'editor'),($4,$5,$6,'editor'),($7,$2,$8,'editor')`,
    [
      randomUUID(),
      WS_A,
      GRANTED,
      randomUUID(),
      WS_B,
      OUTSIDER,
      randomUUID(),
      NONPOD,
    ]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, workspace_id) values
       ($1,'client','Client','role','shared',null),
       ($2,'sys-role','Sys','role','system',null),
       ($3,'b-role','B role','role','shared',$4)`,
    [ROLE_CLIENT, ROLE_SYS, ROLE_B, WS_B]
  );
  await q(
    `insert into profile_workspace_access (profile_id, workspace_id) values ($1,$2)`,
    [ROLE_CLIENT, WS_A]
  );
  for (const d of [D_CLIENT, D_SYS, D_B, D_DETACHED]) {
    await q(
      `insert into documents (id, user_id, workspace_id, title, type, current_version, content_revision) values ($1,$2,null,'Doc','markdown',1,1)`,
      [d, OWNER]
    );
  }
  for (const [e, d] of [
    [E_CLIENT, D_CLIENT],
    [E_SYS, D_SYS],
    [E_B, D_B],
    [E_DETACHED, D_DETACHED],
  ]) {
    await q(
      `insert into entities (id, user_id, workspace_id, title, document_id) values ($1,$2,null,'Person',$3)`,
      [e, OWNER, d]
    );
  }
  await q(
    `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, deleted_at) values
       ($1,$2,$3,$4,null,null),
       ($5,$6,$7,$4,null,null),
       ($8,$9,$10,$4,null,null),
       ($11,$12,$3,$4,null,now())`,
    [
      F_CLIENT,
      E_CLIENT,
      ROLE_CLIENT,
      OWNER,
      F_SYS,
      E_SYS,
      ROLE_SYS,
      F_B,
      E_B,
      ROLE_B,
      F_DETACHED,
      E_DETACHED,
    ]
  );
}, 60_000);

describe("decision B — a shared role shares its entity only with the spaces it is granted to", () => {
  it("owner (solo-pod view): reads every entity, facet and document it owns — unchanged", async () => {
    const all = sorted(E_CLIENT, E_SYS, E_B, E_DETACHED);
    expect(await seen(OWNER, entities)).toEqual(all);
    expect(await podLens(OWNER)).toEqual(all);
    expect(await facetsVia(OWNER)).toEqual(sorted(F_CLIENT, F_SYS, F_B));
    for (const d of [D_CLIENT, D_SYS, D_B, D_DETACHED]) {
      expect(await readable(OWNER, d)).toBe(true);
    }
  });

  it("member of a GRANTED space: reads the client-roled entity, its facet and its document", async () => {
    expect(await seen(GRANTED, entities)).toEqual([E_CLIENT]);
    expect(await podLens(GRANTED)).toEqual([E_CLIENT]);
    // The access rule does not soft-delete-gate facet ROWS (a detached row
    // stays readable to whoever may read it); it never shares the ENTITY.
    expect(await seen(GRANTED, entityFacets)).toEqual(
      sorted(F_CLIENT, F_DETACHED)
    );
    expect(await facetsVia(GRANTED)).toEqual([F_CLIENT]);
    expect(await seen(GRANTED, documents)).toEqual([D_CLIENT]);
    expect(await readable(GRANTED, D_CLIENT)).toBe(true);
    // A detached facet stops sharing; a system role granted nowhere shares nothing.
    expect(await readable(GRANTED, D_DETACHED)).toBe(false);
    expect(await readable(GRANTED, D_SYS)).toBe(false);
  });

  it("pod member NOT in any granted space: cannot read the entity or its document", async () => {
    // OUTSIDER sees only the role owned by ITS space (WS_B), never client.
    expect(await seen(OUTSIDER, entities)).toEqual([E_B]);
    expect(await podLens(OUTSIDER)).toEqual([E_B]);
    expect(await seen(OUTSIDER, entityFacets)).toEqual([F_B]);
    expect(await facetsVia(OUTSIDER)).toEqual([F_B]);
    expect(await seen(OUTSIDER, documents)).toEqual([D_B]);
    expect(await readable(OUTSIDER, D_CLIENT)).toBe(false);
    expect(await readable(OUTSIDER, D_B)).toBe(true);
  });

  it("member of a granted space who is NOT a pod member: nothing shared (pod_members conjunct)", async () => {
    expect(await seen(NONPOD, entities)).toEqual([]);
    expect(await seen(NONPOD, entityFacets)).toEqual([]);
    expect(await readable(NONPOD, D_CLIENT)).toBe(false);
  });

  it("in-memory twin (proposal review) agrees with the SQL floor", async () => {
    const facets = [
      {
        id: F_CLIENT,
        workspaceId: null,
        userId: OWNER,
        profileId: ROLE_CLIENT,
      },
      { id: F_SYS, workspaceId: null, userId: OWNER, profileId: ROLE_SYS },
      { id: F_B, workspaceId: null, userId: OWNER, profileId: ROLE_B },
    ];
    for (const u of [OWNER, GRANTED, OUTSIDER, NONPOD]) {
      const shared = await resolveViewerSharedRoleIds(db, u);
      const inMemory = facets
        .filter((f) => isFacetVisibleForLens(f, null, u, shared))
        .map((f) => f.id)
        .sort();
      expect(inMemory).toEqual(await facetsVia(u));
    }
  });
});
