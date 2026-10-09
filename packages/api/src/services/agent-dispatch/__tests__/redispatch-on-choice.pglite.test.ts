/**
 * "Choose an agent" answered ⇒ the failed run is re-dispatched through the SAME
 * executor path on the SAME run row — once. The reactor matches only that
 * slot's answer.
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
        apiKeys: actual.apiKeys as never,
        links: actual.links as never,
        tools: actual.tools as never,
        focusSessions: actual.focusSessions as never,
        playbooks: actual.playbooks as never,
        playbookRuns: actual.playbookRuns as never,
        entities: actual.entities as never,
        workspaceMembers: actual.workspaceMembers as never,
        workspaces: actual.workspaces as never,
        podMembers: actual.podMembers as never,
        projectMembers: actual.projectMembers as never,
      },
    }),
    getDb: async () => {
      const { drizzle } = await import("drizzle-orm/pglite");
      return drizzle(h.client as never, {
        schema: {
          playbookRuns: actual.playbookRuns as never,
          links: actual.links as never,
        },
      });
    },
  };
});
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  settleParentAutomationRunFromChild: async () => undefined,
}));
vi.mock("../../capabilities/execute-capability.js", () => ({
  executeCapability: async (input: Record<string, unknown>) => {
    h.calls.push(input);
    return { kind: "run", skillId: "s", result: { taskId: "task-9" } };
  },
}));
vi.mock("../../messaging/post-message.js", () => ({
  postChannelMessage: async () => ({ success: true, messageId: "m" }),
}));
vi.mock("../../focus-sessions/notify-needs-you.js", () => ({
  notifySessionNeedsYou: async () => true,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  users,
  apiKeys,
  links,
  tools,
  focusSessions,
  playbooks,
  playbookRuns,
  entities,
  workspaceMembers,
  workspaces,
  podMembers,
  projectMembers,
} from "@synap/database";
import {
  agentChoiceRedispatchReactor,
  redispatchAfterAgentChoice,
  redispatchAfterAgentBound,
} from "../redispatch-on-choice.js";
import { CHOOSE_AGENT_SLOT_LABEL } from "../../playbooks/executors/external-agent-executor.js";

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
const AGENT = randomUUID();
const TOOL = randomUUID();
const PLAYBOOK = randomUUID();

async function failedChooseRun() {
  const sessionId = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, expected_outputs, agent_ids, metadata, criteria, channel_id)
     values ($1, $2, 'Ship it', 'Ship it', 'active', '[]'::jsonb, '{}', $3::jsonb, '[]'::jsonb, $4)`,
    [
      sessionId,
      OWNER,
      JSON.stringify({ params: { agentUserId: AGENT } }),
      randomUUID(),
    ]
  );
  const runId = randomUUID();
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, executor, status, input, created_by, error, started_at, completed_at)
     values ($1, $2, $3, 'external-agent', 'failed', '{}'::jsonb, $4, 'several agents can take this work', now(), now())`,
    [runId, PLAYBOOK, sessionId, OWNER]
  );
  return { sessionId, runId };
}
const run = async (id: string) =>
  (
    await q<{
      status: string;
      error: string | null;
      external_agent: Record<string, unknown> | null;
    }>(
      `select status, error, external_agent from playbook_runs where id = $1`,
      [id]
    )
  ).rows[0]!;

describe("re-dispatch after 'Choose an agent'", () => {
  beforeAll(async () => {
    for (const t of [
      users,
      apiKeys,
      links,
      tools,
      focusSessions,
      playbooks,
      playbookRuns,
      entities,
      workspaceMembers,
      workspaces,
      podMembers,
      projectMembers,
    ]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await q(
      `insert into users (id, email, name, timezone, user_type, agent_type, created_by_user_id) values ($1, 'o@x', 'O', 'UTC', 'human', null, null), ($2, 'a@x', 'Cloud', 'UTC', 'agent', 'cloud', $1)`,
      [OWNER, AGENT]
    );
    await q(
      `insert into playbooks (id, name, created_by) values ($1, 'AI Dev Session', $2)`,
      [PLAYBOOK, OWNER]
    );
    await q(
      `insert into tools (id, created_by, name, kind, executor, config, status) values ($1, $2, 't', 'external', 'external-agent', $3::jsonb, 'active')`,
      [
        TOOL,
        OWNER,
        JSON.stringify({
          agentBinding: {
            protocol: "a2a",
            provider: "acme",
            supports: { push: false, inputRequired: false, cancel: false },
            verbs: { start: "acme_start", send: "acme_send" },
          },
        }),
      ]
    );
    await q(
      `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata) values ($1, 'participant', $2, 'tool', $3, 'dispatched_via', '{}'::jsonb)`,
      [randomUUID(), AGENT, TOOL]
    );
  }, 120_000);
  afterAll(async () => {
    await h.client?.close();
  });
  beforeEach(() => {
    h.calls.length = 0;
  });

  it("re-dispatches the SAME run through the executor, with the chosen agent — once", async () => {
    const { sessionId, runId } = await failedChooseRun();
    const out = await redispatchAfterAgentChoice(sessionId);
    expect(out).toEqual({
      status: "redispatched",
      runId,
      runStatus: "running",
    });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({
      verbId: "acme_start",
      agentUserId: AGENT,
      toolId: TOOL,
    });
    const r = await run(runId);
    expect(r.status).toBe("running");
    expect(r.error).toBeNull();
    expect(r.external_agent).toMatchObject({
      agentUserId: AGENT,
      externalId: "task-9",
    });
    // Idempotent: the run is no longer a failed, unrecorded one.
    expect(await redispatchAfterAgentChoice(sessionId)).toEqual({
      status: "nothing_to_redispatch",
    });
    expect(h.calls).toHaveLength(1);
  });

  it("BINDING an agent re-dispatches every session of its owner still owed 'Choose an agent' — the slot retired, the same run, once", async () => {
    const slot = {
      label: CHOOSE_AGENT_SLOT_LABEL,
      kind: "param",
      owner: "human",
      ask: { mode: "act", steps: ["Bind one of your agents to its provider."] },
    };
    // Owed, unanswered: re-dispatched.
    const owed = await failedChooseRun();
    await q(
      `update focus_sessions set expected_outputs = $2::jsonb, metadata = '{}'::jsonb where id = $1`,
      [
        owed.sessionId,
        JSON.stringify([slot, { label: "Other", owner: "human" }]),
      ]
    );
    // Already answered (done): not owed, left alone.
    const answered = await failedChooseRun();
    await q(
      `update focus_sessions set expected_outputs = $2::jsonb where id = $1`,
      [answered.sessionId, JSON.stringify([{ ...slot, status: "done" }])]
    );
    const out = await redispatchAfterAgentBound(OWNER);
    expect(out).toEqual([
      {
        sessionId: owed.sessionId,
        status: "redispatched",
        runId: owed.runId,
        runStatus: "running",
      },
    ]);
    // The single bound agent is chosen by the executor's own rule.
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ agentUserId: AGENT, toolId: TOOL });
    expect((await run(owed.runId)).status).toBe("running");
    expect((await run(answered.runId)).status).toBe("failed");
    const left = (
      await q<{ expected_outputs: Array<{ label: string }> }>(
        `select expected_outputs from focus_sessions where id = $1`,
        [owed.sessionId]
      )
    ).rows[0]!.expected_outputs.map((o) => o.label);
    expect(left).toEqual(["Other"]);
    // A second bind finds nothing owed.
    expect(await redispatchAfterAgentBound(OWNER)).toEqual([]);
    expect(h.calls).toHaveLength(1);
  });

  it("a binding for ANOTHER owner never re-dispatches this owner's sessions", async () => {
    const owed = await failedChooseRun();
    await q(
      `update focus_sessions set expected_outputs = $2::jsonb where id = $1`,
      [
        owed.sessionId,
        JSON.stringify([{ label: CHOOSE_AGENT_SLOT_LABEL, owner: "human" }]),
      ]
    );
    expect(await redispatchAfterAgentBound(randomUUID())).toEqual([]);
    expect((await run(owed.runId)).status).toBe("failed");
    // Clean up for the other tests.
    await q(`update focus_sessions set expected_outputs = '[]'::jsonb`);
  });

  it("the reactor matches ONLY the 'Choose an agent' param slot's answer", () => {
    const base = {
      subjectType: "focus_session",
      action: "slot_answered",
      subjectId: "s",
    };
    expect(
      agentChoiceRedispatchReactor.match!({
        ...base,
        data: {
          kind: "playbook_param",
          expectedLabel: CHOOSE_AGENT_SLOT_LABEL,
        },
      } as never)
    ).toBe(true);
    expect(
      agentChoiceRedispatchReactor.match!({
        ...base,
        data: { kind: "playbook_param", expectedLabel: "Answer: Repo" },
      } as never)
    ).toBe(false);
    expect(
      agentChoiceRedispatchReactor.match!({
        ...base,
        action: "updated",
        data: {
          kind: "playbook_param",
          expectedLabel: CHOOSE_AGENT_SLOT_LABEL,
        },
      } as never)
    ).toBe(false);
  });
});
