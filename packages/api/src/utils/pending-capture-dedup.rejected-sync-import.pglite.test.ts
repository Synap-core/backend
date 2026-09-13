/**
 * A rejected connection-sync import is found by the REAL lookup SQL, keyed on
 * the content key the REAL stamp writes — so a declined graph is not re-filed.
 *
 * Real: `buildImportGraphProposalData` (the stamp `submitSyncGraphToImport`
 * files with), `importGraphIdempotencyKey` (the key the runner computes), and
 * `findRejectedConnectionSyncImport` on PGlite with the proposals table
 * generated from its Drizzle definition.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { proposals, type db as DatabaseHandle } from "@synap/database";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { findRejectedConnectionSyncImport } from "./pending-capture-dedup.js";
import {
  buildImportGraphProposalData,
  importGraphIdempotencyKey,
} from "../services/import/structuring.js";

const OWNER = "user-1";
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

const contacts = (email: string): CompositeProposalOperation[] => [
  {
    op: "create_entity",
    ref: `person:${email}`,
    profileSlug: "person",
    title: email,
    properties: { email },
  },
];

let client: PGlite;
let database: typeof DatabaseHandle;

async function fileSyncImport(opts: {
  status: string;
  operations: CompositeProposalOperation[];
  connectionId?: string;
  kinds?: string[];
  createdBy?: string;
}): Promise<string> {
  const id = randomUUID();
  const data = {
    ...buildImportGraphProposalData({
      operations: opts.operations,
      source: "connector_sync",
      sourceId: id,
      workspaceId: "ws-1",
    }),
    connectionSync: {
      connectionId: opts.connectionId ?? "conn-1",
      provider: "google",
      kinds: opts.kinds ?? ["contact"],
      keepSyncing: false,
    },
  };
  await client.query(
    `insert into proposals (id, created_by, status, proposal_type, data, created_at)
     values ($1, $2, $3, 'import.graph', $4::jsonb, now())`,
    [id, opts.createdBy ?? OWNER, opts.status, JSON.stringify(data)]
  );
  return id;
}

const lookup = (
  operations: CompositeProposalOperation[],
  over: Partial<{ connectionId: string; kinds: string[]; userId: string }> = {}
) =>
  findRejectedConnectionSyncImport(database, {
    userId: over.userId ?? OWNER,
    idempotencyKey: importGraphIdempotencyKey({
      workspaceId: "ws-1",
      operations,
    })!,
    connectionId: over.connectionId ?? "conn-1",
    kinds: over.kinds ?? ["contact"],
  });

describe("findRejectedConnectionSyncImport", () => {
  beforeAll(async () => {
    client = new PGlite();
    await client.exec(ddlFor(proposals as unknown as PgTable));
    database = drizzle(client) as unknown as typeof DatabaseHandle;
  });
  beforeEach(async () => {
    await client.exec("delete from proposals;");
  });

  it("finds a rejected import of the same content, connection and kinds", async () => {
    const ops = contacts("jelle@acme-corp.io");
    const id = await fileSyncImport({ status: "rejected", operations: ops });
    expect(await lookup(ops)).toEqual({ id });
  });

  it("ignores a pending or approved import, another connection, other kinds, another owner, and changed content", async () => {
    const ops = contacts("jelle@acme-corp.io");
    await fileSyncImport({ status: "pending", operations: ops });
    await fileSyncImport({ status: "approved", operations: ops });
    await fileSyncImport({
      status: "rejected",
      operations: ops,
      connectionId: "conn-2",
    });
    await fileSyncImport({
      status: "rejected",
      operations: ops,
      kinds: ["event", "contact"],
    });
    await fileSyncImport({
      status: "rejected",
      operations: ops,
      createdBy: "user-2",
    });
    expect(await lookup(ops)).toBeNull();
    expect(await lookup(contacts("ana@acme-corp.io"))).toBeNull();

    // Non-vacuity: the same fixtures DO match once a matching row exists.
    const id = await fileSyncImport({ status: "rejected", operations: ops });
    expect(await lookup(ops)).toEqual({ id });
  });
});
