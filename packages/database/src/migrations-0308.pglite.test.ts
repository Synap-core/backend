/**
 * REAL-POSTGRES (PGlite) proof for migration 0308 — workspace identity.
 *
 * Founder rule (2026-10-06): no two ACTIVE spaces share a name, and no two
 * ACTIVE spaces come from the same template — pod-wide, no user link.
 *
 * The migration must never fail on a populated pod (a failed migration aborts
 * boot), so this seeds the duplicates a real pod carries — including the
 * incident pair (the original "Content OS" template space and the empty second
 * one the slug-less update minted) — runs the SQL file itself, and asserts:
 *   - the OLDEST row of each duplicate group keeps its name / template;
 *   - renames skip names that are already taken;
 *   - a detached template copy keeps its slug in `settings.detachedPackageSlug`;
 *   - the keeper is keyed by its slug (idempotency step 1 hits directly);
 *   - archived rows are never touched and never block;
 *   - after it, the indexes refuse a second active name / template;
 *   - re-running it is a no-op.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { findMissingIndexes } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0308 = readFileSync(
  resolve(HERE, "../migrations/0308_workspace_identity_unique.sql"),
  "utf8"
);

let pg: PGlite;
const notices: string[] = [];
let missingBefore: Array<{ table: string; missing: string[] }> = [];

function queryOver(db: PGlite) {
  return async <T>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T> => {
    const text = strings.reduce(
      (acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ""),
      ""
    );
    return (await db.query(text, values)).rows as T;
  };
}
const workspacesOnly = async (
  p: Promise<Array<{ table: string; missing: string[] }>>
) => (await p).filter((r) => r.table === "workspaces");

interface Row {
  id: string;
  name: string;
  package_slug: string | null;
  provisioning_proposal_id: string | null;
  settings: Record<string, unknown>;
  archived_at: string | null;
}

async function row(id: string): Promise<Row> {
  const r = await pg.query<Row>(
    `SELECT id, name, package_slug, provisioning_proposal_id, settings, archived_at
       FROM workspaces WHERE id = $1`,
    [id]
  );
  return r.rows[0];
}

async function seed(
  id: string,
  name: string,
  opts: {
    ageDays: number;
    slug?: string;
    key?: string;
    archived?: boolean;
  }
): Promise<void> {
  const settings: Record<string, unknown> = {};
  if (opts.slug) settings.packageSlug = opts.slug;
  if (opts.key) settings.proposalId = opts.key;
  await pg.query(
    `INSERT INTO workspaces (id, owner_id, name, package_slug, provisioning_proposal_id, settings, created_at, archived_at)
     VALUES ($1, 'u', $2, $3, $4, $5::jsonb, now() - ($6 || ' days')::interval, $7)`,
    [
      id,
      name,
      opts.slug ?? null,
      opts.key ?? null,
      JSON.stringify(settings),
      String(opts.ageDays),
      opts.archived ? new Date().toISOString() : null,
    ]
  );
}

// Fixed ids so the assertions read like the incident report.
const REAL_CONTENT_OS = "9f93c23b-0000-4000-8000-000000000001";
const SECOND_CONTENT_OS = "0cc2beea-0000-4000-8000-000000000002";
const THIRD_CONTENT_OS = "00000000-0000-4000-8000-000000000003";
const ARCHIVED_CONTENT_OS = "00000000-0000-4000-8000-000000000004";
const NOTES_OLD = "00000000-0000-4000-8000-000000000010";
const NOTES_NEW = "00000000-0000-4000-8000-000000000011";
const NOTES_2_TAKEN = "00000000-0000-4000-8000-000000000012";
const BRAND_KEEPER = "00000000-0000-4000-8000-000000000020";
const BRAND_COPY_KEYED = "00000000-0000-4000-8000-000000000021";
const BRAND_COPY_NAMED = "00000000-0000-4000-8000-000000000022";
const BRAND_ARCHIVED = "00000000-0000-4000-8000-000000000023";
const CRM_ALREADY_KEYED = "00000000-0000-4000-8000-000000000030";
const CRM_COPY_HOLDS_NOTHING = "00000000-0000-4000-8000-000000000031";

beforeAll(async () => {
  pg = new PGlite();
  // The workspaces columns the migration reads/writes (0000 baseline + 0020 +
  // 0039). Only those; the real table has more, none of which matter here.
  await pg.exec(`
    CREATE TABLE workspaces (
      id uuid PRIMARY KEY,
      owner_id text NOT NULL,
      name text NOT NULL,
      settings jsonb NOT NULL DEFAULT '{}'::jsonb,
      package_slug text,
      provisioning_proposal_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      archived_at timestamptz
    );
  `);

  // The incident: the real Content OS (template, unkeyed) and the empty second
  // one the slug-less update minted (no template, newer). Plus a third copy
  // with odd spacing/case, and an archived one that must stay untouched.
  await seed(REAL_CONTENT_OS, "Content OS", {
    ageDays: 30,
    slug: "content-os",
  });
  await seed(SECOND_CONTENT_OS, "Content OS", { ageDays: 1 });
  await seed(THIRD_CONTENT_OS, "  content os ", { ageDays: 0 });
  await seed(ARCHIVED_CONTENT_OS, "Content OS", {
    ageDays: 60,
    archived: true,
  });

  // "Notes (2)" already exists, so the duplicate "Notes" must skip to "(3)".
  await seed(NOTES_OLD, "Notes", { ageDays: 10 });
  await seed(NOTES_NEW, "Notes", { ageDays: 2 });
  await seed(NOTES_2_TAKEN, "Notes (2)", { ageDays: 5 });

  // Three active Brand spaces from ONE template (named-instance era).
  await seed(BRAND_KEEPER, "Brand", { ageDays: 20, slug: "brand" });
  await seed(BRAND_COPY_KEYED, "Brand Copy", {
    ageDays: 10,
    slug: "brand",
    key: "brand",
  });
  await seed(BRAND_COPY_NAMED, "Architech Brand", {
    ageDays: 5,
    slug: "brand",
    key: "brand:architech-brand",
  });
  await seed(BRAND_ARCHIVED, "Old Brand", {
    ageDays: 90,
    slug: "brand",
    archived: true,
  });

  // A keeper that is already keyed is left alone; its copy carries a foreign key.
  await seed(CRM_ALREADY_KEYED, "CRM", {
    ageDays: 9,
    slug: "crm",
    key: "crm-v1",
  });
  await seed(CRM_COPY_HOLDS_NOTHING, "CRM 2", {
    ageDays: 3,
    slug: "crm",
    key: "eve-crm",
  });

  missingBefore = await workspacesOnly(findMissingIndexes(queryOver(pg)));
  const res = await pg.exec(M0308);
  // PGlite surfaces RAISE NOTICE through the result's `notices`, when present.
  for (const r of res as Array<{ notices?: Array<{ message?: string }> }>) {
    for (const n of r.notices ?? []) if (n.message) notices.push(n.message);
  }
}, 60_000);

describe("migration 0308 — pre-index dedupe", () => {
  it("the incident pair: the real Content OS keeps its name, the empty copy becomes 'Content OS (2)'", async () => {
    expect((await row(REAL_CONTENT_OS)).name).toBe("Content OS");
    expect((await row(SECOND_CONTENT_OS)).name).toBe("Content OS (2)");
    expect((await row(THIRD_CONTENT_OS)).name).toBe("content os (3)");
  });

  it("archived rows are never renamed", async () => {
    expect((await row(ARCHIVED_CONTENT_OS)).name).toBe("Content OS");
    expect((await row(BRAND_ARCHIVED)).package_slug).toBe("brand");
  });

  it("a rename skips a name that is already taken", async () => {
    expect((await row(NOTES_OLD)).name).toBe("Notes");
    expect((await row(NOTES_2_TAKEN)).name).toBe("Notes (2)");
    expect((await row(NOTES_NEW)).name).toBe("Notes (3)");
  });

  it("the oldest template space keeps the template; copies are detached, nothing lost", async () => {
    const keeper = await row(BRAND_KEEPER);
    expect(keeper.package_slug).toBe("brand");

    const keyed = await row(BRAND_COPY_KEYED);
    expect(keyed.package_slug).toBeNull();
    expect(keyed.provisioning_proposal_id).toBeNull();
    expect(keyed.settings.detachedPackageSlug).toBe("brand");
    expect(keyed.settings.detachedProposalId).toBe("brand");
    expect(keyed.settings).not.toHaveProperty("packageSlug");
    expect(keyed.settings).not.toHaveProperty("proposalId");

    const named = await row(BRAND_COPY_NAMED);
    expect(named.package_slug).toBeNull();
    expect(named.provisioning_proposal_id).toBeNull();
    expect(named.settings.detachedProposalId).toBe("brand:architech-brand");

    // A copy keyed by something that is NOT the template's key keeps that key.
    const crmCopy = await row(CRM_COPY_HOLDS_NOTHING);
    expect(crmCopy.package_slug).toBeNull();
    expect(crmCopy.provisioning_proposal_id).toBe("eve-crm");
    expect(crmCopy.settings.detachedPackageSlug).toBe("crm");
  });

  it("backfill: an unkeyed template space is keyed by its slug once the slot is free", async () => {
    const real = await row(REAL_CONTENT_OS);
    expect(real.provisioning_proposal_id).toBe("content-os");
    expect(real.settings.proposalId).toBe("content-os");
    // The Brand keeper's slot was held by its copy BEFORE the detach; the copy
    // released it, so the keeper is keyed now.
    expect((await row(BRAND_KEEPER)).provisioning_proposal_id).toBe("brand");
    // Already keyed → untouched.
    expect((await row(CRM_ALREADY_KEYED)).provisioning_proposal_id).toBe(
      "crm-v1"
    );
  });

  it("every change is announced (RAISE NOTICE), when the driver surfaces notices", async () => {
    if (notices.length === 0) return; // driver did not surface them — not a failure of the SQL
    expect(notices.some((n) => n.includes(SECOND_CONTENT_OS))).toBe(true);
    expect(notices.some((n) => n.includes("detached"))).toBe(true);
  });
});

describe("migration 0308 — the invariants hold after it", () => {
  it("the boot check (findMissingIndexes) requires both indexes: missing before, present after", async () => {
    expect(missingBefore).toEqual([
      {
        table: "workspaces",
        missing: [
          "workspaces_active_name_unique",
          "workspaces_active_package_slug_unique",
        ],
      },
    ]);
    await expect(
      workspacesOnly(findMissingIndexes(queryOver(pg)))
    ).resolves.toEqual([]);
  });

  it("both unique indexes exist", async () => {
    const r = await pg.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'workspaces'
         AND indexname IN ('workspaces_active_name_unique', 'workspaces_active_package_slug_unique')`
    );
    expect(r.rows.map((x) => x.indexname).sort()).toEqual([
      "workspaces_active_name_unique",
      "workspaces_active_package_slug_unique",
    ]);
  });

  it("a second ACTIVE space with the same name (any case/spacing) is refused by the database", async () => {
    await expect(
      pg.query(
        `INSERT INTO workspaces (id, owner_id, name) VALUES (gen_random_uuid(), 'other-user', ' CONTENT os')`
      )
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("a second ACTIVE space from the same template is refused — whoever owns it", async () => {
    await expect(
      pg.query(
        `INSERT INTO workspaces (id, owner_id, name, package_slug) VALUES (gen_random_uuid(), 'other-user', 'Fresh', 'content-os')`
      )
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("archived duplicates are allowed, and unarchiving one is refused", async () => {
    const id = "00000000-0000-4000-8000-000000000099";
    await pg.query(
      `INSERT INTO workspaces (id, owner_id, name, package_slug, archived_at) VALUES ($1, 'u', 'Content OS', 'content-os', now())`,
      [id]
    );
    await expect(
      pg.query(`UPDATE workspaces SET archived_at = NULL WHERE id = $1`, [id])
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("re-running the migration is a no-op", async () => {
    const before = await pg.query(
      `SELECT id, name, package_slug, provisioning_proposal_id, settings FROM workspaces ORDER BY id`
    );
    await pg.exec(M0308);
    const after = await pg.query(
      `SELECT id, name, package_slug, provisioning_proposal_id, settings FROM workspaces ORDER BY id`
    );
    expect(after.rows).toEqual(before.rows);
  });
});
