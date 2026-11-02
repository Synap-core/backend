/**
 * The reconnect nudge's 6h cooldown is ONE claim in the database, so N runs
 * that hit the same dead credential at once emit ONE nudge.
 *
 * What broke (founder's pod, 2026-10-18 → 11-01): 292 identical "Google needs
 * re-authorization" notifications, 8 in the same second, 4 bursts a day. Every
 * failing connection-sync kind run (contact / email.thread / event × each
 * Google connection) checked the cooldown against the SAME metadata snapshot
 * its caller read before the run, so all of them passed before any wrote the
 * watermark. Driven here on PGlite through the real `tools` /
 * `intelligence_services` rows; the notification, event and Discord doors are
 * counted, not exercised (their own tests pin them).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  createNotification: vi.fn(async (_input: Record<string, unknown>) => "n-1"),
  appendEvent: vi.fn(async (_event: Record<string, unknown>) => {}),
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
    eventRepository: { append: h.appendEvent },
  };
});
vi.mock("../../notifications/NotificationService.js", () => ({
  NotificationService: { create: h.createNotification },
}));
vi.mock("../channels/channel-origin.js", () => ({
  recordChannelOrigin: vi.fn(async () => {}),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { tools, intelligenceServices } from "@synap/database/schema";
import { notifyConnectorUnhealthy } from "./notify-connector-unhealthy.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t)
      ? t.replace(/\(.*\)/, "")
      : t.endsWith("[]")
        ? t
        : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const HOUR = 60 * 60 * 1000;
const PARALLEL_RUNS = 8; // one observed burst: 8 rows in the same second

let toolId: string;
let serviceRowId: string;

const opts = () => ({
  connectorKey: "google",
  connectorName: "Google Workspace",
  reconnectHint: "Reconnect it in the app (Settings → Connections).",
  userId: randomUUID(),
  workspaceId: null,
  watermarkToolId: toolId,
});

async function watermarkOf(
  table: "tools" | "intelligence_services",
  id: string
): Promise<Record<string, unknown>> {
  const { rows } = await q<{ metadata: Record<string, unknown> }>(
    `select metadata from ${table} where id = $1`,
    [id]
  );
  return rows[0]!.metadata;
}

beforeAll(async () => {
  await h.client!.exec(ddlFor(tools));
  await h.client!.exec(ddlFor(intelligenceServices));
});

beforeEach(async () => {
  vi.clearAllMocks();
  toolId = randomUUID();
  serviceRowId = randomUUID();
  // Another connector's watermark and unrelated config already on the row:
  // the claim must keep both.
  await q(`insert into tools (id, name, metadata) values ($1, 'google', $2)`, [
    toolId,
    JSON.stringify({
      sync: { enabled: true },
      connectionHealth: { cal_com: { lastNotifiedMs: 123 } },
    }),
  ]);
  await q(
    `insert into intelligence_services (id, service_id, name, metadata) values ($1, 'synap-is', 'Synap IS', null)`,
    [serviceRowId]
  );
});

describe("notifyConnectorUnhealthy — the cooldown is one claim in the database", () => {
  it(`${PARALLEL_RUNS} parallel runs on a dead connection emit ONE nudge`, async () => {
    const base = opts();
    const results = await Promise.all(
      Array.from({ length: PARALLEL_RUNS }, () =>
        notifyConnectorUnhealthy(base)
      )
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(h.createNotification).toHaveBeenCalledTimes(1);
    expect(h.appendEvent).toHaveBeenCalledTimes(1);

    const meta = await watermarkOf("tools", toolId);
    const health = meta.connectionHealth as Record<
      string,
      { lastNotifiedMs: number }
    >;
    expect(Date.now() - health.google!.lastNotifiedMs).toBeLessThan(HOUR);
    // The rest of the row is untouched.
    expect(health.cal_com).toEqual({ lastNotifiedMs: 123 });
    expect(meta.sync).toEqual({ enabled: true });
  });

  it("a later run inside the cooldown emits nothing; one after it emits again", async () => {
    expect(await notifyConnectorUnhealthy(opts())).toBe(true);
    expect(await notifyConnectorUnhealthy(opts())).toBe(false);
    expect(h.createNotification).toHaveBeenCalledTimes(1);

    // The window elapsed: the stored nudge is 7 h old.
    await q(
      `update tools set metadata = jsonb_set(metadata, '{connectionHealth,google,lastNotifiedMs}', to_jsonb($2::bigint)) where id = $1`,
      [toolId, Date.now() - 7 * HOUR]
    );
    expect(await notifyConnectorUnhealthy(opts())).toBe(true);
    expect(h.createNotification).toHaveBeenCalledTimes(2);
  });

  it("each connector key holds its own window on the same row", async () => {
    // cal_com's stored nudge (ms 123) is decades old: its window is open.
    const [google, cal] = await Promise.all([
      notifyConnectorUnhealthy(opts()),
      notifyConnectorUnhealthy({ ...opts(), connectorKey: "cal_com" }),
    ]);
    expect([google, cal]).toEqual([true, true]);
    expect(h.createNotification).toHaveBeenCalledTimes(2);
  });

  it("the intelligence-service watermark (null metadata) claims once too", async () => {
    const base = {
      ...opts(),
      connectorKey: "intelligence:synap-is",
      watermarkToolId: serviceRowId,
      watermarkTable: "intelligence_services" as const,
      notificationType: "system.intelligence_degraded",
    };
    const results = await Promise.all(
      Array.from({ length: PARALLEL_RUNS }, () =>
        notifyConnectorUnhealthy(base)
      )
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(h.createNotification).toHaveBeenCalledTimes(1);
    const meta = await watermarkOf("intelligence_services", serviceRowId);
    expect(
      (meta.connectionHealth as Record<string, { lastNotifiedMs: number }>)[
        "intelligence:synap-is"
      ]!.lastNotifiedMs
    ).toBeGreaterThan(Date.now() - HOUR);
  });

  it("no row to hold the watermark: nothing is emitted (it could not be deduped)", async () => {
    expect(
      await notifyConnectorUnhealthy({
        ...opts(),
        watermarkToolId: randomUUID(),
      })
    ).toBe(false);
    expect(h.createNotification).not.toHaveBeenCalled();
  });
});
