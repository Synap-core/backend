/**
 * A part follows its whole (founder decision 22226da5, 2026-11-09): a
 * POD-WIDE document that becomes the body of an entity STORED in a space is
 * filed in that space, at the one repository every `documentId` attach
 * converges on (`EntityRepository.create` / `.update`).
 *
 * The REAL repository on PGlite (DDL from the Drizzle schema). Stubbed: the
 * profile / lifecycle / property-index services (not this seam).
 *
 * Rows rule out: an attach that leaves the body pod-wide (the bug), one that
 * MOVES a document already in another space, one that files a homed pod-wide
 * entity's body into its home (that would hand the home's editors a private
 * document), and a create with a body id skipping the rule.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { documents, entities } from "../schema/index.js";
import { EntityRepository } from "./entity-repository.js";
import { ProfileResolutionService } from "../services/profile-resolution-service.js";
import { PropertyIndexService } from "../services/property-index-service.js";
import type { EventRepository } from "./event-repository.js";

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

const USER = randomUUID();
const W = randomUUID(); // the entity's space
const X = randomUUID(); // another space
const H = randomUUID(); // a pod-wide entity's home
const PROFILE = randomUUID();

let pg: PGlite;
let repo: EntityRepository;

const space = async (documentId: string) =>
  (
    await pg.query<{ workspace_id: string | null }>(
      `select workspace_id from documents where id = $1`,
      [documentId]
    )
  ).rows[0]?.workspace_id;

async function doc(ws: string | null): Promise<string> {
  const id = randomUUID();
  await pg.query(
    `insert into documents (id, user_id, workspace_id, title, type) values ($1,$2,$3,'Body','markdown')`,
    [id, USER, ws]
  );
  return id;
}

async function entity(ws: string | null, home: string | null = null) {
  const id = randomUUID();
  await pg.query(
    `insert into entities (id, user_id, workspace_id, home_workspace_id, profile_id, type, title, properties)
     values ($1,$2,$3,$4,$5,'note','Note','{}'::jsonb)`,
    [id, USER, ws, home, PROFILE]
  );
  return id;
}

beforeAll(async () => {
  pg = new PGlite();
  for (const t of [entities, documents]) await pg.exec(ddlFor(t as PgTable));
  const db = drizzle(pg, { schema: { entities, documents } });

  vi.spyOn(
    ProfileResolutionService.prototype,
    "getEffectiveProperties"
  ).mockResolvedValue([] as never);
  vi.spyOn(
    ProfileResolutionService.prototype,
    "getEffectiveLifecycle"
  ).mockResolvedValue(null as never);
  vi.spyOn(
    ProfileResolutionService.prototype,
    "resolveProfile"
  ).mockResolvedValue({
    id: PROFILE,
    slug: "note",
    profileKind: "kind",
    applicableKinds: [],
  } as never);
  vi.spyOn(
    PropertyIndexService.prototype,
    "indexEntityProperties"
  ).mockResolvedValue(undefined as never);
  vi.spyOn(PropertyIndexService.prototype, "reindexEntity").mockResolvedValue(
    undefined as never
  );
  const eventRepo = { append: vi.fn().mockResolvedValue(undefined) };
  repo = new EntityRepository(db, eventRepo as unknown as EventRepository);
}, 60_000);

describe("attaching a body files it in the entity's space", () => {
  it("THE BUG: a pod-wide document attached to an entity in a space moves into that space", async () => {
    const e = await entity(W);
    const d = await doc(null);
    await repo.update(e, { documentId: d }, USER);
    expect(await space(d)).toBe(W);
  });

  it("a document already in another space is left where it is", async () => {
    const e = await entity(W);
    const d = await doc(X);
    await repo.update(e, { documentId: d }, USER);
    expect(await space(d)).toBe(X);
  });

  it("the body of a pod-wide entity stays pod-wide, even when the entity is filed for a space", async () => {
    for (const home of [H, null]) {
      const e = await entity(null, home);
      const d = await doc(null);
      await repo.update(e, { documentId: d }, USER);
      expect(await space(d)).toBeNull();
    }
  });

  it("an update that does not touch the body moves nothing", async () => {
    const d = await doc(null);
    const e = await entity(W);
    await pg.query(`update entities set document_id = $1 where id = $2`, [
      d,
      e,
    ]);
    await repo.update(e, { title: "Renamed" }, USER);
    expect(await space(d)).toBeNull();
  });

  it("a create naming a pod-wide body files it in the new entity's space", async () => {
    const d = await doc(null);
    await repo.create(
      {
        profileSlug: "note",
        title: "With body",
        documentId: d,
        workspaceId: W,
        userId: USER,
      },
      USER
    );
    expect(await space(d)).toBe(W);
  });
});
