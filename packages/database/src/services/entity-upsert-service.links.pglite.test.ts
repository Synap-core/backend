/**
 * EntityUpsertService Step 1 on a real Postgres with the real link key: one row
 * per (provider, external_id, nango_connection_id) — migration 0261.
 *
 * Pinned:
 *   - several rows can match a record; only the caller's copy is resolved onto
 *     (an entity they own, or a row their own connection produced);
 *   - the caller's own connection row is preferred over an unstamped import row;
 *   - re-stamping an unstamped row to the connection that already holds its own
 *     row for the record does not throw: that row stays the connection's link
 *     and the unstamped row is left as is;
 *   - a member with no copy of their own creates one with their own link row.
 *
 * ENGINE: PGlite, ONE instance for the file; `entities` and
 * `entity_external_links` are created from their drizzle definitions (enums as
 * text, constraints dropped; the 0261 unique key added back). The entity create
 * door, role resolution and identity signals are stubbed (not what is tested).
 *
 * The collision case seeds the connection's own row pointing at an entity that
 * is not visible, which is how a row written by a concurrent run looks to this
 * read — PGlite has one connection, so a true interleaving is not reproduced.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => ({ pg: undefined as unknown }));

vi.mock("./facet-resolution-service.js", () => ({
  resolveRolePayload: vi.fn(async () => null),
}));

vi.mock("./identity-resolution-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./identity-resolution-service.js")>();
  return {
    ...actual,
    resolveIdentity: vi.fn(async () => ({
      match: null,
      candidates: [],
      crossKindCandidates: [],
    })),
    registerIdentitySignals: vi.fn(async () => undefined),
  };
});

vi.mock("../utils/materialize-entity.js", () => ({
  materializeEntity: vi.fn(async (input: { userId: string; title: string }) => {
    const id = randomUUID();
    await (holder.pg as PGlite).query(
      `insert into entities (id, user_id, type, title) values ($1, $2, 'event', $3)`,
      [id, input.userId, input.title]
    );
    return { entity: { id, userId: input.userId } };
  }),
}));

vi.mock("../repositories/facet-repository.js", () => ({
  FacetRepository: class {},
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { entities, entityExternalLinks } from "../schema/index.js";
import { EntityUpsertService } from "./entity-upsert-service.js";

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

let pg: PGlite;
let service: EntityUpsertService;

beforeAll(async () => {
  pg = new PGlite();
  holder.pg = pg;
  await pg.exec(ddlFor(entities as unknown as PgTable));
  await pg.exec(ddlFor(entityExternalLinks as unknown as PgTable));
  await pg.exec(
    `create unique index entity_external_links_provider_external_id_connection_idx
       on entity_external_links (provider, external_id, nango_connection_id);`
  );
  const db = drizzle(pg, { schema: { entities, entityExternalLinks } });
  service = new EntityUpsertService(db as never, {} as never);
}, 120_000);

beforeEach(async () => {
  await pg.exec(`delete from entity_external_links; delete from entities;`);
});

async function seedEntity(userId: string): Promise<string> {
  const id = randomUUID();
  await pg.query(
    `insert into entities (id, user_id, type, title) values ($1, $2, 'event', 'Acme sync')`,
    [id, userId]
  );
  return id;
}

async function seedLink(entityId: string, connectionId: string): Promise<void> {
  await pg.query(
    `insert into entity_external_links (entity_id, provider, external_id, nango_connection_id)
     values ($1, 'google', 'ev1', $2)`,
    [entityId, connectionId]
  );
}

async function linkRows() {
  const { rows } = await pg.query<{
    entity_id: string;
    nango_connection_id: string;
  }>(
    `select entity_id, nango_connection_id from entity_external_links
     where provider = 'google' and external_id = 'ev1' order by nango_connection_id`
  );
  return rows;
}

function upsertAs(userId: string, connectionId: string) {
  return service.upsert({
    profileSlug: "event",
    title: "Acme sync",
    properties: {},
    source: "google",
    externalId: "ev1",
    signals: [],
    workspaceId: null,
    userId,
    connectionId,
    provenance: { createdByKind: "system" },
  });
}

describe("EntityUpsertService Step 1 — one link row per connection", () => {
  it("re-stamps the member's own unstamped link to their connection; another member's row is untouched", async () => {
    const m1Event = await seedEntity("M1");
    const m2Event = await seedEntity("M2");
    await seedLink(m1Event, "conn-M1");
    await seedLink(m2Event, "direct-import");

    const res = await upsertAs("M2", "conn-M2");

    expect(res.action).toBe("updated");
    expect(res.entity.id).toBe(m2Event);
    expect(await linkRows()).toEqual([
      { entity_id: m1Event, nango_connection_id: "conn-M1" },
      { entity_id: m2Event, nango_connection_id: "conn-M2" },
    ]);
  });

  it("prefers the connection's own row over an unstamped import row", async () => {
    const imported = await seedEntity("M2");
    const mirrored = await seedEntity("M2");
    await seedLink(imported, "direct-import");
    await seedLink(mirrored, "conn-M2");

    const res = await upsertAs("M2", "conn-M2");

    expect(res.entity.id).toBe(mirrored);
    expect(await linkRows()).toEqual([
      { entity_id: mirrored, nango_connection_id: "conn-M2" },
      { entity_id: imported, nango_connection_id: "direct-import" },
    ]);
  });

  it("a re-stamp that collides with the connection's own row does not throw; both rows stay as they are", async () => {
    const imported = await seedEntity("M2");
    await seedLink(imported, "direct-import");
    const concurrent = randomUUID(); // entity not visible to this read
    await seedLink(concurrent, "conn-M2");

    const res = await upsertAs("M2", "conn-M2");

    expect(res.action).toBe("updated");
    expect(res.entity.id).toBe(imported);
    expect(await linkRows()).toEqual([
      { entity_id: concurrent, nango_connection_id: "conn-M2" },
      { entity_id: imported, nango_connection_id: "direct-import" },
    ]);
  });

  it("a member with no copy of their own creates one, with their own link row", async () => {
    const m1Event = await seedEntity("M1");
    await seedLink(m1Event, "conn-M1");

    const res = await upsertAs("M3", "conn-M3");

    expect(res.action).toBe("created");
    expect(res.entity.id).not.toBe(m1Event);
    expect(await linkRows()).toEqual([
      { entity_id: m1Event, nango_connection_id: "conn-M1" },
      { entity_id: res.entity.id, nango_connection_id: "conn-M3" },
    ]);
  });
});
