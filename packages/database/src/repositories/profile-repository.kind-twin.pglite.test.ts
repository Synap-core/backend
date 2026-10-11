/**
 * Kind twins — slug precedence with no workspace lens, and the create floor
 * that refuses minting a new twin — against a REAL Postgres (PGlite), DDL
 * derived from the drizzle schema.
 *
 * Pinned (SCHEMA-CONVERGENCE-PLAN.md, Defect A; founder decision 3/4):
 *  - `getBySlug(slug, undefined, userId)` — a pod-wide write — resolves a KIND
 *    to its system/shared row, never to a workspace twin, even an OLDER one
 *    (the live `knowledge` twin predates the system row by nine hours);
 *  - inside a workspace (`getBySlugForWorkspace`) that workspace's row still
 *    wins; a ROLE keeps workspace-first with no lens; the caller's own
 *    user-scope row still wins with no lens;
 *  - `create()` refuses a workspace/user-scoped KIND when an ACTIVE
 *    system/shared kind holds the slug, naming the holder; roles, system
 *    creates, and slugs whose pod-wide holder is soft-deleted are unaffected.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../schema/index.js";
import { ProfileRepository } from "./profile-repository.js";
import { isProfileKindTwinError } from "../utils/profile-slug-precedence.js";
import { resolveProfileForApply } from "../utils/resolve-profile-for-apply.js";

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
  return `create table if not exists "${cfg.name}" (${columns.join(", ")});`;
}

const USER = "99999999-9999-4999-8999-999999999999";
const WS = "11111111-1111-4111-8111-111111111111"; // e.g. Pod Admin
const WS2 = "22222222-2222-4222-8222-222222222222"; // e.g. Builder
let pg: PGlite;
let repo: ProfileRepository;

async function seedProfile(opts: {
  slug: string;
  scope: "system" | "shared" | "workspace" | "user";
  kind?: "kind" | "role";
  workspaceId?: string | null;
  isActive?: boolean;
  createdAt: string;
}): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into profiles (slug, display_name, scope, workspace_id, user_id, profile_kind, is_active, origin, lifecycle, version, entity_scope, created_at)
     values ($1, $1, $2, $3, $4, $5, $6, 'core', 'active', 1, 'pod', $7) returning id`,
    [
      opts.slug,
      opts.scope,
      opts.workspaceId ?? null,
      USER,
      opts.kind ?? "kind",
      opts.isActive ?? true,
      opts.createdAt,
    ]
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  pg = new PGlite();
  // Every table: getBySlug's user floor composes member/owned/pod-visible
  // workspace subqueries over several tables (workspaces, members, users, …).
  const tables = Object.values(schema).filter((v): v is PgTable =>
    is(v, PgTable)
  );
  expect(tables.length).toBeGreaterThan(20); // the scan found the schema
  for (const t of tables) await pg.exec(ddlFor(t));
  await pg.exec(`
    create unique index profiles_slug_system_shared_uniq on profiles (slug) where scope in ('system','shared');
    create unique index profiles_slug_workspace_uniq on profiles (slug, workspace_id) where scope = 'workspace';
    create unique index profiles_slug_user_uniq on profiles (slug, user_id) where scope = 'user';
  `);
  await pg.query(
    `insert into workspaces (id, name, owner_id) values ($1, 'Pod Admin', $3), ($2, 'Builder', $3)`,
    [WS, WS2, USER]
  );
  const db = drizzle(pg, { schema });
  repo = new ProfileRepository(db as never);
}, 120_000);

beforeEach(async () => {
  await pg.exec(`delete from profile_workspace_access; delete from profiles;`);
});

afterAll(async () => {
  await pg?.close();
});

describe("getBySlug with NO workspace lens — a kind resolves pod-wide", () => {
  it("system row beats an OLDER workspace twin (the live knowledge case)", async () => {
    await seedProfile({
      slug: "knowledge",
      scope: "workspace",
      workspaceId: WS,
      createdAt: "2026-06-07T14:34:26Z",
    });
    const systemId = await seedProfile({
      slug: "knowledge",
      scope: "system",
      createdAt: "2026-06-07T23:27:52Z",
    });
    const got = await repo.getBySlug("knowledge", undefined, USER);
    expect(got?.id).toBe(systemId);
  });

  it("shared row beats a workspace twin", async () => {
    await seedProfile({
      slug: "partner",
      scope: "workspace",
      workspaceId: WS,
      createdAt: "2026-06-01T00:00:00Z",
    });
    const sharedId = await seedProfile({
      slug: "partner",
      scope: "shared",
      workspaceId: WS2,
      createdAt: "2026-07-01T00:00:00Z",
    });
    expect((await repo.getBySlug("partner", undefined, USER))?.id).toBe(
      sharedId
    );
  });

  it("inside a workspace, that workspace's twin still wins", async () => {
    const twinId = await seedProfile({
      slug: "knowledge",
      scope: "workspace",
      workspaceId: WS,
      createdAt: "2026-06-07T14:34:26Z",
    });
    const systemId = await seedProfile({
      slug: "knowledge",
      scope: "system",
      createdAt: "2026-06-07T23:27:52Z",
    });
    expect((await repo.getBySlug("knowledge", WS, USER))?.id).toBe(twinId);
    // …and another workspace's lens sees the system row, not WS's twin.
    expect((await repo.getBySlug("knowledge", WS2, USER))?.id).toBe(systemId);
  });

  it("a ROLE keeps workspace-first with no lens (per-workspace roles are legitimate)", async () => {
    const wsRoleId = await seedProfile({
      slug: "client",
      scope: "workspace",
      kind: "role",
      workspaceId: WS,
      createdAt: "2026-07-01T00:00:00Z",
    });
    await seedProfile({
      slug: "client",
      scope: "system",
      kind: "role",
      createdAt: "2026-06-01T00:00:00Z",
    });
    expect((await repo.getBySlug("client", undefined, USER))?.id).toBe(
      wsRoleId
    );
  });

  it("the caller's own user-scope row still wins with no lens", async () => {
    const userRowId = await seedProfile({
      slug: "recipe",
      scope: "user",
      createdAt: "2026-07-01T00:00:00Z",
    });
    await seedProfile({
      slug: "recipe",
      scope: "system",
      createdAt: "2026-06-01T00:00:00Z",
    });
    expect((await repo.getBySlug("recipe", undefined, USER))?.id).toBe(
      userRowId
    );
  });
});

const workspaceKindCreate = {
  slug: "knowledge",
  displayName: "Knowledge",
  scope: "workspace" as never,
  workspaceId: WS,
  userId: USER,
  origin: "authored" as const,
};

describe("create() refuses minting a kind twin", () => {
  it("a workspace kind over an ACTIVE system kind is refused, naming the holder", async () => {
    const systemId = await seedProfile({
      slug: "knowledge",
      scope: "system",
      createdAt: "2026-06-07T23:27:52Z",
    });
    const err = await repo.create(workspaceKindCreate).catch((e) => e);
    expect(isProfileKindTwinError(err)).toBe(true);
    expect(err.holder).toEqual({ id: systemId, scope: "system" });
    const { rows } = await pg.query<{ n: number }>(
      `select count(*)::int as n from profiles where slug = 'knowledge'`
    );
    expect(rows[0]!.n).toBe(1);
  });

  it("a user-scoped kind over an active SHARED kind is refused", async () => {
    await seedProfile({
      slug: "partner",
      scope: "shared",
      workspaceId: WS2,
      createdAt: "2026-07-01T00:00:00Z",
    });
    const err = await repo
      .create({
        ...workspaceKindCreate,
        slug: "partner",
        scope: "user" as never,
        workspaceId: undefined,
      })
      .catch((e) => e);
    expect(isProfileKindTwinError(err)).toBe(true);
  });

  it("a workspace ROLE with a system role's slug is allowed", async () => {
    await seedProfile({
      slug: "client",
      scope: "system",
      kind: "role",
      createdAt: "2026-06-01T00:00:00Z",
    });
    const created = await repo.create({
      ...workspaceKindCreate,
      slug: "client",
      profileKind: "role",
    });
    expect(created.scope).toBe("workspace");
  });

  it("a soft-deleted pod-wide holder does not block (the apply door's deferral)", async () => {
    await seedProfile({
      slug: "campaign",
      scope: "system",
      isActive: false,
      createdAt: "2026-06-01T00:00:00Z",
    });
    const created = await repo.create({
      ...workspaceKindCreate,
      slug: "campaign",
    });
    expect(created.scope).toBe("workspace");
  });
});

describe("template apply meeting a pod-wide kind REUSES it — never a twin, never a throw", () => {
  // The live `document` twin: a system row plus an older CRM workspace row.
  // A boot reconcile / install of a template declaring `document` must resolve
  // to an existing row in every workspace, so the create floor is never hit.
  it("resolves the twin pair without creating, in the twin's workspace and elsewhere", async () => {
    const twinId = await seedProfile({
      slug: "document",
      scope: "workspace",
      workspaceId: WS,
      createdAt: "2026-06-01T00:00:00Z",
    });
    const systemId = await seedProfile({
      slug: "document",
      scope: "system",
      createdAt: "2026-06-02T00:00:00Z",
    });
    const apply = (workspaceId: string) =>
      resolveProfileForApply(repo, {
        slug: "document",
        declaredScope: "workspace",
        workspaceId,
        actorUserId: USER,
      });
    const inTwinWs = await apply(WS);
    expect(inTwinWs.profile?.id).toBe(twinId);
    const elsewhere = await apply(WS2);
    expect(elsewhere.profile?.id).toBe(systemId);
    expect(elsewhere.reused).toBe(true);
    const { rows } = await pg.query<{ n: number }>(
      `select count(*)::int as n from profiles where slug = 'document'`
    );
    expect(rows[0]!.n).toBe(2);
  });

  it("a SHARED kind not yet granted to the workspace is reused and granted", async () => {
    const sharedId = await seedProfile({
      slug: "partner",
      scope: "shared",
      workspaceId: WS2,
      createdAt: "2026-07-01T00:00:00Z",
    });
    const res = await resolveProfileForApply(repo, {
      slug: "partner",
      declaredScope: "workspace",
      workspaceId: WS,
      actorUserId: USER,
    });
    expect(res.profile?.id).toBe(sharedId);
    expect(res.promotionDeferred).toBe(false);
  });
});
