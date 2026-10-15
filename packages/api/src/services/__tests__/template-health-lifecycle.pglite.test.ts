/**
 * Template health — the catalog STANDING of a workspace's template
 * (TEMPLATE-LIFECYCLE Contract A), driven through the real service on PGlite.
 *
 *   • `current`  — the slug is a live cache row;
 *   • `retired`  — the slug is a tombstone row: `replacedBy` + reason + a warning;
 *   • `unlisted` — absent, and the last template sync stamp is `ok` (a COMPLETE
 *     fetch), so "not in the catalog" is a fact;
 *   • `unknown`  — absent, and the last sync was partial / failed / never ran.
 *     This is the case the wave is about: an empty result is not a failed read.
 *
 * Also pinned here: a retired row is never a drift target, and the browse door
 * (`queryCatalogCache`) never offers it.
 *
 * Real: `listWorkspaceTemplateHealth`, `getCatalogSyncStamps` (reading the
 * pglite `pod_settings` row), `queryCatalogCache`, the pglite tables.
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
import {
  isTemplateCatalogComplete,
  listWorkspaceTemplateHealth,
} from "../template-health.js";
import { queryCatalogCache } from "../capabilities/catalog-cache-query.js";

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
const WS_CURRENT = randomUUID();
const WS_RETIRED = randomUUID();
const WS_GONE = randomUUID();
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

async function setTemplateStamp(
  status: string | null,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await h.client!.exec(`delete from pod_settings`);
  const stamps =
    status === null
      ? {}
      : {
          [`${CP}::template`]: {
            lastSyncAt: new Date().toISOString(),
            lastStatus: status,
            lastCount: 2,
            ...extra,
          },
        };
  await h.client!.query(
    `insert into pod_settings (settings) values ($1::jsonb)`,
    [JSON.stringify({ catalogSyncStamps: stamps })]
  );
}

async function healthOf(id: string) {
  const rows = await listWorkspaceTemplateHealth([
    WS_CURRENT,
    WS_RETIRED,
    WS_GONE,
    WS_PLAIN,
  ]);
  return rows.find((r) => r.workspaceId === id)!;
}

beforeAll(async () => {
  for (const t of [skills, workspaces, cpCatalogCache, podSettings, proposals])
    await h.client!.exec(ddlFor(t));
  await seedWorkspace(WS_CURRENT, "Ecosystem", {
    packageSlug: "ecosystem",
    packageVersion: "h-old",
  });
  // Installed at h-1; the tombstone carries a DIFFERENT version — must not
  // read as "update available".
  await seedWorkspace(WS_RETIRED, "Radar", {
    packageSlug: "radar",
    packageVersion: "h-1",
  });
  await seedWorkspace(WS_GONE, "Relay", { packageSlug: "relay" });
  await seedWorkspace(WS_PLAIN, "Scratch", {});
  await seedCache({ slug: "ecosystem", version: "h-new" });
  await seedCache({
    slug: "radar",
    version: "h-2",
    retired: {
      replacedBy: "ecosystem",
      reason: "Radar became the Ecosystem space.",
    },
  });
});

beforeEach(async () => {
  await setTemplateStamp("ok");
});

describe("template health — lifecycle", () => {
  it("a live cache row is `current`, with drift still computed", async () => {
    const row = await healthOf(WS_CURRENT);
    expect(row.lifecycle).toBe("current");
    expect(row.drifted).toBe(true);
    expect(row.replacedBy).toBeNull();
    expect(row.lifecycleWarning).toBeNull();
    expect(row.warnings).toEqual([]);
  });

  it("a tombstone is `retired` with replacedBy, reason and a plain warning — never drift", async () => {
    const row = await healthOf(WS_RETIRED);
    expect(row.lifecycle).toBe("retired");
    expect(row.replacedBy).toBe("ecosystem");
    expect(row.retiredReason).toBe("Radar became the Ecosystem space.");
    expect(row.latestVersion).toBeNull();
    expect(row.drifted).toBe(false);
    expect(row.warnings[0]).toMatch(
      /^The "radar" template was retired\. Radar became the Ecosystem space\. It is replaced by "ecosystem"/
    );
  });

  it("absent after a COMPLETE sync is `unlisted`", async () => {
    const row = await healthOf(WS_GONE);
    expect(row.lifecycle).toBe("unlisted");
    expect(row.warnings[0]).toMatch(/no longer in the catalog/);
  });

  it.each(["partial", "unreachable", "empty", "misconfigured"])(
    "absent after a `%s` sync is `unknown`, never `unlisted`",
    async (status) => {
      await setTemplateStamp(status);
      const row = await healthOf(WS_GONE);
      expect(row.lifecycle).toBe("unknown");
      expect(row.lifecycleWarning).toBeNull();
      // The known rows are unaffected by completeness.
      expect((await healthOf(WS_RETIRED)).lifecycle).toBe("retired");
      expect((await healthOf(WS_CURRENT)).lifecycle).toBe("current");
    }
  );

  it("absent after an `ok` sync from a CP that could not report retirements is `unknown`, never `unlisted`", async () => {
    // An older CP 400s `includeRetired`; the worker syncs live rows only and
    // stamps `ok` + `retirementsUnreported`. An absent slug may then be a
    // retirement the pod was never told about.
    await setTemplateStamp("ok", { retirementsUnreported: true });
    const row = await healthOf(WS_GONE);
    expect(row.lifecycle).toBe("unknown");
    expect(row.lifecycleWarning).toBeNull();
    expect((await healthOf(WS_CURRENT)).lifecycle).toBe("current");
  });

  it("absent with NO template stamp at all (cold) is `unknown`", async () => {
    await setTemplateStamp(null);
    expect((await healthOf(WS_GONE)).lifecycle).toBe("unknown");
  });

  it("a workspace with no template has no lifecycle", async () => {
    const row = await healthOf(WS_PLAIN);
    expect(row.attached).toBe(false);
    expect(row.lifecycle).toBeNull();
  });
});

describe("isTemplateCatalogComplete", () => {
  const s = (lastStatus: string) => ({
    lastSyncAt: "2026-10-11T00:00:00Z",
    lastStatus: lastStatus as "ok",
    lastCount: 1,
  });
  it("needs at least one template stamp, all `ok`", () => {
    expect(isTemplateCatalogComplete({})).toBe(false);
    expect(isTemplateCatalogComplete({ [`${CP}::capability`]: s("ok") })).toBe(
      false
    );
    expect(isTemplateCatalogComplete({ [`${CP}::template`]: s("ok") })).toBe(
      true
    );
    expect(
      isTemplateCatalogComplete({
        [`${CP}::template`]: s("ok"),
        [`https://other::template`]: s("partial"),
      })
    ).toBe(false);
  });
});

describe("browse never offers a retired template", () => {
  it("queryCatalogCache excludes the tombstone", async () => {
    const slugs = (await queryCatalogCache({ kind: "template" })).map(
      (e) => e.slug
    );
    expect(slugs).toContain("ecosystem");
    expect(slugs).not.toContain("radar");
  });
});
