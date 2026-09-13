/**
 * `emitAiCorrection` does not count a rejected connection-sync import as an AI
 * correction — on a real Postgres (PGlite), with proposals FILED BY THE REAL
 * PRODUCERS, so the row shape the lookup reads is the one production writes.
 *
 * A connection-sync `import.graph` proposal is built by a deterministic provider
 * mapper, not a model. The reject doors call `emitAiCorrection` in two shapes:
 * a whole-proposal reject names the proposal as `subjectId`; a per-item reject
 * names the item and passes `proposal.correlationId ?? proposalId`. A sync
 * import is filed through `submitSyncGraphToImport` → `createEventBackedProposal`,
 * which leaves the `correlation_id` COLUMN empty — so the per-item shape carries
 * the proposal id. The fixture reads that column back and applies the callers'
 * own expression rather than assuming it.
 *
 * ENGINE: PGlite; `proposals` is created from its drizzle definition (enums
 * mapped to text, constraints dropped). Stubbed edges: `createPendingProposal`
 * (records the producer's arguments as a row — notifications and dedup are not
 * under test), the prior-proposal lookup, and `auditLog` (the assertion target
 * and the `.requested` event the producer appends).
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

const holder = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  return {
    db: undefined as unknown,
    client: undefined as unknown as {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
    },
    audits: [] as Array<Record<string, unknown>>,
  };
});

vi.mock("./audit-log.js", () => ({
  auditLog: async (opts: Record<string, unknown>) => {
    if (opts.subjectType === "ai_correction") holder.audits.push(opts);
    return { id: randomUUID() };
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});

vi.mock("./permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPendingProposal: vi.fn(
    async (input: {
      proposalType: string;
      targetType: string;
      targetId: string;
      workspaceId: string | null;
      data: Record<string, unknown>;
      correlationId?: string | null;
    }) => {
      const id = randomUUID();
      await holder.client.query(
        `insert into proposals (id, proposal_type, target_type, target_id, workspace_id, status, data, correlation_id)
         values ($1, $2, $3, $4, $5, 'pending', $6::jsonb, $7)`,
        [
          id,
          input.proposalType,
          input.targetType,
          input.targetId,
          input.workspaceId,
          JSON.stringify(input.data),
          input.correlationId ?? null,
        ]
      );
      return { id };
    }
  ),
}));

vi.mock("../services/import/structuring.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  findPriorImportGraphProposal: vi.fn(async () => null),
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { proposals } from "@synap/database/schema";
import { emitAiCorrection } from "./ai-feedback-events.js";
import { createEventBackedProposal } from "./event-backed-proposal.js";
import { submitSyncGraphToImport } from "../services/connector-import-bridge.js";

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

let client: PGlite;

beforeAll(async () => {
  client = new PGlite();
  await client.exec(ddlFor(proposals as unknown as PgTable));
  holder.client = client as never;
}, 120_000);

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  await client.exec(`delete from proposals;`);
  holder.db = drizzle(client);
  holder.audits = [];
});

/** What a per-item reject door passes: `proposal.correlationId ?? proposalId`. */
async function callerCorrelationId(proposalId: string): Promise<string> {
  const r = await client.query<{ correlation_id: string | null }>(
    `select correlation_id from proposals where id = $1`,
    [proposalId]
  );
  return r.rows[0]!.correlation_id ?? proposalId;
}

async function fileSyncImport(): Promise<string> {
  const { proposalId } = await submitSyncGraphToImport({
    userId: "user-1",
    workspaceId: null,
    operations: [],
    summary: "First import from Google",
    connectionSync: {
      connectionId: "row-1",
      provider: "google",
      kinds: ["contact"],
      keepSyncing: true,
    },
  });
  return proposalId;
}

async function fileOrdinaryImport(): Promise<string> {
  const { proposal } = await createEventBackedProposal({
    userId: "user-1",
    workspaceId: null,
    targetType: "entity",
    targetId: randomUUID(),
    proposalType: "import.graph",
    action: "create",
    source: "csv",
    summary: "CSV import",
    data: { operations: [] },
  });
  return (proposal as { id: string }).id;
}

const reject = (subjectId: string, correlationId: string, extra = {}) =>
  emitAiCorrection({
    action: "reject",
    userId: "user-1",
    subjectId,
    data: {
      kind: "extract",
      correlationId,
      reason: "not my contacts",
      ...extra,
    },
  });

describe("emitAiCorrection — a rejected connection-sync import is not an AI correction", () => {
  it("the real producer leaves the correlation column empty (the per-item shape therefore carries the proposal id)", async () => {
    const id = await fileSyncImport();
    await expect(callerCorrelationId(id)).resolves.toBe(id);
  });

  it("a whole-proposal reject of a sync import records nothing", async () => {
    const id = await fileSyncImport();
    await reject(id, await callerCorrelationId(id));
    expect(holder.audits).toEqual([]);
  });

  it("a per-item reject (subject = the item) records nothing", async () => {
    const id = await fileSyncImport();
    await reject("event:ev1", await callerCorrelationId(id), {
      itemRef: "event:ev1",
    });
    expect(holder.audits).toEqual([]);
  });

  it("a reject of an ordinary import (no connectionSync stamp) is still recorded, whole or per item", async () => {
    const id = await fileOrdinaryImport();
    await reject(id, await callerCorrelationId(id));
    await reject("person:1", await callerCorrelationId(id), {
      itemRef: "person:1",
    });
    expect(holder.audits).toHaveLength(2);
  });

  it("a correction of an entity (no proposal behind the ids) is still recorded", async () => {
    await fileSyncImport();
    await reject(randomUUID(), randomUUID());
    expect(holder.audits).toHaveLength(1);
  });

  it("a lookup that FAILS still records the correction — unknown is not 'sync import'", async () => {
    holder.db = {
      select: () => {
        throw new Error("db down");
      },
    };
    await reject(randomUUID(), randomUUID());
    expect(holder.audits).toHaveLength(1);
  });
});
