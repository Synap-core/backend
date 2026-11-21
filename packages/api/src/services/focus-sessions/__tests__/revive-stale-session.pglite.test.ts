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
import {
  focusSessions,
  lifecycleTransitionOutbox,
  playbookRuns,
} from "@synap/database/schema";
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
  holder?: { kind: string; id: string | null };
}): Promise<{ sess: string; run: string }> {
  const sess = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, metadata, started_at, updated_at)
     values ($1, $2, 'g', $3, '{}'::jsonb, now(), now() - interval '30 hours')`,
    [sess, opts.userId ?? "u1", opts.sessionStatus]
  );
  const run = randomUUID();
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, executor, status, started_at, created_by, input, holder)
     values ($1, $2, $3, 'external-agent', $4, now() - interval '30 hours', 'u1', '{}'::jsonb, $5::jsonb)`,
    [
      run,
      randomUUID(),
      sess,
      opts.runStatus,
      opts.holder
        ? JSON.stringify({
            ...opts.holder,
            assignedAt: new Date(Date.now() - 3_600_000).toISOString(),
            claimedAt: null,
          })
        : null,
    ]
  );
  return { sess, run };
}

beforeAll(async () => {
  for (const t of [focusSessions, lifecycleTransitionOutbox, playbookRuns])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from focus_sessions; delete from playbook_runs; delete from lifecycle_transition_outbox;"
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

const holderOf = async (run: string) =>
  (
    await q<{
      holder: { kind: string; id: string | null; claimedAt: string | null };
    }>(`select holder from playbook_runs where id = $1`, [run])
  ).rows[0]!.holder;

describe("an agent's write is its claim on the run handed to it", () => {
  it("its queued or blocked run goes running, claimed by it", async () => {
    for (const runStatus of ["queued", "blocked"]) {
      const { sess, run } = await sessionWithRun({
        sessionStatus: "active",
        runStatus,
        holder: { kind: "agent", id: "agent-1" },
      });
      await reviveSessionForWrite({
        userId: "u1",
        agentUserId: "agent-1",
        sessionId: sess,
        subjectType: "entity",
      });
      expect(await statusOf("playbook_runs", run)).toBe("running");
      const holder = await holderOf(run);
      expect(holder).toMatchObject({ kind: "agent", id: "agent-1" });
      expect(holder.claimedAt).not.toBeNull();
    }
  });

  it("a run handed to an agent not named yet is not claimed by whichever agent writes first", async () => {
    const { sess, run } = await sessionWithRun({
      sessionStatus: "active",
      runStatus: "queued",
      holder: { kind: "agent", id: null },
    });
    await reviveSessionForWrite({
      userId: "u1",
      agentUserId: "agent-2",
      sessionId: sess,
      subjectType: "entity",
    });
    expect(await statusOf("playbook_runs", run)).toBe("queued");
  });

  it("another agent's write, a person's write, or a Synap AI run: no claim", async () => {
    const other = await sessionWithRun({
      sessionStatus: "active",
      runStatus: "queued",
      holder: { kind: "agent", id: "agent-1" },
    });
    await reviveSessionForWrite({
      userId: "u1",
      agentUserId: "agent-9",
      sessionId: other.sess,
      subjectType: "entity",
    });
    expect(await statusOf("playbook_runs", other.run)).toBe("queued");

    await reviveSessionForWrite({
      userId: "u1",
      sessionId: other.sess,
      subjectType: "entity",
    });
    expect(await statusOf("playbook_runs", other.run)).toBe("queued");

    const synapAi = await sessionWithRun({
      sessionStatus: "active",
      runStatus: "queued",
      holder: { kind: "synap_ai", id: null },
    });
    await reviveSessionForWrite({
      userId: "u1",
      agentUserId: "agent-1",
      sessionId: synapAi.sess,
      subjectType: "entity",
    });
    expect(await statusOf("playbook_runs", synapAi.run)).toBe("queued");
  });
});

describe("an approved hand-off revives the run instead of landing on a dead one", () => {
  it("a blocked or stale run waits again for the approved agent, its session active; a verdict stands", async () => {
    const { requeueRunForHandOff } = await import("../agent-hand-off.js");
    for (const [sessionStatus, runStatus] of [
      ["active", "blocked"],
      ["stale", "stale"],
      ["active", "queued"],
    ] as const) {
      const { sess, run } = await sessionWithRun({
        sessionStatus,
        runStatus,
        holder: { kind: "agent", id: "agent-1" },
      });
      expect(
        await requeueRunForHandOff({
          sessionId: sess,
          ownerId: "u1",
          agentId: "agent-2",
          proposalId: randomUUID(),
        })
      ).toBe(1);
      expect(await statusOf("playbook_runs", run)).toBe("queued");
      const holder = await holderOf(run);
      expect(holder).toMatchObject({ kind: "agent", id: "agent-2" });
      expect(holder.claimedAt).toBeNull();
      expect(await statusOf("focus_sessions", sess)).toBe("active");
    }
    const ended = await sessionWithRun({
      sessionStatus: "active",
      runStatus: "failed",
    });
    expect(
      await requeueRunForHandOff({
        sessionId: ended.sess,
        ownerId: "u1",
        agentId: "agent-2",
        proposalId: randomUUID(),
      })
    ).toBe(0);
    expect(await statusOf("playbook_runs", ended.run)).toBe("failed");
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
