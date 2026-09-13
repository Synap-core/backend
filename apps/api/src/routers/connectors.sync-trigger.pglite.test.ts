/**
 * POST /api/connectors/sync-trigger resolves the broker connection id to the
 * pod registry row on a real Postgres, so the ownership predicate itself is
 * tested: a poke naming user A never enqueues user B's connection, even when
 * both rows carry the same broker connection id.
 *
 * ENGINE: PGlite; `secrets` is created from its drizzle definition (enums
 * mapped to text, constraints dropped). The CP token verifier, the broker list,
 * the reconciler and the queue are faked (covered by
 * connectors.sync-trigger.test.ts); the registry read is real SQL.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  process.env.CONTROL_PLANE_URL = "https://cp.example.test";
  return {
    db: undefined as unknown,
    enqueue: vi.fn(),
    reconcile: vi.fn(),
  };
});

vi.mock("@synap/api", () => ({
  verifyCpJwtWithTrust: async () => ({
    type: "connector_sync_trigger",
    providerConfigKey: "google",
    connectionId: "nango-conn-abc",
    podUserId: "user-A",
  }),
  enqueueConnectionSync: h.enqueue,
  reconcileLiveConnections: h.reconcile,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, getDb: async () => h.db };
});

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { secrets } from "@synap/database/schema";
import { connectorsRouter } from "./connectors.js";

/** CREATE TABLE from the drizzle definition — columns, types and literal defaults. */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

async function freshDb(): Promise<PGlite> {
  const client = new PGlite();
  await client.exec(ddlFor(secrets as unknown as PgTable));
  h.db = drizzle(client);
  return client;
}

async function seedConnection(client: PGlite, userId: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into secrets (id, user_id, capability_id, account_hint) values ($1, $2, $3, 'nango-conn-abc')`,
    [id, userId, randomUUID()]
  );
  return id;
}

function poke() {
  return connectorsRouter.request("/sync-trigger", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "t" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PUBLIC_URL = "https://pod.example.test";
  h.enqueue.mockResolvedValue(undefined);
  h.reconcile.mockResolvedValue({ ok: true, capabilities: 0 });
});

describe("POST /sync-trigger — registry ownership on real SQL", () => {
  it("another user's row with the same broker connection id is never enqueued", async () => {
    const client = await freshDb();
    await seedConnection(client, "user-B");
    const res = await poke();
    expect(res.status).toBe(404);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("the poked user's own row is the one enqueued", async () => {
    const client = await freshDb();
    await seedConnection(client, "user-B");
    const own = await seedConnection(client, "user-A");
    const res = await poke();
    expect(res.status).toBe(202);
    expect(h.enqueue).toHaveBeenCalledWith({
      provider: "google",
      connectionId: own,
      reason: "webhook",
    });
  });
});
