/**
 * The renderer-binding SURFACE dimension (migration 0299) on a real Postgres.
 *
 * The table is built by running the REAL migrations (0243 then 0299), and rows
 * are written through the real write door (`setRendererBinding`), so the
 * partial unique index and the surface default are the ones production has.
 *
 * What is pinned:
 *   - `resolveSurfaceRenderer` walks user → workspace → pod on the `mcp-app`
 *     surface, skips the workspace rung without a workspaceId, and refuses a
 *     bound cell that is missing, inactive, or not `rendererType: "mcp-app"`.
 *   - The two surfaces never see each other: an `app` binding is not served
 *     to `mcp-app`, and the in-app ladder (`getEffectiveRendererWithSource`)
 *     ignores `mcp-app` bindings — the blast-radius guarantee.
 *   - An `app` and an `mcp-app` binding for the same key coexist (0299 put
 *     `surface` into the active-unique key).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { setRendererBinding } from "./renderer-binding-service.js";
import {
  ProfileResolutionService,
  resolveSurfaceRenderer,
} from "./profile-resolution-service.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const migration = (name: string) =>
  readFileSync(resolve(HERE, `../../migrations/${name}`), "utf8");

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

const USER = "u-1";
const WS = "11111111-1111-4111-8111-111111111111";
const kindKey = {
  subjectKind: "proposal",
  contentKind: "entity-detail" as const,
};
const cellRef = (cellKey: string) => ({
  kind: "cell" as const,
  cellKey,
  props: {},
});

async function addCell(
  typeKey: string,
  opts: {
    rendererType?: string;
    workspaceId?: string | null;
    isActive?: boolean;
  } = {}
) {
  await pg.query(
    `INSERT INTO widget_definitions
       (type_key, workspace_id, renderer_type, renderer_source, external_hosts, version, is_active)
     VALUES ($1, $2, $3, $4, $5::jsonb, '1.2.0', $6)`,
    [
      typeKey,
      opts.workspaceId ?? null,
      opts.rendererType ?? "mcp-app",
      `<!doctype html><title>${typeKey}</title>`,
      JSON.stringify(["https://api.example.com"]),
      opts.isActive ?? true,
    ]
  );
}

const bindMcp = (scope: "user" | "workspace" | "pod", cellKey: string) =>
  setRendererBinding(db, {
    scopeKind: scope,
    userId: scope === "user" ? USER : null,
    workspaceId: scope === "workspace" ? WS : null,
    ...kindKey,
    surface: "mcp-app",
    ref: cellRef(cellKey),
    actorUserId: USER,
  });

const resolveMcp = (workspaceId: string | null = WS) =>
  resolveSurfaceRenderer(db, {
    userId: USER,
    workspaceId,
    ...kindKey,
    surface: "mcp-app",
  });

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE workspaces (id uuid PRIMARY KEY);
    INSERT INTO workspaces (id) VALUES ('${WS}');
    CREATE TABLE widget_definitions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      type_key text NOT NULL,
      workspace_id uuid,
      renderer_type text NOT NULL DEFAULT 'builtin',
      renderer_source text,
      external_hosts jsonb,
      version text DEFAULT '1.0.0',
      is_active boolean NOT NULL DEFAULT true
    );
  `);
  await pg.exec(migration("0243_renderer_bindings.sql"));
  await pg.exec(migration("0299_renderer_bindings_surface.sql"));
  db = drizzle(pg);
}, 120_000);

beforeEach(async () => {
  await pg.exec(
    `DELETE FROM renderer_bindings; DELETE FROM widget_definitions;`
  );
});

afterAll(async () => {
  await pg?.close();
});

describe("resolveSurfaceRenderer — the mcp-app ladder", () => {
  it("user beats workspace beats pod", async () => {
    await addCell("pod-cell");
    await addCell("ws-cell");
    await addCell("user-cell");
    await bindMcp("pod", "pod-cell");
    await expect(resolveMcp()).resolves.toMatchObject({
      cellKey: "pod-cell",
      bindingScope: "pod",
    });

    await bindMcp("workspace", "ws-cell");
    await expect(resolveMcp()).resolves.toMatchObject({
      cellKey: "ws-cell",
      bindingScope: "workspace",
    });

    await bindMcp("user", "user-cell");
    await expect(resolveMcp()).resolves.toEqual({
      cellKey: "user-cell",
      rendererSource: "<!doctype html><title>user-cell</title>",
      externalHosts: ["https://api.example.com"],
      version: "1.2.0",
      bindingScope: "user",
    });
  });

  it("skips the workspace rung when no workspaceId is given", async () => {
    await addCell("pod-cell");
    await addCell("ws-cell");
    await bindMcp("pod", "pod-cell");
    await bindMcp("workspace", "ws-cell");
    await expect(resolveMcp(null)).resolves.toMatchObject({
      cellKey: "pod-cell",
      bindingScope: "pod",
    });
  });

  it("refuses a bound cell that is not rendererType mcp-app", async () => {
    await addCell("frame-cell", { rendererType: "frame" });
    await bindMcp("pod", "frame-cell");
    await expect(resolveMcp()).resolves.toBeNull();
  });

  it("refuses a bound cell that is missing or inactive (soft-deleted)", async () => {
    await bindMcp("pod", "gone-cell");
    await expect(resolveMcp()).resolves.toBeNull();

    await addCell("gone-cell", { isActive: false });
    await expect(resolveMcp()).resolves.toBeNull();
  });

  it("nothing bound → null", async () => {
    await expect(resolveMcp()).resolves.toBeNull();
  });
});

describe("the two surfaces never see each other", () => {
  it("an app-surface binding is NOT served to mcp-app", async () => {
    await addCell("an-mcp-cell");
    await setRendererBinding(db, {
      scopeKind: "pod",
      ...kindKey,
      ref: cellRef("an-mcp-cell"),
      actorUserId: USER,
    });
    await expect(resolveMcp()).resolves.toBeNull();
  });

  it("the in-app ladder ignores mcp-app bindings, and still reads app ones", async () => {
    const svc = new ProfileResolutionService(db);
    // No profile rows in this harness — the legacy rung is not under test.
    (svc as unknown as { profileRepo: { getBySlug: () => null } }).profileRepo =
      { getBySlug: () => null };

    await bindMcp("pod", "an-mcp-cell");
    await bindMcp("user", "an-mcp-cell");
    const ignored = await svc.getEffectiveRendererWithSource(
      "proposal",
      null,
      "entity-detail",
      { userId: USER }
    );
    expect(ignored.source).toBe("default");
    expect(ignored.binding).toBeUndefined();

    await setRendererBinding(db, {
      scopeKind: "pod",
      ...kindKey,
      ref: cellRef("in-app-cell"),
      actorUserId: USER,
    });
    const read = await svc.getEffectiveRendererWithSource(
      "proposal",
      null,
      "entity-detail",
      { userId: USER }
    );
    expect(read.source).toBe("pod");
    expect(read.ref).toMatchObject({ cellKey: "in-app-cell" });
  });

  it("an app and an mcp-app binding for the same key coexist (surface is in the unique key)", async () => {
    await setRendererBinding(db, {
      scopeKind: "pod",
      ...kindKey,
      ref: cellRef("in-app-cell"),
      actorUserId: USER,
    });
    await bindMcp("pod", "an-mcp-cell");
    const live = await pg.query<{ surface: string }>(
      `SELECT surface FROM renderer_bindings WHERE revoked_at IS NULL ORDER BY surface`
    );
    expect(live.rows.map((r) => r.surface)).toEqual(["app", "mcp-app"]);
  });
});
