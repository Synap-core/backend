/**
 * `intelligence.relayToService` is pod-admin only and reaches ONE service
 * named exactly; no read of an `intelligence_services` row returns a secret
 * (audit 2026-10-28, pod-routers F5).
 *
 * WHY: relayToService authenticates to the service with its stored
 * `metadata.managementToken`. Any space member could drive it, and a
 * `LIKE '<id>-%'` prefix reached other rows. Separately,
 * `intelligenceRegistry.get` filtered a key named `_apiKey` (the column is
 * `apiKey`), so it returned the key cell; `list` and
 * `intelligence.listRegisteredServices` returned the management token.
 *
 * The secret check is derived, not a list of fields: every string value of
 * every read result is scanned for the secret VALUES seeded into the row, so a
 * new field that leaks one fails here whatever its name.
 *
 * Driven through the REAL procedures → the REAL `isPodAdmin` → SQL on PGlite.
 * Stubbed: the db handle, the split-brain probe, `fetch`.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
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
  intelligenceServices,
  syncGeneration,
} from "@synap/database/schema";
import { intelligenceRegistryRouter } from "./intelligence-registry.js";
import { intelligenceRouter } from "./intelligence.js";

const WS = randomUUID();
const POD_ADMIN_WS = randomUUID();
const SPACE_OWNER = "space-owner-1";
const ADMIN = "pod-admin-1";
const ROW = "svc-row-1";

/** The secret VALUES seeded into the row; none may come back from a read. */
const API_KEY_CELL = "legacy-plaintext-service-key-0001";
const MGMT_TOKEN = "mgmt-token-secret-0002";
const PENDING_BOT_TOKEN = "pending-bot-token-0003";
const SECRETS = [API_KEY_CELL, MGMT_TOKEN, PENDING_BOT_TOKEN];

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

const ctxFor = (userId: string) =>
  ({ db: h.db, authenticated: true, userId, workspaceId: WS }) as never;
const registry = (userId: string) =>
  intelligenceRegistryRouter.createCaller(ctxFor(userId));
const intelligence = (userId: string) =>
  intelligenceRouter.createCaller(ctxFor(userId));

/** Every string anywhere in `value`. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      strings(v, out);
    }
  return out;
}
function leaked(result: unknown): string[] {
  const all = strings(result);
  return SECRETS.filter((s) => all.some((v) => v.includes(s)));
}

const fetchSpy = vi.fn(
  async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ ok: true }), { status: 200 })
);

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
    [WS, SPACE_OWNER]
  );
  await h.client!.query(
    `insert into workspaces (id, name, owner_id, settings, system_slug, created_at, updated_at)
     values ($1, 'Pod admin', $2, '{}'::jsonb, 'pod-admin', now(), now())`,
    [POD_ADMIN_WS, ADMIN]
  );
  for (const [ws, user, role] of [
    [WS, SPACE_OWNER, "owner"],
    [WS, ADMIN, "admin"],
    [POD_ADMIN_WS, ADMIN, "owner"],
  ])
    await h.client!.query(
      `insert into workspace_members (id, workspace_id, user_id, role)
       values ($1, $2, $3, $4)`,
      [randomUUID(), ws, user, role]
    );
});

beforeEach(async () => {
  await h.client!.exec(`delete from intelligence_services;`);
  await h.client!.query(
    `insert into intelligence_services
       (id, service_id, name, webhook_url, api_key, capabilities, status, enabled,
        metadata, created_at, updated_at)
     values ($1, 'openclaw-user-a', 'Claw', 'https://claw.example', $2,
        '["chat"]'::jsonb, 'active', true, $3::jsonb, now(), now())`,
    [
      ROW,
      API_KEY_CELL,
      JSON.stringify({
        kind: "remote",
        managementToken: MGMT_TOKEN,
        pendingConfig: { configure_channel_1: { botToken: PENDING_BOT_TOKEN } },
      }),
    ]
  );
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("intelligence.relayToService — pod admin, one service named exactly", () => {
  it("a space owner who is not a pod admin is refused before any call", async () => {
    await expect(
      intelligence(SPACE_OWNER).relayToService({
        serviceId: "openclaw-user-a",
        command: "list_channels",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a prefix no longer reaches another row", async () => {
    await expect(
      intelligence(ADMIN).relayToService({
        serviceId: "openclaw",
        command: "list_channels",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      intelligence(ADMIN).relayToService({
        serviceId: "%",
        command: "list_channels",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a pod admin relays to the service named exactly", async () => {
    const res = await intelligence(ADMIN).relayToService({
      serviceId: "openclaw-user-a",
      command: "list_channels",
    });
    expect(res).toMatchObject({ success: true, pending: false });
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      "https://claw.example/api/management"
    );
  });
});

describe("service reads return no secret", () => {
  it("intelligenceRegistry.get", async () => {
    const row = await registry(SPACE_OWNER).get({ id: ROW });
    expect(row.serviceId).toBe("openclaw-user-a");
    expect(row.metadata).toMatchObject({ kind: "remote" });
    expect(leaked(row)).toEqual([]);
  });

  it("intelligenceRegistry.list", async () => {
    const rows = await registry(SPACE_OWNER).list();
    expect(rows).toHaveLength(1);
    expect(leaked(rows)).toEqual([]);
  });

  it("intelligence.listRegisteredServices", async () => {
    const res = await intelligence(SPACE_OWNER).listRegisteredServices();
    expect(res.services).toHaveLength(1);
    expect(leaked(res)).toEqual([]);
  });

  it("the scan itself sees a leak (positive control on the raw row)", async () => {
    const { rows } = await h.client!.query(
      `select * from intelligence_services`
    );
    expect(leaked(rows).sort()).toEqual([...SECRETS].sort());
  });
});
