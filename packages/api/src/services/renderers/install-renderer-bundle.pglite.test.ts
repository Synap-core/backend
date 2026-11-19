/**
 * `installRendererBundle` on REAL rows (PGlite, the real 0436 migration and
 * the real cell door `defineCell`):
 *   - happy path: the host modules, the cells (`cell:<slug>:<key>`, mechanism
 *     frame, slot, view types, the bundle's version) and the bundle row with
 *     its defaults; the defaults never become a renderer binding; each cell
 *     is announced after the commit;
 *   - a declared hash that does not match its source is refused, nothing
 *     written;
 *   - a second slug's host set is refused (RENDERER_HOST_SET_TAKEN);
 *   - a failure inside the act rolls the whole act back (no module, no cell,
 *     no bundle row, no announcement);
 *   - a reinstall of the same slug updates in place;
 *   - the reads: status and host modules (notModified, NOT_FOUND).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  emitted: [] as Array<Record<string, unknown>>,
  failOnKey: null as string | null,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});
vi.mock("../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: (e: Record<string, unknown>) => h.emitted.push(e),
}));
// The real cell door, with a switch that fails one cell mid-act.
vi.mock("../cells/install-cell-from-definition.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../cells/install-cell-from-definition.js")
    >();
  return {
    ...actual,
    installCellFromDefinition: async (
      input: Parameters<typeof actual.installCellFromDefinition>[0]
    ) => {
      if (input.cellKey === h.failOnKey) throw new Error("cell write failed");
      return actual.installCellFromDefinition(input);
    },
  };
});

import { rendererBindings, widgetDefinitions } from "@synap/database/schema";
import {
  installRendererBundle,
  rendererSetSha256,
  RENDERER_BUNDLE_HASH_MISMATCH,
  RENDERER_HOST_SET_TAKEN,
} from "./install-renderer-bundle.js";
import {
  NO_RENDERER_BUNDLE,
  readRendererHostModules,
  readRendererStatus,
} from "./read-renderer-bundle.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0436 = readFileSync(
  resolve(HERE, "../../../../database/migrations/0436_renderer_bundles.sql"),
  "utf8"
);

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary ? " primary key" : "";
    const def =
      type === "uuid" && c.primary ? " DEFAULT gen_random_uuid()" : "";
    const notNullDefault =
      c.name === "is_active"
        ? " DEFAULT true"
        : c.name === "content_kind"
          ? " DEFAULT 'widget'"
          : "";
    return `"${c.name}" ${type}${pk}${def}${notNullDefault}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const mod = (source: string) => ({ source, sha256: sha(source) });

function bundle(slug = "synap-renderers", version = "1.0.0") {
  const hostModules = {
    react: mod("export default {};"),
    reactDom: mod("export default { dom: true };"),
    reactDomClient: mod("export const createRoot = () => null;"),
    jsxRuntime: mod("export const jsx = () => null;"),
    kit: mod(
      "export const Card = () => null; export const Board = () => null;"
    ),
    tokensCss: mod(":root{}"),
  };
  const card =
    'import { Card } from "@synap/kit";\nexport default function C() { return null; }';
  const board =
    'import { Board } from "@synap/kit";\nexport default function B() { return null; }';
  return {
    _meta: { slug, version, kind: "renderer-bundle" as const },
    bundleApi: 1 as const,
    reactVersion: "19.2.3",
    setSha256: rendererSetSha256(
      Object.fromEntries(
        Object.entries(hostModules).map(([k, v]) => [k, v.sha256])
      )
    ),
    kitExports: ["Card", "Board"],
    hostModules,
    cells: [
      {
        key: "entity-card",
        name: "Entity card",
        code: card,
        sha256: sha(card),
        contentKind: "entity-card",
        kitImports: ["Card"],
      },
      {
        key: "board",
        name: "Board",
        code: board,
        sha256: sha(board),
        contentKind: "collection",
        viewTypes: ["board", "kanban"],
        defaultSize: { w: 12, h: 8 },
        kitImports: ["Board"],
      },
    ],
    defaults: { "entity-card": "entity-card", views: { board: "board" } },
  };
}

const count = async (sql: string) =>
  (await h.client!.query<{ n: number }>(sql)).rows[0]!.n;

const reasonOf = (err: unknown) =>
  (err as { cause?: { reasonCode?: string } }).cause?.reasonCode;

beforeAll(async () => {
  await h.client!.exec(M0436);
  await h.client!.exec(ddlFor(widgetDefinitions as never));
  await h.client!.exec(
    `CREATE UNIQUE INDEX widget_def_type_key_workspace_uniq ON widget_definitions (type_key, workspace_id);`
  );
  await h.client!.exec(ddlFor(rendererBindings as never));
}, 60_000);

beforeEach(async () => {
  await h.client!.exec(
    `delete from renderer_host_modules; delete from renderer_bundles; delete from widget_definitions; delete from renderer_bindings;`
  );
  h.emitted.length = 0;
  h.failOnKey = null;
});

describe("installRendererBundle", () => {
  it("installs the modules, the cells and the bundle row with its defaults", async () => {
    const def = bundle();
    const out = await installRendererBundle(def, {
      userId: "user-1",
      source: "synap",
    });
    expect(out).toMatchObject({
      slug: "synap-renderers",
      version: "1.0.0",
      setSha256: def.setSha256,
    });
    expect(out.cells.map((c) => c.typeKey).sort()).toEqual([
      "cell:synap-renderers:board",
      "cell:synap-renderers:entity-card",
    ]);

    const modules = await h.client!.query<{
      module: string;
      sha256: string;
      byte_length: number;
    }>(
      `select module, sha256, byte_length from renderer_host_modules order by module`
    );
    expect(modules.rows.map((r) => r.module)).toEqual([
      "jsxRuntime",
      "kit",
      "react",
      "reactDom",
      "reactDomClient",
      "tokensCss",
    ]);
    expect(modules.rows.find((r) => r.module === "react")).toMatchObject({
      sha256: def.hostModules.react.sha256,
      byte_length: Buffer.byteLength(def.hostModules.react.source),
    });

    const cells = await h.client!.query<{
      type_key: string;
      renderer_type: string;
      content_kind: string;
      view_renderer_view_types: string[] | null;
      version: string;
      workspace_id: string | null;
    }>(
      `select type_key, renderer_type, content_kind, view_renderer_view_types, version, workspace_id
         from widget_definitions order by type_key`
    );
    expect(cells.rows).toEqual([
      {
        type_key: "cell:synap-renderers:board",
        renderer_type: "frame",
        content_kind: "collection",
        view_renderer_view_types: ["board", "kanban"],
        version: "1.0.0",
        workspace_id: null,
      },
      {
        type_key: "cell:synap-renderers:entity-card",
        renderer_type: "frame",
        content_kind: "entity-card",
        view_renderer_view_types: null,
        version: "1.0.0",
        workspace_id: null,
      },
    ]);

    const row = await h.client!.query<{
      defaults: unknown;
      kit_exports: unknown;
      installed_by: string;
      source: string;
    }>(
      `select defaults, kit_exports, installed_by, source from renderer_bundles where slug = 'synap-renderers'`
    );
    expect(row.rows[0]).toEqual({
      defaults: def.defaults,
      kit_exports: ["Card", "Board"],
      installed_by: "user-1",
      source: "synap",
    });

    // Defaults are the host fallback, never a binding.
    expect(
      await count(`select count(*)::int as n from renderer_bindings`)
    ).toBe(0);
    // Each cell announced once, after the commit.
    expect(h.emitted.map((e) => e.subjectId).sort()).toEqual([
      "cell:synap-renderers:board",
      "cell:synap-renderers:entity-card",
    ]);
  });

  it("refuses a source whose declared sha256 does not match, and writes nothing", async () => {
    const def = bundle();
    def.hostModules.kit = {
      source: def.hostModules.kit.source + "\n// changed",
      sha256: def.hostModules.kit.sha256,
    };
    const err = await installRendererBundle(def, {
      userId: "user-1",
      source: "synap",
    }).catch((e: unknown) => e);
    expect(reasonOf(err)).toBe(RENDERER_BUNDLE_HASH_MISMATCH);
    expect(
      (err as { cause?: { mismatches?: string[] } }).cause?.mismatches
    ).toContain("hostModules.kit.sha256");

    const tamperedCell = bundle();
    tamperedCell.cells[0]!.code += "\n// changed";
    const err2 = await installRendererBundle(tamperedCell, {
      userId: "user-1",
      source: "synap",
    }).catch((e: unknown) => e);
    expect(
      (err2 as { cause?: { mismatches?: string[] } }).cause?.mismatches
    ).toEqual(["cells[0].sha256"]);

    expect(
      await count(`select count(*)::int as n from renderer_host_modules`)
    ).toBe(0);
    expect(
      await count(`select count(*)::int as n from widget_definitions`)
    ).toBe(0);
    expect(await count(`select count(*)::int as n from renderer_bundles`)).toBe(
      0
    );
  });

  it("refuses a second slug's host set", async () => {
    await installRendererBundle(bundle(), {
      userId: "user-1",
      source: "synap",
    });
    const err = await installRendererBundle(bundle("acme-renderers"), {
      userId: "user-1",
      source: "synap",
    }).catch((e: unknown) => e);
    expect(reasonOf(err)).toBe(RENDERER_HOST_SET_TAKEN);
    expect((err as { code?: string }).code).toBe("CONFLICT");
    expect(
      await count(
        `select count(*)::int as n from widget_definitions where type_key like 'cell:acme-renderers:%'`
      )
    ).toBe(0);
    expect(
      await count(
        `select count(*)::int as n from renderer_bundles where slug = 'acme-renderers'`
      )
    ).toBe(0);
  });

  it("rolls the whole act back when a step fails inside it", async () => {
    h.failOnKey = "board";
    await expect(
      installRendererBundle(bundle(), { userId: "user-1", source: "synap" })
    ).rejects.toThrow("cell write failed");
    expect(
      await count(`select count(*)::int as n from renderer_host_modules`)
    ).toBe(0);
    expect(
      await count(`select count(*)::int as n from widget_definitions`)
    ).toBe(0);
    expect(await count(`select count(*)::int as n from renderer_bundles`)).toBe(
      0
    );
    expect(h.emitted).toEqual([]);
  });

  it("a reinstall of the same slug updates it in place", async () => {
    await installRendererBundle(bundle(), {
      userId: "user-1",
      source: "synap",
    });
    const next = bundle("synap-renderers", "1.1.0");
    next.hostModules.tokensCss = mod(":root{--x:1}");
    next.setSha256 = rendererSetSha256(
      Object.fromEntries(
        Object.entries(next.hostModules).map(([k, v]) => [k, v.sha256])
      )
    );
    const out = await installRendererBundle(next, {
      userId: "user-2",
      source: "synap",
    });
    expect(out.cells.every((c) => c.changeType === "updated")).toBe(true);
    const row = await h.client!.query<{ version: string; set_sha256: string }>(
      `select version, set_sha256 from renderer_bundles`
    );
    expect(row.rows).toEqual([
      { version: "1.1.0", set_sha256: next.setSha256 },
    ]);
    expect(
      await count(`select count(*)::int as n from renderer_host_modules`)
    ).toBe(6);
  });
});

describe("the reads", () => {
  it("with no bundle: status is empty and the host modules are NOT_FOUND", async () => {
    expect(await readRendererStatus({ workspaceId: null })).toEqual({
      bundle: null,
      defaults: {},
      installed: [],
    });
    const err = await readRendererHostModules({}).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("NOT_FOUND");
    expect(reasonOf(err)).toBe(NO_RENDERER_BUNDLE);
  });

  it("status names the bundle, its defaults and the installed cells without source", async () => {
    const def = bundle();
    await installRendererBundle(def, { userId: "user-1", source: "synap" });
    const status = await readRendererStatus({ workspaceId: null });
    expect(status).toEqual({
      bundle: {
        slug: "synap-renderers",
        version: "1.0.0",
        setSha256: def.setSha256,
        reactVersion: "19.2.3",
      },
      defaults: def.defaults,
      installed: [
        {
          key: "cell:synap-renderers:board",
          runtime: "frame",
          contentKind: "collection",
          viewTypes: ["board", "kanban"],
        },
        {
          key: "cell:synap-renderers:entity-card",
          runtime: "frame",
          contentKind: "entity-card",
          viewTypes: [],
        },
      ],
    });
    expect(JSON.stringify(status)).not.toContain("@synap/kit");
  });

  it("host modules: the set, then notModified for the set the caller holds", async () => {
    const def = bundle();
    await installRendererBundle(def, { userId: "user-1", source: "synap" });
    const full = await readRendererHostModules({});
    expect(full).toEqual({
      notModified: false,
      setSha256: def.setSha256,
      modules: Object.fromEntries(
        Object.entries(def.hostModules).map(([k, v]) => [k, v.source])
      ),
      kitExports: ["Card", "Board"],
    });
    expect(
      await readRendererHostModules({ knownSetSha256: def.setSha256 })
    ).toEqual({ notModified: true, setSha256: def.setSha256 });
    expect(
      await readRendererHostModules({ knownSetSha256: "0".repeat(64) })
    ).toMatchObject({ notModified: false });
  });
});
