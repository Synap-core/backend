/**
 * RUNAWAY-AUTOMATION GUARDRAILS, through the REAL executor on PGlite.
 *
 * The incident (2026-10): cron → query every company (limit 100, no filter) →
 * loop → a playbook run + an IS command per item. ~200 AI calls a day for
 * weeks, while the parent run read "completed" — every child it started failed
 * later, and nothing walked that failure back to the parent, so the breakers
 * (keyed on the parent's outcome) never fired.
 *
 * Proved here, each through `handleAutomationExecute` and the real SQL:
 *   1. a loop of 100 with an AI body dispatches at most the per-run cap, and
 *      the run records the skip (reason + count) instead of "completed";
 *   2. the per-automation DAILY cap refuses a cron-origin run once the rolling
 *      24h sum is spent (the matcher's maxRunsPerDay never saw the cron path);
 *   3. a child playbook run failing later (the reaper) turns the parent run
 *      `failed`, flips its dispatching step, moves the counters, and trips the
 *      never-worked breaker;
 *   4. a child that failed while the parent was still walking is caught by the
 *      executor's own settle.
 *
 * Stubbed (each is a seam with its own tests): the playbook runner step (it
 * writes the child session + run rows exactly as run-playbook does, with the
 * chain metadata), the IS command transport, session open/close, narration.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  playbookCalls: 0,
  commandCalls: 0,
  /** Status the stub runner writes on the child run row it creates. */
  childStatus: "running" as string,
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
      schema: {
        automations: actual.automations as never,
        automationRuns: actual.automationRuns as never,
      },
    }),
    openRunSession: async () => ({ sessionId: randomUUID(), reused: false }),
  };
});
vi.mock("../../utils/post-run-summary.js", () => ({
  postRunSummary: async () => undefined,
  resolveRunChannel: async () => null,
}));
vi.mock("../../utils/session-close.js", () => ({
  closeSessionViaDoor: async () => null,
}));
vi.mock("../steps/command-skill-capability.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    executeCommandStep: async () => {
      h.commandCalls += 1;
      return { ok: true };
    },
  };
});
/**
 * The playbook runner step, reduced to what run-playbook persists: a session
 * carrying the chain metadata (`automationRunId` + `automationChainContext.
 * stepRunId`) and a `playbook_runs` row.
 */
vi.mock("../steps/playbook-run.js", () => ({
  executePlaybookRun: async (
    _data: unknown,
    _ctx: unknown,
    _ws: string,
    _owner: string,
    automationContext: { automationRunId: string; automationId: string },
    _producer: unknown,
    attribution?: { stepRunId: string }
  ) => {
    h.playbookCalls += 1;
    const sessionId = randomUUID();
    const runId = randomUUID();
    await h.client!.query(
      `insert into focus_sessions (id, user_id, goal, status, metadata, started_at, updated_at)
       values ($1, 'owner', 'g', 'active', $2::jsonb, now(), now())`,
      [
        sessionId,
        JSON.stringify({
          automationId: automationContext.automationId,
          automationRunId: automationContext.automationRunId,
          automationChainContext: {
            automationRunId: automationContext.automationRunId,
            stepRunId: attribution?.stepRunId,
          },
        }),
      ]
    );
    await h.client!.query(
      `insert into playbook_runs (id, playbook_id, session_id, status, error, started_at, completed_at)
       values ($1, gen_random_uuid(), $2, $3, $4, now(), case when $3 = 'running' then null else now() end)`,
      [
        runId,
        sessionId,
        h.childStatus,
        h.childStatus === "failed" ? "IS turn failed" : null,
      ]
    );
    return { runId, sessionId, status: h.childStatus };
  },
}));

import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { handleAutomationExecute } from "../automation-executor.js";
import { handlePlaybookRunReaper } from "../playbook-run-reaper.js";
import {
  AI_DISPATCH_GUARDRAILS,
  AUTOMATION_SKIP_REASONS,
} from "@synap-core/types/automations";
import { NEVER_WORKED_FAILURE_LIMIT } from "../automation-breaker.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function sqlDefault(d: unknown): string {
  if (is(d, SQL)) {
    return (d as SQL).queryChunks
      .map((c) => {
        const v = (c as { value?: unknown }).value;
        return Array.isArray(v) ? v.join("") : "";
      })
      .join("");
  }
  if (typeof d === "string") return `'${d.replace(/'/g, "''")}'`;
  if (typeof d === "number" || typeof d === "boolean") return String(d);
  if (d && typeof d === "object") return `'${JSON.stringify(d)}'::jsonb`;
  return "";
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]")
      ? t
      : BASIC.test(t)
        ? t.replace(/\(.*\)/, "")
        : "text";
    // An object default only makes sense on a json column (an array column's
    // `[]` default is a JS value, not SQL) — defaults elsewhere are dropped.
    const def =
      !c.hasDefault ||
      (c.default !== null &&
        typeof c.default === "object" &&
        !is(c.default, SQL) &&
        !/^json/.test(type))
        ? ""
        : sqlDefault(c.default);
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def ? ` default ${def}` : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWNER = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";

async function automation(opts: {
  flow: unknown;
  triggerConfig?: Record<string, unknown>;
  successCount?: number;
  failureCount?: number;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into automations (id, workspace_id, created_by, name, trigger_type, trigger_config, flow_definition, status, success_count, failure_count, run_count, version)
     values ($1, $2, $3, 'rule', 'cron', $4::jsonb, $5::jsonb, 'active', $6, $7, 0, 1)`,
    [
      id,
      WS,
      OWNER,
      JSON.stringify(opts.triggerConfig ?? {}),
      JSON.stringify(opts.flow),
      opts.successCount ?? 0,
      opts.failureCount ?? 0,
    ]
  );
  return id;
}

/** A cron-origin run row, as the cron scheduler creates it. */
async function run(
  automationId: string,
  payload: Record<string, unknown> = {},
  extra: { aiDispatchCount?: number; hoursAgo?: number; status?: string } = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into automation_runs (id, automation_id, workspace_id, triggered_by, trigger_payload, status, ai_dispatch_count, started_at)
     values ($1, $2, $3, 'system', $4::jsonb, $5, $6, now() - ($7::int * interval '1 hour'))`,
    [
      id,
      automationId,
      WS,
      JSON.stringify({ scheduledAt: new Date().toISOString(), ...payload }),
      extra.status ?? "running",
      extra.aiDispatchCount ?? 0,
      extra.hoursAgo ?? 0,
    ]
  );
  return id;
}

const execute = (automationId: string, runId: string) =>
  handleAutomationExecute({
    data: {
      runId,
      automationId,
      workspaceId: WS,
      automationContext: {
        automationRunId: runId,
        automationId,
        chainDepth: 0,
      },
    } as never,
  });

const runRow = async (id: string) =>
  (
    await q<{
      status: string;
      error_message: string | null;
      ai_dispatch_count: number;
      steps_failed: number;
    }>(
      "select status, error_message, ai_dispatch_count, steps_failed from automation_runs where id = $1",
      [id]
    )
  ).rows[0]!;

const automationRow = async (id: string) =>
  (
    await q<{ status: string; success_count: number; failure_count: number }>(
      "select status, success_count, failure_count from automations where id = $1",
      [id]
    )
  ).rows[0]!;

/** trigger → loop(trigger.payload.items) → <body>. */
const loopFlow = (body: Record<string, unknown>) => ({
  nodes: [
    { id: "t", type: "trigger", data: {} },
    {
      id: "loop",
      type: "loop",
      data: { iteratorExpression: "trigger.payload.items", itemVariable: "c" },
    },
    { id: "body", ...body },
  ],
  edges: [
    { id: "e1", source: "t", target: "loop" },
    { id: "e2", source: "loop", target: "body" },
  ],
});
const PLAYBOOK_BODY = {
  type: "playbook_run",
  data: { label: "p", playbookName: "advance" },
};
/** The playbook-delegate shape (one playbook_run node). */
const SINGLE_PLAYBOOK = {
  nodes: [{ id: "p", ...PLAYBOOK_BODY }],
  edges: [],
};
const SINGLE_COMMAND = {
  nodes: [
    { id: "t", type: "trigger", data: {} },
    { id: "cmd", type: "command", data: { label: "c", commandId: "x" } },
  ],
  edges: [{ id: "e1", source: "t", target: "cmd" }],
};

/** The incident's child death: 25h old, its session no longer active. */
const KILL_CHILD_QUIETLY =
  "update playbook_runs set started_at = now() - interval '25 hours'; update focus_sessions set status = 'closed';";

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value as PgTable));
  }
}, 120_000);

beforeEach(async () => {
  h.playbookCalls = 0;
  h.commandCalls = 0;
  h.childStatus = "running";
  await h.client!.exec(
    "delete from automations; delete from automation_runs; delete from automation_step_runs; delete from playbook_runs; delete from focus_sessions;"
  );
});

describe("per-run AI dispatch cap", () => {
  it("a loop of 100 with an AI body dispatches at most the cap, and records the skip", async () => {
    const cap = AI_DISPATCH_GUARDRAILS.maxAiDispatchesPerRun;
    const a = await automation({
      flow: loopFlow(PLAYBOOK_BODY),
      triggerConfig: { maxAiDispatchesPerDay: 1000 },
    });
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const r = await run(a, { items });

    await execute(a, r);

    expect(h.playbookCalls).toBe(cap);
    const row = await runRow(r);
    expect(row.ai_dispatch_count).toBe(cap);
    // Not "completed" as if every item ran — the reason and the count are on
    // the run row.
    expect(row.status).not.toBe("completed");
    expect(row.status).toBe("blocked_by_policy");
    expect(row.error_message).toContain(
      AUTOMATION_SKIP_REASONS.aiDispatchCapReached
    );
    expect(row.error_message).toContain(
      `${100 - cap} of 100 items were skipped`
    );
  });

  it("a loop under the cap runs every item and completes", async () => {
    const a = await automation({ flow: loopFlow(PLAYBOOK_BODY) });
    const r = await run(a, { items: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    await execute(a, r);
    expect(h.playbookCalls).toBe(3);
    expect((await runRow(r)).status).toBe("completed");
  });
});

describe("per-automation daily AI cap — on the cron path", () => {
  it("refuses the AI step once the rolling 24h sum is spent", async () => {
    const perDay = AI_DISPATCH_GUARDRAILS.maxAiDispatchesPerDayDefault;
    const a = await automation({ flow: SINGLE_COMMAND });
    // Earlier runs today spent the whole budget; one older run is outside it.
    await run(
      a,
      {},
      { aiDispatchCount: perDay - 10, hoursAgo: 3, status: "completed" }
    );
    await run(a, {}, { aiDispatchCount: 10, hoursAgo: 1, status: "completed" });
    await run(
      a,
      {},
      { aiDispatchCount: 500, hoursAgo: 30, status: "completed" }
    );
    const r = await run(a);

    await execute(a, r);

    expect(h.commandCalls).toBe(0);
    const row = await runRow(r);
    expect(row.status).toBe("blocked_by_policy");
    expect(row.error_message).toContain(
      AUTOMATION_SKIP_REASONS.aiDailyCapReached
    );
  });

  it("runs when one dispatch of the budget is left (the twin)", async () => {
    const perDay = AI_DISPATCH_GUARDRAILS.maxAiDispatchesPerDayDefault;
    const a = await automation({ flow: SINGLE_COMMAND });
    await run(
      a,
      {},
      { aiDispatchCount: perDay - 1, hoursAgo: 1, status: "completed" }
    );
    const r = await run(a);
    await execute(a, r);
    expect(h.commandCalls).toBe(1);
    const row = await runRow(r);
    expect(row.status).toBe("completed");
    expect(row.ai_dispatch_count).toBe(1);
  });

  it("two runs racing for the last dispatch: exactly one gets it (atomic reservation)", async () => {
    const perDay = AI_DISPATCH_GUARDRAILS.maxAiDispatchesPerDayDefault;
    const a = await automation({ flow: SINGLE_COMMAND });
    await run(
      a,
      {},
      { aiDispatchCount: perDay - 1, hoursAgo: 1, status: "completed" }
    );
    const r1 = await run(a);
    const r2 = await run(a);

    await Promise.all([execute(a, r1), execute(a, r2)]);

    expect(h.commandCalls).toBe(1);
    const rows = [await runRow(r1), await runRow(r2)];
    expect(rows.map((x) => x.status).sort()).toEqual([
      "blocked_by_policy",
      "completed",
    ]);
    expect(rows.reduce((n, x) => n + Number(x.ai_dispatch_count), 0)).toBe(1);
  });

  it("the cron scheduler enqueues runs to the executor queue this test drives", () => {
    // The cap lives in the executor; this pins that the cron path reaches it.
    const cron = readFileSync(
      fileURLToPath(
        new URL("../automation-cron-scheduler.ts", import.meta.url)
      ),
      "utf8"
    );
    expect(cron).toMatch(/["']automation-execute["']/);
  });
});

describe("a parent run settles from its children's outcomes", () => {
  it("a child failing LATER (reaper) fails the parent, its step, moves the counters, and trips the breaker", async () => {
    // One success short of nothing: 9 failures, 0 successes before this run.
    const a = await automation({
      flow: SINGLE_PLAYBOOK,
      failureCount: NEVER_WORKED_FAILURE_LIMIT - 1,
    });
    const r = await run(a);
    await execute(a, r);

    // As today: the parent settles completed while its child is still running.
    expect((await runRow(r)).status).toBe("completed");
    expect((await automationRow(a)).success_count).toBe(1);

    await h.client!.exec(KILL_CHILD_QUIETLY);
    await handlePlaybookRunReaper();

    const parent = await runRow(r);
    expect(parent.status).toBe("failed");
    expect(parent.error_message).toContain(
      "1 of 1 playbook run this run started failed"
    );
    expect(parent.steps_failed).toBe(1);
    const step = (
      await q<{ status: string }>(
        "select status from automation_step_runs where run_id = $1",
        [r]
      )
    ).rows[0]!;
    expect(step.status).toBe("failed");

    const auto = await automationRow(a);
    expect(auto.success_count).toBe(0);
    expect(auto.failure_count).toBe(NEVER_WORKED_FAILURE_LIMIT);
    // The never-worked breaker fired on the CHILD's outcome.
    expect(auto.status).toBe("error");
  });

  it("re-settling is idempotent: a second pass moves no counter", async () => {
    const a = await automation({ flow: SINGLE_PLAYBOOK, successCount: 5 });
    const r = await run(a);
    await execute(a, r);
    await h.client!.exec(KILL_CHILD_QUIETLY);
    await handlePlaybookRunReaper();
    await handlePlaybookRunReaper();
    const auto = await automationRow(a);
    expect(auto.success_count).toBe(5);
    expect(auto.failure_count).toBe(1);
    expect(auto.status).toBe("active");
  });

  it("a child that failed WHILE the parent walked is caught by the executor's settle", async () => {
    h.childStatus = "failed";
    const a = await automation({ flow: SINGLE_PLAYBOOK, successCount: 3 });
    const r = await run(a);
    await execute(a, r);
    const parent = await runRow(r);
    expect(parent.status).toBe("failed");
    const auto = await automationRow(a);
    expect(auto.success_count).toBe(3);
    expect(auto.failure_count).toBe(1);
  });

  it("a child that COMPLETES leaves the parent completed", async () => {
    h.childStatus = "completed";
    const a = await automation({ flow: SINGLE_PLAYBOOK });
    const r = await run(a);
    await execute(a, r);
    expect((await runRow(r)).status).toBe("completed");
    expect((await automationRow(a)).success_count).toBe(1);
  });
});
