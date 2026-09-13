/**
 * The connection-registry doors on a real Postgres (PGlite), where the SQL — not
 * a mock that ignores it — decides which rows are touched.
 *
 *  1. DISCONNECT → LINKS: the sync door stamps `entity_external_links` with the
 *     registry ROW id; links written before it carry the broker connection id.
 *     `detachNangoConnectionRegistry(<broker id>)` must mark BOTH disconnected,
 *     and must not touch another connection's links.
 *  2. SYNC NOW, provider mode: the rows enqueued come from the SQL owner filter
 *     (the in-code filter is a second fence; this proves the query itself
 *     selects only the caller's live rows).
 *  3. A SERVER-SIDE reconcile (no live list supplied) reads the list through the
 *     broker; a broker fault is `ok:false` and reconciles nothing.
 *
 * Tables are created FROM THEIR DRIZZLE DEFINITIONS (enums → text, constraints
 * dropped). Stubbed: `encryptServerSide` (needs VAULT_SERVER_KEY), the sync
 * queue (assertion target), the provider-key resolver, the sync-tool join
 * (tables not modelled here) and `resolveBroker`.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterAll,
} from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  enqueued: [] as Array<Record<string, unknown>>,
  broker: null as unknown,
  /** Connection ids whose governance rules were retired (SQL pinned in @synap/database's own pglite test). */
  retired: [] as string[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    encryptServerSide: () => ({ encryptedData: "", iv: "", authTag: "" }),
    retireConnectionRules: vi.fn(async (input: { connectionIds: string[] }) => {
      holder.retired.push(...input.connectionIds);
      return { revokedRuleIds: [] };
    }),
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
    return { queued: true, jobId: "job-1" };
  }),
}));

vi.mock("../../event-sync/sync-state-store.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveSyncTool: vi.fn(async () => ({
    id: "tool-google",
    createdBy: "u",
    workspaceId: null,
    metadata: {},
  })),
}));

vi.mock("../capability-provider-resolution.js", () => ({
  resolveCapabilityNangoProviderKeys: vi.fn(async () => ["google"]),
}));

vi.mock("../../../connectors/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveBroker: vi.fn(async () =>
    holder.broker
      ? { ok: true, broker: holder.broker, source: "control-plane" }
      : {
          ok: false,
          reason: "broker-credential-missing",
          error: "no relay key",
        }
  ),
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  secrets,
  entityExternalLinks,
  tools,
  links,
  users,
} from "@synap/database/schema";
import {
  detachNangoConnectionRegistry,
  disconnectAllUserConnections,
  enqueueManualConnectionSync,
  reconcileLiveConnections,
} from "../capability-nango-sync.js";
import { resolveSyncConnections } from "../../event-sync/sync-state-store.js";

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

const TABLES = [secrets, entityExternalLinks, tools, links, users] as const;

// ONE PGlite for the file, emptied before every case: a fresh instance per case
// (never closed) piled up WASM databases and stalled late cases in a loaded run.
let client: PGlite;

beforeAll(async () => {
  client = new PGlite();
  for (const table of TABLES) {
    await client.exec(ddlFor(table as unknown as PgTable));
  }
  holder.db = drizzle(client);
}, 120_000);

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  for (const table of TABLES) {
    await client.exec(
      `delete from "${getTableConfig(table as unknown as PgTable).name}";`
    );
  }
  holder.enqueued = [];
  holder.broker = null;
  holder.retired = [];
});

async function syncTool(metadata: unknown): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into tools (id, name, metadata) values ($1, 'google', $2::jsonb)`,
    [id, JSON.stringify(metadata)]
  );
  return id;
}

async function toolMetadata(id: string): Promise<any> {
  const r = await client.query<{ metadata: unknown }>(
    `select metadata from tools where id = $1`,
    [id]
  );
  return r.rows[0]!.metadata;
}

async function isDeleted(id: string): Promise<boolean> {
  const r = await client.query<{ deleted: boolean }>(
    `select deleted_at is not null as deleted from secrets where id = $1`,
    [id]
  );
  return r.rows[0]!.deleted;
}

async function pointerRow(over: {
  userId: string;
  accountHint: string | null;
  capabilityId?: string | null;
  deleted?: boolean;
}): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into secrets (id, user_id, name, type, capability_id, account_hint, is_default,
       encrypted_data, iv, auth_tag, encryption_version, encryption_mode, deleted_at)
     values ($1, $2, 'p', 'api_key', $3, $4, false, '', '', '', 1, 'server', $5)`,
    [
      id,
      over.userId,
      over.capabilityId === undefined ? randomUUID() : over.capabilityId,
      over.accountHint,
      over.deleted ? new Date().toISOString() : null,
    ]
  );
  return id;
}

async function link(nangoConnectionId: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into entity_external_links (id, entity_id, provider, external_id, nango_connection_id, status)
     values ($1, $2, 'google', $3, $4, 'active')`,
    [id, randomUUID(), randomUUID(), nangoConnectionId]
  );
  return id;
}

async function linkStatus(id: string): Promise<string> {
  const r = await client.query<{ status: string }>(
    `select status from entity_external_links where id = $1`,
    [id]
  );
  return r.rows[0]!.status;
}

describe("disconnect marks the connection's links disconnected — by row id AND broker id", () => {
  it("links stamped with the registry row id and with the broker id both flip; another connection's do not", async () => {
    const rowId = await pointerRow({
      userId: "user-1",
      accountHint: "nango-abc",
    });
    const otherRow = await pointerRow({
      userId: "user-1",
      accountHint: "nango-other",
    });
    const byRow = await link(rowId);
    const byBroker = await link("nango-abc");
    const unrelated = await link(otherRow);

    await detachNangoConnectionRegistry("nango-abc");

    expect(await linkStatus(byRow)).toBe("disconnected");
    expect(await linkStatus(byBroker)).toBe("disconnected");
    expect(await linkStatus(unrelated)).toBe("active");
    const deleted = await client.query<{ deleted: boolean }>(
      `select deleted_at is not null as deleted from secrets where id = $1`,
      [rowId]
    );
    expect(deleted.rows[0]!.deleted).toBe(true);
  });
});

describe("disconnect leaves nothing governing or tracking the connection", () => {
  it("retires the connection's rules and removes its run state from every kind; config and other connections stay", async () => {
    const rowId = await pointerRow({
      userId: "user-1",
      accountHint: "nango-abc",
    });
    const otherRow = await pointerRow({
      userId: "user-1",
      accountHint: "nango-other",
    });
    const toolId = await syncTool({
      sync: {
        enabled: true,
        kinds: {
          event: {
            enabled: true,
            windowDays: 30,
            connections: {
              [rowId]: { phase: "synced", cursor: "2026-09-01" },
              [otherRow]: { phase: "synced" },
            },
          },
          contact: { connections: { [rowId]: { phase: "failed" } } },
          "email.thread": { enabled: false },
        },
      },
    });

    await detachNangoConnectionRegistry("nango-abc");

    expect(holder.retired).toEqual([rowId]);
    const meta = await toolMetadata(toolId);
    expect(meta.sync.enabled).toBe(true);
    expect(meta.sync.kinds.event).toEqual({
      enabled: true,
      windowDays: 30,
      connections: { [otherRow]: { phase: "synced" } },
    });
    expect(meta.sync.kinds.contact).toEqual({ connections: {} });
    expect(meta.sync.kinds["email.thread"]).toEqual({ enabled: false });
    expect(await isDeleted(rowId)).toBe(true);
    expect(await isDeleted(otherRow)).toBe(false);
  });
});

describe("deleting a user removes every connection they hold", () => {
  const revokes: Array<[string, string | undefined, string | undefined]> = [];
  function brokerListing(connections: Array<{ connectionId: string }>) {
    revokes.length = 0;
    holder.broker = {
      listConnectionsResult: async (userId: string) => ({
        ok: true,
        connections:
          userId === "user-1"
            ? connections.map((c) => ({
                ...c,
                provider: "google",
                userId,
                createdAt: null,
              }))
            : [],
      }),
      revokeConnection: async (
        id: string,
        provider?: string,
        userId?: string
      ) => {
        revokes.push([id, provider, userId]);
      },
    };
  }

  it("revokes each live connection AS the user, detaches rows whose connection is already gone, and touches no one else", async () => {
    const live = await pointerRow({
      userId: "user-1",
      accountHint: "nango-live",
    });
    const gone = await pointerRow({
      userId: "user-1",
      accountHint: "nango-gone",
    });
    const someoneElse = await pointerRow({
      userId: "user-2",
      accountHint: "nango-x",
    });
    brokerListing([{ connectionId: "nango-live" }]);

    await expect(disconnectAllUserConnections("user-1")).resolves.toEqual({
      revoked: 1,
      detached: 1,
    });

    expect(revokes).toEqual([["nango-live", "google", "user-1"]]);
    expect(await isDeleted(live)).toBe(true);
    expect(await isDeleted(gone)).toBe(true);
    expect(await isDeleted(someoneElse)).toBe(false);
    expect([...holder.retired].sort()).toEqual([live, gone].sort());
  });

  it("another user's connection with the SAME account hint is untouched — rows, rules and links", async () => {
    // Vault account hints are free text, so two users can both hold "work".
    const mine = await pointerRow({ userId: "user-1", accountHint: "work" });
    const theirs = await pointerRow({ userId: "user-2", accountHint: "work" });
    const theirLinkByRow = await link(theirs);
    const linkByHint = await link("work");
    brokerListing([]);

    await expect(disconnectAllUserConnections("user-1")).resolves.toEqual({
      revoked: 0,
      detached: 1,
    });

    expect(await isDeleted(mine)).toBe(true);
    expect(await isDeleted(theirs)).toBe(false);
    expect(holder.retired).toEqual([mine]);
    expect(await linkStatus(theirLinkByRow)).toBe("active");
    expect(await linkStatus(linkByHint)).toBe("active");
  });

  it("an unreadable broker list throws and removes nothing", async () => {
    const row = await pointerRow({
      userId: "user-1",
      accountHint: "nango-live",
    });
    holder.broker = {
      listConnectionsResult: async () => ({
        ok: false,
        reason: "unreachable",
        error: "down",
      }),
    };
    await expect(disconnectAllUserConnections("user-1")).rejects.toThrow(
      /unreachable/
    );
    expect(await isDeleted(row)).toBe(false);
    expect(holder.retired).toEqual([]);
  });

  it("a failed revoke throws and keeps the connection's row", async () => {
    const row = await pointerRow({
      userId: "user-1",
      accountHint: "nango-live",
    });
    brokerListing([{ connectionId: "nango-live" }]);
    (holder.broker as { revokeConnection: unknown }).revokeConnection =
      async () => {
        throw new Error("broker 502");
      };
    await expect(disconnectAllUserConnections("user-1")).rejects.toThrow(
      /broker 502/
    );
    expect(await isDeleted(row)).toBe(false);
  });

  it("the sync runner never resolves a connection whose owner no longer exists", async () => {
    const capabilityId = randomUUID();
    const toolId = randomUUID();
    await client.query(
      `insert into links (id, from_type, from_id, link_type, to_type, to_id)
       values ($1, 'tool', $2, 'member_of', 'capability', $3)`,
      [randomUUID(), toolId, capabilityId]
    );
    await client.query(
      `insert into users (id, email) values ('user-1', 'a@example.com')`
    );
    const kept = await pointerRow({
      userId: "user-1",
      accountHint: "h1",
      capabilityId,
    });
    await pointerRow({
      userId: "user-deleted",
      accountHint: "h2",
      capabilityId,
    });

    const resolved = await resolveSyncConnections(toolId, undefined);

    expect(resolved).toEqual([{ id: kept, userId: "user-1" }]);
  });
});

describe("sync now (provider mode) — the SQL selects only the caller's live rows", () => {
  it("enqueues exactly the caller's live registry rows", async () => {
    const mine = await pointerRow({ userId: "user-1", accountHint: "a" });
    const mine2 = await pointerRow({ userId: "user-1", accountHint: "b" });
    await pointerRow({ userId: "user-2", accountHint: "c" });
    await pointerRow({ userId: "user-1", accountHint: "d", deleted: true });
    await pointerRow({
      userId: "user-1",
      accountHint: null,
      capabilityId: null,
    });

    const r = await enqueueManualConnectionSync({
      userId: "user-1",
      provider: "google",
    });

    expect(r).toEqual({ ok: true, queued: 2, debounced: 0 });
    expect(holder.enqueued.map((e) => e.connectionId).sort()).toEqual(
      [mine, mine2].sort()
    );
  });
});

describe("server-side reconcile (no live list supplied)", () => {
  it("a broker fault is ok:false — nothing is reconciled off an unread list", async () => {
    holder.broker = null;
    expect(await reconcileLiveConnections("user-1")).toMatchObject({
      ok: false,
      reason: "broker-credential-missing",
    });
  });

  it("a failed list is ok:false", async () => {
    holder.broker = {
      listConnectionsResult: async () => ({
        ok: false,
        reason: "truncated",
        error: "partial",
      }),
    };
    expect(await reconcileLiveConnections("user-1")).toMatchObject({
      ok: false,
      reason: "truncated",
    });
  });

  it("reads the list through the broker; with no provider tool yet it reports 0 capabilities", async () => {
    const seen: string[] = [];
    holder.broker = {
      listConnectionsResult: async (userId: string) => {
        seen.push(userId);
        return { ok: true, connections: [] };
      },
    };
    expect(await reconcileLiveConnections("user-1")).toEqual({
      ok: true,
      capabilities: 0,
    });
    expect(seen).toEqual(["user-1"]);
  });
});
