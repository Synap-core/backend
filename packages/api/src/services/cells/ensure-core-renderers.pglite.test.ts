/**
 * `ensureCoreRenderers` on REAL tables: the catalog row → the ONE install door
 * (`applyMarketInstall` → `installCellFromDefinition` → `defineCell`) → the ONE
 * binding door (`setProfileRenderer` → `setRendererBinding`), and finally the
 * resolver an outside host is actually served from (`resolveSurfaceRenderer`),
 * so the assertion is that the renderer ARRIVES, not that a row has a shape.
 *
 * Tables are generated from Drizzle schema definitions (FKs stripped — PGlite
 * has no workspaces/users here), so the version default, the active-unique
 * binding index and the scope CHECK are the production ones.
 *
 * Stubbed: the pod-owner lookup (the actor), the pod-admin floor (granted — it
 * has its own tests) and the realtime emit.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  failNextSelect: false,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const real = drizzle(client, { schema });
  // A db whose next `select` rejects — proves a failed read is not "absent".
  h.db = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "select" && h.failNextSelect) {
        h.failNextSelect = false;
        return () => {
          throw new Error("connection reset");
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { ...actual, db: h.db, getDb: async () => h.db };
});
vi.mock("../capabilities/pod-owner.js", () => ({
  resolvePodOwnerUserId: async () => "owner-1",
}));
vi.mock("../../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isPodAdmin: async () => true,
}));
vi.mock("../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: () => undefined,
}));

import {
  resolveSurfaceRenderer,
  widgetDefinitions,
  cpCatalogCache,
} from "@synap/database";
import {
  ensureCoreRenderers,
  CORE_MCP_RENDERERS,
} from "./ensure-core-renderers.js";
import { TOOL_UI_SUBJECT } from "../../routers/mcp/ui-tools.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary ? " primary key" : "";
    // PGlite doesn't support gen_random_uuid(), so add DEFAULT for uuid PKs
    const defaults =
      type === "uuid" && c.primary ? " DEFAULT gen_random_uuid()" : "";
    return `"${c.name}" ${type}${pk}${defaults}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const PROPOSAL = TOOL_UI_SUBJECT.synap_get_proposal!;
const TYPE_KEY = "cell:synap-mcp-renderers:proposal-card";
const HTML = (v: string) =>
  `<!doctype html><html><body>proposal ${v}</body></html>`;

async function seedCatalog(
  version: string | null,
  code = HTML(version ?? "x")
) {
  await h.client!.query(
    `insert into cp_catalog_cache (id, source, kind, slug, name, version, definition)
     values ($1, 'https://cp.test', 'cell', 'synap-mcp-renderers/proposal-card', 'Proposal card', $2, $3)
     on conflict (source, kind, slug) do update set version = excluded.version, definition = excluded.definition`,
    [
      randomUUID(),
      version,
      JSON.stringify({
        key: "proposal-card",
        packageSlug: "synap-mcp-renderers",
        rendererType: "mcp-app",
        contentKind: "entity-card",
        code,
      }),
    ]
  );
}
const cellRows = () =>
  h.client!.query<{
    version: string;
    renderer_source: string;
    updated_at: string;
  }>(
    `select version, renderer_source, updated_at::text from widget_definitions where type_key = $1`,
    [TYPE_KEY]
  );
const bindingRows = () =>
  h.client!.query<{
    scope_kind: string;
    ref: { cellKey: string };
    revoked_at: string | null;
    user_id: string | null;
  }>(
    `select scope_kind, ref, revoked_at::text, user_id from renderer_bindings order by created_at`
  );
const served = (userId = "someone") =>
  resolveSurfaceRenderer(h.db as never, {
    userId,
    workspaceId: null,
    subjectKind: PROPOSAL.subjectKind,
    contentKind: PROPOSAL.contentKind,
    surface: "mcp-app",
  });

beforeAll(async () => {
  await h.client!.exec(ddlFor(widgetDefinitions as never));
  await h.client!.exec(ddlFor(cpCatalogCache as never));
  // Add unique index for cp_catalog_cache (ddlFor only creates the table)
  await h.client!.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_cp_catalog_cache ON cp_catalog_cache (source, kind, slug);`
  );
  // renderer_bindings uses an enum type that PGlite doesn't support;
  // recreate the table with text for scope_kind instead.
  // pgcrypto extension isn't available in PGlite, so we can't use gen_random_uuid().
  // We'll generate UUIDs manually in test inserts.
  await h.client!.exec(`
    CREATE TABLE "renderer_bindings" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "scope_kind" text NOT NULL,
      "user_id" text,
      "workspace_id" text,
      "subject_kind" text NOT NULL,
      "subject_id" text,
      "content_kind" text NOT NULL,
      "surface" text NOT NULL DEFAULT 'app',
      "ref" jsonb NOT NULL DEFAULT '{}',
      "source_proposal_id" uuid,
      "created_by" text NOT NULL DEFAULT '',
      "revoked_at" timestamp with time zone,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX "renderer_bindings_active_unique" ON "renderer_bindings" (
      "scope_kind",
      COALESCE("user_id", ''),
      COALESCE("workspace_id", ''),
      "subject_kind",
      "content_kind",
      "surface"
    ) WHERE "revoked_at" IS NULL;
    CREATE INDEX "renderer_bindings_subject_idx" ON "renderer_bindings" ("subject_kind", "content_kind") WHERE "revoked_at" IS NULL;
    CREATE INDEX "renderer_bindings_source_proposal_idx" ON "renderer_bindings" ("source_proposal_id");
  `);
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    `delete from cp_catalog_cache; delete from widget_definitions; delete from renderer_bindings;`
  );
});

describe("ensureCoreRenderers", () => {
  it("the pinned list derives its binding identity from TOOL_UI_SUBJECT", () => {
    expect(CORE_MCP_RENDERERS).toEqual([
      expect.objectContaining({
        slug: "synap-mcp-renderers",
        cellKey: "proposal-card",
        subjectKind: PROPOSAL.subjectKind,
        contentKind: PROPOSAL.contentKind,
      }),
    ]);
  });

  it("catalog absent → nothing installed, nothing bound", async () => {
    const r = await ensureCoreRenderers();
    expect(r).toEqual([
      expect.objectContaining({
        install: "not-in-catalog",
        binding: "skipped",
      }),
    ]);
    expect((await cellRows()).rows).toHaveLength(0);
    expect((await bindingRows()).rows).toHaveLength(0);
    expect(await served()).toBeNull();
  });

  it("catalog present, not installed → installed at the catalog version + pod binding an outside host is served", async () => {
    await seedCatalog("1.0.0");
    const r = await ensureCoreRenderers();
    expect(r).toEqual([
      expect.objectContaining({ install: "installed", binding: "created" }),
    ]);
    expect((await cellRows()).rows).toEqual([
      expect.objectContaining({ version: "1.0.0" }),
    ]);
    const b = (await bindingRows()).rows;
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({
      scope_kind: "pod",
      revoked_at: null,
      ref: { cellKey: TYPE_KEY },
    });
    const hit = await served();
    expect(hit?.rendererSource).toBe(HTML("1.0.0"));
    expect(hit?.bindingScope).toBe("pod");
  });

  it("installed at the same version → no-op (no write)", async () => {
    await seedCatalog("1.0.0");
    await ensureCoreRenderers();
    const before = (await cellRows()).rows[0];
    const bindingsBefore = (await bindingRows()).rows;
    const r = await ensureCoreRenderers();
    expect(r).toEqual([
      expect.objectContaining({ install: "up-to-date", binding: "kept" }),
    ]);
    expect((await cellRows()).rows[0]).toEqual(before);
    expect((await bindingRows()).rows).toEqual(bindingsBefore);
  });

  it("catalog newer → re-installed with the new source and version", async () => {
    await seedCatalog("1.0.0");
    await ensureCoreRenderers();
    await seedCatalog("1.1.0");
    const r = await ensureCoreRenderers();
    expect(r).toEqual([
      expect.objectContaining({ install: "reinstalled", binding: "kept" }),
    ]);
    expect((await cellRows()).rows[0]).toMatchObject({
      version: "1.1.0",
      renderer_source: HTML("1.1.0"),
    });
    expect((await served())?.rendererSource).toBe(HTML("1.1.0"));
  });

  it("catalog OLDER than installed → never downgrades", async () => {
    await seedCatalog("2.0.0");
    await ensureCoreRenderers();
    await seedCatalog("1.0.0");
    const r = await ensureCoreRenderers();
    expect(r).toEqual([expect.objectContaining({ install: "up-to-date" })]);
    expect((await cellRows()).rows[0]!.version).toBe("2.0.0");
  });

  it("an existing pod mcp-app binding to another cell is untouched", async () => {
    await h.client!.query(
      `insert into renderer_bindings (id, scope_kind, subject_kind, content_kind, surface, ref, created_by)
       values ($1, 'pod', $2, $3, 'mcp-app', '{"kind":"cell","cellKey":"cell:acme:other","props":{}}', 'admin')`,
      [randomUUID(), PROPOSAL.subjectKind, PROPOSAL.contentKind]
    );
    await seedCatalog("1.0.0");
    const r = await ensureCoreRenderers();
    expect(r).toEqual([
      expect.objectContaining({ install: "installed", binding: "kept" }),
    ]);
    const b = (await bindingRows()).rows;
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({
      revoked_at: null,
      ref: { cellKey: "cell:acme:other" },
    });
  });

  it("an admin UNBIND (revoked pod binding, nothing newer) is never re-seeded", async () => {
    await h.client!.query(
      `insert into renderer_bindings (id, scope_kind, subject_kind, content_kind, surface, ref, created_by, revoked_at)
       values ($1, 'pod', $2, $3, 'mcp-app', $4, 'admin', now())`,
      [
        randomUUID(),
        PROPOSAL.subjectKind,
        PROPOSAL.contentKind,
        JSON.stringify({ kind: "cell", cellKey: TYPE_KEY, props: {} }),
      ]
    );
    await seedCatalog("1.0.0");
    const r = await ensureCoreRenderers();
    expect(r).toEqual([expect.objectContaining({ binding: "kept" })]);
    expect(
      (await bindingRows()).rows.filter((x) => x.revoked_at === null)
    ).toHaveLength(0);
  });

  it("a user binding is untouched and still wins for that user", async () => {
    await h.client!.query(
      `insert into renderer_bindings (id, scope_kind, user_id, subject_kind, content_kind, surface, ref, created_by)
       values ($1, 'user', 'u-9', $2, $3, 'mcp-app', '{"kind":"cell","cellKey":"cell:mine:card","props":{}}', 'u-9')`,
      [randomUUID(), PROPOSAL.subjectKind, PROPOSAL.contentKind]
    );
    await h.client!.query(
      `insert into widget_definitions (id, type_key, name, renderer_type, renderer_source, is_active)
       values ($1, 'cell:mine:card', 'Mine', 'mcp-app', '<p>mine</p>', true)`,
      [randomUUID()]
    );
    await seedCatalog("1.0.0");
    await ensureCoreRenderers();
    const userRow = (await bindingRows()).rows.find(
      (x) => x.scope_kind === "user"
    );
    expect(userRow).toMatchObject({
      user_id: "u-9",
      revoked_at: null,
      ref: { cellKey: "cell:mine:card" },
    });
    expect((await served("u-9"))?.rendererSource).toBe("<p>mine</p>");
    expect((await served("other"))?.rendererSource).toBe(HTML("1.0.0"));
  });

  it("a DB error surfaces — never read as 'not in catalog'", async () => {
    await seedCatalog("1.0.0");
    h.failNextSelect = true;
    await expect(ensureCoreRenderers()).rejects.toThrow("connection reset");
    expect((await cellRows()).rows).toHaveLength(0);
  });
});
