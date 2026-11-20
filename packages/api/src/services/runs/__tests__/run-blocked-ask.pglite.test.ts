/**
 * A run nobody claimed is the person's to decide: the pod asks them with the
 * reason, and their answer starts it again, keeps waiting, or stops it
 * (`run-blocked-ask.ts`). The REAL status writes on PGlite; the ask door, the
 * re-dispatch and the cancel door are CAPTURED (their own suites cover them).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  asks: [] as Array<Record<string, unknown>>,
  redispatched: [] as Array<{ runId: string; executor: string }>,
  cancelled: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client, { schema }) };
});
vi.mock("../run-ask.js", () => ({
  raiseRunAsk: async (p: Record<string, unknown>) => {
    h.asks.push(p);
    return true;
  },
}));
vi.mock("../../agent-dispatch/redispatch-on-choice.js", () => ({
  redispatchRun: async (run: { id: string }, executor: string) => {
    h.redispatched.push({ runId: run.id, executor });
    return "queued";
  },
}));
vi.mock("../../agent-dispatch/cancel-run.js", () => ({
  cancelRun: async (p: Record<string, unknown>) => {
    h.cancelled.push(p);
    return { status: "cancelled" };
  },
}));

import type { PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { pgliteTableDdl } from "../../../__tests__/pglite-ddl.js";
import {
  RUN_BLOCKED_SLOT_LABEL,
  applyBlockedRunAnswer,
  askAboutBlockedRun,
} from "../run-blocked-ask.js";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function blockedRun(
  kind: "synap_ai" | "agent",
  status = "blocked"
): Promise<{ sessionId: string; runId: string }> {
  const sessionId = randomUUID();
  const runId = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, metadata, expected_outputs, started_at, updated_at)
     values ($1, 'u1', 'g', 'active', '{}'::jsonb, '[]'::jsonb, now(), now())`,
    [sessionId]
  );
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, executor, status, started_at, created_by, input, holder)
     values ($1, $2, $3, $4, $5, now() - interval '1 hour', 'u1', '{}'::jsonb, $6::jsonb)`,
    [
      runId,
      randomUUID(),
      sessionId,
      kind === "synap_ai" ? "is-agent" : "external-agent",
      status,
      JSON.stringify({
        kind,
        id: kind === "agent" ? "agent-1" : null,
        assignedAt: "2026-11-20T00:00:00.000Z",
        claimedAt: null,
      }),
    ]
  );
  return { sessionId, runId };
}

const runOf = async (id: string) =>
  (
    await q<{
      status: string;
      holder: { kind: string; id: string | null; assignedAt: string };
    }>(`select status, holder from playbook_runs where id = $1`, [id])
  ).rows[0]!;

beforeAll(async () => {
  for (const t of [
    schema.focusSessions,
    schema.playbookRuns,
    schema.lifecycleTransitionOutbox,
  ])
    await h.client!.exec(pgliteTableDdl(t as unknown as PgTable));
}, 120_000);

beforeEach(() => {
  h.asks.length = 0;
  h.redispatched.length = 0;
  h.cancelled.length = 0;
});

describe("a blocked run asks its person, with the reason", () => {
  it("asks on the session, the reason as the card's why", async () => {
    const { runId, sessionId } = await blockedRun("synap_ai");
    const reason =
      "Nobody started this run: Synap AI did not pick it up within 5 minutes.";
    expect(await askAboutBlockedRun(runId, reason)).toBe(true);
    expect(h.asks).toEqual([
      expect.objectContaining({
        runId,
        session: expect.objectContaining({ id: sessionId }),
        why: reason,
        slot: expect.objectContaining({ label: RUN_BLOCKED_SLOT_LABEL }),
        ask: expect.objectContaining({ prompt: "Try Synap AI again?" }),
      }),
    ]);
  });

  it("asks nothing about a run that moved on (claimed after all)", async () => {
    const { runId } = await blockedRun("synap_ai", "running");
    expect(await askAboutBlockedRun(runId, "x")).toBe(false);
    expect(h.asks).toEqual([]);
  });
});

describe("the person's answer", () => {
  it("yes on a Synap AI run: queued with a fresh window, dispatched to Synap AI again", async () => {
    const { sessionId, runId } = await blockedRun("synap_ai");
    expect(
      await applyBlockedRunAnswer({
        sessionId,
        answeredBy: "u1",
        confirmed: true,
      })
    ).toBe("restarted");
    const run = await runOf(runId);
    expect(run.status).toBe("queued");
    expect(run.holder.assignedAt > "2026-11-20T00:00:00.000Z").toBe(true);
    expect(h.redispatched).toEqual([{ runId, executor: "is-agent" }]);
  });

  it("yes on an agent's run: queued again for the same agent, nothing dispatched", async () => {
    const { sessionId, runId } = await blockedRun("agent");
    expect(
      await applyBlockedRunAnswer({
        sessionId,
        answeredBy: "u1",
        confirmed: true,
      })
    ).toBe("waiting");
    const run = await runOf(runId);
    expect(run.status).toBe("queued");
    expect(run.holder).toMatchObject({ kind: "agent", id: "agent-1" });
    expect(h.redispatched).toEqual([]);
  });

  it("no: the run is cancelled through the cancel door", async () => {
    const { sessionId, runId } = await blockedRun("agent");
    expect(
      await applyBlockedRunAnswer({
        sessionId,
        answeredBy: "u1",
        confirmed: false,
      })
    ).toBe("cancelled");
    expect(h.cancelled).toEqual([{ runId, userId: "u1" }]);
  });

  it("a run that is no longer blocked is left as it is", async () => {
    const { sessionId, runId } = await blockedRun("synap_ai", "running");
    expect(
      await applyBlockedRunAnswer({
        sessionId,
        answeredBy: "u1",
        confirmed: true,
      })
    ).toBe("nothing");
    expect((await runOf(runId)).status).toBe("running");
  });
});
