/**
 * `intelligenceRegistry.list` names the POD DEFAULT (`isDefault`), and
 * `intelligenceRegistry.connectToWorkspace` is owner/admin only.
 *
 * `isDefault` must be the row the RESOLVER routes an unpinned space to — not a
 * re-read of the `is_default` column. The two differ exactly where these
 * fixtures sit: an `is_default` row whose key is a sync placeholder is NOT the
 * default (the resolver skips it to failover), and with no `is_default` row the
 * failover row IS the default. A flag-read would get both wrong.
 *
 * Driven through the REAL procedures → the REAL `selectPodDefaultService`
 * (`@synap/intelligence-client`, the selector `resolveIntelligenceService`
 * itself calls) → SQL on PGlite. Stubbed: nothing but the db handle.
 *
 * What this CANNOT see: production constraints (PGlite tables are generated
 * from the Drizzle definitions without FKs/NOT NULL/enums/indexes — the
 * one-default partial unique index is not here), and the env fallback's
 * endpoint (step 5 is no registered row, so it only shows as "none is default").
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
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

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  workspaces,
  workspaceMembers,
  intelligenceServices,
  syncGeneration,
} from "@synap/database/schema";
import { intelligenceRegistryRouter } from "./intelligence-registry.js";

const WS = randomUUID();
const OWNER = "owner-1";
const MEMBER = "member-1";

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
  intelligenceRegistryRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId,
    workspaceId: WS,
  } as never);

async function addService(
  serviceId: string,
  opts: {
    isDefault?: boolean;
    apiKey?: string;
    status?: string;
    updatedAt?: string;
  } = {}
) {
  await h.client!.query(
    `insert into intelligence_services
       (id, service_id, name, webhook_url, api_key, capabilities, status, enabled,
        is_default, created_at, updated_at)
     values ($1, $2, $2, 'https://is.example', $3, '["chat"]'::jsonb, $4, true,
        $5, now(), $6::timestamp)`,
    [
      randomUUID(),
      serviceId,
      opts.apiKey ?? "real-key",
      opts.status ?? "active",
      opts.isDefault ?? false,
      opts.updatedAt ?? "2026-09-01T00:00:00Z",
    ]
  );
}

const defaults = async () =>
  (await caller(OWNER).list())
    .filter((s) => s.isDefault)
    .map((s) => s.serviceId);

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
     values ($1, 'Builder', $2, '{}'::jsonb, now(), now())`,
    [WS, OWNER]
  );
  for (const [user, role] of [
    [OWNER, "owner"],
    [MEMBER, "editor"],
  ])
    await h.client!.query(
      `insert into workspace_members (id, workspace_id, user_id, role)
       values ($1, $2, $3, $4)`,
      [randomUUID(), WS, user, role]
    );
});

beforeEach(async () => {
  await h.client!.exec(`delete from intelligence_services;`);
});

describe("intelligenceRegistry.list — isDefault is the resolver's pod default", () => {
  it("the is_default row with a real key is the one default", async () => {
    await addService("svc-a", { updatedAt: "2026-09-20T00:00:00Z" });
    await addService("svc-house", { isDefault: true });
    const rows = await caller(OWNER).list();
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(typeof r.isDefault).toBe("boolean");
    expect(await defaults()).toEqual(["svc-house"]);
  });

  it("a placeholder-key is_default is NOT the default — the failover row is", async () => {
    await addService("svc-synced", {
      isDefault: true,
      apiKey: "SYNC_PLACEHOLDER",
    });
    await addService("svc-old", { updatedAt: "2026-09-01T00:00:00Z" });
    await addService("svc-new", { updatedAt: "2026-09-20T00:00:00Z" });
    expect(await defaults()).toEqual(["svc-new"]);
  });

  it("no active service ⇒ the env service routes, and no row claims default", async () => {
    await addService("svc-off", { isDefault: true, status: "inactive" });
    const rows = await caller(OWNER).list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isDefault).toBe(false);
  });
});

describe("intelligenceRegistry.connectToWorkspace — owner/admin only", () => {
  beforeEach(async () => {
    await addService("svc-house", { isDefault: true });
    await h.client!.query(
      `update workspaces set settings = '{}'::jsonb where id = $1`,
      [WS]
    );
  });

  it("a non-admin member is refused and the space stays unpinned", async () => {
    await expect(
      caller(MEMBER).connectToWorkspace({ serviceId: "svc-house" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { rows } = await h.client!.query<{
      settings: Record<string, unknown>;
    }>(`select settings from workspaces where id = $1`, [WS]);
    expect(rows[0]!.settings).not.toHaveProperty("intelligenceServiceId");
  });

  it("the owner pins the space", async () => {
    const res = await caller(OWNER).connectToWorkspace({
      serviceId: "svc-house",
    });
    expect(res).toMatchObject({ success: true, serviceId: "svc-house" });
    const { rows } = await h.client!.query<{
      settings: Record<string, unknown>;
    }>(`select settings from workspaces where id = $1`, [WS]);
    expect(rows[0]!.settings).toMatchObject({
      intelligenceServiceId: "svc-house",
    });
  });
});
