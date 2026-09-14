/**
 * Retirement tombstone (`profiles.ui_hints.retired`) on the template-apply
 * resolver, against a REAL Postgres (PGlite) and the REAL ProfileRepository.
 *
 * Pinned:
 *   (a) a soft-deleted workspace-scope holder WITH a tombstone is never
 *       reactivated — the row stays inactive and the apply reports a
 *       `conflict` carrying `retired` (dryRun identical);
 *   (b) a tombstone with `mergedInto` resolves to the canonical (granted when
 *       pod-wide), and never to a canonical that is inactive;
 *   (c) a soft-deleted holder WITHOUT a tombstone is still revived — the
 *       no-silent-change rule for rows nobody retired deliberately. This is the
 *       row that discriminates "tombstone check" from "never revive anything";
 *   (e) a retired POD-WIDE holder is not re-minted through the
 *       `slug-taken-pod-wide` deferral.
 *
 * ENGINE: PGlite, ONE instance for the file; `profiles` and
 * `profile_workspace_access` are created from their drizzle definitions (enums
 * as text, constraints dropped). Rows are truncated between tests.
 *
 * NOT covered here: `delete()` stamping / `reactivate()` clearing the tombstone
 * (profile-repository.ts was held by a peer session when this lane ran).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "../schema/index.js";
import { profiles, profileWorkspaceAccess } from "../schema/profiles.js";
import {
  ProfileRepository,
  markProfileRetired,
} from "../repositories/profile-repository.js";
import { resolveProfileForApply } from "./resolve-profile-for-apply.js";

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

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const HOLDER = "a0000000-0000-4000-8000-000000000001";
const CANON = "a0000000-0000-4000-8000-000000000002";

let pg: PGlite;
let repo: ProfileRepository;

async function seed(row: {
  id: string;
  slug?: string;
  scope: string;
  workspaceId?: string | null;
  isActive: boolean;
  uiHints?: Record<string, unknown>;
  profileKind?: string;
}) {
  await pg.query(
    `insert into profiles (id, slug, display_name, scope, workspace_id, user_id,
       profile_kind, is_active, ui_hints)
     values ($1, $2, 'Client', $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      row.id,
      row.slug ?? "client",
      row.scope,
      row.workspaceId ?? null,
      USER,
      row.profileKind ?? "kind",
      row.isActive,
      JSON.stringify(row.uiHints ?? {}),
    ]
  );
}

async function isActive(id: string): Promise<boolean> {
  const r = await pg.query<{ is_active: boolean }>(
    `select is_active from profiles where id = $1`,
    [id]
  );
  return r.rows[0]!.is_active;
}

const apply = (over: Record<string, unknown> = {}) =>
  resolveProfileForApply(repo, {
    slug: "client",
    declaredScope: "workspace",
    declaredKind: "kind",
    workspaceId: WS,
    actorUserId: USER,
    ...over,
  });

const TOMBSTONE = { at: "2026-09-14T00:00:00.000Z", reason: "deleted" };

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(ddlFor(profiles as unknown as PgTable));
  await pg.exec(ddlFor(profileWorkspaceAccess as unknown as PgTable));
  repo = new ProfileRepository(drizzle(pg, { schema }) as never);
}, 60_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`truncate profiles; truncate profile_workspace_access;`);
});

describe("resolveProfileForApply — retirement tombstone (PGlite)", () => {
  it("(a) never reactivates a tombstoned workspace-scope holder; reports a retired conflict", async () => {
    await seed({
      id: HOLDER,
      scope: "workspace",
      workspaceId: WS,
      isActive: false,
      uiHints: { icon: "user", retired: TOMBSTONE },
    });

    const r = await apply();

    expect(r.profile).toBeNull();
    expect(r.reused).toBe(false);
    expect(r.conflict).toEqual({
      slug: "client",
      existingKind: "kind",
      declaredKind: "kind",
      retired: TOMBSTONE,
    });
    expect(await isActive(HOLDER)).toBe(false);
  });

  it("(a, dryRun) reports the same retired conflict and writes nothing", async () => {
    await seed({
      id: HOLDER,
      scope: "workspace",
      workspaceId: WS,
      isActive: false,
      uiHints: { retired: TOMBSTONE },
    });

    const r = await apply({ dryRun: true });

    expect(r.profile).toBeNull();
    expect(r.conflict?.retired).toEqual(TOMBSTONE);
    expect(await isActive(HOLDER)).toBe(false);
  });

  it("(b) resolves to an active pod-wide mergedInto canonical and grants it", async () => {
    // A DIFFERENT slug: a same-slug active shared row would be picked by the
    // active-candidate branch and never reach the tombstone path (measured —
    // this row stayed green under the negative control until the slug changed).
    await seed({
      id: CANON,
      slug: "customer",
      scope: "shared",
      isActive: true,
    });
    await seed({
      id: HOLDER,
      scope: "workspace",
      workspaceId: WS,
      isActive: false,
      uiHints: { retired: { ...TOMBSTONE, mergedInto: CANON } },
    });

    const r = await apply();

    expect(r.conflict).toBeNull();
    expect(r.reused).toBe(true);
    expect(r.profile?.id).toBe(CANON);
    expect(await isActive(HOLDER)).toBe(false);
    const grants = await pg.query(
      `select 1 from profile_workspace_access where profile_id = $1 and workspace_id = $2`,
      [CANON, WS]
    );
    expect(grants.rows).toHaveLength(1);
  });

  it("(b) resolves to a workspace-scoped canonical in the same workspace", async () => {
    await seed({
      id: CANON,
      slug: "customer",
      scope: "workspace",
      workspaceId: WS,
      isActive: true,
    });
    await seed({
      id: HOLDER,
      scope: "workspace",
      workspaceId: WS,
      isActive: false,
      uiHints: { retired: { ...TOMBSTONE, mergedInto: CANON } },
    });

    const r = await apply();

    expect(r.profile?.id).toBe(CANON);
    expect(r.reused).toBe(true);
    expect(await isActive(HOLDER)).toBe(false);
  });

  it("(b) an inactive or unreachable mergedInto canonical is a retired conflict, not a revive", async () => {
    await seed({
      id: CANON,
      slug: "customer",
      scope: "workspace",
      workspaceId: OTHER_WS,
      isActive: true,
    });
    await seed({
      id: HOLDER,
      scope: "workspace",
      workspaceId: WS,
      isActive: false,
      uiHints: { retired: { ...TOMBSTONE, mergedInto: CANON } },
    });

    const r = await apply();

    expect(r.profile).toBeNull();
    expect(r.conflict?.retired?.mergedInto).toBe(CANON);
    expect(await isActive(HOLDER)).toBe(false);
  });

  it("(c) a soft-deleted holder WITHOUT a tombstone is still revived (no silent change)", async () => {
    await seed({
      id: HOLDER,
      scope: "workspace",
      workspaceId: WS,
      isActive: false,
      uiHints: { icon: "user" },
    });

    const r = await apply();

    expect(r.conflict).toBeNull();
    expect(r.reused).toBe(true);
    expect(r.profile?.id).toBe(HOLDER);
    expect(await isActive(HOLDER)).toBe(true);
  });

  it("(e) a retired pod-wide holder is not re-minted through the slug-taken-pod-wide deferral", async () => {
    await seed({
      id: HOLDER,
      scope: "shared",
      isActive: false,
      uiHints: { retired: TOMBSTONE },
    });

    const r = await apply({ declaredScope: "shared" });

    expect(r.promotionDeferred).toBe(false);
    expect(r.profile).toBeNull();
    expect(r.conflict?.retired).toEqual(TOMBSTONE);
    expect(await isActive(HOLDER)).toBe(false);
  });

  it("(e, control) an untombstoned soft-deleted pod-wide holder still defers as before", async () => {
    await seed({ id: HOLDER, scope: "shared", isActive: false });

    const r = await apply({ declaredScope: "shared" });

    expect(r.conflict).toBeNull();
    expect(r.promotionDeferred).toBe(true);
    expect(r.deferredReason).toBe("slug-taken-pod-wide");
  });
});

async function uiHints(id: string): Promise<Record<string, unknown>> {
  const r = await pg.query<{ ui_hints: Record<string, unknown> }>(
    `select ui_hints from profiles where id = $1`,
    [id]
  );
  return r.rows[0]!.ui_hints;
}

describe("the retirement write door (PGlite)", () => {
  it("(d) markProfileRetired flips is_active AND stamps the tombstone, keeping other ui_hints keys; the resolver then refuses to revive", async () => {
    await seed({
      id: HOLDER,
      scope: "workspace",
      workspaceId: WS,
      isActive: true,
      uiHints: { icon: "user", color: "#000" },
    });

    await markProfileRetired(drizzle(pg, { schema }) as never, HOLDER, {
      reason: "merged",
      byProposalId: "prop-1",
      mergedInto: CANON,
      at: new Date("2026-09-14T01:02:03.000Z"),
    });

    expect(await isActive(HOLDER)).toBe(false);
    expect(await uiHints(HOLDER)).toEqual({
      icon: "user",
      color: "#000",
      retired: {
        at: "2026-09-14T01:02:03.000Z",
        reason: "merged",
        byProposalId: "prop-1",
        mergedInto: CANON,
      },
    });

    // CANON does not exist → the tombstone cannot redirect → retired conflict.
    const r = await apply();
    expect(r.profile).toBeNull();
    expect(r.conflict?.retired?.reason).toBe("merged");
    expect(await isActive(HOLDER)).toBe(false);
  });

  it("(d) ProfileRepository.delete() goes through the door (reason 'deleted'), and the resolver no longer revives the row", async () => {
    await seed({
      id: HOLDER,
      scope: "workspace",
      workspaceId: WS,
      isActive: true,
      uiHints: { icon: "user" },
    });

    await repo.delete(HOLDER);

    expect(await isActive(HOLDER)).toBe(false);
    const hints = await uiHints(HOLDER);
    expect(hints.icon).toBe("user");
    expect(hints.retired).toMatchObject({ reason: "deleted" });
    expect(typeof (hints.retired as { at: unknown }).at).toBe("string");

    const r = await apply();
    expect(r.profile).toBeNull();
    expect(r.conflict?.retired?.reason).toBe("deleted");
    expect(await isActive(HOLDER)).toBe(false);
  });

  it("(d) reactivate() clears the tombstone and keeps other keys, so the explicit restore path still works", async () => {
    await seed({
      id: HOLDER,
      scope: "workspace",
      workspaceId: WS,
      isActive: false,
      uiHints: { icon: "user", retired: TOMBSTONE },
    });

    const revived = await repo.reactivate(HOLDER);

    expect(revived.isActive).toBe(true);
    expect(await uiHints(HOLDER)).toEqual({ icon: "user" });
  });
});
