/**
 * D6 — a write attributed to a STALE session revives it (session `active`,
 * its stale run `running`), through the REAL UPDATEs on PGlite.
 *
 * Every positive case has a discriminating twin: a session that is not stale,
 * a handle naming someone else's session, a lifecycle close. A revive that
 * fired on everything — or on nothing — fails one half.
 *
 * NOT covered here: the call sites (`checkPermissionOrPropose` and the Hub
 * capture-back route) — this pins the door's behaviour, not that every write
 * reaches it.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
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
import { focusSessions, playbookRuns } from "@synap/database/schema";
import {
  reviveStaleSession,
  reviveSessionForWrite,
  sessionToReviveForWrite,
} from "../revive-stale-session.js";

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

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const statusOf = async (table: string, id: string) =>
  (
    await q<{ status: string }>(`select status from ${table} where id = $1`, [
      id,
    ])
  ).rows[0]!.status;

async function sessionWithRun(opts: {
  sessionStatus: string;
  runStatus: string;
  userId?: string;
}): Promise<{ sess: string; run: string }> {
  const sess = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, metadata, started_at, updated_at)
     values ($1, $2, 'g', $3, '{}'::jsonb, now(), now() - interval '30 hours')`,
    [sess, opts.userId ?? "u1", opts.sessionStatus]
  );
  const run = randomUUID();
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, executor, status, started_at, created_by, input)
     values ($1, $2, $3, 'external-agent', $4, now() - interval '30 hours', 'u1', '{}'::jsonb)`,
    [run, randomUUID(), sess, opts.runStatus]
  );
  return { sess, run };
}

beforeAll(async () => {
  for (const t of [focusSessions, playbookRuns])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from focus_sessions; delete from playbook_runs;"
  );
});

describe("reviveStaleSession", () => {
  it("a stale session goes active (updatedAt bumped) and its stale run goes running", async () => {
    const { sess, run } = await sessionWithRun({
      sessionStatus: "stale",
      runStatus: "stale",
    });
    const result = await reviveStaleSession(sess, "u1");
    expect(result).toEqual({ sessionRevived: true, runsRevived: 1 });
    expect(await statusOf("focus_sessions", sess)).toBe("active");
    expect(await statusOf("playbook_runs", run)).toBe("running");
    const { rows } = await q<{ fresh: boolean }>(
      `select updated_at > now() - interval '1 minute' as fresh from focus_sessions where id = $1`,
      [sess]
    );
    expect(rows[0]!.fresh).toBe(true);
  });

  it("a session that is NOT stale is untouched (and so is its run)", async () => {
    const { sess, run } = await sessionWithRun({
      sessionStatus: "active",
      runStatus: "stale",
    });
    expect(await reviveStaleSession(sess, "u1")).toEqual({
      sessionRevived: false,
      runsRevived: 0,
    });
    expect(await statusOf("playbook_runs", run)).toBe("stale");
  });

  it("someone else's stale session is never revived by my write", async () => {
    const { sess, run } = await sessionWithRun({
      sessionStatus: "stale",
      runStatus: "stale",
      userId: "u-other",
    });
    expect((await reviveStaleSession(sess, "u1")).sessionRevived).toBe(false);
    expect(await statusOf("focus_sessions", sess)).toBe("stale");
    expect(await statusOf("playbook_runs", run)).toBe("stale");
  });

  it("only STALE runs come back — a failed run on the same session stays failed", async () => {
    const { sess, run } = await sessionWithRun({
      sessionStatus: "stale",
      runStatus: "failed",
    });
    expect(await reviveStaleSession(sess, "u1")).toEqual({
      sessionRevived: true,
      runsRevived: 0,
    });
    expect(await statusOf("playbook_runs", run)).toBe("failed");
  });
});

describe("reviveSessionForWrite — the gate's hook", () => {
  it("a write carrying the session handle revives it", async () => {
    const { sess, run } = await sessionWithRun({
      sessionStatus: "stale",
      runStatus: "stale",
    });
    await reviveSessionForWrite({
      userId: "u1",
      sessionId: sess,
      subjectType: "entity",
      data: { title: "x" },
    });
    expect(await statusOf("focus_sessions", sess)).toBe("active");
    expect(await statusOf("playbook_runs", run)).toBe("running");
  });

  it("an update ABOUT the session (no ctx handle) revives it; closing it does not", async () => {
    const a = await sessionWithRun({
      sessionStatus: "stale",
      runStatus: "stale",
    });
    await reviveSessionForWrite({
      userId: "u1",
      subjectType: "focus_session",
      data: { id: a.sess, progress: 90 },
    });
    expect(await statusOf("focus_sessions", a.sess)).toBe("active");

    const b = await sessionWithRun({
      sessionStatus: "stale",
      runStatus: "stale",
    });
    await reviveSessionForWrite({
      userId: "u1",
      subjectType: "focus_session",
      data: { id: b.sess, status: "closed" },
    });
    expect(await statusOf("focus_sessions", b.sess)).toBe("stale");
  });
});

describe("sessionToReviveForWrite", () => {
  const id = randomUUID();
  it("prefers the ctx handle, falls back to the session subject, drops malformed ids", () => {
    expect(
      sessionToReviveForWrite({ sessionId: id, subjectType: "entity" })
    ).toBe(id);
    expect(
      sessionToReviveForWrite({ subjectType: "focus_session", data: { id } })
    ).toBe(id);
    expect(
      sessionToReviveForWrite({ subjectType: "entity", data: { id } })
    ).toBeUndefined();
    expect(
      sessionToReviveForWrite({
        sessionId: "not-a-uuid",
        subjectType: "entity",
      })
    ).toBeUndefined();
  });
});
