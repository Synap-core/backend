/**
 * PAGES of a saved view — `views.execute` with an ephemeral `limit` / `offset`
 * (plan cb8470f2, the renderer frames' `views.execute` bridge op), on PGlite
 * through the REAL procedure and the real access floor. Only governance, the
 * audit log, side effects and the split-brain guard are stubbed (same harness
 * as views.members-of.pglite.test.ts).
 *
 * A frame read only the stored query's first page (100 rows): it could never
 * draw a view past it. A page asked for replaces the stored pair for that run
 * only, and `hasMore` says whether a next page exists.
 *
 * What this CANNOT see: production Postgres, Typesense.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
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
  const db = drizzle(client, { schema });
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: {
      append: async () => undefined,
      emitCompleted: async () => undefined,
    },
  };
});
vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async () => ({ allowed: true })),
  previewPermissionDecision: vi.fn(async () => ({ decision: "allow" })),
  proposedMessageFor: vi.fn(() => "proposed"),
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => {} }));
vi.mock("../lib/event-helpers.js", () => ({
  ViewEvents: new Proxy(
    {},
    { get: (_t, k) => (k === "then" ? undefined : async () => undefined) }
  ),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { viewsRouter } from "./views.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const A = randomUUID();
const WA = randomUUID();
const KIND = randomUUID();
/** Five rows, newest first (the default order is `created_at desc`). */
const ROWS = Array.from({ length: 5 }, () => randomUUID());

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);
const caller = () =>
  viewsRouter.createCaller({
    authenticated: true,
    userId: A,
    workspaceId: null,
  } as never);

type Page = { entities: Array<{ id: string }>; hasMore?: boolean };
async function page(
  viewId: string,
  input: { limit?: number; offset?: number } = {}
): Promise<{ ids: string[]; hasMore: boolean | undefined }> {
  const res = (await caller().execute({ id: viewId, ...input })) as Page;
  return { ids: res.entities.map((e) => e.id), hasMore: res.hasMore };
}

async function insertList(query: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into views (id, workspace_id, user_id, name, type, scope_profile_ids, query, config, metadata)
     values ($1, $2, $3, 'Things', 'list', $4::uuid[], $5::jsonb, '{}'::jsonb, '{}'::jsonb)`,
    [id, WA, A, `{${KIND}}`, JSON.stringify(query)]
  );
  return id;
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(`insert into users (id, email) values ($1, $2)`, [
    A,
    `${A}@example.test`,
  ]);
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
    [randomUUID(), A]
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'w',$2,'{}'::jsonb)`,
    [WA, A]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WA, A]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope) values ($1,'thing','Thing','kind','system')`,
    [KIND]
  );
  // Distinct creation times, so the order (and so each page) is fixed.
  for (const [i, id] of ROWS.entries()) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, title, properties, created_at)
       values ($1,$2,$3,$4,'e','{}'::jsonb, now() - ($5 || ' minutes')::interval)`,
      [id, A, WA, KIND, String(i)]
    );
  }
}, 120_000);

describe("views.execute — one page of a saved view", () => {
  it("with no page asked for, the stored pair applies, and says a next page exists", async () => {
    const view = await insertList({ limit: 3 });
    expect(await page(view)).toEqual({
      ids: ROWS.slice(0, 3),
      hasMore: true,
    });
  });

  it("a page asked for replaces the stored pair: pages are disjoint and cover every row", async () => {
    const view = await insertList({ limit: 3 });
    const first = await page(view, { limit: 2, offset: 0 });
    const second = await page(view, { limit: 2, offset: 2 });
    const last = await page(view, { limit: 2, offset: 4 });
    expect(first).toEqual({ ids: ROWS.slice(0, 2), hasMore: true });
    expect(second).toEqual({ ids: ROWS.slice(2, 4), hasMore: true });
    expect(last).toEqual({ ids: ROWS.slice(4), hasMore: false });
    // The page is ephemeral: the stored pair still applies to the next run.
    expect((await page(view)).ids).toEqual(ROWS.slice(0, 3));
  });

  it("an exact last page says no next page", async () => {
    const view = await insertList({});
    expect(await page(view, { limit: 5 })).toEqual({
      ids: ROWS,
      hasMore: false,
    });
  });

  it("a stored pair written as text is still read as numbers", async () => {
    const view = await insertList({ limit: "2", offset: "1" });
    expect(await page(view)).toEqual({ ids: ROWS.slice(1, 3), hasMore: true });
  });

  it("refuses a page over the cap or below one row", async () => {
    const view = await insertList({});
    await expect(page(view, { limit: 501 })).rejects.toThrow();
    await expect(page(view, { limit: 0 })).rejects.toThrow();
    await expect(page(view, { offset: -1 })).rejects.toThrow();
  });
});
