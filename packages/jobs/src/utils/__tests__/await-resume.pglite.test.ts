/**
 * AWAIT ON A `playbook_run` STEP (runner engine slice 5, spec 7111934d §4):
 * the run's end resumes the step that waits for it; the timeout fails it.
 *
 * Driven through the real terminal-writer entry (`settleParentAutomationRunFromChild`),
 * the reaper's timeout pass (`failTimedOutAwaitingSteps`) and the reaper's run
 * exemption, on PGlite. Stubbed: pg-boss (`send` recorded), the session close
 * door and the run narration (recorded) — each pinned in its own suite.
 *
 * Asserted (each rules out a rule the others would pass):
 *   - the run completed: the step is completed with the run's verdict, summary
 *     and delivered outputs by label, and the walk is re-enqueued past it with
 *     the producer; the outputs reach the next walk's context through the
 *     ledger seed the executor uses (`seedResumeState`);
 *   - a second end of the same run re-enqueues nothing (compare and set);
 *   - the run failed: the step fails and the automation run fails with the
 *     reason, its session is closed; with `continueOnError` the walk goes on;
 *   - past `resumeAfter`: the step fails "did not finish in 2h", the run it
 *     started is untouched; a wait not yet due is left alone;
 *   - the stale reaper exempts a run whose last step awaits (not yet due).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  sent: [] as Array<{ queue: string; payload: Record<string, unknown> }>,
  closed: [] as Array<Record<string, unknown>>,
  narrated: [] as string[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});
vi.mock("@synap/events", () => ({
  getBoss: () => ({
    send: vi.fn(async (queue: string, payload: Record<string, unknown>) => {
      h.sent.push({ queue, payload });
    }),
  }),
}));
vi.mock("../session-close.js", () => ({
  closeSessionViaDoor: vi.fn(async (input: Record<string, unknown>) => {
    h.closed.push(input);
    return { status: "closed" };
  }),
}));
vi.mock("../post-run-summary.js", () => ({
  postRunSummary: vi.fn(async (runId: string) => {
    h.narrated.push(runId);
  }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  automations,
  automationRuns,
  automationStepRuns,
  focusSessions,
  playbookRuns,
} from "@synap/database/schema";
import {
  AWAIT_RESUME_KEY,
  failTimedOutAwaitingSteps,
  settleParentAutomationRunFromChild,
} from "../automation-parent-settle.js";
import { seedResumeState } from "../../workers/retry-safety.js";
import { RUN_NOT_DELAY_SUSPENDED } from "../../workers/automation-run-reaper.js";
import { db } from "@synap/database";
import { and, eq } from "drizzle-orm";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.primary && type === "uuid"
        ? " default gen_random_uuid()"
        : type.startsWith("timestamp") && c.hasDefault
          ? " default now()"
          : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = randomUUID();
const WS = randomUUID();
const AUTOMATION = randomUUID();

/** One automation run whose `wait` step awaits a playbook run; returns the ids. */
async function seed(
  opts: {
    childStatus?: string;
    resumeAfter?: string;
    continueOnError?: boolean;
    startedMinutesAgo?: number;
  } = {}
) {
  const runId = randomUUID();
  const stepId = randomUUID();
  const childSession = randomUUID();
  const childRun = randomUUID();
  const runSession = randomUUID();
  await q(
    `insert into automation_runs (id, automation_id, workspace_id, status, steps_completed, steps_failed, started_at)
     values ($1, $2, $3, 'running', 1, 0, now() - ($4::int * interval '1 minute'))`,
    [runId, AUTOMATION, WS, opts.startedMinutesAgo ?? 1]
  );
  await q(
    `insert into automation_step_runs (id, run_id, node_id, status, output, child_session_id, started_at)
     values ($1, $2, 'wait', 'running', $3::jsonb, $4, now())`,
    [
      stepId,
      runId,
      JSON.stringify({
        runId: childRun,
        sessionId: childSession,
        status: "awaiting",
        childSessionId: childSession,
        awaitTimeout: "2h",
        resumeAfter:
          opts.resumeAfter ?? new Date(Date.now() + 3_600_000).toISOString(),
        [AWAIT_RESUME_KEY]: {
          automationId: AUTOMATION,
          workspaceId: WS,
          automationContext: { automationRunId: runId },
          completedNodeIds: ["trigger", "wait"],
          producerAgentUserId: "agent-producer",
          continueOnError: opts.continueOnError === true,
        },
      }),
      childSession,
    ]
  );
  // The automation run's own session, and the session of the run it started.
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, status, metadata, expected_outputs)
     values ($1, $2, $3, 'active', $4::jsonb, '[]'::jsonb),
            ($5, $2, $3, 'closed', '{}'::jsonb, $6::jsonb)`,
    [
      runSession,
      USER,
      WS,
      JSON.stringify({ automationRunId: runId }),
      childSession,
      JSON.stringify([
        {
          kind: "document",
          label: "Final cut",
          status: "done",
          ref: { url: "https://example.test/cut.mp4" },
        },
        { kind: "note", label: "Notes", status: "pending" },
      ]),
    ]
  );
  await q(
    `insert into playbook_runs (id, session_id, status, summary, error, started_at)
     values ($1, $2, $3, 'Rendered the cut', $4, now())`,
    [
      childRun,
      childSession,
      opts.childStatus ?? "completed",
      opts.childStatus === "failed" ? "ffmpeg crashed" : null,
    ]
  );
  return { runId, stepId, childSession, childRun, runSession };
}

const step = (id: string) =>
  q<{
    status: string;
    output: Record<string, unknown>;
    error_message: string | null;
  }>(
    `select status, output, error_message from automation_step_runs where id = $1`,
    [id]
  ).then((r) => r.rows[0]!);
const run = (id: string) =>
  q<{ status: string; error_message: string | null }>(
    `select status, error_message from automation_runs where id = $1`,
    [id]
  ).then((r) => r.rows[0]!);

beforeAll(async () => {
  for (const t of [
    automations,
    automationRuns,
    automationStepRuns,
    focusSessions,
    playbookRuns,
  ]) {
    await h.client!.exec(ddlFor(t as PgTable));
  }
  await q(
    `insert into automations (id, workspace_id, name, status) values ($1, $2, 'Render then post', 'active')`,
    [AUTOMATION, WS]
  );
});

beforeEach(async () => {
  h.sent.length = 0;
  h.closed.length = 0;
  h.narrated.length = 0;
  await h.client!.exec(
    "delete from automation_runs; delete from automation_step_runs; delete from focus_sessions; delete from playbook_runs;"
  );
});

describe("the awaited run ends", () => {
  it("completed: the step carries its verdict and outputs, the walk resumes past it", async () => {
    const s = await seed();
    await settleParentAutomationRunFromChild({ playbookRunId: s.childRun });

    const row = await step(s.stepId);
    expect(row.status).toBe("completed");
    expect(row.output).toMatchObject({
      status: "completed",
      sessionId: s.childSession,
      summary: "Rendered the cut",
      outputs: {
        "Final cut": {
          kind: "document",
          ref: { url: "https://example.test/cut.mp4" },
        },
      },
    });
    expect(row.output.outputs).not.toHaveProperty("Notes");
    expect(row.output).not.toHaveProperty(AWAIT_RESUME_KEY);

    expect(h.sent).toEqual([
      {
        queue: "automation-execute",
        payload: expect.objectContaining({
          runId: s.runId,
          automationId: AUTOMATION,
          completedNodeIds: ["trigger", "wait"],
          producerAgentUserId: "agent-producer",
        }),
      },
    ]);
    expect((await run(s.runId)).status).toBe("running");

    // What the next walk reads: the executor seeds its context from the ledger.
    const ledger = await db
      .select()
      .from(automationStepRuns)
      .where(eq(automationStepRuns.runId, s.runId));
    const seeded = seedResumeState(["trigger", "wait"], ledger);
    expect(
      (
        seeded.priorSteps.wait?.output.outputs as Record<
          string,
          { ref: unknown }
        >
      )["Final cut"]?.ref
    ).toEqual({ url: "https://example.test/cut.mp4" });

    // A second end of the same run re-enqueues nothing.
    await settleParentAutomationRunFromChild({ playbookRunId: s.childRun });
    expect(h.sent).toHaveLength(1);
  });

  it("two ends racing (the run's close and the timeout) resume the walk once", async () => {
    const s = await seed();
    await Promise.all([
      settleParentAutomationRunFromChild({ playbookRunId: s.childRun }),
      settleParentAutomationRunFromChild({ playbookRunId: s.childRun }),
    ]);
    expect(h.sent).toHaveLength(1);
  });

  it("failed: the step and the automation run fail with the reason; its session closes", async () => {
    const s = await seed({ childStatus: "failed" });
    await settleParentAutomationRunFromChild({ playbookRunId: s.childRun });
    expect(await step(s.stepId)).toMatchObject({
      status: "failed",
      error_message: "The run it waited on failed: ffmpeg crashed",
    });
    expect(await run(s.runId)).toMatchObject({
      status: "failed",
      error_message: "The run it waited on failed: ffmpeg crashed",
    });
    expect(h.sent).toEqual([]);
    expect(h.closed).toEqual([
      expect.objectContaining({ sessionId: s.runSession }),
    ]);
    expect(h.narrated).toEqual([s.runId]);
  });

  it("failed, the node continues on error: the walk goes on", async () => {
    const s = await seed({ childStatus: "failed", continueOnError: true });
    await settleParentAutomationRunFromChild({ playbookRunId: s.childRun });
    expect((await step(s.stepId)).status).toBe("failed");
    expect((await run(s.runId)).status).toBe("running");
    expect(h.sent).toHaveLength(1);
  });
});

describe("the wait times out", () => {
  it("past resumeAfter: the step fails, the run it started keeps going", async () => {
    const due = await seed({
      childStatus: "running",
      resumeAfter: new Date(Date.now() - 60_000).toISOString(),
    });
    const notDue = await seed({ childStatus: "running" });
    expect(await failTimedOutAwaitingSteps()).toBe(1);
    expect(await step(due.stepId)).toMatchObject({
      status: "failed",
      error_message: "The run it waited on did not finish in 2h.",
    });
    expect((await step(due.stepId)).output.status).toBe("timed_out");
    expect((await run(due.runId)).status).toBe("failed");
    const [child] = (
      await q<{ status: string }>(
        `select status from playbook_runs where id = $1`,
        [due.childRun]
      )
    ).rows;
    expect(child!.status).toBe("running");
    expect((await step(notDue.stepId)).output.status).toBe("awaiting");
  });

  it("the stale reaper exempts a run whose last step awaits", async () => {
    const s = await seed({ childStatus: "running", startedMinutesAgo: 120 });
    const exempt = await db
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .where(and(eq(automationRuns.id, s.runId), RUN_NOT_DELAY_SUSPENDED));
    expect(exempt).toEqual([]);
    // Non-vacuity: the same predicate does NOT exempt it once nothing awaits.
    await q(
      `update automation_step_runs set output = jsonb_set(output, '{status}', '"completed"') where id = $1`,
      [s.stepId]
    );
    const after = await db
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .where(and(eq(automationRuns.id, s.runId), RUN_NOT_DELAY_SUSPENDED));
    expect(after).toEqual([{ id: s.runId }]);
  });
});
