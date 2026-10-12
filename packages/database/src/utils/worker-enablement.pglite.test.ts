/**
 * Stage worker reads against real SQL (PGlite). Each row names what it rules
 * out:
 *  - backlog: another enablement's pending proposal counted; a decided one
 *    counted; the propose-mode `playbook/run` half (no session) dropped;
 *  - in flight: a target with a result still "in flight"; a closed session's
 *    target excluded forever; an INPUT edge (role "input") taken for a target;
 *  - ceiling: see its describe block.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
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
import { automationRuns, automationStepRuns } from "../schema/automations.js";
import { events } from "../schema/events.js";
import {
  countWorkerIrreversibleSendsToday,
  countWorkerIrreversibleSentToday,
  countWorkerPendingApprovals,
  listHeldWorkerRuns,
  listWorkerTargetsInFlight,
  workerAutomationOfSession,
  WORKER_SEND_EVENT_SOURCE,
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
  for (const t of [
    proposals,
    focusSessions,
    links,
    automationRuns,
    automationStepRuns,
    events,
  ])
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

/**
 * The ceiling (FB2 item 3). The SENT half reads the external-dispatch audit
 * rows of the enablement's sessions; the PENDING half reads proposals still
 * waiting. Rows rule out: an approved proposal counted twice (its send row
 * already counts it); yesterday's PENDING send dropped (approving it sends
 * today); a read-method provider call, a failed send, yesterday's send,
 * another session's send or a non-dispatch event counted as a send.
 */
describe("countWorkerIrreversibleSendsToday / SentToday", () => {
  async function sent(e: {
    sessionId: string | null;
    type?: string;
    status?: string;
    method?: string;
    source?: string;
    at?: string;
  }) {
    await client.query(
      `insert into events (id, timestamp, type, subject_id, subject_type, data, source, session_id)
       values ($1, $2, $3, 'c', 'x', $4::jsonb, $5, $6)`,
      [
        randomUUID(),
        e.at ?? "2026-10-12T10:00:00.000Z",
        e.type ?? "gmail.send.completed",
        JSON.stringify({
          status: e.status ?? "sent",
          ...(e.method ? { method: e.method } : {}),
        }),
        e.source ?? WORKER_SEND_EVENT_SOURCE,
        e.sessionId,
      ]
    );
  }

  it("sent today by this enablement's sessions + its sends still pending", async () => {
    const mine = await session(A);
    const theirs = await session(B);
    const now = new Date("2026-10-12T15:00:00.000Z");
    // sent half — 2 count
    await sent({ sessionId: mine });
    await sent({
      sessionId: mine,
      type: "nango.action.completed",
      method: "post",
    });
    await sent({
      sessionId: mine,
      type: "nango.action.completed",
      method: "GET",
    });
    await sent({ sessionId: mine, status: "failed" });
    await sent({ sessionId: mine, at: "2026-10-11T23:00:00.000Z" });
    await sent({ sessionId: theirs });
    await sent({ sessionId: null });
    await sent({ sessionId: mine, source: "api" });
    // pending half — 2 count
    await proposal({ sessionId: mine, type: "messaging.external.send" });
    await proposal({
      sessionId: mine,
      type: "provider.action",
      createdAt: "2026-10-11T08:00:00.000Z",
    });
    await proposal({
      sessionId: mine,
      type: "provider.action",
      status: "approved",
    });
    await proposal({
      sessionId: mine,
      type: "messaging.external.send",
      status: "rejected",
    });
    await proposal({ sessionId: mine, type: "update" });
    await proposal({ sessionId: theirs, type: "messaging.external.send" });

    expect(await countWorkerIrreversibleSentToday(A, now)).toBe(2);
    expect(await countWorkerIrreversibleSendsToday(A, now)).toBe(4);
    expect(await countWorkerIrreversibleSendsToday(B, now)).toBe(2);
  });

  it("names the worker of a session, and nothing for a plain or bogus one", async () => {
    const mine = await session(A);
    const plain = randomUUID();
    await client.query(
      `insert into focus_sessions (id, status, metadata) values ($1, 'active', '{}'::jsonb)`,
      [plain]
    );
    expect(await workerAutomationOfSession(mine)).toBe(A);
    expect(await workerAutomationOfSession(plain)).toBeNull();
    expect(await workerAutomationOfSession("not-a-uuid")).toBeNull();
  });
});

/**
 * arch F12: a backlog skip HOLDS the fire. Rows rule out: a plain skip (no
 * `held` mark) taken for a hold; a hold superseded by a LATER run of the same
 * automation for the same subject (its release, or a fresh fire) offered
 * again; another enablement's hold; an EARLIER run of the subject hiding a
 * later hold (the supersede check must look forward only).
 */
describe("listHeldWorkerRuns", () => {
  async function run(o: {
    automationId: string;
    subject: string | null;
    at: string;
    output?: Record<string, unknown>;
  }) {
    const id = randomUUID();
    await client.query(
      `insert into automation_runs (id, automation_id, subject_entity_id, trigger_payload, status, started_at)
       values ($1, $2, $3, $4::jsonb, 'completed', $5)`,
      [id, o.automationId, o.subject, JSON.stringify({ eventType: "x" }), o.at]
    );
    if (o.output) {
      await client.query(
        `insert into automation_step_runs (id, run_id, node_id, status, output)
         values ($1, $2, 'run', 'completed', $3::jsonb)`,
        [randomUUID(), id, JSON.stringify(o.output)]
      );
    }
    return id;
  }
  const HELD = {
    status: "skipped",
    reason: "approvals_backlog",
    held: true,
    producerAgentUserId: "agent-1",
  };

  it("held fires nothing superseded, oldest first, with their producer", async () => {
    const t1 = randomUUID();
    const t2 = randomUUID();
    const t3 = randomUUID();
    const t4 = randomUUID();
    await run({ automationId: A, subject: t1, at: "2026-10-12T01:00:00Z" });
    const h1 = await run({
      automationId: A,
      subject: t1,
      at: "2026-10-12T02:00:00Z",
      output: HELD,
    });
    const h2 = await run({
      automationId: A,
      subject: t2,
      at: "2026-10-12T01:30:00Z",
      output: { ...HELD, producerAgentUserId: undefined },
    });
    // superseded: a later run of the same subject exists
    await run({
      automationId: A,
      subject: t3,
      at: "2026-10-12T01:00:00Z",
      output: HELD,
    });
    await run({ automationId: A, subject: t3, at: "2026-10-12T03:00:00Z" });
    // a plain skip is not a hold
    await run({
      automationId: A,
      subject: t4,
      at: "2026-10-12T01:00:00Z",
      output: { status: "skipped", reason: "approvals_backlog" },
    });
    // another enablement's hold
    await run({
      automationId: B,
      subject: t4,
      at: "2026-10-12T01:00:00Z",
      output: HELD,
    });
    const held = await listHeldWorkerRuns(A, 10);
    expect(held.map((h) => h.runId)).toEqual([h2, h1]);
    expect(held[1]).toMatchObject({
      subjectEntityId: t1,
      producerAgentUserId: "agent-1",
      triggerPayload: { eventType: "x" },
    });
    expect(held[0]!.producerAgentUserId).toBeNull();
    expect(await listHeldWorkerRuns(A, 1)).toHaveLength(1);
    expect(await listHeldWorkerRuns(A, 0)).toEqual([]);
  });
});
