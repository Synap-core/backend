/**
 * `system.listUsers`, `system.getDataPodStats` and `system.getServiceHealth`
 * are pod-admin only (audit 2026-10-28, pod-routers F8).
 *
 * WHY: `listUsers` returns every person's email and every agent's governance
 * metadata, yet it was a `protectedProcedure`: any signed-in principal, a
 * guest who redeemed a share link included (guest containment blocks only
 * mutations), could page through the pod's people. The pod stats and the
 * service health (raw infrastructure errors) are the same admin overview.
 *
 * Driven through the REAL procedures → the REAL `isPodAdmin` → SQL on PGlite.
 * The refused calls stop in the middleware, before any query or network
 * probe; `getServiceHealth` is never run for the admin here (it probes
 * Postgres, Typesense, MinIO and Kratos).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

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
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    eventRepository: { append: async () => undefined },
  };
});

vi.mock("../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: async () => false,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  workspaces,
  workspaceMembers,
  users,
  apps,
  entities,
  documents,
} from "@synap/database/schema";
import { systemRouter } from "./system.js";

const MEMBER = "member-1";
const ADMIN = "pod-admin-1";
const WS = randomUUID();
const POD_ADMIN_WS = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const caller = (userId: string) =>
  systemRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId,
    workspaceId: null,
  } as never);

beforeAll(async () => {
  for (const t of [
    workspaces,
    workspaceMembers,
    users,
    apps,
    entities,
    documents,
  ])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  for (const id of [MEMBER, ADMIN])
    await h.client!.query(
      `insert into users (id, email, name, user_type, created_at)
       values ($1, $2, $1, 'human', now())`,
      [id, `${id}@pod.example`]
    );
  await h.client!.query(
    `insert into workspaces (id, name, owner_id, settings, created_at, updated_at)
     values ($1, 'Builder', $2, '{}'::jsonb, now(), now())`,
    [WS, MEMBER]
  );
  await h.client!.query(
    `insert into workspaces (id, name, owner_id, settings, system_slug, created_at, updated_at)
     values ($1, 'Pod admin', $2, '{}'::jsonb, 'pod-admin', now(), now())`,
    [POD_ADMIN_WS, ADMIN]
  );
  for (const [ws, user] of [
    [WS, MEMBER],
    [POD_ADMIN_WS, ADMIN],
  ])
    await h.client!.query(
      `insert into workspace_members (id, workspace_id, user_id, role)
       values ($1, $2, $3, 'owner')`,
      [randomUUID(), ws, user]
    );
});

describe("system admin reads — a member (owner of her own space) is refused", () => {
  it("listUsers", async () => {
    await expect(caller(MEMBER).listUsers({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("getDataPodStats", async () => {
    await expect(caller(MEMBER).getDataPodStats()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("getServiceHealth", async () => {
    await expect(caller(MEMBER).getServiceHealth()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("system admin reads — a pod admin still reads them", () => {
  it("listUsers returns the pod's people", async () => {
    const res = await caller(ADMIN).listUsers({});
    expect(res.users.map((u) => u.email).sort()).toEqual([
      `${ADMIN}@pod.example`,
      `${MEMBER}@pod.example`,
    ]);
  });

  it("getDataPodStats counts them", async () => {
    expect((await caller(ADMIN).getDataPodStats()).userCount).toBe(2);
  });
});
