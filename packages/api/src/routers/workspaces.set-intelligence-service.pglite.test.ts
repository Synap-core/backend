/**
 * `workspaces.setIntelligenceService` — pinning a space to a service, and
 * clearing the pin, both actually land.
 *
 * Clearing did not: `serviceId: null` became `mergeSettings({
 * intelligenceServiceId: undefined })`, JSON dropped the `undefined`, and the
 * `settings || patch` merge left the stored pin in place — while the procedure
 * answered "updated". Every "Reset to the pod default" button therefore did
 * nothing (Settings › House AI, Space › Intelligence).
 *
 * Driven through the REAL procedure → REAL `WorkspaceRepository` → REAL SQL on
 * PGlite. Stubbed: the permission gate (granted — governance has its own
 * tests), the event append, the audit log and the side-effect bus.
 *
 * What this CANNOT see: production Postgres constraints (PGlite tables are
 * generated from the Drizzle definitions without FKs/NOT NULL/enums), and the
 * resolver reading the result (`resolveIntelligenceService` has its own tests;
 * an absent key is its "no workspace preference" branch).
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
vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/permission-check.js")>()),
  checkPermissionOrPropose: async () => ({ granted: true }),
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: () => undefined }));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/events")>()),
  emitSideEffects: () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  workspaces,
  workspaceMembers,
  intelligenceServices,
  syncGeneration,
} from "@synap/database/schema";
import { workspacesRouter } from "./workspaces.js";

const OWNER = "owner-1";
const WS = randomUUID();

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

const settingsOf = async () =>
  (
    await h.client!.query<{ settings: Record<string, unknown> }>(
      `select settings from workspaces where id = $1`,
      [WS]
    )
  ).rows[0]?.settings;

const caller = () =>
  workspacesRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId: OWNER,
    workspaceId: WS,
    workspaceRole: "owner",
  } as never);

beforeAll(async () => {
  for (const t of [
    workspaces,
    workspaceMembers,
    intelligenceServices,
    syncGeneration,
  ])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  await h.client!.query(
    `insert into workspaces (id, name, owner_id, settings, created_at, updated_at)
     values ($1, 'Builder', $2, '{"agentPersonality":"terse"}'::jsonb, now(), now())`,
    [WS, OWNER]
  );
  await h.client!.query(
    `insert into workspace_members (id, workspace_id, user_id, role)
     values ($1, $2, $3, 'owner')`,
    [randomUUID(), WS, OWNER]
  );
  await h.client!.query(
    `insert into intelligence_services (id, service_id, name, status, enabled)
     values ($1, 'svc-house', 'House IS', 'active', true)`,
    [randomUUID()]
  );
});

describe("workspaces.setIntelligenceService — the pin lands and clears", () => {
  it("a service id pins the space, keeping the other settings", async () => {
    const res = await caller().setIntelligenceService({
      workspaceId: WS,
      serviceId: "svc-house",
    });
    expect(res.status).toBe("updated");
    expect(await settingsOf()).toEqual({
      agentPersonality: "terse",
      intelligenceServiceId: "svc-house",
    });
  });

  it("null REMOVES the pin (follow the pod default), keeping the rest", async () => {
    const res = await caller().setIntelligenceService({
      workspaceId: WS,
      serviceId: null,
    });
    expect(res.status).toBe("updated");
    const settings = await settingsOf();
    expect(settings).not.toHaveProperty("intelligenceServiceId");
    expect(settings).toEqual({ agentPersonality: "terse" });
  });
});
