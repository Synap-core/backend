/**
 * DELETE /projects/:id — the visibility floor and the gate's scope.
 *
 * The REST door used to call the gate with NO workspace (so membership RBAC
 * never ran: the gate reads a workspace-less write as the caller's own
 * pod-scoped resource) and `ProjectRepository.delete` filters on the id alone,
 * so any key holding `hub-protocol.write` hard-deleted ANY user's project.
 *
 * Through the REAL route, the REAL gate and the REAL repository on PGlite with
 * every @synap/database table. Rows rule out:
 *  - a floor that refuses everyone (the owner's own delete must land);
 *  - a floor that only checks pod-personal projects (the workspace project row);
 *  - a gate that still gets no workspace (a workspace VIEWER — visible, so past
 *    the floor — must not delete: the RBAC step is the only thing that stops it).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  audit: [] as unknown[],
  sideEffects: [] as unknown[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  // The spine-event append is not what is under test; every method is a no-op.
  class EventRepository {
    constructor() {
      return new Proxy(this, { get: () => async () => undefined });
    }
  }
  return { ...actual, db: h.db, getDb: async () => h.db, EventRepository };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: (e: unknown) => {
    h.sideEffects.push(e);
    return Promise.resolve();
  },
}));
vi.mock("../../../utils/audit-log.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditLog: (e: unknown) => h.audit.push(e),
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as schema from "@synap/database/schema";
import { registerProjectsRoutes } from "./projects.js";
import type { HubHono, HubVariables } from "./_shared.js";

const OWNER = "owner-pd";
const VIEWER = "viewer-pd";
const MALLORY = "mallory-pd";
const WS = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    return `"${c.name}" ${type}${key}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

async function seedProject(owner: string, workspaceId: string | null) {
  const id = randomUUID();
  await q(
    `insert into projects (id, user_id, workspace_id, name, status) values ($1, $2, $3, $4, 'active')`,
    [id, owner, workspaceId, `p-${id.slice(0, 6)}`]
  );
  return id;
}
async function exists(id: string): Promise<boolean> {
  const { rows } = await q(
    `select count(*)::int n from projects where id = $1`,
    [id]
  );
  return (rows[0] as { n: number }).n === 1;
}

function del(userId: string, id: string) {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", userId);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    await next();
  });
  registerProjectsRoutes(app);
  return app.request(`/projects/${id}`, { method: "DELETE" });
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  for (const u of [OWNER, VIEWER, MALLORY])
    await q(
      `insert into users (id, email, user_type) values ($1, $2, 'human')`,
      [u, `${u}@x`]
    );
  await q(
    `insert into workspaces (id, owner_id, name, settings) values ($1, $2, 'W', '{}'::jsonb)`,
    [WS, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner'), ($4, $2, $5, 'viewer')`,
    [randomUUID(), WS, OWNER, randomUUID(), VIEWER]
  );
});

beforeEach(() => {
  h.audit.length = 0;
  h.sideEffects.length = 0;
});

describe("DELETE /projects/:id — floor + gate scope", () => {
  it("another user cannot delete a pod-personal project (404, row kept)", async () => {
    const p = await seedProject(OWNER, null);
    const res = await del(MALLORY, p);
    expect(res.status).toBe(404);
    expect(await exists(p)).toBe(true);
  });

  it("a non-member cannot delete a workspace project (404, row kept)", async () => {
    const p = await seedProject(OWNER, WS);
    const res = await del(MALLORY, p);
    expect(res.status).toBe(404);
    expect(await exists(p)).toBe(true);
  });

  it("a workspace VIEWER sees it but cannot delete it — the gate gets the project's workspace", async () => {
    const p = await seedProject(OWNER, WS);
    const res = await del(VIEWER, p);
    // A member below `delete` proposes to a reviewer (202) — never deletes.
    expect([202, 403]).toContain(res.status);
    expect(await exists(p)).toBe(true);
  });

  it("CONTROL — the owner deletes their own project, audited + side effects", async () => {
    const personal = await seedProject(OWNER, null);
    const res = await del(OWNER, personal);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "deleted" });
    expect(await exists(personal)).toBe(false);
    // The REST door used to skip both (drift from tRPC `projects.delete`).
    const mine = {
      subjectType: "project",
      action: "delete",
      subjectId: personal,
    };
    expect(h.audit).toContainEqual(expect.objectContaining(mine));
    expect(h.sideEffects).toContainEqual(expect.objectContaining(mine));
  });

  it("CONTROL — the workspace owner deletes a workspace project", async () => {
    const p = await seedProject(OWNER, WS);
    const res = await del(OWNER, p);
    expect(res.status).toBe(200);
    expect(await exists(p)).toBe(false);
  });
});
