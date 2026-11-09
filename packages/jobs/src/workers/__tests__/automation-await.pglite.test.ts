/**
 * AWAIT, THROUGH THE REAL EXECUTOR (runner engine slice 5, spec 7111934d §4).
 *
 * trigger → playbook_run (await) → command. Proved through
 * `handleAutomationExecute` and the real SQL on PGlite:
 *   1. the walk starts the run and PAUSES on it: the step waits (`awaiting`,
 *      the run's session), the automation run stays `running`, the command
 *      after it has not run;
 *   2. the run ends (its terminal writer's entry, `settleParentAutomationRunFromChild`):
 *      the step completes with the run's outputs and ONE resume is queued;
 *   3. that resume walks on: the playbook is not started again, the command
 *      runs and SEES the run's outputs at `steps.<node>.output.outputs.<label>`,
 *      and the automation run completes.
 * Stubbed (each a seam with its own tests): the playbook runner step (it writes
 * the child session and run rows as run-playbook does), the command transport
 * (it records the context it was given), pg-boss (`send` recorded), session
 * open/close, narration.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  playbookCalls: 0,
  commandContexts: [] as Array<Record<string, unknown>>,
  sent: [] as Array<{ queue: string; payload: Record<string, unknown> }>,
  child: null as null | { sessionId: string; runId: string },
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
vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getBoss: () => ({
      send: async (queue: string, payload: Record<string, unknown>) => {
        h.sent.push({ queue, payload });
        return "job";
      },
    }),
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
    executeCommandStep: async (
      _data: unknown,
      context: { steps: Record<string, unknown> }
    ) => {
      h.commandContexts.push(JSON.parse(JSON.stringify(context.steps)));
      return { ok: true };
    },
  };
});
/** The playbook runner step, reduced to what run-playbook persists. */
vi.mock("../steps/playbook-run.js", () => ({
  executePlaybookRun: async (
    _data: unknown,
    _ctx: unknown,
    _ws: string,
    _owner: string,
    automationContext: { automationRunId: string; automationId: string }
  ) => {
    h.playbookCalls += 1;
    const sessionId = randomUUID();
    const runId = randomUUID();
    h.child = { sessionId, runId };
    await h.client!.query(
      `insert into focus_sessions (id, user_id, goal, status, metadata, expected_outputs, started_at, updated_at)
       values ($1, 'owner', 'g', 'active', $2::jsonb, $3::jsonb, now(), now())`,
      [
        sessionId,
        JSON.stringify({ automationRunId: automationContext.automationRunId }),
        JSON.stringify([
          { kind: "document", label: "final", status: "pending" },
        ]),
      ]
    );
    await h.client!.query(
      `insert into playbook_runs (id, playbook_id, session_id, status, started_at)
       values ($1, gen_random_uuid(), $2, 'running', now())`,
      [runId, sessionId]
    );
    return { runId, sessionId, status: "running" };
  },
}));

import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { handleAutomationExecute } from "../automation-executor.js";
import { settleParentAutomationRunFromChild } from "../../utils/automation-parent-settle.js";

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

const FLOW = {
  nodes: [
    { id: "t", type: "trigger", data: {} },
    {
      id: "render",
      type: "playbook_run",
      data: {
        label: "render",
        playbookName: "Render a cut",
        await: true,
        awaitTimeout: "2h",
      },
    },
    { id: "post", type: "command", data: { label: "post", commandId: "x" } },
  ],
  edges: [
    { id: "e1", source: "t", target: "render" },
    { id: "e2", source: "render", target: "post" },
  ],
};

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value as PgTable));
  }
}, 120_000);

beforeEach(async () => {
  h.playbookCalls = 0;
  h.commandContexts.length = 0;
  h.sent.length = 0;
  h.child = null;
  await h.client!.exec(
    "delete from automations; delete from automation_runs; delete from automation_step_runs; delete from playbook_runs; delete from focus_sessions;"
  );
});

describe("a playbook_run that awaits its run", () => {
  it("pauses the walk, resumes when the run ends, and the next node sees its outputs", async () => {
    const automationId = randomUUID();
    await q(
      `insert into automations (id, workspace_id, created_by, name, trigger_type, trigger_config, flow_definition, status, success_count, failure_count, run_count, version)
       values ($1, $2, $3, 'render then post', 'manual', '{}'::jsonb, $4::jsonb, 'active', 0, 0, 0, 1)`,
      [automationId, WS, OWNER, JSON.stringify(FLOW)]
    );
    const runId = randomUUID();
    await q(
      `insert into automation_runs (id, automation_id, workspace_id, triggered_by, trigger_payload, status, ai_dispatch_count, started_at)
       values ($1, $2, $3, 'system', '{}'::jsonb, 'running', 0, now())`,
      [runId, automationId, WS]
    );
    await handleAutomationExecute({
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

    // 1. Paused on the run.
    expect(h.playbookCalls).toBe(1);
    const child = h.child!;
    const [waiting] = (
      await q<{
        status: string;
        output: Record<string, unknown>;
        child_session_id: string;
      }>(
        `select status, output, child_session_id from automation_step_runs where run_id = $1 and node_id = 'render'`,
        [runId]
      )
    ).rows;
    expect(waiting).toMatchObject({
      status: "running",
      child_session_id: child.sessionId,
      output: expect.objectContaining({
        status: "awaiting",
        childSessionId: child.sessionId,
        awaitTimeout: "2h",
      }),
    });
    expect(h.commandContexts).toEqual([]);
    const [paused] = (
      await q<{ status: string }>(
        `select status from automation_runs where id = $1`,
        [runId]
      )
    ).rows;
    expect(paused!.status).toBe("running");
    expect(h.sent).toEqual([]);

    // 2. The run ends, delivering its slot: ONE resume is queued.
    await q(
      `update focus_sessions set status = 'closed', expected_outputs = $2::jsonb where id = $1`,
      [
        child.sessionId,
        JSON.stringify([
          {
            kind: "document",
            label: "final",
            status: "done",
            ref: { url: "https://example.test/cut.mp4" },
          },
        ]),
      ]
    );
    await q(
      `update playbook_runs set status = 'completed', summary = 'Rendered', completed_at = now() where id = $1`,
      [child.runId]
    );
    await settleParentAutomationRunFromChild({ playbookRunId: child.runId });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.queue).toBe("automation-execute");

    // 3. The resume walks on with the run's outputs.
    await handleAutomationExecute({ data: h.sent[0]!.payload as never });
    expect(h.playbookCalls).toBe(1);
    expect(h.commandContexts).toHaveLength(1);
    expect(h.commandContexts[0]).toMatchObject({
      render: {
        output: {
          status: "completed",
          sessionId: child.sessionId,
          summary: "Rendered",
          outputs: {
            final: {
              kind: "document",
              ref: { url: "https://example.test/cut.mp4" },
            },
          },
        },
      },
    });
    const [done] = (
      await q<{ status: string }>(
        `select status from automation_runs where id = $1`,
        [runId]
      )
    ).rows;
    expect(done!.status).toBe("completed");
  });
});
