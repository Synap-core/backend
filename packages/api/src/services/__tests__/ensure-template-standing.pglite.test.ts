/**
 * `readTemplateStanding` — where a template an app needs stands on this pod
 * (TEMPLATE-LIFECYCLE Contract B), driven through the real service on PGlite.
 * Fixture rows are chosen so each status rules a wrong rule out:
 *   • installed: an ACTIVE space holds the template identity — an ARCHIVED
 *     holder of another slug must not count (rules out "any row");
 *   • retired: a tombstone answers `retired` + replacedBy BEFORE any install
 *     offer, even though the pod's built-in bundle could not install it either;
 *   • not_in_catalog: only with a COMPLETE (`ok`) template sync stamp;
 *   • unknown: the same absent slug with a `partial` stamp (rules out folding
 *     "the read was incomplete" into "it is not in the catalog");
 *   • available: a live cache row, with the card read from the cache;
 *   • exists: a domain twin (one space per domain) is answered, never installed.
 * Real: `readTemplateStanding`, `resolveTemplateCatalog`, the pglite tables.
 * Mocked: the stamp reader (bound to the database package's own connection,
 * same boundary as `template-health-lifecycle.pglite.test.ts`) and the
 * one-space-per-domain verdict (proven in its own suite).
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  verdict: { action: "create" } as Record<string, unknown>,
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
    getCatalogSyncStamps: async () => {
      const [row] = await db
        .select({ settings: schema.podSettings.settings })
        .from(schema.podSettings)
        .limit(1);
      return row?.settings?.catalogSyncStamps ?? {};
    },
  };
});

vi.mock("../workspace-creation-service.js", () => ({
  checkOneSpacePerDomain: async () => h.verdict,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  cpCatalogCache,
  podSettings,
  workspaces,
} from "@synap/database/schema";
import { readTemplateStanding } from "../ensure-template.js";

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
const WS_CRM = randomUUID();
const WS_OLD = randomUUID();

async function setTemplateStamp(status: string): Promise<void> {
  await h.client!.exec(`delete from pod_settings`);
  await h.client!.query(
    `insert into pod_settings (settings) values ($1::jsonb)`,
    [
      JSON.stringify({
        catalogSyncStamps: {
          [`${CP}::template`]: {
            lastSyncAt: new Date().toISOString(),
            lastStatus: status,
            lastCount: 3,
          },
        },
      }),
    ]
  );
}

beforeAll(async () => {
  for (const t of [workspaces, cpCatalogCache, podSettings])
    await h.client!.exec(ddlFor(t));
  await h.client!.query(
    `insert into workspaces (id, name, owner_id, package_slug, settings) values ($1,'CRM','user-1','crm',$2::jsonb)`,
    [WS_CRM, JSON.stringify({ packageSlug: "crm", packageVersion: "v1" })]
  );
  // Archived holder of a slug: never "installed".
  await h.client!.query(
    `insert into workspaces (id, name, owner_id, package_slug, settings, archived_at) values ($1,'Old','user-1','content-os',$2::jsonb, now())`,
    [WS_OLD, JSON.stringify({ packageSlug: "content-os" })]
  );
  const cache = async (
    slug: string,
    version: string,
    extra: { retired?: [string | null, string]; definition?: unknown } = {}
  ) =>
    h.client!.query(
      `insert into cp_catalog_cache (source, kind, slug, name, description, version, definition, retired_at, replaced_by_slug, retired_reason)
       values ($1,'template',$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
      [
        CP,
        slug,
        `${slug} name`,
        `${slug} description`,
        version,
        JSON.stringify(extra.definition ?? {}),
        extra.retired ? new Date() : null,
        extra.retired?.[0] ?? null,
        extra.retired?.[1] ?? null,
      ]
    );
  await cache("crm", "v2");
  await cache("content-os", "v1", { definition: { _meta: { icon: "pen" } } });
  await cache("radar", "v9", {
    retired: ["ecosystem", "Radar became Ecosystem."],
  });
});

beforeEach(async () => {
  h.verdict = { action: "create" };
  await setTemplateStamp("ok");
});

describe("readTemplateStanding", () => {
  it("installed: an ACTIVE space holds the template, with its stamp and drift", async () => {
    expect(await readTemplateStanding("crm", "user-1")).toEqual({
      status: "installed",
      workspaceId: WS_CRM,
      version: "v1",
      drifted: true,
      lifecycle: "current",
      replacedBy: null,
    });
  });

  it("an ARCHIVED holder is not installed: the template is available, with its card", async () => {
    expect(await readTemplateStanding("content-os", "user-1")).toEqual({
      status: "available",
      template: {
        slug: "content-os",
        name: "content-os name",
        description: "content-os description",
        icon: "pen",
      },
    });
  });

  it("retired: answered from the cache with its replacement, before any install offer", async () => {
    expect(await readTemplateStanding("radar", "user-1")).toEqual({
      status: "retired",
      replacedBy: "ecosystem",
      reason: "Radar became Ecosystem.",
    });
  });

  it("not_in_catalog: only after a COMPLETE template sync", async () => {
    expect(await readTemplateStanding("zz-never-was", "user-1")).toEqual({
      status: "not_in_catalog",
    });
  });

  it("unknown: the same absent slug when the last sync was not provably complete", async () => {
    await setTemplateStamp("partial");
    expect(await readTemplateStanding("zz-never-was", "user-1")).toEqual({
      status: "unknown",
    });
  });

  it("exists: a domain twin is answered, never offered for install", async () => {
    h.verdict = {
      action: "refuse",
      reply: {
        workspaceId: "ws-twin",
        workspaceName: "My Content",
        guidance: "Use the space you have.",
      },
    };
    expect(await readTemplateStanding("content-os", "user-1")).toEqual({
      status: "exists",
      workspaceId: "ws-twin",
      workspaceName: "My Content",
      guidance: "Use the space you have.",
    });
  });
});
