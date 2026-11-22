/**
 * A run nobody claimed is the person's to decide: the pod asks them with the
 * reason, one card per automation, and their answer starts it again, keeps
 * waiting, hands it to another runner, or stops it (`run-blocked-ask.ts`). The REAL status writes on
 * PGlite; the ask door, the re-dispatch and the cancel door are CAPTURED
 * (their own suites cover them).
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
vi.mock("../../agent-dispatch/agents-for-handoff.js", () => ({
  readAgentsForHandoff: async () => ({
    agents: [
      // The run's own agent is the "same runner" option, not another.
      {
        agentUserId: "agent-1",
        name: "Claude Code",
        canTakeYourWork: true,
        reach: "dispatch",
        wake: { state: "awake" },
      },
      {
        agentUserId: "agent-2",
        name: "Codex",
        canTakeYourWork: true,
        reach: "dispatch",
        wake: { state: "awake" },
      },
      {
        agentUserId: "agent-3",
        name: "Asleep",
        canTakeYourWork: true,
        reach: "dispatch",
        wake: { state: "asleep" },
      },
      {
        agentUserId: "agent-4",
        name: "Pull only",
        canTakeYourWork: true,
        reach: "pull",
        wake: { state: "awake" },
      },
    ],
    computers: [],
  }),
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
  status = "blocked",
  opts: {
    automationId?: string;
    carded?: boolean;
    playbookExecutor?: string;
  } = {}
): Promise<{ sessionId: string; runId: string }> {
  const sessionId = randomUUID();
  const runId = randomUUID();
  const playbookId = randomUUID();
  await q(
    `insert into playbooks (id, created_by, name, goal_template, executor, status, version, created_at, updated_at)
     values ($1, 'u1', 'Enrich', 'Enrich it', $2, 'active', 1, now(), now())`,
    [playbookId, opts.playbookExecutor ?? "is-agent"]
  );
  await q(
    `insert into focus_sessions (id, user_id, goal, status, metadata, expected_outputs, started_at, updated_at)
     values ($1, 'u1', 'g', 'active', $2::jsonb, $3::jsonb, now(), now())`,
    [
      sessionId,
      JSON.stringify(
        opts.automationId ? { automationId: opts.automationId } : {}
      ),
      JSON.stringify(
        opts.carded
          ? [
              {
                label: RUN_BLOCKED_SLOT_LABEL,
                owner: "human",
                status: "blocked",
              },
            ]
          : []
      ),
    ]
  );
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, executor, status, started_at, created_by, input, holder)
     values ($1, $2, $3, $4, $5, now() - interval '1 hour', 'u1', '{}'::jsonb, $6::jsonb)`,
    [
      runId,
      playbookId,
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
      executor: string;
      input: Record<string, unknown>;
      holder: { kind: string; id: string | null; assignedAt: string };
    }>(
      `select status, executor, input, holder from playbook_runs where id = $1`,
      [id]
    )
  ).rows[0]!;

const values = (ask: unknown) =>
  ((ask as { options?: Array<{ value: string }> }).options ?? []).map(
    (o) => o.value
  );

beforeAll(async () => {
  for (const t of [
    schema.playbooks,
    schema.focusSessions,
    schema.playbookRuns,
    schema.lifecycleTransitionOutbox,
    schema.automationRuns,
  ])
    await h.client!.exec(pgliteTableDdl(t as unknown as PgTable));
  await h.client!.exec(
    "create schema pgboss; create table pgboss.job (name text, state text, data jsonb);"
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from focus_sessions; delete from playbook_runs; delete from playbooks; delete from pgboss.job;"
  );
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
        ask: expect.objectContaining({ mode: "choose" }),
      }),
    ]);
    // The same runner first, then the awake dispatch agents, then stop.
    expect(values(h.asks[0]!.ask)).toEqual([
      "same",
      "agent-1",
      "agent-2",
      "stop",
    ]);
  });

  it("an agent's run offers Synap AI when its playbook allows it, never its own agent twice", async () => {
    const { runId } = await blockedRun("agent");
    await askAboutBlockedRun(runId, "x");
    expect(values(h.asks[0]!.ask)).toEqual([
      "same",
      "synap_ai",
      "agent-2",
      "stop",
    ]);
  });

  it("an agent-only playbook never offers Synap AI", async () => {
    const { runId } = await blockedRun("agent", "blocked", {
      playbookExecutor: "external-agent",
    });
    await askAboutBlockedRun(runId, "x");
    expect(values(h.asks[0]!.ask)).toEqual(["same", "agent-2", "stop"]);
  });

  it("one card per automation: a second blocked run of it asks nothing", async () => {
    const automationId = randomUUID();
    await blockedRun("synap_ai", "blocked", { automationId, carded: true });
    const second = await blockedRun("synap_ai", "blocked", { automationId });
    expect(await askAboutBlockedRun(second.runId, "x")).toBe(false);
    const other = await blockedRun("synap_ai", "blocked", {
      automationId: randomUUID(),
    });
    expect(await askAboutBlockedRun(other.runId, "x")).toBe(true);
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
        choice: { kind: "same" },
      })
    ).toEqual(["restarted"]);
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
        choice: { kind: "same" },
      })
    ).toEqual(["waiting"]);
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
        choice: { kind: "stop" },
      })
    ).toEqual(["cancelled"]);
    expect(h.cancelled).toEqual([{ runId, userId: "u1" }]);
  });

  it("another agent picked: queued for it and dispatched to it", async () => {
    const { sessionId, runId } = await blockedRun("synap_ai");
    expect(
      await applyBlockedRunAnswer({
        sessionId,
        answeredBy: "u1",
        choice: { kind: "agent", agentUserId: "agent-2" },
      })
    ).toEqual(["restarted"]);
    const run = await runOf(runId);
    expect(run.status).toBe("queued");
    expect(run.holder).toMatchObject({ kind: "agent", id: "agent-2" });
    expect(run.executor).toBe("external-agent");
    expect(run.input).toMatchObject({ agentUserId: "agent-2" });
    expect(h.redispatched).toEqual([{ runId, executor: "external-agent" }]);
  });

  it("Synap AI picked for an agent's run: queued for Synap AI and dispatched to it", async () => {
    const { sessionId, runId } = await blockedRun("agent");
    expect(
      await applyBlockedRunAnswer({
        sessionId,
        answeredBy: "u1",
        choice: { kind: "synap_ai" },
      })
    ).toEqual(["restarted"]);
    const run = await runOf(runId);
    expect(run.holder).toMatchObject({ kind: "synap_ai", id: null });
    expect(run.executor).toBe("is-agent");
    expect(h.redispatched).toEqual([{ runId, executor: "is-agent" }]);
  });

  it("a run that is no longer blocked is left as it is", async () => {
    const { sessionId, runId } = await blockedRun("synap_ai", "running");
    expect(
      await applyBlockedRunAnswer({
        sessionId,
        answeredBy: "u1",
        choice: { kind: "same" },
      })
    ).toEqual([]);
    expect((await runOf(runId)).status).toBe("running");
  });

  it("yes on a Synap AI run whose turn still waits in pg-boss: it waits for that turn, no second dispatch", async () => {
    const { sessionId, runId } = await blockedRun("synap_ai");
    await q(
      `insert into pgboss.job (name, state, data) values ('a2ai-response-trigger', 'created', $1::jsonb)`,
      [JSON.stringify({ focusSessionId: sessionId })]
    );
    expect(
      await applyBlockedRunAnswer({
        sessionId,
        answeredBy: "u1",
        choice: { kind: "same" },
      })
    ).toEqual(["waiting"]);
    expect((await runOf(runId)).status).toBe("queued");
    expect(h.redispatched).toEqual([]);
  });

  it("the answer applies to every blocked run of the same automation", async () => {
    const automationId = randomUUID();
    const a = await blockedRun("agent", "blocked", { automationId });
    const b = await blockedRun("agent", "blocked", { automationId });
    const other = await blockedRun("agent");
    expect(
      await applyBlockedRunAnswer({
        sessionId: a.sessionId,
        answeredBy: "u1",
        choice: { kind: "same" },
      })
    ).toEqual(["waiting", "waiting"]);
    expect((await runOf(b.runId)).status).toBe("queued");
    expect((await runOf(other.runId)).status).toBe("blocked");
  });
});
