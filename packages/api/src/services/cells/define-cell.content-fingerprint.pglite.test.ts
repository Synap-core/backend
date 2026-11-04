/**
 * `defineCell` stamps `widget_definitions.content_sha256` with the fingerprint
 * of the content the row HOLDS, on REAL rows (decision Q9, approval per
 * fingerprint; migration 0396).
 *
 * Proven through the real upsert SQL on PGlite, in both scope branches (the ON
 * CONFLICT path of a space cell and the manual UPDATE of a pod-wide one):
 *   - a write stamps the fingerprint of the row as written, recomputed here
 *     from the stored columns;
 *   - a change of source re-stamps it;
 *   - the values SQL or omit-is-silence resolve from the stored row count: a
 *     builtin row keeps its mechanism, a re-push that names no egress keeps
 *     the stored grant, and both are in the fingerprint;
 *   - approved = stored: for an agent cell, the stamp its proposal is filed
 *     with is the fingerprint its approval writes to the row, also over a row
 *     that keeps a builtin mechanism and an egress grant;
 *   - a NEW cell is stamped: the table keeps the schema's real defaults, so
 *     the insert's timestamps are what Postgres would write.
 * And migration 0396 adds the column, idempotently, to a table without it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";

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
import { defineCell, stampCellDefinePayload } from "./define-cell.js";
import {
  CELL_CONTENT_FINGERPRINT_KEY,
  cellContentFingerprint,
  gatedRendererTypeOf,
  withCellContentFingerprint,
} from "./cell-content-fingerprint.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

const dialect = new PgDialect();

/**
 * The column's REAL default, as the schema declares it. A table built without
 * them hides what the write path depends on: with no `defaultNow()`, a new row's
 * `updated_at` was NULL here and the fingerprint stamp's equality guard matched
 * NULL, while on Postgres a microsecond `now()` never equalled the returned
 * millisecond `Date` and no new cell was ever stamped.
 */
function defaultOf(c: ReturnType<typeof getTableConfig>["columns"][number]) {
  if (!c.hasDefault || c.default === undefined) return "";
  const d = c.default;
  if (is(d, SQL)) return ` DEFAULT ${dialect.sqlToQuery(d).sql}`;
  if (typeof d === "string") return ` DEFAULT '${d.replace(/'/g, "''")}'`;
  if (typeof d === "number" || typeof d === "boolean") return ` DEFAULT ${d}`;
  return ` DEFAULT '${JSON.stringify(d).replace(/'/g, "''")}'`;
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary ? " primary key" : "";
    const defaults =
      type === "uuid" && c.primary
        ? " DEFAULT gen_random_uuid()"
        : defaultOf(c);
    const notNull = c.notNull && !c.primary ? " NOT NULL" : "";
    return `"${c.name}" ${type}${pk}${notNull}${defaults}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const WS = "11111111-1111-4111-8111-111111111111";
const MODULE = "export default function Cell() { return null; }";
const MODULE_V2 = "export default function Cell() { return 'v2'; }";

interface StoredRow {
  renderer_type: string;
  renderer_source: string;
  deps: Record<string, string> | null;
  external_hosts: string[] | null;
  content_sha256: string | null;
}

const stored = async (typeKey: string, workspaceId: string | null) => {
  const r = await h.client!.query<StoredRow>(
    `select renderer_type, renderer_source, deps, external_hosts, content_sha256
       from widget_definitions
      where type_key = $1 and workspace_id is not distinct from $2`,
    [typeKey, workspaceId]
  );
  expect(r.rows).toHaveLength(1);
  return r.rows[0]!;
};

/** The fingerprint of what the row holds, recomputed from its columns. */
const fingerprintOf = (row: StoredRow) =>
  cellContentFingerprint({
    rendererType: row.renderer_type,
    rendererSource: row.renderer_source,
    deps: row.deps,
    externalHosts: row.external_hosts,
  });

beforeAll(async () => {
  await h.client!.exec(ddlFor(widgetDefinitions as never));
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
] as const)("defineCell content fingerprint — %s", (_label, ws) => {
  it("a write stamps the fingerprint of the row as written", async () => {
    const result = await defineCell({
      name: "x",
      typeKey: "generated:x",
      workspaceId: ws,
      rendererSource: MODULE,
      userId: "user-1",
    });
    const row = await stored("generated:x", ws);
    expect(row.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.content_sha256).toBe(fingerprintOf(row));
    expect(result.contentSha256).toBe(row.content_sha256);
  });

  it("a change of source re-stamps it", async () => {
    const base = { name: "x", typeKey: "generated:x", workspaceId: ws };
    await defineCell({ ...base, rendererSource: MODULE, userId: "u" });
    const first = (await stored("generated:x", ws)).content_sha256;
    await defineCell({ ...base, rendererSource: MODULE_V2, userId: "u" });
    const row = await stored("generated:x", ws);
    expect(row.content_sha256).not.toBe(first);
    expect(row.content_sha256).toBe(fingerprintOf(row));
  });

  it("the mechanism and egress kept from the stored row are in the fingerprint", async () => {
    const base = { name: "x", typeKey: "cell:pkg:x", workspaceId: ws };
    await defineCell({
      ...base,
      rendererSource: MODULE,
      rendererType: "builtin",
      externalHosts: ["https://api.vendor.com"],
      userId: "u",
    });
    // A source-only re-push: names no mechanism and no egress.
    await defineCell({ ...base, rendererSource: MODULE_V2, userId: "u" });
    const row = await stored("cell:pkg:x", ws);
    expect(row.renderer_type).toBe("builtin");
    expect(row.external_hosts).toEqual(["https://api.vendor.com"]);
    expect(row.content_sha256).toBe(fingerprintOf(row));
    expect(row.content_sha256).not.toBe(
      cellContentFingerprint({
        rendererType: "frame",
        rendererSource: MODULE_V2,
      })
    );
  });

  it("approved = stored: an agent cell's proposal stamp is the fingerprint its approval writes", async () => {
    // What a door files (the gate stamps it) …
    const payload = withCellContentFingerprint({
      name: "My Cell",
      rendererSource: MODULE,
    });
    // … and what the cell/define executor hands defineCell from that payload.
    await defineCell({
      name: payload.name,
      rendererSource: payload.rendererSource,
      rendererType: gatedRendererTypeOf(
        (payload as Record<string, unknown>).rendererType
      ),
      workspaceId: ws,
      userId: "u",
    });
    const row = await stored("generated:my-cell", ws);
    expect(row.content_sha256).toBe(payload[CELL_CONTENT_FINGERPRINT_KEY]);
  });

  it("approved = stored over a row that keeps a builtin mechanism and an egress grant", async () => {
    // An operator's cell: a kept mechanism and an egress grant.
    await defineCell({
      name: "My Cell",
      workspaceId: ws,
      rendererSource: MODULE,
      rendererType: "builtin",
      externalHosts: ["https://api.vendor.com"],
      userId: "operator",
    });
    // An agent proposes a new source for it: the gate stamps it against the
    // row its approval writes …
    const payload = await stampCellDefinePayload(
      { name: "My Cell", rendererSource: MODULE_V2 },
      ws
    );
    // … and the executor writes it, naming no mechanism and no egress.
    await defineCell({
      name: payload.name,
      rendererSource: payload.rendererSource,
      rendererType: gatedRendererTypeOf(
        (payload as Record<string, unknown>).rendererType
      ),
      workspaceId: ws,
      userId: "u",
    });
    const row = await stored("generated:my-cell", ws);
    expect(row.renderer_type).toBe("builtin");
    expect(row.external_hosts).toEqual(["https://api.vendor.com"]);
    expect(row.content_sha256).toBe(fingerprintOf(row));
    expect(row.content_sha256).toBe(payload[CELL_CONTENT_FINGERPRINT_KEY]);
  });
});

describe("migration 0396", () => {
  it("adds content_sha256 to a table without it, and runs twice", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const pg = new PGlite();
    await pg.exec(
      `create table "widget_definitions" (id uuid primary key, renderer_source text);`
    );
    const sql = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../database/migrations/0396_widget_definitions_content_sha256.sql"
      ),
      "utf8"
    );
    await pg.exec(sql);
    await pg.exec(sql);
    const cols = await pg.query<{ data_type: string; is_nullable: string }>(
      `select data_type, is_nullable from information_schema.columns
        where table_name = 'widget_definitions' and column_name = 'content_sha256'`
    );
    expect(cols.rows).toEqual([{ data_type: "text", is_nullable: "YES" }]);
  });
});
