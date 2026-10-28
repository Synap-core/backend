/**
 * `defineCell` derives a cell's MECHANISM from its source, on REAL rows.
 *
 * The agent doors (MCP `synap_create_cell`, Hub `POST /cells/define`) name no
 * mechanism. Before this rule every such cell was stored as `frame` — an ES
 * module run in the React frame — so an agent's HTML page (document 6aa8d140,
 * `generated:claude-code-fleet-report`, which opens with `<title>`) failed on
 * the desktop and showed as a chip in the console.
 *
 * Proven here, through the real upsert SQL on PGlite (both scope branches —
 * the ON CONFLICT path of a space cell and the manual UPDATE of a pod-wide
 * one):
 *   - INSERT with no mechanism: a page → `iframe`, a module → `frame`;
 *   - UPDATE with no mechanism: a stored frame/iframe row is re-derived from
 *     the source being written, both ways;
 *   - a stored `builtin` / `mcp-app` row keeps its mechanism;
 *   - an explicit mechanism always wins, on insert and on update.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
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
  emitHubRealtimeEvent: () => undefined,
}));

import { widgetDefinitions } from "@synap/database";
import { defineCell } from "./define-cell.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary ? " primary key" : "";
    const defaults =
      type === "uuid" && c.primary ? " DEFAULT gen_random_uuid()" : "";
    return `"${c.name}" ${type}${pk}${defaults}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const WS = "11111111-1111-4111-8111-111111111111";
/** How the founder's report opens: no doctype, no <html>. */
const PAGE =
  '<title>Claude Code Fleet Report</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n<style>body{margin:0}</style>';
const MODULE = "export default function Cell() { return null; }";

const mechanism = async (typeKey: string, workspaceId: string | null) => {
  const r = await h.client!.query<{ renderer_type: string }>(
    `select renderer_type from widget_definitions where type_key = $1 and workspace_id is not distinct from $2`,
    [typeKey, workspaceId]
  );
  expect(r.rows).toHaveLength(1);
  return r.rows[0]!.renderer_type;
};

const define = (
  typeKey: string,
  workspaceId: string | null,
  rendererSource: string,
  rendererType?: "builtin" | "iframe" | "frame" | "mcp-app"
) =>
  defineCell({
    name: typeKey,
    typeKey,
    workspaceId,
    rendererSource,
    ...(rendererType ? { rendererType } : {}),
    userId: "user-1",
  });

beforeAll(async () => {
  await h.client!.exec(ddlFor(widgetDefinitions as never));
  // The production unique index the space branch's ON CONFLICT targets.
  await h.client!.exec(
    `CREATE UNIQUE INDEX widget_def_type_key_workspace_uniq ON widget_definitions (type_key, workspace_id);`
  );
});

beforeEach(async () => {
  await h.client!.exec(`delete from widget_definitions`);
});

describe.each([
  ["a space cell (ON CONFLICT upsert)", WS],
  ["a pod-wide cell (manual update)", null],
] as const)("defineCell mechanism — %s", (_label, ws) => {
  it("INSERT with no mechanism: a page is `iframe`, a module is `frame`", async () => {
    await define("generated:page", ws, PAGE);
    await define("generated:module", ws, MODULE);
    expect(await mechanism("generated:page", ws)).toBe("iframe");
    expect(await mechanism("generated:module", ws)).toBe("frame");
  });

  it("UPDATE with no mechanism re-derives a frame/iframe row from the new source", async () => {
    // A row stored the old way: a page under `frame`.
    await define("generated:x", ws, PAGE, "frame");
    expect(await mechanism("generated:x", ws)).toBe("frame");
    await define("generated:x", ws, PAGE);
    expect(await mechanism("generated:x", ws)).toBe("iframe");
    // …and a module written onto an `iframe` row makes it `frame` again.
    await define("generated:x", ws, MODULE);
    expect(await mechanism("generated:x", ws)).toBe("frame");
  });

  it("a stored builtin / mcp-app row keeps its mechanism", async () => {
    await define("cell:x:builtin", ws, MODULE, "builtin");
    await define("cell:x:mcp", ws, PAGE, "mcp-app");
    await define("cell:x:builtin", ws, PAGE);
    await define("cell:x:mcp", ws, MODULE);
    expect(await mechanism("cell:x:builtin", ws)).toBe("builtin");
    expect(await mechanism("cell:x:mcp", ws)).toBe("mcp-app");
  });

  it("an explicit mechanism always wins, on insert and on update", async () => {
    await define("generated:explicit", ws, PAGE, "frame");
    expect(await mechanism("generated:explicit", ws)).toBe("frame");
    await define("generated:explicit", ws, MODULE, "iframe");
    expect(await mechanism("generated:explicit", ws)).toBe("iframe");
  });
});
