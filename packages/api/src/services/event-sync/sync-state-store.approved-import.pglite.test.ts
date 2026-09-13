/**
 * `findApprovedConnectionImport` — the one predicate behind "automatic syncing
 * may turn on" (the keep-syncing toggle and the status row's
 * `keepSyncing.available`) — on a real Postgres, so the jsonb SQL is tested.
 *
 * ENGINE: PGlite; `proposals` is created from its drizzle definition (enums
 * mapped to text, constraints dropped).
 */

import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  return { db: undefined as unknown };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { proposals } from "@synap/database/schema";
import { findApprovedConnectionImport } from "./sync-state-store.js";

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
  await client.exec(ddlFor(proposals as unknown as PgTable));
  holder.db = drizzle(client);
  return client;
}

async function seedProposal(
  client: PGlite,
  p: { type: string; status: string; connectionId: string; reviewedAt?: string }
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into proposals (id, proposal_type, status, data, reviewed_at) values ($1, $2, $3, $4::jsonb, $5)`,
    [
      id,
      p.type,
      p.status,
      JSON.stringify({
        connectionSync: { connectionId: p.connectionId, keepSyncing: true },
      }),
      p.reviewedAt ?? null,
    ]
  );
  return id;
}

describe("findApprovedConnectionImport", () => {
  it("null while the connection's first import is only pending, or another connection's is approved", async () => {
    const client = await freshDb();
    await seedProposal(client, {
      type: "import.graph",
      status: "pending",
      connectionId: "conn-1",
    });
    await seedProposal(client, {
      type: "import.graph",
      status: "approved",
      connectionId: "conn-2",
    });
    await seedProposal(client, {
      type: "entity.create",
      status: "approved",
      connectionId: "conn-1",
    });
    expect(await findApprovedConnectionImport("conn-1")).toBeNull();
  });

  it("the most recently reviewed approved import of THIS connection", async () => {
    const client = await freshDb();
    await seedProposal(client, {
      type: "import.graph",
      status: "approved",
      connectionId: "conn-1",
      reviewedAt: "2026-09-10T00:00:00.000Z",
    });
    const latest = await seedProposal(client, {
      type: "import.graph",
      status: "approved",
      connectionId: "conn-1",
      reviewedAt: "2026-09-12T00:00:00.000Z",
    });
    expect(await findApprovedConnectionImport("conn-1")).toEqual({
      id: latest,
    });
  });
});
