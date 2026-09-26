/**
 * REAL-POSTGRES (PGlite) test for migration 0276 — the exposure substrate
 * (Sites W2, sub-step S1: schema only).
 *
 * Pinned:
 *   - 0276 runs TWICE on a pre-0276 database without error, and the second run
 *     changes nothing (row snapshot byte-equal);
 *   - a legacy row (plaintext `public_token`) is neutralised: token + hash
 *     NULL, revoked, audience derived from `visibility`;
 *   - REVOKE IS PERMANENT at the DB: un-revoking (or re-tokening / re-publishing
 *     / re-pinning) a revoked row raises SQLSTATE 23514, from a trigger that is
 *     asserted to fire BEFORE UPDATE per ROW (its event, not only its effect);
 *   - the PIN is a `document_versions` row id (FK); a LIVE published row never
 *     loses it (deleting its version is refused), a draft/revoked row drops it;
 *   - the CHECKs refuse the shapes the doors must never write (published without
 *     a snapshot object, a live link without an anchor, unknown audience/state,
 *     an exposed view without a project);
 *   - the unique indexes hold (one hash, one live link per resource+anchor) and a
 *     revoked link frees the slot for a NEW row;
 *   - REACHABILITY: every new column accepts its value THROUGH the Drizzle schema
 *     (a drizzle insert names every declared column, so a Drizzle column the
 *     migration forgot fails here), including the publication snapshot;
 *   - `granted_via_share_id` FK is ON DELETE SET NULL; `idx_workspace_members_user_id`
 *     exists.
 * Plus a DB-free parity check: every column 0276 adds is also in
 * 0000_baseline_schema.sql and in the Drizzle table, and every
 * REQUIRED_COLUMNS entry attributed to 0276 is a column 0276 adds.
 *
 * PRE-0276 SHAPE: `resource_shares` is the CREATE TABLE block cut out of the
 * baseline itself (the real legacy shape). `views` / `project_members` are their
 * Drizzle DDL MINUS the columns 0276 adds (derived, not hand-listed).
 *
 * NOT covered: the whole migration chain (0000..0276) — PGlite lacks the
 * baseline's extensions; CI's `migrate` step runs it on real Postgres.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL, eq } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { resourceShares } from "./schema/sharing.js";
import { views } from "./schema/views.js";
import { projectMembers } from "./schema/project-members.js";
import { documentVersions } from "./schema/documents.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_FILE = "0276_exposure_substrate.sql";
const MIGRATION = readFileSync(
  resolve(HERE, `../migrations/${MIGRATION_FILE}`),
  "utf8"
);
const BASELINE = readFileSync(
  resolve(HERE, "../migrations/0000_baseline_schema.sql"),
  "utf8"
);

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
const ADDED_BY_0276 = addedColumns(MIGRATION);

function ddlFor(table: PgTable, omit: ReadonlyArray<string> = []): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns
    .filter((c) => !omit.includes(c.name))
    .map((c) => {
      const type = c.getSQLType();
      let def = "";
      const d = c.default as unknown;
      if (d !== undefined && !(d instanceof SQL)) {
        if (typeof d === "string") def = ` default '${d}'`;
        else if (typeof d === "number" || typeof d === "boolean")
          def = ` default ${d}`;
        else if (Array.isArray(d)) def = ` default '{}'`;
        else def = ` default '${JSON.stringify(d)}'`;
      } else if (type.startsWith("timestamp") && c.hasDefault) {
        def = " default now()";
      } else if (c.primary && type === "uuid") {
        def = " default gen_random_uuid()";
      }
      const nn = c.notNull && !c.primary ? " not null" : "";
      return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${nn}${def}`;
    });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}
const omitFor = (table: string) =>
  ADDED_BY_0276.filter((a) => a.table === table).map((a) => a.column);

/** The legacy `resource_shares` CREATE block, cut out of the baseline. */
function baselineCreate(table: string): string {
  const m = BASELINE.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS "${table}" \\([\\s\\S]*?\\n\\);`)
  );
  if (!m) throw new Error(`baseline has no CREATE TABLE for ${table}`);
  return m[0];
}

async function preSchema(pg: PGlite): Promise<void> {
  await pg.exec(`create table "workspaces" (id uuid primary key);`);
  await pg.exec(`create table "projects" (id uuid primary key);`);
  await pg.exec(
    `create table "workspace_members" (id uuid primary key default gen_random_uuid(), workspace_id uuid, user_id text);`
  );
  await pg.exec(baselineCreate("resource_shares"));
  await pg.exec(ddlFor(views, omitFor("views")));
  await pg.exec(ddlFor(projectMembers, omitFor("project_members")));
  await pg.exec(ddlFor(documentVersions));
}

/** A saved checkpoint row; returns its id (the pin target). */
async function seedVersion(pg: PGlite, version = 1): Promise<string> {
  const { rows } = await pg.query<{ id: string }>(
    `insert into document_versions (document_id, version, content, author, author_id)
     values (gen_random_uuid(), $1, 'c', 'user', 'u') returning id`,
    [version]
  );
  return rows[0]!.id;
}

async function sqlState(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    // Drizzle wraps the driver error ("Failed query: …") and keeps it as `cause`.
    const err = e as { code?: string; cause?: { code?: string } };
    return err.code ?? err.cause?.code ?? `no-code: ${String(e)}`;
  }
}

describe("0276 parity (DB-free)", () => {
  it("non-vacuity: the scan sees the columns 0276 adds", () => {
    expect(ADDED_BY_0276.length).toBeGreaterThanOrEqual(13);
    expect(ADDED_BY_0276).toContainEqual({
      table: "resource_shares",
      column: "published_properties",
    });
  });

  it("every column 0276 adds is also in the baseline (new column ⇒ baseline)", () => {
    const inBaseline = new Set(
      addedColumns(BASELINE).map((a) => `${a.table}.${a.column}`)
    );
    const missing = ADDED_BY_0276.filter(
      (a) => !inBaseline.has(`${a.table}.${a.column}`)
    );
    expect(missing).toEqual([]);
  });

  it("every column 0276 adds is declared in the Drizzle schema", () => {
    const drizzleCols = new Set(
      [resourceShares, views, projectMembers].flatMap((t) => {
        const cfg = getTableConfig(t);
        return cfg.columns.map((c) => `${cfg.name}.${c.name}`);
      })
    );
    const missing = ADDED_BY_0276.filter(
      (a) => !drizzleCols.has(`${a.table}.${a.column}`)
    );
    expect(missing).toEqual([]);
  });

  it("every REQUIRED_COLUMNS entry attributed to 0276 is a column 0276 adds", () => {
    const req = REQUIRED_COLUMNS.filter((r) => r.addedBy === MIGRATION_FILE);
    expect(req.length).toBeGreaterThanOrEqual(7);
    const added = new Set(ADDED_BY_0276.map((a) => `${a.table}.${a.column}`));
    expect(req.filter((r) => !added.has(`${r.table}.${r.column}`))).toEqual([]);
  });
});

describe("migration 0276 on a pre-0276 database", () => {
  let pg: PGlite;
  let db: ReturnType<typeof drizzle>;
  const legacyPublic = randomUUID();
  const legacyPrivate = randomUUID();
  const ws = randomUUID();
  const project = randomUUID();
  let afterFirstRun: unknown[] = [];

  beforeAll(async () => {
    pg = new PGlite();
    db = drizzle(pg);
    await preSchema(pg);
    await pg.exec(`insert into workspaces values ('${ws}');`);
    await pg.exec(`insert into projects values ('${project}');`);
    // Two legacy rows written by the deleted router: plaintext tokens.
    await pg.query(
      `insert into resource_shares (id, resource_type, resource_id, visibility, public_token, token_hash, created_by)
       values ($1, 'entity', gen_random_uuid(), 'public', 'plain-public', 'hash-public', 'u1'),
              ($2, 'view', gen_random_uuid(), 'invite_only', 'plain-private', 'hash-private', 'u1')`,
      [legacyPublic, legacyPrivate]
    );
    await pg.exec(MIGRATION);
    afterFirstRun = (
      await pg.query(`select * from resource_shares order by id`)
    ).rows;
  }, 120_000);

  afterAll(async () => {
    await pg?.close();
  });

  it("a second run succeeds and changes nothing", async () => {
    await pg.exec(MIGRATION);
    const again = (await pg.query(`select * from resource_shares order by id`))
      .rows;
    expect(again).toEqual(afterFirstRun);
  });

  it("legacy rows are neutralised: no plaintext, no hash, revoked, audience derived", async () => {
    const { rows } = await pg.query<{
      id: string;
      public_token: string | null;
      token_hash: string | null;
      revoked_at: Date | null;
      audience: string;
      state: string;
    }>(
      `select id, public_token, token_hash, revoked_at, audience, state from resource_shares where id = any($1)`,
      [[legacyPublic, legacyPrivate]]
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.public_token).toBeNull();
      expect(r.token_hash).toBeNull();
      expect(r.revoked_at).not.toBeNull();
      expect(r.state).toBe("draft");
    }
    const byId = new Map(rows.map((r) => [r.id, r.audience]));
    expect(byId.get(legacyPublic)).toBe("public");
    expect(byId.get(legacyPrivate)).toBe("link");
  });

  it("the revoke-is-permanent trigger exists", async () => {
    const { rows } = await pg.query(
      `select 1 from pg_trigger where tgname = 'resource_shares_revoke_is_permanent' and not tgisinternal`
    );
    expect(rows).toHaveLength(1);
  });

  it("the revoke-is-permanent trigger fires BEFORE UPDATE, per ROW, and on nothing else", async () => {
    const { rows } = await pg.query<{
      event_manipulation: string;
      action_timing: string;
      action_orientation: string;
    }>(
      `select event_manipulation, action_timing, action_orientation
         from information_schema.triggers
        where trigger_name = 'resource_shares_revoke_is_permanent'
          and event_object_table = 'resource_shares'`
    );
    // One row per event: exactly one event, and it is UPDATE.
    expect(rows).toEqual([
      {
        event_manipulation: "UPDATE",
        action_timing: "BEFORE",
        action_orientation: "ROW",
      },
    ]);
  });

  it("un-revoking a revoked row raises 23514", async () => {
    expect(
      await sqlState(
        pg.query(`update resource_shares set revoked_at = null where id = $1`, [
          legacyPublic,
        ])
      )
    ).toBe("23514");
    expect(
      await sqlState(
        pg.query(
          `update resource_shares set token_hash = 'fresh' where id = $1`,
          [legacyPrivate]
        )
      )
    ).toBe("23514");
  });

  it("REACHABILITY: a link row with every new column round-trips through Drizzle", async () => {
    const id = randomUUID();
    await db.insert(resourceShares).values({
      id,
      resourceType: "entity",
      resourceId: randomUUID(),
      workspaceId: ws,
      audience: "link",
      anchorProjectId: project,
      tokenHash: `h-${id}`,
      tokenPrefix: "abc123",
      expiresAt: new Date(Date.now() + 86_400_000),
      createdBy: "u1",
    });
    const [row] = await db
      .select()
      .from(resourceShares)
      .where(eq(resourceShares.id, id));
    expect(row).toMatchObject({
      workspaceId: ws,
      audience: "link",
      anchorProjectId: project,
      state: "draft",
      tokenPrefix: "abc123",
      publicToken: null,
    });
    // Revoking is allowed once, and then frozen.
    await db
      .update(resourceShares)
      .set({ revokedAt: new Date(), revokedBy: "u1" })
      .where(eq(resourceShares.id, id));
    expect(
      await sqlState(
        db
          .update(resourceShares)
          .set({ revokedAt: null })
          .where(eq(resourceShares.id, id))
      )
    ).toBe("23514");
  });

  it("REACHABILITY: a published row stores its pinned revision and property snapshot", async () => {
    const id = randomUUID();
    const snapshot = { title: "Menu", price: 12, tags: ["a"] };
    const pin = await seedVersion(pg, 3);
    await db.insert(resourceShares).values({
      id,
      resourceType: "entity",
      resourceId: randomUUID(),
      workspaceId: ws,
      audience: "public",
      state: "published",
      publishedAt: new Date(),
      publishedBy: "u1",
      publishedDocumentVersionId: pin,
      publishedProperties: snapshot,
      createdBy: "u1",
    });
    const [row] = await db
      .select()
      .from(resourceShares)
      .where(eq(resourceShares.id, id));
    expect(row!.publishedProperties).toEqual(snapshot);
    expect(row!.publishedDocumentVersionId).toBe(pin);
    // Revoked publication cannot be re-published with a new snapshot, nor
    // re-pinned to another checkpoint.
    await db
      .update(resourceShares)
      .set({ revokedAt: new Date() })
      .where(eq(resourceShares.id, id));
    expect(
      await sqlState(
        db
          .update(resourceShares)
          .set({ publishedProperties: { title: "edited" } })
          .where(eq(resourceShares.id, id))
      )
    ).toBe("23514");
    const other = await seedVersion(pg, 4);
    expect(
      await sqlState(
        db
          .update(resourceShares)
          .set({ publishedDocumentVersionId: other })
          .where(eq(resourceShares.id, id))
      )
    ).toBe("23514");
  });

  it("PIN: the FK only accepts a real checkpoint row id", async () => {
    expect(
      await sqlState(
        pg.query(
          `insert into resource_shares (resource_type, resource_id, created_by, audience, published_document_version_id)
           values ('entity', gen_random_uuid(), 'u', 'public', gen_random_uuid())`
        )
      )
    ).toBe("23503");
  });

  it("PIN FLOOR: a live publication never loses its pin; draft and revoked rows just drop it", async () => {
    const publish = async (pin: string, state: "draft" | "published") => {
      const { rows } = await pg.query<{ id: string }>(
        `insert into resource_shares (resource_type, resource_id, created_by, audience, state, published_at, published_properties, published_document_version_id)
         values ('entity', gen_random_uuid(), 'u', 'public', $2, now(), '{}', $1) returning id`,
        [pin, state]
      );
      return rows[0]!.id;
    };
    const pinOf = async (id: string) =>
      (
        await pg.query<{ p: string | null }>(
          `select published_document_version_id as p from resource_shares where id = $1`,
          [id]
        )
      ).rows[0]!.p;

    // Live published: deleting its pinned version is refused, pin intact.
    const vLive = await seedVersion(pg);
    const live = await publish(vLive, "published");
    expect(
      await sqlState(
        pg.query(`delete from document_versions where id = $1`, [vLive])
      )
    ).toBe("23514");
    expect(await pinOf(live)).toBe(vLive);
    // …and a direct clear is refused too.
    expect(
      await sqlState(
        pg.query(
          `update resource_shares set published_document_version_id = null where id = $1`,
          [live]
        )
      )
    ).toBe("23514");

    // Draft: the version can go; the pin is dropped.
    const vDraft = await seedVersion(pg);
    const draft = await publish(vDraft, "draft");
    expect(
      await sqlState(
        pg.query(`delete from document_versions where id = $1`, [vDraft])
      )
    ).toBeNull();
    expect(await pinOf(draft)).toBeNull();

    // Revoked publication: the version can go (clearing grants nothing).
    const vRevoked = await seedVersion(pg);
    const revoked = await publish(vRevoked, "published");
    await pg.query(
      `update resource_shares set revoked_at = now() where id = $1`,
      [revoked]
    );
    expect(
      await sqlState(
        pg.query(`delete from document_versions where id = $1`, [vRevoked])
      )
    ).toBeNull();
    expect(await pinOf(revoked)).toBeNull();
  });

  it("CHECKs refuse the shapes no door may write", async () => {
    const base = `insert into resource_shares (resource_type, resource_id, created_by, audience, state, anchor_project_id, published_at, published_properties)`;
    const cases: Array<[string, string]> = [
      // published without a snapshot
      [
        "published, no snapshot",
        `${base} values ('entity', gen_random_uuid(), 'u', 'public', 'published', null, now(), null)`,
      ],
      // published with a non-object snapshot
      [
        "published, array snapshot",
        `${base} values ('entity', gen_random_uuid(), 'u', 'public', 'published', null, now(), '[]')`,
      ],
      // published without published_at
      [
        "published, no time",
        `${base} values ('entity', gen_random_uuid(), 'u', 'public', 'published', null, null, '{}')`,
      ],
      // a LINK cannot be published
      [
        "link published",
        `${base} values ('entity', gen_random_uuid(), 'u', 'link', 'published', '${project}', now(), '{}')`,
      ],
      // a live link needs an anchor
      [
        "link, no anchor",
        `${base} values ('entity', gen_random_uuid(), 'u', 'link', 'draft', null, null, null)`,
      ],
      // a live public row has no anchor
      [
        "public with anchor",
        `${base} values ('entity', gen_random_uuid(), 'u', 'public', 'draft', '${project}', null, null)`,
      ],
      [
        "unknown audience",
        `${base} values ('entity', gen_random_uuid(), 'u', 'guest', 'draft', null, null, null)`,
      ],
      [
        "unknown state",
        `${base} values ('entity', gen_random_uuid(), 'u', 'public', 'live', null, null, null)`,
      ],
    ];
    for (const [label, stmt] of cases) {
      expect(`${label}: ${await sqlState(pg.query(stmt))}`).toBe(
        `${label}: 23514`
      );
    }
    // audience is NOT NULL
    expect(
      await sqlState(
        pg.query(
          `insert into resource_shares (resource_type, resource_id, created_by) values ('entity', gen_random_uuid(), 'u')`
        )
      )
    ).toBe("23502");
  });

  it("unique indexes: one hash, one live link per (resource, anchor); a revoke frees the slot", async () => {
    const resource = randomUUID();
    const link = (hash: string) =>
      pg.query(
        `insert into resource_shares (resource_type, resource_id, created_by, audience, anchor_project_id, token_hash)
         values ('entity', $1, 'u', 'link', $2, $3) returning id`,
        [resource, project, hash]
      );
    const first = await link(`uniq-${resource}`);
    expect(await sqlState(link(`uniq-${resource}`))).toBe("23505"); // same hash
    expect(await sqlState(link(`other-${resource}`))).toBe("23505"); // 2nd live link
    await pg.query(
      `update resource_shares set revoked_at = now() where id = $1`,
      [first.rows[0] && (first.rows[0] as { id: string }).id]
    );
    expect(await sqlState(link(`third-${resource}`))).toBeNull(); // NEW row
  });

  it("views: exposed_at requires a project; the marker round-trips through Drizzle", async () => {
    expect(
      await sqlState(
        pg.query(
          `insert into views (user_id, type, category, name, exposed_at) values ('u', 'table', 'structured', 'v', now())`
        )
      )
    ).toBe("23514");
    const id = randomUUID();
    await db.insert(views).values({
      id,
      userId: "u",
      type: "table",
      category: "structured",
      name: "shared",
      projectId: project,
      exposedAt: new Date(),
      exposedBy: "u",
    });
    const [row] = await db.select().from(views).where(eq(views.id, id));
    expect(row!.exposedBy).toBe("u");
    expect(row!.exposedAt).toBeInstanceOf(Date);
  });

  it("project_members: a guest row records its link; deleting the link sets NULL", async () => {
    const shareId = randomUUID();
    await pg.query(
      `insert into resource_shares (id, resource_type, resource_id, created_by, audience, anchor_project_id)
       values ($1, 'entity', gen_random_uuid(), 'u', 'link', $2)`,
      [shareId, project]
    );
    const [m] = await db
      .insert(projectMembers)
      .values({
        projectId: project,
        userId: `guest-${shareId}`,
        role: "guest",
        grantedViaShareId: shareId,
      })
      .returning();
    expect(m!.grantedViaShareId).toBe(shareId);
    expect(m!.role).toBe("guest");
    await pg.query(`delete from resource_shares where id = $1`, [shareId]);
    const [after] = await db
      .select()
      .from(projectMembers)
      .where(eq(projectMembers.id, m!.id));
    expect(after!.grantedViaShareId).toBeNull();
  });

  it("idx_workspace_members_user_id exists", async () => {
    const { rows } = await pg.query(
      `select 1 from pg_indexes where indexname = 'idx_workspace_members_user_id'`
    );
    expect(rows).toHaveLength(1);
  });
});
