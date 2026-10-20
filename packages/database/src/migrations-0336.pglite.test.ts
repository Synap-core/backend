/**
 * REAL-POSTGRES (PGlite) test for migration 0336 — site collections (collection
 * door C1a: "a published project is a site").
 *
 * PRE-0336 SHAPE: `resource_shares` is the baseline's own CREATE TABLE block
 * plus 0276 run on it (the real pre-0336 table, with 0276's
 * `resource_shares_live_public_uidx` and trigger), never a hand-written copy.
 *
 * Pinned:
 *   - 0336 runs TWICE without error; existing rows are untouched;
 *   - the five columns exist and equal the Drizzle table; the baseline and the
 *     boot coherence list name each of them, attributed to 0336;
 *   - the 0276 "one live publication per resource" index is REPLACED by the
 *     standalone one: still one live standalone publication per resource and
 *     one live site per project, but a record may now be standalone AND a site
 *     member, and one member row per (site, record);
 *   - the CHECKs refuse a member without a collection / public id, a site
 *     config on a non-site row, a malformed slug;
 *   - slug uniqueness among a collection's live PUBLISHED members only;
 *     `public_id` unique;
 *   - REVOKE IS PERMANENT covers the site columns; `public_id` goes NULL →
 *     value once and never changes again;
 *   - deleting a site row deletes its member rows (FK cascade).
 *
 * NOT covered: the whole migration chain (CI's `migrate` step on real
 * Postgres); the site-revoke member cascade (a service act, pinned in
 * `services/sharing/__tests__/site-service.pglite.test.ts`).
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { resourceShares } from "./schema/sharing.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, `../migrations/${f}`), "utf8");
const M0336_FILE = "0336_site_collections.sql";
const M0336 = read(M0336_FILE);
const M0276 = read("0276_exposure_substrate.sql");
const BASELINE = read("0000_baseline_schema.sql");

/** `ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "c"` pairs in a SQL text. */
function addedColumns(
  sqlText: string
): Array<{ table: string; column: string }> {
  const re = /ALTER TABLE "([a-z_]+)" ADD COLUMN IF NOT EXISTS "([a-z_]+)"/g;
  return Array.from(sqlText.matchAll(re), (m) => ({
    table: m[1]!,
    column: m[2]!,
  }));
}
const ADDED = addedColumns(M0336);

function baselineCreate(table: string): string {
  const m = BASELINE.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS "${table}" \\([\\s\\S]*?\\n\\);`)
  );
  if (!m) throw new Error(`baseline has no CREATE TABLE for ${table}`);
  return m[0];
}

/** The tables 0276 references, reduced to what it touches. */
const REFERENCED = `
  create table "workspaces" (id uuid primary key);
  create table "projects" (id uuid primary key);
  create table "workspace_members" (id uuid primary key default gen_random_uuid(), workspace_id uuid, user_id text);
  create table "document_versions" (id uuid primary key);
  create table "views" (id uuid primary key, project_id uuid);
  create table "project_members" (id uuid primary key default gen_random_uuid());
`;

async function pre0336(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(REFERENCED + baselineCreate("resource_shares"));
  await pg.exec(M0276);
  return pg;
}

async function migrated(): Promise<PGlite> {
  const pg = await pre0336();
  await pg.exec(M0336);
  return pg;
}

async function columnsOf(pg: PGlite): Promise<string[]> {
  const r = await pg.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'resource_shares'`
  );
  return r.rows.map((x) => x.column_name).sort();
}

async function indexesOf(pg: PGlite): Promise<string[]> {
  const r = await pg.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'resource_shares'`
  );
  return r.rows.map((x) => x.indexname).sort();
}

interface Row {
  id?: string;
  resource_type?: string;
  resource_id?: string;
  audience?: string;
  state?: string;
  site_share_id?: string | null;
  site_config?: unknown;
  public_id?: string | null;
  public_slug?: string | null;
  published_collection?: string | null;
  revoked_at?: string | null;
}

/** Insert one row; published rows get the 0276-required time + snapshot. */
async function insert(pg: PGlite, row: Row): Promise<string> {
  const id = row.id ?? randomUUID();
  const state = row.state ?? "draft";
  await pg.query(
    `INSERT INTO resource_shares
       (id, resource_type, resource_id, audience, state, created_by,
        published_at, published_properties,
        site_share_id, site_config, public_id, public_slug, published_collection, revoked_at)
     VALUES ($1,$2,$3,$4,$5,'u-1',$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12,$13)`,
    [
      id,
      row.resource_type ?? "entity",
      row.resource_id ?? randomUUID(),
      row.audience ?? "public",
      state,
      state === "published" ? new Date().toISOString() : null,
      state === "published" ? "{}" : null,
      row.site_share_id ?? null,
      row.site_config === undefined ? null : JSON.stringify(row.site_config),
      row.public_id ?? null,
      row.public_slug ?? null,
      row.published_collection ?? null,
      row.revoked_at ?? null,
    ]
  );
  return id;
}

const site = (pg: PGlite, projectId = randomUUID(), extra: Row = {}) =>
  insert(pg, {
    resource_type: "project",
    resource_id: projectId,
    site_config: { version: 1, collections: {} },
    ...extra,
  });

let n = 0;
const pid = () => `p_${String(++n).padStart(16, "0")}`;
const member = (pg: PGlite, siteId: string, extra: Row = {}) =>
  insert(pg, {
    site_share_id: siteId,
    published_collection: "paper",
    public_id: pid(),
    ...extra,
  });

async function sqlState(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
}

describe("migration 0336 — site collections", { timeout: 60_000 }, () => {
  it("non-vacuity: Drizzle declares the columns, the pre-0336 table lacks them and has the 0276 index", async () => {
    const declared = getTableConfig(resourceShares).columns.map((c) => c.name);
    expect(ADDED.map((a) => a.column).sort()).toEqual(
      [
        "public_id",
        "public_slug",
        "published_collection",
        "site_config",
        "site_share_id",
      ].sort()
    );
    for (const a of ADDED) expect(declared).toContain(a.column);
    const pg = await pre0336();
    const cols = await columnsOf(pg);
    for (const a of ADDED) expect(cols).not.toContain(a.column);
    expect(await indexesOf(pg)).toContain("resource_shares_live_public_uidx");
  });

  it("runs twice, keeps existing rows, and ends with exactly the Drizzle columns", async () => {
    const pg = await pre0336();
    // The pre-0336 table has no site columns: a W3 publication as 0276 wrote it.
    const kept = randomUUID();
    await pg.query(
      `INSERT INTO resource_shares (id, resource_type, resource_id, audience, state, created_by, published_at, published_properties)
       VALUES ($1, 'entity', gen_random_uuid(), 'public', 'published', 'u-1', now(), '{}'::jsonb)`,
      [kept]
    );
    await pg.exec(M0336);
    await pg.exec(M0336);
    const declared = getTableConfig(resourceShares)
      .columns.map((c) => c.name)
      .sort();
    expect(await columnsOf(pg)).toEqual(declared);
    const r = await pg.query<Record<string, unknown>>(
      `SELECT id, state, site_share_id, site_config, public_id FROM resource_shares`
    );
    expect(r.rows).toEqual([
      {
        id: kept,
        state: "published",
        site_share_id: null,
        site_config: null,
        public_id: null,
      },
    ]);
  });

  it("replaces the 0276 live-public index with the standalone one (and adds the site indexes)", async () => {
    const pg = await migrated();
    const idx = await indexesOf(pg);
    expect(idx).not.toContain("resource_shares_live_public_uidx");
    for (const name of [
      "resource_shares_live_public_standalone_uidx",
      "resource_shares_live_site_member_uidx",
      "resource_shares_site_slug_uidx",
      "resource_shares_public_id_uidx",
      "resource_shares_site_list_idx",
    ]) {
      expect(idx).toContain(name);
    }
  });

  it("one live standalone publication per record, one live site per project; a revoked one frees the slot", async () => {
    const pg = await migrated();
    const entity = randomUUID();
    await insert(pg, { resource_id: entity });
    expect(await sqlState(insert(pg, { resource_id: entity }))).toBe("23505");
    const project = randomUUID();
    const s1 = await site(pg, project);
    expect(await sqlState(site(pg, project))).toBe("23505");
    await pg.query(
      `UPDATE resource_shares SET revoked_at = now() WHERE id = $1`,
      [s1]
    );
    expect(await sqlState(site(pg, project))).toBeNull();
  });

  it("a record may be standalone AND a member of two sites, but one live member row per (site, record)", async () => {
    const pg = await migrated();
    const entity = randomUUID();
    await insert(pg, { resource_id: entity });
    const s1 = await site(pg);
    const s2 = await site(pg);
    expect(await sqlState(member(pg, s1, { resource_id: entity }))).toBeNull();
    expect(await sqlState(member(pg, s2, { resource_id: entity }))).toBeNull();
    expect(await sqlState(member(pg, s1, { resource_id: entity }))).toBe(
      "23505"
    );
  });

  it("CHECKs: a member needs an entity row, a collection and a public id; site_config only on a site row; slug shape", async () => {
    const pg = await migrated();
    const s = await site(pg);
    for (const bad of [
      { published_collection: null },
      { public_id: null },
      { resource_type: "view" },
      { audience: "link" },
    ] as Row[]) {
      expect(await sqlState(member(pg, s, bad))).toBe("23514");
    }
    expect(
      await sqlState(
        insert(pg, { site_config: { version: 1, collections: {} } })
      )
    ).toBe("23514");
    expect(
      await sqlState(
        member(pg, s, { site_config: { version: 1, collections: {} } })
      )
    ).toBe("23514");
    for (const slug of ["Has-Caps", "a--b", "-a", "a_b", "x".repeat(97)]) {
      expect(await sqlState(member(pg, s, { public_slug: slug }))).toBe(
        "23514"
      );
    }
    expect(
      await sqlState(member(pg, s, { public_slug: "hello-world-2" }))
    ).toBeNull();
  });

  it("slug unique among a collection's live PUBLISHED members only; public_id unique", async () => {
    const pg = await migrated();
    const s = await site(pg);
    await member(pg, s, { public_slug: "dup", state: "published" });
    expect(
      await sqlState(member(pg, s, { public_slug: "dup", state: "published" }))
    ).toBe("23505");
    // A draft member, or another collection, may hold the same slug.
    expect(await sqlState(member(pg, s, { public_slug: "dup" }))).toBeNull();
    expect(
      await sqlState(
        member(pg, s, {
          public_slug: "dup",
          state: "published",
          published_collection: "person",
        })
      )
    ).toBeNull();
    const fixed = "p_AAAAAAAAAAAAAAAA";
    await member(pg, s, { public_id: fixed });
    expect(await sqlState(member(pg, s, { public_id: fixed }))).toBe("23505");
  });

  it("revoke is permanent for the site columns; a public id is set once and never changes", async () => {
    const pg = await migrated();
    const s1 = await site(pg);
    const s2 = await site(pg);
    const m = await member(pg, s1);
    // Live row: public_id can never change, NULL → value is allowed once.
    expect(
      await sqlState(
        pg.query(`UPDATE resource_shares SET public_id = $2 WHERE id = $1`, [
          m,
          pid(),
        ])
      )
    ).toBe("23514");
    const standalone = await insert(pg, {});
    expect(
      await sqlState(
        pg.query(`UPDATE resource_shares SET public_id = $2 WHERE id = $1`, [
          standalone,
          pid(),
        ])
      )
    ).toBeNull();
    await pg.query(
      `UPDATE resource_shares SET revoked_at = now() WHERE id = ANY($1)`,
      [[m, s1]]
    );
    for (const [id, set, value] of [
      [m, "site_share_id", s2],
      [m, "public_slug", "moved"],
      [m, "published_collection", "person"],
      [
        s1,
        "site_config",
        JSON.stringify({ version: 1, collections: { x: {} } }),
      ],
      [m, "revoked_at", null],
    ] as Array<[string, string, string | null]>) {
      expect(
        await sqlState(
          pg.query(`UPDATE resource_shares SET ${set} = $2 WHERE id = $1`, [
            id,
            value,
          ])
        )
      ).toBe("23514");
    }
  });

  it("deleting a site row deletes its members (FK cascade)", async () => {
    const pg = await migrated();
    const s = await site(pg);
    await member(pg, s);
    await member(pg, s);
    const other = await insert(pg, {});
    await pg.query(`DELETE FROM resource_shares WHERE id = $1`, [s]);
    const r = await pg.query<{ id: string }>(`SELECT id FROM resource_shares`);
    expect(r.rows.map((x) => x.id)).toEqual([other]);
  });

  it("parity: every 0336 column is in the baseline, and boot coherence names each, attributed to 0336", () => {
    const baselineCols = addedColumns(BASELINE).filter(
      (a) => a.table === "resource_shares"
    );
    for (const a of ADDED) {
      expect(baselineCols).toContainEqual(a);
    }
    const mine = REQUIRED_COLUMNS.filter((c) => c.addedBy === M0336_FILE)
      .map((c) => `${c.table}.${c.column}`)
      .sort();
    expect(mine).toEqual(ADDED.map((a) => `${a.table}.${a.column}`).sort());
  });
});
