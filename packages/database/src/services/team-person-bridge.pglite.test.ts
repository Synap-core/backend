/**
 * team-member is a PER-WORKSPACE role on a real Postgres (PGlite), through the
 * REAL seed (`ensureTeamMemberRoleProfile`), the REAL `FacetRepository` and the
 * REAL bridge attach/detach SQL.
 *
 * Pinned (FX-B1, RV2 MUST-FIX 2):
 *  - joining two workspaces yields one team-member facet PER workspace (the
 *    W2b "shared/system role ⇒ pod-wide" rule does not collapse it);
 *  - removing the member from ONE workspace detaches exactly that facet, and
 *    the other workspace's facet stays live;
 *  - a pod seeded before the category existed gets it stamped at boot.
 *
 * The earlier bridge tests mock the db, which is how "attach stores NULL,
 * detach looks up by workspace ⇒ no_facet forever" shipped green.
 *
 * ENGINE: PGlite, ONE instance for the file; tables built from their drizzle
 * definitions (enums as text, constraints dropped; the 0174 facet unique key
 * added back). Identity resolution is stubbed to a strong match on the seeded
 * person (it is not what is tested).
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterAll,
} from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  personId: "",
}));

vi.mock("../client-pg.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../client-pg.js")>()),
  getDb: async () => holder.db,
}));

vi.mock("./identity-resolution-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./identity-resolution-service.js")>();
  return {
    ...actual,
    resolveIdentity: vi.fn(async () => ({
      match: "strong",
      entity: { id: holder.personId },
      candidates: [],
      crossKindCandidates: [],
    })),
    registerIdentitySignals: vi.fn(async () => undefined),
  };
});

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "../schema/index.js";
import {
  entities,
  entityFacets,
  profiles,
  profileWorkspaceAccess,
  users,
  workspaceMembers,
} from "../schema/index.js";
import {
  detachTeamMemberFacet,
  ensureTeamPersonForMember,
} from "./team-person-bridge.js";
import { ensureTeamMemberRoleProfile } from "../utils/ensure-system-profiles.js";
import { WORKSPACE_MEMBERSHIP_ROLE_CATEGORY } from "../utils/facet-visibility.js";

/** CREATE TABLE from the drizzle definition — columns, types and literal defaults. */
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

const OWNER = "owner-user";
const MEMBER = "member-user";
const CRM = "f73f40f0-c023-4f2e-b55a-10d3f7539b1f";
const OPS = "708edb59-2299-42d4-9f7b-4c8424aed5c6";

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

beforeAll(async () => {
  pg = new PGlite();
  for (const t of [
    users,
    workspaceMembers,
    entities,
    entityFacets,
    profiles,
    profileWorkspaceAccess,
  ]) {
    await pg.exec(ddlFor(t as unknown as PgTable));
  }
  // 0174 live-facet unique key (a lens-collapsing write would hit it).
  await pg.exec(`
    CREATE UNIQUE INDEX entity_facets_entity_profile_ctx_ws_uniq ON entity_facets (
      entity_id, profile_id,
      COALESCE(context_entity_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)
    ) WHERE deleted_at IS NULL;`);
  db = drizzle(pg, { schema });
  holder.db = db;
}, 120_000);

beforeEach(async () => {
  await pg.exec(
    `delete from entity_facets; delete from entities; delete from profiles;
     delete from workspace_members; delete from users;`
  );
  await pg.query(
    `insert into users (id, email, name, user_type) values
       ($1, 'owner@x.test', 'Owner', 'human'),
       ($2, 'sam@x.test', 'Sam', 'human')`,
    [OWNER, MEMBER]
  );
  for (const ws of [CRM, OPS]) {
    await pg.query(
      `insert into workspace_members (id, workspace_id, user_id, role) values
         (gen_random_uuid(), $1, $2, 'owner'), (gen_random_uuid(), $1, $3, 'member')`,
      [ws, OWNER, MEMBER]
    );
  }
  holder.personId = randomUUID();
  await pg.query(
    `insert into entities (id, user_id, type, title) values ($1, $2, 'person', 'Sam')`,
    [holder.personId, OWNER]
  );
});

afterAll(async () => {
  await pg?.close();
});

const liveFacets = async () =>
  (
    await pg.query<{ workspace_id: string | null }>(
      `select f.workspace_id from entity_facets f
         join profiles p on p.id = f.profile_id
        where p.slug = 'team-member' and f.deleted_at is null
        order by f.workspace_id`
    )
  ).rows.map((r) => r.workspace_id);

describe("team-member is a per-workspace role (real FacetRepository)", () => {
  it("joining two workspaces keeps one facet per workspace; leaving one detaches exactly it", async () => {
    const seeded = await ensureTeamMemberRoleProfile();
    expect(seeded.status, seeded.error).toBe("created");

    for (const ws of [CRM, OPS]) {
      const r = await ensureTeamPersonForMember(db, {
        memberUserId: MEMBER,
        workspaceId: ws,
        ownerUserId: OWNER,
      });
      expect(r.entityId).toBe(holder.personId);
    }
    expect(await liveFacets()).toEqual([CRM, OPS].sort());

    const out = await detachTeamMemberFacet(db, {
      memberUserId: MEMBER,
      workspaceId: CRM,
      ownerUserId: OWNER,
    });
    expect(out).toMatchObject({ detached: true, entityId: holder.personId });
    expect(await liveFacets()).toEqual([OPS]);
  });

  it("a pod seeded before the category existed is stamped at boot", async () => {
    await pg.query(
      `insert into profiles (slug, display_name, profile_kind, scope, applicable_kinds, entity_scope)
       values ('team-member', 'Team Member', 'role', 'system', '{person}', 'workspace')`
    );
    const r = await ensureTeamMemberRoleProfile();
    expect(r.status, r.error).toBe("exists");
    const row = (
      await pg.query<{ role_category: string | null }>(
        `select role_category from profiles where slug = 'team-member'`
      )
    ).rows[0];
    expect(row.role_category).toBe(WORKSPACE_MEMBERSHIP_ROLE_CATEGORY);
  });
});
