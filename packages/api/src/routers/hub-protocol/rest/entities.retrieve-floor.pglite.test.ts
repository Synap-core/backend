/**
 * POST /entities/retrieve — the type-inference CATALOG follows the caller's
 * lens; it is never pinned to "the first workspace". Driven through the REAL
 * route, the REAL `getCaller` → hub `profiles.listProfiles` → `profiles.list`
 * → `getAccessibleProfiles`, compiled and run as SQL on PGlite. Only the auth
 * middleware (a stub that sets what it would) and the SRE `retrieve()` (a spy
 * that records the catalog + lens it was handed — Typesense/pgvector are not
 * what is under test) are replaced.
 *
 * Defect this pins (same root cause as O1 on GET /users/:id/entities): without
 * `workspaceId` the route resolved the catalog from
 * `getUserAccessibleWorkspaceIds(userId)[0]` — the first row of an UNORDERED
 * read — "because listProfiles requires one" (it does not: a null workspace is
 * the caller's pod floor). So:
 *  - when that first workspace was archived, `podProcedure` refused the whole
 *    retrieve with 403 "This workspace has been archived.";
 *  - otherwise the inferred types depended on row order: a kind living in any
 *    OTHER workspace was unnameable (the defect `resolveKnowledgeLens` fixed on
 *    the /knowledge doors).
 * Without a workspace the catalog is now the pod-wide union (the same
 * `getAccessibleProfiles(userId, "")` the knowledge doors use). An explicit
 * workspaceId still pins (an archived one is still a 403 — a choice).
 *
 * The archived workspace is inserted FIRST so the unordered read hands it back
 * first on PGlite (heap order) — the live shape; the test asserts that
 * precondition so it cannot pass vacuously.
 *
 * Cannot see: production Postgres (no FKs/enums/defaults here), the real auth
 * middleware, the SRE ranking itself.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  retrieve: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});

vi.mock("../../../services/retrieval/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  retrieve: h.retrieve,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { registerEntitiesRoutes } from "./entities.js";
import type { HubHono, HubVariables } from "./_shared.js";

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
        : c.name === "is_active"
          ? " default true"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const A = randomUUID(); // the caller
const ARCHIVED = randomUUID(); // A's, archived — inserted first
const LIVE = randomUUID(); // A's — holds the `client` kind
const LIVE2 = randomUUID(); // A's — holds the `deal` kind

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

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
  // ARCHIVED first: the unordered membership read returns it first.
  for (const [ws, archived] of [
    [ARCHIVED, true],
    [LIVE, false],
    [LIVE2, false],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, settings, archived_at) values ($1,$2,$3,'{}'::jsonb,$4)`,
      [ws, `ws-${ws.slice(0, 4)}`, A, archived ? new Date() : null]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, A]
    );
  }
  for (const [slug, scope, ws] of [
    ["note", "system", null],
    ["client", "workspace", LIVE],
    ["deal", "workspace", LIVE2],
  ] as const) {
    await q(
      `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id)
       values ($1,$2,$3,'kind',$4,'workspace',true,'{}'::jsonb,$5)`,
      [randomUUID(), slug, slug, scope, ws]
    );
  }
}, 120_000);

beforeEach(() => {
  h.retrieve.mockReset();
  h.retrieve.mockResolvedValue({
    entities: [],
    understanding: {},
    source: "typesense",
    verdict: "empty",
  });
});

/** The route behind a stub of what the hub auth middleware sets. */
async function post(body: Record<string, unknown>): Promise<Response> {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", A);
    c.set("scopes", ["hub-protocol.read"]);
    c.set("apiKeyId", "key-a");
    await next();
  });
  registerEntitiesRoutes(a);
  return a.request(`/entities/retrieve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** What the route handed the SRE: the lens and the catalog's slugs. */
function handed(): { workspaceId: unknown; slugs: string[] } {
  expect(h.retrieve).toHaveBeenCalledTimes(1);
  const arg = h.retrieve.mock.calls[0]![0] as {
    workspaceId: unknown;
    catalog: Array<{ slug: string }>;
  };
  return {
    workspaceId: arg.workspaceId,
    slugs: arg.catalog.map((e) => e.slug).sort(),
  };
}

describe("POST /entities/retrieve — no workspaceId: the catalog is the caller's floor", () => {
  it("the archived workspace being first does not refuse the read", async () => {
    // Precondition: the unordered read DOES hand back the archived workspace
    // first — otherwise this row would prove nothing.
    const first = await q<{ id: string }>(
      `select id from workspaces where owner_id = $1`,
      [A]
    );
    expect(first.rows[0]!.id).toBe(ARCHIVED);

    const res = await post({ query: "who are my clients" });
    expect(res.status).toBe(200);
  });

  it("the catalog is the pod-wide union — kinds from EVERY live workspace, lens stays null", async () => {
    const res = await post({ query: "who are my clients" });
    expect(res.status).toBe(200);
    const { workspaceId, slugs } = handed();
    expect(workspaceId).toBeNull();
    expect(slugs).toEqual(expect.arrayContaining(["client", "deal", "note"]));
  });
});

describe("POST /entities/retrieve — an explicit workspaceId still pins", () => {
  it("a live workspace: that workspace's catalog, recall under that lens", async () => {
    const res = await post({ query: "clients", workspaceId: LIVE });
    expect(res.status).toBe(200);
    const { workspaceId, slugs } = handed();
    expect(workspaceId).toBe(LIVE);
    expect(slugs).toContain("client");
    expect(slugs).not.toContain("deal");
  });

  it("an explicit archived workspaceId is still refused (a choice, not an accident)", async () => {
    const res = await post({ query: "clients", workspaceId: ARCHIVED });
    expect(res.status).toBe(403);
    expect(h.retrieve).not.toHaveBeenCalled();
  });
});
