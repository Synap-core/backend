/**
 * `ProfileRepository.update({ uiHints })` never wipes or forges the retirement
 * tombstone (`ui_hints.retired`) — against a REAL Postgres (PGlite).
 *
 * Pinned: a uiHints patch on a retired row REPLACES the other keys but keeps
 * `retired`; a patch carrying its own `retired` cannot overwrite it; on a row
 * with no tombstone a patch cannot plant one. The first case is the one the old
 * wholesale replace failed.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "../schema/index.js";
import { profiles } from "../schema/profiles.js";
import { ProfileRepository, markProfileRetired } from "./profile-repository.js";
import { readProfileRetirement } from "../utils/resolve-profile-for-apply.js";

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
let pg: PGlite;
let repo: ProfileRepository;

async function seed(uiHints: Record<string, unknown>): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into profiles (slug, display_name, scope, user_id, profile_kind, is_active, ui_hints, version)
     values ('client', 'Client', 'system', $1, 'kind', true, $2::jsonb, 1) returning id`,
    [USER, JSON.stringify(uiHints)]
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(ddlFor(profiles as unknown as PgTable));
  repo = new ProfileRepository(drizzle(pg, { schema }) as never);
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec(`truncate profiles;`);
});

describe(
  "ProfileRepository.update — uiHints keeps the retirement tombstone",
  { timeout: 60_000 },
  () => {
    it("a uiHints patch on a retired row replaces other keys but keeps `retired`", async () => {
      const id = await seed({ icon: "user", color: "blue" });
      await markProfileRetired(drizzle(pg, { schema }) as never, id, {
        reason: "conversion:test.op",
        mergedInto: "a0000000-0000-4000-8000-000000000001",
      });
      const before = readProfileRetirement((await repo.getById(id))!);
      expect(before).not.toBeNull();

      const updated = await repo.update(id, { uiHints: { icon: "star" } });

      expect(updated.uiHints).toEqual({ icon: "star", retired: before });
      expect(readProfileRetirement((await repo.getById(id))!)).toEqual(before);
    });

    it("a patch carrying its own `retired` cannot overwrite the existing tombstone", async () => {
      const id = await seed({});
      await markProfileRetired(drizzle(pg, { schema }) as never, id, {
        reason: "deleted",
      });
      const before = readProfileRetirement((await repo.getById(id))!);

      const updated = await repo.update(id, {
        uiHints: { icon: "star", retired: { at: "x", reason: "forged" } },
      });

      expect(readProfileRetirement(updated)).toEqual(before);
    });

    it("on a row with no tombstone, a patch replaces ui_hints and cannot plant one", async () => {
      const id = await seed({ icon: "user", color: "blue" });

      const updated = await repo.update(id, {
        uiHints: { icon: "star", retired: { at: "x", reason: "forged" } },
      });

      expect(updated.uiHints).toEqual({ icon: "star" });
      expect(readProfileRetirement(updated)).toBeNull();
    });
  }
);
