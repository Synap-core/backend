/**
 * "Keep syncing" OFF chosen at first-import review must survive the async rule
 * mint — on a real Postgres (PGlite), composing the three doors in the order
 * the clients drive them.
 *
 * The sequence: the owner approves the connection's first import, the approve
 * call returns, and the client immediately calls `setKeepSyncing(false)`. The
 * `connection-sync-approval` worker (`applyConnectionSyncApprovalForProposal`)
 * runs later, from a queue. Nothing may let that later mint turn the switch
 * back ON: after the worker, no auto rule is active and the next sync proposes.
 *
 * Also pinned: the reverse order (the worker already minted, then OFF revokes
 * it), and turning the switch back ON after OFF.
 *
 * Tables are created FROM THEIR DRIZZLE DEFINITIONS (enums → text, constraints
 * dropped). Stubbed: the provider-key resolver and the sync-tool join (tables
 * not modelled here), and the sync queue.
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

const holder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});

vi.mock("../../event-sync/connection-sync.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enqueueConnectionSync: vi.fn(async () => ({ queued: true, jobId: "job-1" })),
}));

vi.mock("../../event-sync/sync-state-store.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveSyncTool: vi.fn(async () => ({
    id: "tool-google",
    createdBy: "user-1",
    workspaceId: null,
    metadata: {},
  })),
}));

vi.mock("../capability-provider-resolution.js", () => ({
  resolveCapabilityNangoProviderKeys: vi.fn(async () => ["google"]),
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { secrets, proposals, governanceRules } from "@synap/database/schema";
import {
  applyConnectionSyncApprovalForProposal,
  resolveConnectionSyncDecision,
} from "@synap/database";
import { setConnectionKeepSyncing } from "../capability-nango-sync.js";

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

const TABLES = [secrets, proposals, governanceRules] as const;
const OWNER = "user-1";

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
});

/** A connection registry row and its APPROVED first import, as the sync door stamps it. */
async function approvedFirstImport(): Promise<{
  connectionId: string;
  proposalId: string;
}> {
  const connectionId = randomUUID();
  await client.query(
    `insert into secrets (id, user_id, name, type, capability_id, account_hint, is_default,
       encrypted_data, iv, auth_tag, encryption_version, encryption_mode)
     values ($1, $2, 'google', 'api_key', $3, 'nango-abc', true, '', '', '', 1, 'server')`,
    [connectionId, OWNER, randomUUID()]
  );
  const proposalId = randomUUID();
  await client.query(
    `insert into proposals (id, proposal_type, target_type, target_id, status, data, reviewed_at, updated_at)
     values ($1, 'import.graph', 'entity', $2, 'approved', $3::jsonb, now(), now())`,
    [
      proposalId,
      randomUUID(),
      JSON.stringify({
        operations: [],
        connectionSync: {
          connectionId,
          provider: "google",
          kinds: ["contact"],
          keepSyncing: true,
        },
      }),
    ]
  );
  return { connectionId, proposalId };
}

/** What the `connection-sync-approval` worker runs for an approved proposal. */
const runApprovalWorker = (proposalId: string) =>
  applyConnectionSyncApprovalForProposal({
    db: holder.db as never,
    proposalId,
    userId: OWNER,
  });

async function activeAutoRules(connectionId: string): Promise<number> {
  const r = await client.query<{ n: number }>(
    `select count(*)::int as n from governance_rules
     where target_pattern = $1 and verdict = 'auto' and revoked_at is null`,
    [connectionId]
  );
  return r.rows[0]!.n;
}

const nextDecision = (connectionId: string) =>
  resolveConnectionSyncDecision({
    db: holder.db as never,
    userId: OWNER,
    workspaceId: null,
    connectionId,
  });

async function activeReviewRules(
  connectionId: string
): Promise<Array<{ source_proposal_id: string | null }>> {
  const r = await client.query<{ source_proposal_id: string | null }>(
    `select source_proposal_id from governance_rules
     where target_pattern = $1 and verdict = 'propose' and revoked_at is null`,
    [connectionId]
  );
  return r.rows;
}

describe("keep syncing OFF at first-import review vs the async rule mint", () => {
  it("OFF chosen BEFORE the worker runs stays OFF after it runs", async () => {
    const { connectionId, proposalId } = await approvedFirstImport();

    await expect(
      setConnectionKeepSyncing({ userId: OWNER, connectionId, enabled: false })
    ).resolves.toEqual({ ok: true, enabled: false });
    await expect(runApprovalWorker(proposalId)).resolves.toMatchObject({
      applied: false,
      skipped: "keep-syncing-off",
    });

    expect(await activeAutoRules(connectionId)).toBe(0);
    expect(await activeReviewRules(connectionId)).toEqual([
      { source_proposal_id: proposalId },
    ]);
    await expect(nextDecision(connectionId)).resolves.toMatchObject({
      verdict: "propose",
    });
  });

  it("a review rule from an OLDER import does not block a new approval with the switch ON", async () => {
    const { connectionId } = await approvedFirstImport();
    const olderImport = randomUUID();
    await client.query(
      `insert into governance_rules (id, principal_kind, scope_kind, target_kind, target_pattern,
         verdict, source_proposal_id, created_by, created_at)
       values ($1, 'any', 'pod', 'connection', $2, 'propose', $3, 'user:user-1', now() - interval '30 days')`,
      [randomUUID(), connectionId, olderImport]
    );
    const newImport = randomUUID();
    await client.query(
      `insert into proposals (id, proposal_type, target_type, target_id, status, data, reviewed_at, updated_at)
       values ($1, 'import.graph', 'entity', $2, 'approved', $3::jsonb, now(), now())`,
      [
        newImport,
        randomUUID(),
        JSON.stringify({
          operations: [],
          connectionSync: {
            connectionId,
            provider: "google",
            kinds: ["contact"],
            keepSyncing: true,
          },
        }),
      ]
    );

    await expect(runApprovalWorker(newImport)).resolves.toMatchObject({
      applied: true,
    });

    expect(await activeAutoRules(connectionId)).toBe(1);
    expect(await activeReviewRules(connectionId)).toEqual([]);
    await expect(nextDecision(connectionId)).resolves.toMatchObject({
      verdict: "auto",
    });
  });

  it("OFF chosen AFTER the worker minted the rule revokes it", async () => {
    const { connectionId, proposalId } = await approvedFirstImport();
    await runApprovalWorker(proposalId);
    expect(await activeAutoRules(connectionId)).toBe(1);

    await setConnectionKeepSyncing({
      userId: OWNER,
      connectionId,
      enabled: false,
    });

    expect(await activeAutoRules(connectionId)).toBe(0);
    await expect(nextDecision(connectionId)).resolves.toMatchObject({
      verdict: "propose",
    });
  });

  it("turning it back ON after OFF auto-applies again", async () => {
    const { connectionId, proposalId } = await approvedFirstImport();
    await setConnectionKeepSyncing({
      userId: OWNER,
      connectionId,
      enabled: false,
    });
    await runApprovalWorker(proposalId);

    await expect(
      setConnectionKeepSyncing({ userId: OWNER, connectionId, enabled: true })
    ).resolves.toMatchObject({ ok: true, enabled: true });

    expect(await activeAutoRules(connectionId)).toBe(1);
    await expect(nextDecision(connectionId)).resolves.toMatchObject({
      verdict: "auto",
    });
  });
});
