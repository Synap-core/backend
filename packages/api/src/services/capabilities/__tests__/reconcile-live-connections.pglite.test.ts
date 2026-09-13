/**
 * CONNECT → REGISTRY ROW → FIRST SYNC, on a real Postgres.
 *
 * The defect: a connection made from relay / browser never got a registry row —
 * the reconciler only ran when someone opened a capability's connection list —
 * so its first sync was never enqueued. `connectors.connections` (the client's
 * post-OAuth refetch) now calls `reconcileLiveConnections`, which is driven here
 * through real SQL: tool → member_of link → capability → pointer row insert →
 * `enqueueConnectionSync`, and a repeat refetch enqueues nothing more.
 *
 * ENGINE: PGlite; `secrets`, `tools`, `links` are created FROM THEIR DRIZZLE
 * DEFINITIONS (enums mapped to text, constraints dropped).
 *
 * Stubbed, and why: `encryptServerSide` (needs VAULT_SERVER_KEY; the pointer row
 * holds an empty blob whose bytes are irrelevant here) and the sync queue
 * (`enqueueConnectionSync` — the assertion target).
 *
 * NOT covered: the tRPC procedure's own call into this function (pinned by the
 * source assertion at the bottom), and the materialize step when the provider
 * tool does not exist yet.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  enqueued: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    encryptServerSide: () => ({ encryptedData: "", iv: "", authTag: "" }),
  };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});

vi.mock("../../event-sync/connection-sync.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enqueueConnectionSync: vi.fn(async (input: Record<string, unknown>) => {
    holder.enqueued.push(input);
  }),
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { secrets, tools, links } from "@synap/database/schema";
import { reconcileLiveConnections } from "../capability-nango-sync.js";

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

const USER = "user-1";

async function freshDb() {
  const client = new PGlite();
  for (const table of [secrets, tools, links]) {
    await client.exec(ddlFor(table as unknown as PgTable));
  }
  holder.db = drizzle(client);
  return client;
}

async function seedGoogleCapability(client: PGlite): Promise<string> {
  const toolId = randomUUID();
  const capabilityId = randomUUID();
  await client.query(
    `insert into tools (id, name, credential_ref) values ($1, 'Google', 'nango://google')`,
    [toolId]
  );
  await client.query(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type)
     values ($1, 'tool', $2, 'capability', $3, 'member_of')`,
    [randomUUID(), toolId, capabilityId]
  );
  return capabilityId;
}

const live = (connectionId: string, provider = "google") => ({
  connectionId,
  provider,
  userId: USER,
  createdAt: new Date("2026-09-13T00:00:00.000Z"),
});

async function pointerRows(client: PGlite) {
  const { rows } = await client.query<{
    id: string;
    capability_id: string;
    account_hint: string;
    user_id: string;
  }>(
    `select id, capability_id, account_hint, user_id from secrets where deleted_at is null`
  );
  return rows;
}

beforeEach(() => {
  holder.enqueued = [];
});

describe("reconcileLiveConnections — a client refetch mirrors a new connection", () => {
  it("inserts ONE pointer row for the capability and enqueues its first sync once", async () => {
    const client = await freshDb();
    const capabilityId = await seedGoogleCapability(client);

    await reconcileLiveConnections(USER, [live("conn-1")]);

    const rows = await pointerRows(client);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      capability_id: capabilityId,
      account_hint: "conn-1",
      user_id: USER,
    });
    expect(holder.enqueued).toEqual([
      {
        provider: "google",
        connectionId: rows[0]!.id,
        workspaceId: null,
        reason: "connect",
      },
    ]);
  });

  it("is idempotent — a repeat refetch neither duplicates the row nor re-enqueues", async () => {
    const client = await freshDb();
    await seedGoogleCapability(client);

    await reconcileLiveConnections(USER, [live("conn-1")]);
    await reconcileLiveConnections(USER, [live("conn-1")]);

    expect(await pointerRows(client)).toHaveLength(1);
    expect(holder.enqueued).toHaveLength(1);
  });

  it("a connection whose provider has no tool mirrors nothing", async () => {
    const client = await freshDb();
    await seedGoogleCapability(client);

    await reconcileLiveConnections(USER, [live("conn-9", "notion")]);

    expect(await pointerRows(client)).toHaveLength(0);
    expect(holder.enqueued).toHaveLength(0);
  });
});

describe("the client refetch door reaches the reconcile", () => {
  it("connectors.connections calls reconcileLiveConnections after a successful list", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      join(here, "../../../routers/connectors-trpc.ts"),
      "utf8"
    );
    const start = src.indexOf("  connections: protectedProcedure");
    const end = src.indexOf("  syncToolRows: protectedProcedure", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body.indexOf("if (!listed.ok)")).toBeGreaterThan(-1);
    expect(body.indexOf("mirrorObservedConnections(")).toBeGreaterThan(
      body.indexOf("if (!listed.ok)")
    );
    const helper = src.slice(
      src.indexOf("async function mirrorObservedConnections(")
    );
    expect(helper).toContain("reconcileLiveConnections(");
  });
});
