/**
 * Decisions 90897bca + ce5fb987 (2026-11-27): an automation that only STORES
 * data records its run in `automation_runs` and mints NO focus session.
 *
 * Proved through the REAL `handleAutomationExecute` on PGlite:
 *   1. an ingest-only run (contract `ingest`, no reacts, a `set_state` output)
 *      completes and never calls `openRunSession`;
 *   2. a react run still opens its session; so does an `ingest` contract whose
 *      flow runs a command (the flow is what runs, not the label);
 *   3. a FAILED ingest-only run still opens no session, and its failure is on
 *      the run row (status, error) and handed to the run narration, the
 *      readers that surface failures with no session.
 *
 * Stubbed (seams with their own suites): session open/close, narration, the
 * IS command transport.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  sessionsOpened: [] as string[],
  narrated: [] as string[],
  commandCalls: 0,
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
    openRunSession: async (input: { automationRunId?: string | null }) => {
      h.sessionsOpened.push(String(input.automationRunId));
      return { sessionId: randomUUID(), reused: false };
    },
  };
});
vi.mock("../../utils/post-run-summary.js", () => ({
  postRunSummary: async (runId: string) => {
    h.narrated.push(runId);
  },
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

import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { handleAutomationExecute } from "../automation-executor.js";

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

const WS = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";

const contract = (mode: "ingest" | "react") => ({
  dataContract: {
    version: 1,
    mode,
    gets: [
      {
        id: "g",
        label: "events",
        nodeIds: ["t"],
        origin: "external",
        event: "e",
      },
    ],
    stores:
      mode === "ingest"
        ? [{ id: "s", label: "state", nodeIds: ["o"], resource: "state" }]
        : [],
    reacts:
      mode === "react"
        ? [{ id: "r", label: "run", nodeIds: ["o"], kind: "agent" }]
        : [],
  },
});

const flowOf = (last: { type: string; data: Record<string, unknown> }) => ({
  nodes: [
    { id: "t", type: "trigger", data: {} },
    { id: "o", ...last },
  ],
  edges: [{ id: "e1", source: "t", target: "o" }],
});

const SET_STATE = flowOf({
  type: "output",
  data: {
    label: "keep cursor",
    outputType: "set_state",
    config: { cursor: 7 },
  },
});
const COMMAND = flowOf({
  type: "command",
  data: { label: "c", commandId: "x" },
});
/** An observation with no `type`: the step throws, the run fails. */
const BROKEN_OBSERVATION = flowOf({
  type: "output",
  data: {
    label: "record",
    outputType: "record_observation",
    config: { subjectId: "repo#1" },
  },
});

async function automation(
  metadata: Record<string, unknown>,
  flow: unknown
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into automations (id, workspace_id, created_by, name, trigger_type, trigger_config, flow_definition, metadata, status, success_count, failure_count, run_count, version)
     values ($1, $2, $3, $4, 'webhook', '{}'::jsonb, $5::jsonb, $6::jsonb, 'active', 0, 0, 0, 1)`,
    [
      id,
      WS,
      OWNER,
      `rule-${id}`,
      JSON.stringify(flow),
      JSON.stringify(metadata),
    ]
  );
  return id;
}

async function run(automationId: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into automation_runs (id, automation_id, workspace_id, triggered_by, trigger_payload, status, ai_dispatch_count, started_at)
     values ($1, $2, $3, 'system', '{}'::jsonb, 'running', 0, now())`,
    [id, automationId, WS]
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
    await q<{ status: string; error_message: string | null }>(
      "select status, error_message from automation_runs where id = $1",
      [id]
    )
  ).rows[0]!;

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value as PgTable));
  }
}, 120_000);

beforeEach(async () => {
  h.sessionsOpened = [];
  h.narrated = [];
  h.commandCalls = 0;
  await h.client!.exec(
    "delete from automations; delete from automation_runs; delete from automation_step_runs; delete from users; delete from workspace_members;"
  );
  await q(
    `insert into users (id, email, user_type) values ($1, 'o@x.test', 'human')`,
    [OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'editor')`,
    [randomUUID(), WS, OWNER]
  );
});

describe("an ingest-only automation run mints no session", () => {
  it("records the run on its row and never opens a session", async () => {
    const a = await automation(contract("ingest"), SET_STATE);
    const r = await run(a);

    await execute(a, r);

    expect(await runRow(r)).toMatchObject({ status: "completed" });
    expect(h.sessionsOpened).toEqual([]);
    const state = await q<{ state: Record<string, unknown> }>(
      "select state from automations where id = $1",
      [a]
    );
    expect(state.rows[0]!.state).toMatchObject({ cursor: 7 });
  });

  it("CONTROL: a react run still opens its session", async () => {
    const a = await automation(contract("react"), COMMAND);
    const r = await run(a);

    await execute(a, r);

    expect(h.commandCalls).toBe(1);
    expect(h.sessionsOpened).toEqual([r]);
  });

  it("CONTROL: an ingest contract whose flow runs a command still opens its session", async () => {
    const a = await automation(contract("ingest"), COMMAND);
    const r = await run(a);

    await execute(a, r);

    expect(h.commandCalls).toBe(1);
    expect(h.sessionsOpened).toEqual([r]);
  });

  it("a FAILED ingest-only run opens no session; its failure is on the run row and narrated", async () => {
    const a = await automation(contract("ingest"), BROKEN_OBSERVATION);
    const r = await run(a);

    await execute(a, r).catch(() => undefined);

    const row = await runRow(r);
    expect(row.status).toBe("failed");
    expect(row.error_message ?? "").toMatch(/config\.type is required/);
    expect(h.sessionsOpened).toEqual([]);
    expect(h.narrated).toContain(r);
  });
});
