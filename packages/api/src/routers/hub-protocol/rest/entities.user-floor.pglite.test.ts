/**
 * GET /users/:userId/entities — the user-floor list door (the Intelligence
 * Service's `getEntities`, its CLI and monitor) — driven through the REAL route,
 * the REAL `getCaller` → hub `entities.getEntities` → `entities.list`, and the
 * REAL access floor, compiled and run as SQL on PGlite. Only the auth middleware
 * is replaced by a stub that sets what it would (`userId`, `scopes`).
 *
 * Defects this pins (live probe 2026-10-19, report 06 §2):
 *
 *  - O1: without `workspaceId` the route pinned the caller to the FIRST
 *    readable workspace (`effectiveWsIds[0]` of an UNORDERED read). When that
 *    one was archived, `podProcedure` refused the whole read with 403 "This
 *    workspace has been archived." — the answer depended on row order. It now
 *    reads the user floor, the same way `GET /entities` does.
 *  - O1b: `GET /users/me/entities` answered 200 `[]`: "me" was never resolved,
 *    `getUserAccessibleWorkspaceIds("me")` found nothing, and a FAILED lookup
 *    read as an empty list. "me" is now the caller; any other id is a 403 (the
 *    read never runs with it).
 *
 * The archived workspace is inserted FIRST so the unordered read hands it back
 * first on PGlite (heap order) — the live shape. With the pin restored, the
 * O1 rows are red.
 *
 * Cannot see: production Postgres (no FKs/enums/defaults here), the real auth
 * middleware's identity remaps (covered in `_middleware/`), Typesense.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

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
  return { ...actual, db, getDb: async () => db };
});

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
const B = randomUUID(); // another person on the pod
const ARCHIVED = randomUUID(); // A's, archived — inserted first
const LIVE = randomUUID(); // A's
const B_WS = randomUUID(); // B's
const NOTE = randomUUID(); // profile
const IN_LIVE = randomUUID(); // A's note in LIVE
const POD_WIDE = randomUUID(); // A's pod-wide note (workspace NULL)
const B_NOTE = randomUUID(); // B's note in B_WS

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  for (const u of [A, B]) {
    await q(`insert into users (id, email) values ($1, $2)`, [
      u,
      `${u}@example.test`,
    ]);
  }
  // ARCHIVED first: the unordered membership read returns it first.
  for (const [ws, owner, archived] of [
    [ARCHIVED, A, true],
    [LIVE, A, false],
    [B_WS, B, false],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, settings, archived_at) values ($1,$2,$3,'{}'::jsonb,$4)`,
      [ws, `ws-${ws.slice(0, 4)}`, owner, archived ? new Date() : null]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, owner]
    );
  }
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id)
     values ($1,'note','Note','kind','system','workspace',true,'{}'::jsonb,null)`,
    [NOTE]
  );
  for (const [id, owner, ws] of [
    [IN_LIVE, A, LIVE],
    [POD_WIDE, A, null],
    [B_NOTE, B, B_WS],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
       values ($1,$2,$3,$4,'note','n','{}'::jsonb,'{}'::jsonb)`,
      [id, owner, ws, NOTE]
    );
  }
}, 120_000);

/** The route behind a stub of what the hub auth middleware sets. */
function app(): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", A);
    c.set("scopes", ["hub-protocol.read"]);
    c.set("apiKeyId", "key-a");
    await next();
  });
  registerEntitiesRoutes(a);
  return a;
}

async function ids(res: Response): Promise<string[]> {
  const body = (await res.json()) as Array<{ id: string }>;
  return body.map((r) => r.id).sort();
}

describe("GET /users/:userId/entities — no workspaceId reads the user floor (O1)", () => {
  it("the archived workspace being first does not refuse the read", async () => {
    // Precondition: the unordered membership read DOES hand back the archived
    // workspace first — otherwise this row would prove nothing.
    const first = await q<{ id: string }>(
      `select id from workspaces where owner_id = $1`,
      [A]
    );
    expect(first.rows[0]!.id).toBe(ARCHIVED);

    const res = await app().request(`/users/${A}/entities`);
    expect(res.status).toBe(200);
    expect(await ids(res)).toEqual([IN_LIVE, POD_WIDE].sort());
  });

  it("with profileSlug (the IS call shape) — same floor, pod-wide included", async () => {
    const res = await app().request(
      `/users/${A}/entities?profileSlug=note&limit=50`
    );
    expect(res.status).toBe(200);
    expect(await ids(res)).toEqual([IN_LIVE, POD_WIDE].sort());
  });

  it("an explicit workspaceId still pins that workspace (+ pod-wide)", async () => {
    const res = await app().request(`/users/${A}/entities?workspaceId=${LIVE}`);
    expect(res.status).toBe(200);
    expect(await ids(res)).toEqual([IN_LIVE, POD_WIDE].sort());
  });

  it("an explicit archived workspaceId is still refused (a choice, not an accident)", async () => {
    const res = await app().request(
      `/users/${A}/entities?workspaceId=${ARCHIVED}`
    );
    expect(res.status).toBe(403);
  });
});
