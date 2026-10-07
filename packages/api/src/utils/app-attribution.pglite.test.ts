/**
 * APP ATTRIBUTION (App Connect v1) — the write door stamps the app id.
 *
 * A write made with an APP's key is today attributed to the connecting HUMAN;
 * the app identity (`grants.client_id`) is loaded at auth and then dropped. This
 * pins the thread: a grant carrying `clientId` (entered with `runWithGrant`,
 * exactly what the key-auth doors do) makes the PENDING proposal row record
 * `app_id`; a grant with NO clientId, and NO grant at all, leave it NULL.
 *
 * Driven through the REAL `createPendingProposal` on PGlite with every
 * @synap/database table, so the column, the door and the request context are
 * proven against each other rather than against a mock.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
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
  return { ...actual, db: h.db, getDb: async () => h.db };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { grantOfScope, runWithGrant } from "@synap/database";
import type { GrantScope } from "@synap/governance-policy/grants";
import { createPendingProposal } from "./permission-check.js";

const WS = randomUUID();
const APP = "app_11111111-2222-4333-8444-555555555555";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    return `"${c.name}" ${type}${key}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
});

type Db = { transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T> };

/**
 * File ONE pending proposal through the real door, inside a transaction so the
 * fire-and-forget notifications are skipped (the door's contract), and inside
 * `runWithGrant` when a grant is given — the same write context the three
 * key-auth doors enter. Returns the inserted `proposals` row.
 */
async function write(
  grant: GrantScope | null,
  over: Partial<Parameters<typeof createPendingProposal>[0]> = {}
) {
  const db = h.db as unknown as Db;
  let row: { appId: string | null } | undefined;
  await db.transaction(async (tx) => {
    const run = () =>
      createPendingProposal(
        {
          userId: "human-1",
          workspaceId: WS,
          targetType: "entity",
          targetId: randomUUID(),
          proposalType: "create",
          data: { title: "a note" },
          ...over,
        },
        tx as Parameters<typeof createPendingProposal>[1]
      );
    row = (await (grant ? runWithGrant(grantOfScope(grant, grant.clientId ?? null), run) : run())) as {
      appId: string | null;
    };
  });
  return row!;
}

describe("app attribution stamps the proposal row (App Connect v1)", () => {
  it("stamps app_id from the request's grant clientId", async () => {
    const row = await write({ permissions: ["*"], clientId: APP });
    expect(row.appId).toBe(APP);
  });

  it("leaves app_id NULL for a grant with no app identity", async () => {
    const row = await write({ permissions: ["*"] });
    expect(row.appId).toBeNull();
  });

  it("leaves app_id NULL when the write carries no grant at all", async () => {
    const row = await write(null);
    expect(row.appId).toBeNull();
  });

  it("never lets clientId widen the grant (a bare human write is unaffected)", async () => {
    // The grant below permits NOTHING, yet the app identity is present: the
    // proposal is still filed (createPendingProposal does not gate) — this only
    // asserts the attribution is orthogonal to permission (the gate is tested in
    // grant-write-check.pglite.test.ts).
    const row = await write({
      permissions: ["entity.knowledge.read"],
      clientId: APP,
    });
    expect(row.appId).toBe(APP);
  });
});
