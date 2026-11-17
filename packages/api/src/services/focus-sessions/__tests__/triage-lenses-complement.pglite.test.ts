/**
 * The two triage lenses are COMPLEMENTS: every session row is in exactly one
 * of `triagePendingWhere()` (drafts awaiting a person) and
 * `notTriagePendingWhere()` (the default lens, and the needs-you lens's main
 * half). A row in neither vanishes from every list and from needs-you — which
 * is what happened to an open, unaccepted agent RECEIPT (ticket 37a6074a): the
 * pending lens excluded receipts, the default lens had no clause for them, so
 * the asks owed on a receipt never reached needs-you.
 *
 * Evaluated by Postgres (PGlite), not by reading the SQL text: the NULL
 * semantics of `#>>`, `IN` and `NOT` are the whole question. Rows are the
 * cross product of every value each clause reads, NULLs included.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, {
      schema: { focusSessions: actual.focusSessions as never },
    }),
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { db, drizzleSql, focusSessions } from "@synap/database";
import type { SQL } from "@synap/database";
import { triagePendingWhere, notTriagePendingWhere } from "../triage.js";
import { AGENT_PROPOSAL_PACKAGE_KIND } from "../session-kind.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const ORIGINS = [null, "agent", "automation", "human", "playbook"];
const STATUSES = ["active", "forming", "closed", "cancelled"];
const ACCEPTED = { triage: { acceptedAt: "2026-11-17T00:00:00.000Z" } };
const METADATAS: Array<Record<string, unknown> | null> = [
  null,
  {},
  { kind: "other" },
  { kind: AGENT_PROPOSAL_PACKAGE_KIND },
  ACCEPTED,
  { kind: AGENT_PROPOSAL_PACKAGE_KIND, ...ACCEPTED },
];

/** The open, unaccepted agent receipt the ticket lost. */
let receiptId = "";

beforeAll(async () => {
  await h.client!.exec(ddlFor(focusSessions as unknown as PgTable));
  let n = 0;
  for (const origin of ORIGINS) {
    for (const status of STATUSES) {
      for (const metadata of METADATAS) {
        const { rows } = await h.client!.query<{ id: string }>(
          `insert into focus_sessions (user_id, goal, origin, status, metadata)
           values ($1, $2, $3, $4, $5::jsonb) returning id`,
          [
            "user-1",
            `row ${n++}`,
            origin,
            status,
            metadata === null ? null : JSON.stringify(metadata),
          ]
        );
        if (
          origin === "agent" &&
          status === "active" &&
          JSON.stringify(metadata) ===
            JSON.stringify({ kind: AGENT_PROPOSAL_PACKAGE_KIND })
        ) {
          receiptId = rows[0]!.id;
        }
      }
    }
  }
}, 120_000);
afterAll(async () => h.client?.close());

const idsWhere = async (where: SQL) =>
  new Set(
    (
      await db
        .select({ id: focusSessions.id })
        .from(focusSessions)
        .where(where)
    ).map((r) => r.id)
  );

describe("triage lenses", () => {
  it("put every row in exactly one lens", async () => {
    const all = await idsWhere(drizzleSql`true` as SQL);
    expect(all.size).toBe(ORIGINS.length * STATUSES.length * METADATAS.length);
    const pending = await idsWhere(triagePendingWhere());
    const notPending = await idsWhere(notTriagePendingWhere());
    // Non-vacuity: both lenses hold rows.
    expect(pending.size).toBeGreaterThan(0);
    expect(notPending.size).toBeGreaterThan(0);
    const inNeither = [...all].filter(
      (id) => !pending.has(id) && !notPending.has(id)
    );
    const inBoth = [...all].filter((id) => pending.has(id) && notPending.has(id));
    expect(inNeither).toEqual([]);
    expect(inBoth).toEqual([]);
  });

  it("an open, unaccepted agent receipt is in the default lens (its asks reach needs-you)", async () => {
    expect(receiptId).not.toBe("");
    expect((await idsWhere(triagePendingWhere())).has(receiptId)).toBe(false);
    expect((await idsWhere(notTriagePendingWhere())).has(receiptId)).toBe(true);
  });
});
