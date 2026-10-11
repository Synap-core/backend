/**
 * Stage worker reads against real SQL (PGlite). Each row names what it rules
 * out:
 *  - backlog: another enablement's pending proposal counted; a decided one
 *    counted; the propose-mode `playbook/run` half (no session) dropped;
 *  - in flight: a target with a result still "in flight"; a closed session's
 *    target excluded forever; an INPUT edge (role "input") taken for a target;
 *  - ceiling: yesterday's send, a rejected send, a reversible proposal type
 *    counted toward today's irreversible ceiling.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });
const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../client-pg.js", () => ({
  get db() {
    return holder.db;
  },
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { proposals } from "../schema/proposals.js";
import { focusSessions } from "../schema/focus-sessions.js";
import { links } from "../schema/links.js";
import {
  countWorkerIrreversibleSendsToday,
  countWorkerPendingApprovals,
  listWorkerTargetsInFlight,
} from "./worker-enablement.js";

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
const A = randomUUID(); // this enablement's automation
const B = randomUUID(); // another enablement

beforeEach(async () => {
  client = new PGlite();
  for (const t of [proposals, focusSessions, links])
    await client.exec(ddlFor(t as unknown as PgTable));
  holder.db = drizzle(client);
});

async function session(automationId: string, status = "active") {
  const id = randomUUID();
  await client.query(
    `insert into focus_sessions (id, status, metadata) values ($1, $2, $3::jsonb)`,
    [id, status, JSON.stringify({ automationId })]
  );
  return id;
}
async function proposal(p: {
  sessionId?: string | null;
  status?: string;
  type?: string;
  data?: Record<string, unknown>;
  createdAt?: string;
}) {
  await client.query(
    `insert into proposals (id, status, proposal_type, target_type, session_id, data, created_at)
     values ($1, $2, $3, 'x', $4, $5::jsonb, $6)`,
    [
      randomUUID(),
      p.status ?? "pending",
      p.type ?? "update",
      p.sessionId ?? null,
      JSON.stringify(p.data ?? {}),
      p.createdAt ?? new Date().toISOString(),
    ]
  );
}
async function target(sessionId: string, meta: Record<string, unknown>) {
  const entityId = randomUUID();
  await client.query(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata)
     values ($1, 'session', $2, 'entity', $3, 'targets', $4::jsonb)`,
    [randomUUID(), sessionId, entityId, JSON.stringify(meta)]
  );
  return entityId;
}

describe("countWorkerPendingApprovals", () => {
  it("counts this enablement's pending proposals: in its sessions AND its propose-mode run proposals", async () => {
    const mine = await session(A);
    const theirs = await session(B);
    await proposal({ sessionId: mine });
    await proposal({ sessionId: mine });
    await proposal({ sessionId: mine, status: "approved" });
    await proposal({ sessionId: theirs });
    await proposal({ type: "playbook/run", data: { automationId: A } });
    await proposal({ type: "playbook/run", data: { automationId: B } });
    expect(await countWorkerPendingApprovals(A)).toBe(3);
  });
});

describe("listWorkerTargetsInFlight", () => {
  it("only unresolved worker targets of this enablement's OPEN sessions", async () => {
    const open = await session(A);
    const closed = await session(A, "closed");
    const other = await session(B);
    const working = await target(open, { role: "worker_target" });
    await target(open, { role: "worker_target", result: "done" });
    await target(open, { role: "input", via: "x" });
    await target(closed, { role: "worker_target" });
    await target(other, { role: "worker_target" });
    expect(await listWorkerTargetsInFlight(A)).toEqual([working]);
  });
});

describe("countWorkerIrreversibleSendsToday", () => {
  it("today's irreversible sends of this enablement's sessions that sent or may still send", async () => {
    const mine = await session(A);
    const now = new Date("2026-10-12T15:00:00.000Z");
    await proposal({
      sessionId: mine,
      type: "messaging.external.send",
      createdAt: "2026-10-12T01:00:00.000Z",
    });
    await proposal({
      sessionId: mine,
      type: "provider.action",
      status: "approved",
      createdAt: "2026-10-12T02:00:00.000Z",
    });
    await proposal({
      sessionId: mine,
      type: "messaging.external.send",
      status: "rejected",
      createdAt: "2026-10-12T03:00:00.000Z",
    });
    await proposal({
      sessionId: mine,
      type: "messaging.external.send",
      createdAt: "2026-10-11T23:00:00.000Z",
    });
    await proposal({
      sessionId: mine,
      type: "update",
      createdAt: "2026-10-12T04:00:00.000Z",
    });
    expect(await countWorkerIrreversibleSendsToday(A, now)).toBe(2);
    expect(await countWorkerIrreversibleSendsToday(B, now)).toBe(0);
  });
});
