/**
 * A session waiting on its pending plan/deploy GATE waits on the person — the
 * third arm of both waits-on-the-person predicates, through the REAL rendered
 * SQL on PGlite (Resolve-XP W3).
 *
 * Each row names what it rules out:
 *   - a pending `dev.plan_approval` read as idle (the defect: the reapers
 *     failed a run whose agent stopped for its gate);
 *   - a DECIDED gate still holding the session;
 *   - any pending proposal counting (only the awaited gate types wait);
 *   - a gate filed in ANOTHER session counting for this one;
 *   - a closed session's leftover gate parking a run forever (by id only:
 *     the row form leaves status to its caller, like its other arms).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql as drizzleSql, type SQL } from "drizzle-orm";
import {
  focusSessionWaitsOnPersonWhere,
  sessionWaitsOnPersonWhere,
} from "./open-room-question.js";

let client: PGlite;
const dialect = new PgDialect();

async function run(sql: SQL): Promise<Array<Record<string, unknown>>> {
  const q = dialect.sqlToQuery(sql);
  return (await client.query<Record<string, unknown>>(q.sql, q.params)).rows;
}

async function session(p: {
  status?: string;
  gates?: Array<{ type: string; status: string; elsewhere?: boolean }>;
}): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into focus_sessions (id, status, expected_outputs, channel_id) values ($1, $2, '[]'::jsonb, $3)`,
    [id, p.status ?? "active", randomUUID()]
  );
  for (const g of p.gates ?? []) {
    await client.query(
      `insert into proposals (id, session_id, status, proposal_type) values ($1, $2, $3, $4)`,
      [randomUUID(), g.elsewhere ? randomUUID() : id, g.status, g.type]
    );
  }
  return id;
}

async function waits(id: string): Promise<{ byId: boolean; byRow: boolean }> {
  const [a] = await run(
    drizzleSql`select ${sessionWaitsOnPersonWhere(drizzleSql`${id}::uuid`)} as w`
  );
  const rows = await run(
    drizzleSql`select id from focus_sessions where id = ${id}::uuid and ${focusSessionWaitsOnPersonWhere()}`
  );
  return { byId: a!.w === true, byRow: rows.length === 1 };
}

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    create table focus_sessions (id uuid primary key, status text, expected_outputs jsonb, channel_id uuid);
    create table messages (id uuid primary key, channel_id uuid, author_type text, deleted_at timestamptz, metadata jsonb);
    create table proposals (id uuid primary key, session_id uuid, status text, proposal_type text);
  `);
});
afterAll(async () => {
  await client.close();
});

describe("waits on the person: a pending awaited gate", () => {
  it("a pending plan or deploy approval in the session waits", async () => {
    for (const type of ["dev.plan_approval", "dev.deploy_approval"]) {
      const id = await session({ gates: [{ type, status: "pending" }] });
      expect(await waits(id), type).toEqual({ byId: true, byRow: true });
    }
  });

  it("a decided gate does not", async () => {
    const id = await session({
      gates: [{ type: "dev.plan_approval", status: "approved" }],
    });
    expect(await waits(id)).toEqual({ byId: false, byRow: false });
  });

  it("another pending proposal type does not", async () => {
    const id = await session({
      gates: [{ type: "update", status: "pending" }],
    });
    expect(await waits(id)).toEqual({ byId: false, byRow: false });
  });

  it("a gate filed in another session does not", async () => {
    const id = await session({
      gates: [{ type: "dev.plan_approval", status: "pending", elsewhere: true }],
    });
    expect(await waits(id)).toEqual({ byId: false, byRow: false });
  });

  it("a closed session's gate parks nothing (by id)", async () => {
    const id = await session({
      status: "completed",
      gates: [{ type: "dev.plan_approval", status: "pending" }],
    });
    expect((await waits(id)).byId).toBe(false);
  });
});
