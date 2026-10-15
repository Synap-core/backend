/**
 * Template health over OVERLAYS — the packs composed onto a space
 * (`settings.installedPacks`), driven through the real service on PGlite.
 *
 * The gap this closes: health judged only a space's own `packageSlug`, so a
 * CRM space that had `business-developer` composed onto it (now retired →
 * crm) got no signal at all. Each overlay now carries its own standing,
 * classified by the SAME `templateHealthFor` the workspace row uses:
 *   • retired, replacement already on the space → a plain "nothing to move";
 *   • retired, replacement elsewhere / none     → the warning says so;
 *   • unlisted only after a COMPLETE sync, else unknown (never "not there");
 *   • current overlays keep their own drift; the space's own row is unchanged.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema: {} as never });
  return {
    ...actual,
    db,
    getDb: async () => db,
    // The real reader's query, against THIS db (the actual one is bound to the
    // database package's own connection, which mocking `db` here cannot reach).
    // BOUNDARY: so the real `getCatalogSyncStamps` is not exercised here.
    getCatalogSyncStamps: async () => {
      const [row] = await db
        .select({ settings: schema.podSettings.settings })
        .from(schema.podSettings)
        .limit(1);
      return row?.settings?.catalogSyncStamps ?? {};
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  cpCatalogCache,
  podSettings,
  proposals,
  skills,
  workspaces,
} from "@synap/database/schema";
import { listWorkspaceTemplateHealth } from "../template-health.js";

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

/** DDL for one Drizzle table — columns only (no FKs), enough for a real write. */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const raw = c.getSQLType();
    const isArray = raw.endsWith("[]");
    const base = raw.replace(/\[\]$/, "").replace(/\(.*\)/, "");
    const type =
      /^(text|uuid|jsonb|boolean|integer|timestamp with time zone|timestamp)$/.test(
        base
      )
        ? base
        : "text";
    let def = "";
    if (c.hasDefault) {
      const d = c.default;
      if (isArray) def = " default '{}'";
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (typeof d === "string")
        def = ` default '${d.replace(/'/g, "''")}'`;
      else if (d && typeof d === "object" && !("queryChunks" in d))
        def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
      else if (type === "uuid") def = " default gen_random_uuid()";
      else if (type.startsWith("timestamp")) def = " default now()";
    }
    return `"${c.name}" ${type}${isArray ? "[]" : ""}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const CP = "https://cp.example.test";
// Since marketplace sources, a bare template slug reads the OFFICIAL catalog
// only (`officialCatalogUrl()`); the rows here are seeded under CP, so pin it.
process.env.CONTROL_PLANE_URL = CP;
const WS_CRM = randomUUID();
const WS_OPS = randomUUID();
const WS_BARE = randomUUID();
const WS_PLAIN = randomUUID();

async function seedWorkspace(
  id: string,
  name: string,
  settings: Record<string, unknown>
): Promise<void> {
  await h.client!.query(
    `insert into workspaces (id, name, owner_id, settings) values ($1,$2,'user-1',$3::jsonb)`,
    [id, name, JSON.stringify(settings)]
  );
}

async function seedCache(row: {
  slug: string;
  version?: string;
  retired?: { replacedBy: string | null; reason: string };
}): Promise<void> {
  await h.client!.query(
    `insert into cp_catalog_cache (source, kind, slug, name, version, retired_at, replaced_by_slug, retired_reason)
     values ($1,'template',$2,$2,$3,$4,$5,$6)`,
    [
      CP,
      row.slug,
      row.version ?? null,
      row.retired ? new Date("2026-10-11T00:00:00Z") : null,
      row.retired?.replacedBy ?? null,
      row.retired?.reason ?? null,
    ]
  );
}

async function setTemplateStamp(status: string | null): Promise<void> {
  await h.client!.exec(`delete from pod_settings`);
  const stamps =
    status === null
      ? {}
      : {
          [`${CP}::template`]: {
            lastSyncAt: new Date().toISOString(),
            lastStatus: status,
            lastCount: 4,
          },
        };
  await h.client!.query(
    `insert into pod_settings (settings) values ($1::jsonb)`,
    [JSON.stringify({ catalogSyncStamps: stamps })]
  );
}

const pack = (slug: string, version = "h-1") => ({
  slug,
  version,
  installedAt: "2026-10-01T00:00:00Z",
});

async function healthOf(id: string) {
  const rows = await listWorkspaceTemplateHealth([
    WS_CRM,
    WS_OPS,
    WS_BARE,
    WS_PLAIN,
  ]);
  return rows.find((r) => r.workspaceId === id)!;
}
const overlay = (row: Awaited<ReturnType<typeof healthOf>>, slug: string) =>
  row.overlays.find((o) => o.slug === slug)!;

beforeAll(async () => {
  for (const t of [skills, workspaces, cpCatalogCache, podSettings, proposals])
    await h.client!.exec(ddlFor(t));
  // The founder's case: business-developer (retired → crm) on the CRM space.
  // The space's own slug is ALSO listed in the ledger — never its own overlay.
  await seedWorkspace(WS_CRM, "CRM", {
    packageSlug: "crm",
    packageVersion: "h-crm",
    installedPacks: [
      pack("business-developer"),
      pack("crm"),
      pack("business-developer"), // a duplicate ledger entry is one overlay
      { version: "h-1" }, // malformed: no slug
      pack("some-profile-pack", "1.0.0"),
    ],
  });
  // grants retired → finance, which this space does NOT have; business-model
  // is current and behind.
  await seedWorkspace(WS_OPS, "Operations", {
    packageSlug: "operations",
    packageVersion: "h-ops",
    installedPacks: [pack("grants"), pack("business-model", "h-1")],
  });
  // An overlay retired with no replacement, onto a space with no template.
  await seedWorkspace(WS_BARE, "Scratch", {
    installedPacks: [pack("old-thing")],
  });
  await seedWorkspace(WS_PLAIN, "Plain", { packageSlug: "crm" });
  await seedCache({ slug: "crm", version: "h-crm" });
  await seedCache({ slug: "operations", version: "h-ops" });
  await seedCache({ slug: "business-model", version: "h-2" });
  await seedCache({
    slug: "business-developer",
    version: "h-9",
    retired: { replacedBy: "crm", reason: "Its fields moved into CRM." },
  });
  await seedCache({
    slug: "grants",
    retired: { replacedBy: "finance", reason: "Grants live in Finance now." },
  });
  await seedCache({
    slug: "old-thing",
    retired: { replacedBy: null, reason: "Nobody used it." },
  });
});

beforeEach(async () => {
  await setTemplateStamp("ok");
});

describe("template health — overlays", () => {
  it("a retired overlay whose replacement IS the space's template says there is nothing to move", async () => {
    const row = await healthOf(WS_CRM);
    const bd = overlay(row, "business-developer");
    expect(bd.lifecycle).toBe("retired");
    expect(bd.replacedBy).toBe("crm");
    expect(bd.retiredReason).toBe("Its fields moved into CRM.");
    expect(bd.replacementHere).toBe(true);
    expect(bd.drifted).toBe(false); // a tombstone is never an update target
    expect(bd.latestVersion).toBeNull();
    expect(bd.lifecycleWarning).toBe(
      'The "business-developer" overlay on this space was retired. Its fields moved into CRM. It is replaced by "crm", which this space already has. Its fields stay; there is nothing to move.'
    );
    // Surfaced in the MCP row's warnings too, after the space's own (none here).
    expect(row.warnings).toContain(bd.lifecycleWarning);
    // The space's own row is untouched by its overlays.
    expect(row.lifecycle).toBe("current");
    expect(row.drifted).toBe(false);
    expect(row.lifecycleWarning).toBeNull();
  });

  it("the ledger's own-template entry, duplicates and malformed entries are not overlays", async () => {
    const row = await healthOf(WS_CRM);
    expect(row.overlays.map((o) => o.slug)).toEqual([
      "business-developer",
      "some-profile-pack",
    ]);
  });

  it("a retired overlay whose replacement is NOT on the space says it gets no updates until it is", async () => {
    const g = overlay(await healthOf(WS_OPS), "grants");
    expect(g.lifecycle).toBe("retired");
    expect(g.replacedBy).toBe("finance");
    expect(g.replacementHere).toBe(false);
    expect(g.lifecycleWarning).toMatch(
      /^The "grants" overlay on this space was retired\. Grants live in Finance now\. It is replaced by "finance"\. Its fields stay, but they get no updates until "finance" is installed\.$/
    );
  });

  it("a replacement that is ANOTHER overlay on the space also counts as already here", async () => {
    // Same ledger as Operations, plus finance composed as an overlay.
    const id = randomUUID();
    await seedWorkspace(id, "Ops 2", {
      packageSlug: "operations",
      installedPacks: [pack("grants"), pack("finance")],
    });
    const rows = await listWorkspaceTemplateHealth([id]);
    expect(overlay(rows[0]!, "grants").replacementHere).toBe(true);
    await h.client!.query(`delete from workspaces where id = $1`, [id]);
  });

  it("a retired overlay with no replacement says so, even on a space with no template", async () => {
    const row = await healthOf(WS_BARE);
    expect(row.attached).toBe(false);
    expect(row.lifecycle).toBeNull();
    const o = overlay(row, "old-thing");
    expect(o.lifecycle).toBe("retired");
    expect(o.replacementHere).toBe(false);
    expect(o.lifecycleWarning).toMatch(/It has no replacement\./);
    expect(row.warnings).toEqual([o.lifecycleWarning]);
  });

  it("a current overlay keeps its own drift", async () => {
    const bm = overlay(await healthOf(WS_OPS), "business-model");
    expect(bm.lifecycle).toBe("current");
    expect(bm.installedVersion).toBe("h-1");
    expect(bm.latestVersion).toBe("h-2");
    expect(bm.drifted).toBe(true);
    expect(bm.lifecycleWarning).toBeNull();
  });

  it("an overlay absent after a COMPLETE sync is `unlisted` — worded true for a non-template pack too", async () => {
    const p = overlay(await healthOf(WS_CRM), "some-profile-pack");
    expect(p.lifecycle).toBe("unlisted");
    expect(p.lifecycleWarning).toBe(
      '"some-profile-pack" on this space is not in the template catalog, so it gets no template updates. What it added stays.'
    );
  });

  it.each(["partial", "unreachable", null])(
    "an overlay absent after a `%s` sync is `unknown`, never `unlisted`",
    async (status) => {
      await setTemplateStamp(status);
      const row = await healthOf(WS_CRM);
      const p = overlay(row, "some-profile-pack");
      expect(p.lifecycle).toBe("unknown");
      expect(p.lifecycleWarning).toBeNull();
      // Known rows do not depend on completeness.
      expect(overlay(row, "business-developer").lifecycle).toBe("retired");
    }
  );

  it("a space with no overlays has an empty list", async () => {
    expect((await healthOf(WS_PLAIN)).overlays).toEqual([]);
  });
});
