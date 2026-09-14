/**
 * R2 — a probe kind (D8) must never block or capture a real kind — against a
 * REAL Postgres (PGlite), DDL derived from the drizzle schema.
 *
 * Pinned:
 *  - a human/template `create()` whose unique-index SEAT holds a probe row
 *    RECLAIMS it in place (same id, restamped origin/lifecycle/owner) instead
 *    of raising 23505;
 *  - probe ENTITIES already on that profile stay hidden by their own marker
 *    (`notProbeEntityWhere`), while a real entity on the reclaimed kind lists;
 *  - inside a probe context there is no reclaim (probe vs probe still collides);
 *  - slug resolution (`getBySlug`, `getBySlugForWorkspace`,
 *    `findActiveBySlugAnyScope`) does not resolve a probe-only kind outside a
 *    probe context, so a human `entities.create` cannot attach to a hidden kind;
 *    inside a probe context it still does (dogfood uses its own probe kinds).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL, and, eq } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "../schema/index.js";
import { profiles } from "../schema/profiles.js";
import { entities } from "../schema/entities.js";
import { ProfileRepository } from "./profile-repository.js";
import {
  notProbeEntityWhere,
  runWithProbeWrites,
} from "../utils/request-write-context.js";

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

const USER = "99999999-9999-4999-8999-999999999999";
const WS = "11111111-1111-4111-8111-111111111111";
let pg: PGlite;
let db: ReturnType<typeof drizzle>;
let repo: ProfileRepository;

async function seedProfile(
  slug: string,
  scope: "system" | "workspace",
  origin: string
): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into profiles (slug, display_name, scope, workspace_id, user_id, profile_kind, is_active, origin, lifecycle, version, entity_scope)
     values ($1, $1, $2, $3, $4, 'kind', true, $5, 'experimental', 1, 'workspace') returning id`,
    [slug, scope, scope === "workspace" ? WS : null, USER, origin]
  );
  return r.rows[0]!.id;
}

async function seedEntity(profileId: string, title: string, probe: boolean) {
  await pg.query(
    `insert into entities (user_id, workspace_id, profile_id, type, title, system_data, properties)
     values ($1, $2, $3, 'podcast', $4, $5::jsonb, '{}'::jsonb)`,
    [USER, WS, profileId, title, JSON.stringify(probe ? { probe: true } : {})]
  );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(ddlFor(profiles as unknown as PgTable));
  await pg.exec(ddlFor(entities as unknown as PgTable));
  // `getBySlugForWorkspace` left-joins the shared-profile access table.
  await pg.exec(ddlFor(schema.profileWorkspaceAccess as unknown as PgTable));
  // The partial unique indexes the seat logic mirrors (baseline 419-429).
  await pg.exec(`
    create unique index profiles_slug_system_shared_uniq on profiles (slug) where scope in ('system','shared');
    create unique index profiles_slug_workspace_uniq on profiles (slug, workspace_id) where scope = 'workspace';
    create unique index profiles_slug_user_uniq on profiles (slug, user_id) where scope = 'user';
  `);
  db = drizzle(pg, { schema });
  repo = new ProfileRepository(db as never);
}, 120_000);

beforeEach(async () => {
  await pg.exec(`delete from entities; delete from profiles;`);
});

afterAll(async () => {
  await pg?.close();
});

const templateCreate = {
  slug: "podcast",
  displayName: "Podcast",
  scope: "workspace" as never,
  workspaceId: WS,
  userId: USER,
  origin: "template" as const,
  ownerKind: "workspace" as const,
  ownerId: WS,
  entityScope: "workspace" as const,
};

describe("R2 — a probe row in the seat is reclaimed, never a 23505", () => {
  it("a template create reclaims the probe row in place (same id, restamped)", async () => {
    const probeId = await seedProfile("podcast", "workspace", "probe");
    const created = await repo.create(templateCreate);
    expect(created.id).toBe(probeId);
    expect(created).toMatchObject({
      origin: "template",
      lifecycle: "active",
      ownerKind: "workspace",
      ownerId: WS,
      isActive: true,
    });
    const { rows } = await pg.query<{ n: number }>(
      `select count(*)::int as n from profiles where slug = 'podcast'`
    );
    expect(rows[0]!.n).toBe(1);
  });

  it("probe ENTITIES on the reclaimed kind stay hidden; a real entity lists", async () => {
    const probeId = await seedProfile("podcast", "workspace", "probe");
    await seedEntity(probeId, "probe episode", true);
    const reclaimed = await repo.create(templateCreate);
    await seedEntity(reclaimed.id, "real episode", false);
    const listed = await db
      .select({ title: entities.title })
      .from(entities)
      .where(and(eq(entities.profileId, reclaimed.id), notProbeEntityWhere()));
    expect(listed.map((r) => r.title)).toEqual(["real episode"]);
  });

  it("inside a probe context there is no reclaim (probe vs probe still collides)", async () => {
    await seedProfile("podcast", "workspace", "probe");
    await expect(
      runWithProbeWrites(true, () => repo.create(templateCreate))
    ).rejects.toThrow();
  });

  it("an empty seat still inserts a new row", async () => {
    const created = await repo.create(templateCreate);
    expect(created).toMatchObject({ slug: "podcast", origin: "template" });
  });
});

describe("R2 — slug resolution never lands a human on a probe-only kind", () => {
  it("getBySlug / findActiveBySlugAnyScope: hidden outside a probe context, resolved inside", async () => {
    await seedProfile("dogfood-x", "system", "probe");
    expect(await repo.getBySlug("dogfood-x")).toBeNull();
    expect(await repo.findActiveBySlugAnyScope("dogfood-x")).toEqual([]);
    const inside = await runWithProbeWrites(true, () =>
      repo.getBySlug("dogfood-x")
    );
    expect(inside?.slug).toBe("dogfood-x");
  });

  it("getBySlugForWorkspace: hidden outside a probe context, resolved inside", async () => {
    await seedProfile("dogfood-ws", "workspace", "probe");
    expect(await repo.getBySlugForWorkspace("dogfood-ws", WS)).toBeNull();
    const inside = await runWithProbeWrites(true, () =>
      repo.getBySlugForWorkspace("dogfood-ws", WS)
    );
    expect(inside?.slug).toBe("dogfood-ws");
  });

  it("a real kind beside a probe of another slug is unaffected", async () => {
    await seedProfile("person", "system", "core");
    expect((await repo.getBySlug("person"))?.slug).toBe("person");
  });
});
