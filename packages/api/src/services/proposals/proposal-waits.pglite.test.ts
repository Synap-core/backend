/**
 * `resolveProposalWaits` on PGlite — which proposals an agent waits on, and why
 * Real SQL for both batched reads (sessions through the ONE
 * session read rule, parked runs).
 *
 * Each row names the rule it rules out:
 *   - gate: a pending dev approval waits even with NO session (rules out
 *     "waits needs a session") and wins over a parked run in its session
 *     (the reason order);
 *   - owed_slot: a proposal claiming an OPEN session's unmet slot waits; the
 *     same claim on a DELIVERED slot, a CLOSED session, or a session the
 *     reader may not open does not (rules out "any expectedLabel waits");
 *   - parked_run: a proposal with no claim in a session whose run is parked
 *     `waiting_on_you` waits (rules out "only slots and gates");
 *   - a DECIDED proposal never waits, whatever it claims.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions, playbookRuns } from "@synap/database";
import { resolveProposalWaits } from "./proposal-waits.js";

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
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const USER = "user-1";
const SLOT = "Pricing table";
const OPEN = randomUUID();
const DELIVERED = randomUUID();
const CLOSED = randomUUID();
const FOREIGN = randomUUID();
const PARKED = randomUUID();

async function session(
  id: string,
  o: { status?: string; owner?: string; slotStatus?: string }
) {
  await q(
    `insert into focus_sessions (id, user_id, status, expected_outputs) values ($1, $2, $3, $4::jsonb)`,
    [
      id,
      o.owner ?? USER,
      o.status ?? "active",
      JSON.stringify([
        { kind: "document", label: SLOT, status: o.slotStatus ?? "pending" },
      ]),
    ]
  );
}

const row = (
  id: string,
  o: {
    sessionId?: string | null;
    proposalType?: string;
    status?: string;
    claims?: boolean;
  }
) => ({
  id,
  proposalType: o.proposalType ?? "update",
  status: o.status ?? "pending",
  sessionId: o.sessionId ?? null,
  data: o.claims ? { expectedLabel: SLOT } : {},
});

beforeAll(async () => {
  await h.client!.exec(ddlFor(focusSessions as unknown as PgTable));
  await h.client!.exec(ddlFor(playbookRuns as unknown as PgTable));
  await session(OPEN, {});
  await session(DELIVERED, { slotStatus: "done" });
  await session(CLOSED, { status: "completed" });
  await session(FOREIGN, { owner: "someone-else" });
  await session(PARKED, {});
  await q(
    `insert into playbook_runs (id, session_id, status) values ($1, $2, 'waiting_on_you')`,
    [randomUUID(), PARKED]
  );
}, 120_000);

describe("resolveProposalWaits — gate, owed slot, parked run", () => {
  it("names the one reason each proposal waits for, or none", async () => {
    const rows = [
      row("gate-no-session", { proposalType: "dev.plan_approval" }),
      row("gate-in-parked", {
        proposalType: "dev.deploy_approval",
        sessionId: PARKED,
      }),
      row("owed", { sessionId: OPEN, claims: true }),
      row("delivered", { sessionId: DELIVERED, claims: true }),
      row("closed", { sessionId: CLOSED, claims: true }),
      row("foreign", { sessionId: FOREIGN, claims: true }),
      row("parked", { sessionId: PARKED }),
      row("plain", { sessionId: OPEN }),
      row("decided", { sessionId: OPEN, claims: true, status: "approved" }),
    ];
    const waits = await resolveProposalWaits(rows, { userId: USER });
    expect(Object.fromEntries(waits)).toEqual({
      "gate-no-session": { waits: true, reason: "gate" },
      "gate-in-parked": { waits: true, reason: "gate" },
      owed: { waits: true, reason: "owed_slot" },
      delivered: { waits: false },
      closed: { waits: false },
      foreign: { waits: false },
      parked: { waits: true, reason: "parked_run" },
      plain: { waits: false },
      decided: { waits: false },
    });
  });
});
