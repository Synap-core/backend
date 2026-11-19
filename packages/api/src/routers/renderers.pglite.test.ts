/**
 * `renderers.status` and `renderers.hostModules` through the real router and
 * podProcedure, on real rows (PGlite, the real 0436 migration):
 *   - NOT_FOUND (`reasonCode: NO_RENDERER_BUNDLE`) with no bundle; an empty status;
 *   - status: the bundle, its defaults, the frame/iframe cells of the lens
 *     (pod-wide, plus the caller's space), never their source;
 *   - hostModules: the set, then `notModified` for the set the caller holds;
 *     a malformed `knownSetSha256` is refused.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});
vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});

import { widgetDefinitions } from "@synap/database/schema";
import { renderersRouter } from "./renderers.js";
import type { Context } from "../types/context.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0436 = readFileSync(
  resolve(HERE, "../../../database/migrations/0436_renderer_bundles.sql"),
  "utf8"
);
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key DEFAULT gen_random_uuid()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const SET = "c".repeat(64);
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const caller = () =>
  renderersRouter.createCaller({
    authenticated: true,
    userId: "user-1",
  } as unknown as Context);
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

beforeAll(async () => {
  await h.client!.exec(M0436);
  await h.client!.exec(ddlFor(widgetDefinitions as never));
}, 60_000);

beforeEach(async () => {
  await h.client!.exec(
    `delete from renderer_host_modules; delete from renderer_bundles; delete from widget_definitions;`
  );
});

async function seedBundle() {
  await h.client!.exec(`BEGIN;
    INSERT INTO renderer_host_modules (bundle_slug, module, source, sha256, byte_length) VALUES
      ('synap-renderers', 'react', 'export default {}', '${"1".repeat(64)}', 17),
      ('synap-renderers', 'tokensCss', ':root{}', '${"2".repeat(64)}', 7);
    INSERT INTO renderer_bundles (slug, version, set_sha256, react_version, kit_exports, defaults, source, installed_by)
      VALUES ('synap-renderers', '1.0.0', '${SET}', '19.2.3', '["Card"]', '{"entity-card":"entity-card"}', 'synap', 'user-1');
    COMMIT;`);
  const cell = (
    typeKey: string,
    rendererType: string,
    workspaceId: string | null,
    isActive = true
  ) =>
    q(
      `insert into widget_definitions (type_key, name, renderer_type, renderer_source, content_kind, view_renderer_view_types, workspace_id, is_active)
       values ($1, $1, $2, 'SECRET-SOURCE', 'entity-card', null, $3, $4)`,
      [typeKey, rendererType, workspaceId, isActive]
    );
  await cell("cell:synap-renderers:entity-card", "frame", null);
  await cell("generated:page", "iframe", null);
  await cell("builtin:table", "builtin", null);
  await cell("cell:x:retired", "frame", null, false);
  await cell("cell:x:other-space", "frame", OTHER_WS);
}

describe("renderers router", () => {
  it("with no bundle: an empty status, and hostModules is NOT_FOUND", async () => {
    expect(await caller().status()).toEqual({
      bundle: null,
      defaults: {},
      installed: [],
    });
    const err = await caller()
      .hostModules()
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("NOT_FOUND");
    expect((err as { cause?: { reasonCode?: string } }).cause?.reasonCode).toBe(
      "NO_RENDERER_BUNDLE"
    );
  });

  it("status: the bundle, its defaults and the frame/iframe cells of the lens, without source", async () => {
    await seedBundle();
    const status = await caller().status();
    expect(status).toEqual({
      bundle: {
        slug: "synap-renderers",
        version: "1.0.0",
        setSha256: SET,
        reactVersion: "19.2.3",
      },
      defaults: { "entity-card": "entity-card" },
      installed: [
        {
          key: "cell:synap-renderers:entity-card",
          runtime: "frame",
          contentKind: "entity-card",
          viewTypes: [],
        },
        {
          key: "generated:page",
          runtime: "direct",
          contentKind: "entity-card",
          viewTypes: [],
        },
      ],
    });
    expect(JSON.stringify(status)).not.toContain("SECRET-SOURCE");
  });

  it("hostModules: the set, then notModified for the set the caller holds", async () => {
    await seedBundle();
    expect(await caller().hostModules()).toEqual({
      notModified: false,
      setSha256: SET,
      modules: { react: "export default {}", tokensCss: ":root{}" },
      kitExports: ["Card"],
    });
    expect(await caller().hostModules({ knownSetSha256: SET })).toEqual({
      notModified: true,
      setSha256: SET,
    });
    await expect(
      caller().hostModules({ knownSetSha256: "not-a-sha" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
