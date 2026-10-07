/**
 * `cancelRun` — a dispatched run is cancelled through the binding's `cancel`
 * verb when the binding supports it, and SAYS so when it cannot; a cancel verb
 * that fails leaves the run running (never a "cancelled" run whose agent keeps
 * working).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
  calls: [] as Array<Record<string, unknown>>,
  next: null as null | Record<string, unknown>,
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
        users: actual.users as never,
        links: actual.links as never,
        tools: actual.tools as never,
        focusSessions: actual.focusSessions as never,
        playbookRuns: actual.playbookRuns as never,
      },
    }),
  };
});
vi.mock("@synap/jobs", () => ({
  settleParentAutomationRunFromChild: async () => undefined,
}));
vi.mock("../../capabilities/execute-capability.js", () => ({
  executeCapability: async (input: Record<string, unknown>) => {
    h.calls.push(input);
    return h.next ?? { kind: "run", skillId: "s", result: { ok: true } };
  },
}));
vi.mock("../../messaging/post-message.js", () => ({
  postChannelMessage: async () => ({ success: true, messageId: "m" }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  users,
  links,
  tools,
  focusSessions,
  playbookRuns,
} from "@synap/database";
import { cancelRun } from "../cancel-run.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${c.name === "created_at" ? " default now()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWNER = randomUUID();
const CANCELLABLE = randomUUID();
const NO_CANCEL = randomUUID();

function binding(cancel: boolean) {
  return {
    protocol: "a2a",
    provider: cancel ? "acme" : "plain",
    supports: { push: false, inputRequired: false, cancel },
    verbs: {
      start: "x_start",
      send: "x_send",
      ...(cancel ? { cancel: "x_cancel" } : {}),
    },
  };
}

async function dispatchedRun(agentUserId: string, provider: string) {
  const sessionId = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, metadata, criteria, channel_id) values ($1, $2, 'g', 'active', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, $3)`,
    [sessionId, OWNER, randomUUID()]
  );
  const runId = randomUUID();
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, executor, status, input, created_by, external_agent, started_at)
     values ($1, $2, $3, 'external-agent', 'running', '{}'::jsonb, $4, $5::jsonb, now())`,
    [
      runId,
      randomUUID(),
      sessionId,
      OWNER,
      JSON.stringify({
        agentUserId,
        toolId: "t",
        provider,
        externalId: "task-1",
        url: null,
        status: "running",
        startedAt: new Date().toISOString(),
      }),
    ]
  );
  return runId;
}
const runRow = async (id: string) =>
  (
    await q<{ status: string; external_agent: { status: string } }>(
      `select status, external_agent from playbook_runs where id = $1`,
      [id]
    )
  ).rows[0]!;

describe("cancelRun", () => {
  beforeAll(async () => {
    for (const t of [users, links, tools, focusSessions, playbookRuns]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await q(
      `insert into users (id, email, name, timezone, user_type, agent_type) values
        ($1, 'o@x', 'O', 'UTC', 'human', null),
        ($2, 'c@x', 'C', 'UTC', 'agent', 'c'),
        ($3, 'n@x', 'N', 'UTC', 'agent', 'n')`,
      [OWNER, CANCELLABLE, NO_CANCEL]
    );
    for (const [agent, cancel] of [
      [CANCELLABLE, true],
      [NO_CANCEL, false],
    ] as const) {
      const tool = randomUUID();
      await q(
        `insert into tools (id, created_by, name, kind, executor, config, status) values ($1, $2, 't', 'external', 'external-agent', $3::jsonb, 'active')`,
        [tool, OWNER, JSON.stringify({ agentBinding: binding(cancel) })]
      );
      await q(
        `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata) values ($1, 'participant', $2, 'tool', $3, 'dispatched_via', '{}'::jsonb)`,
        [randomUUID(), agent, tool]
      );
    }
  }, 120_000);

  afterAll(async () => {
    await h.client?.close();
  });

  beforeEach(() => {
    h.calls.length = 0;
    h.next = null;
  });

  it("supports.cancel ⇒ the cancel verb runs as the agent, then the run is cancelled", async () => {
    const runId = await dispatchedRun(CANCELLABLE, "acme");
    const out = await cancelRun({ runId, userId: OWNER });
    expect(out).toEqual({ status: "cancelled", externalCancelled: true });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({
      verbId: "x_cancel",
      agentUserId: CANCELLABLE,
      userId: OWNER,
    });
    expect(await runRow(runId)).toMatchObject({
      status: "cancelled",
      external_agent: { status: "cancelled" },
    });
  });

  it("no cancel verb ⇒ cancelled, and it SAYS the agent could not be stopped", async () => {
    const runId = await dispatchedRun(NO_CANCEL, "plain");
    const out = await cancelRun({ runId, userId: OWNER });
    expect(out).toMatchObject({
      status: "cancelled",
      externalCancelled: false,
    });
    expect((out as { note?: string }).note).toMatch(/cannot be cancelled/);
    expect(h.calls).toHaveLength(0);
    expect((await runRow(runId)).status).toBe("cancelled");
  });

  it("a cancel verb that fails leaves the run RUNNING", async () => {
    h.next = { kind: "error", message: "provider down" };
    const runId = await dispatchedRun(CANCELLABLE, "acme");
    const out = await cancelRun({ runId, userId: OWNER });
    expect(out).toEqual({ status: "cancel_failed", message: "provider down" });
    expect((await runRow(runId)).status).toBe("running");
  });

  it("a run that is not live is refused", async () => {
    const runId = await dispatchedRun(NO_CANCEL, "plain");
    await cancelRun({ runId, userId: OWNER });
    expect(await cancelRun({ runId, userId: OWNER })).toEqual({
      status: "not_live",
      runStatus: "cancelled",
    });
  });
});
