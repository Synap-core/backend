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
import { proposals, users, type db as DatabaseHandle } from "@synap/database";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { findRejectedConnectionSyncImport } from "./pending-capture-dedup.js";
import {
  buildImportGraphProposalData,
  importGraphIdempotencyKey,
} from "../services/import/structuring.js";

const OWNER = "user-1";
/** An agent-user the owner created — the owner's authorship lineage. */
const OWNER_AGENT = "agent-of-user-1";
/** Another human's agent — outside the owner's lineage. */
const OTHER_AGENT = "agent-of-user-2";
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
    // The owner floor is the authorship lineage (`authoredByUser`), whose
    // subquery reads `users`: the owner's agent-users, and another human's.
    await client.exec(ddlFor(users as unknown as PgTable));
    await client.query(
      `insert into users (id, user_type, created_by_user_id) values
         ($1, 'human', null), ($2, 'agent', $1), ('user-2', 'human', null), ($3, 'agent', 'user-2')`,
      [OWNER, OWNER_AGENT, OTHER_AGENT]
    );
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

  it("finds a rejection filed through the owner's AGENT (agent id in createdBy), never another human's agent", async () => {
    // `createdBy` is overloaded: a sync import filed by the owner's agent
    // carries the AGENT's id. A bare `createdBy = owner` floor missed it, so the
    // next sync tick re-filed the graph the owner had declined.
    const ops = contacts("jelle@acme-corp.io");
    const mine = await fileSyncImport({
      status: "rejected",
      operations: ops,
      createdBy: OWNER_AGENT,
    });
    expect(await lookup(ops)).toEqual({ id: mine });

    await client.exec("delete from proposals;");
    const theirs = await fileSyncImport({
      status: "rejected",
      operations: ops,
      createdBy: OTHER_AGENT,
    });
    expect(await lookup(ops)).toBeNull();
    // Non-vacuity: that rejection IS found for its own owner.
    expect(await lookup(ops, { userId: "user-2" })).toEqual({ id: theirs });
  });
});
