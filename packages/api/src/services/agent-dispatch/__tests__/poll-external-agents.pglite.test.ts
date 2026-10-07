/**
 * The external-agent status poll, read back out of PGlite.
 *
 *   - the normalizer: a recognized state maps; an unknown one is `null`
 *     (unreadable — never guessed);
 *   - IDEMPOTENT: one post per state change; an unchanged state posts nothing;
 *   - needs_input ⇒ a QUESTION card posted AS the agent;
 *   - done ⇒ the run capture (completed) and polling stops;
 *   - a binding without a status verb is never polled;
 *   - a proposed status read pauses polling while its proposal is pending.
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
  posts: [] as Array<Record<string, unknown>>,
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
        proposals: actual.proposals as never,
        entities: actual.entities as never,
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
    return (
      h.next ?? { kind: "run", skillId: "s", result: { state: "running" } }
    );
  },
}));
vi.mock("../../messaging/post-message.js", () => ({
  postChannelMessage: async (p: Record<string, unknown>) => {
    h.posts.push(p);
    return { success: true, messageId: "m" };
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  users,
  links,
  tools,
  focusSessions,
  playbookRuns,
  proposals,
  entities,
} from "@synap/database";
import {
  normalizeExternalAgentStatus,
  pollExternalAgentRuns,
  statusKey,
} from "../poll-external-agents.js";

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
const POLLED = randomUUID();
const NO_STATUS = randomUUID();

async function bindAgent(agent: string, withStatus: boolean) {
  const tool = randomUUID();
  await q(
    `insert into tools (id, created_by, name, kind, executor, config, status) values ($1, $2, 't', 'external', 'external-agent', $3::jsonb, 'active')`,
    [
      tool,
      OWNER,
      JSON.stringify({
        agentBinding: {
          protocol: "a2a",
          provider: "acme",
          supports: { push: false, inputRequired: true, cancel: false },
          verbs: {
            start: "x_start",
            send: "x_send",
            ...(withStatus ? { status: "x_status" } : {}),
          },
        },
      }),
    ]
  );
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata) values ($1, 'participant', $2, 'tool', $3, 'dispatched_via', '{}'::jsonb)`,
    [randomUUID(), agent, tool]
  );
}

async function dispatchedRun(agentUserId: string) {
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
        provider: "acme",
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
    await q<{
      status: string;
      summary: string | null;
      external_agent: Record<string, unknown>;
    }>(
      `select status, summary, external_agent from playbook_runs where id = $1`,
      [id]
    )
  ).rows[0]!;
const ran = (state: Record<string, unknown>) => {
  h.next = { kind: "run", skillId: "s", result: state };
};

describe("external agent status poll", () => {
  beforeAll(async () => {
    for (const t of [
      users,
      links,
      tools,
      focusSessions,
      playbookRuns,
      proposals,
      entities,
    ]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await q(
      `insert into users (id, email, name, timezone, user_type, agent_type) values
        ($1, 'o@x', 'O', 'UTC', 'human', null),
        ($2, 'p@x', 'P', 'UTC', 'agent', 'p'),
        ($3, 'n@x', 'N', 'UTC', 'agent', 'n')`,
      [OWNER, POLLED, NO_STATUS]
    );
    await bindAgent(POLLED, true);
    await bindAgent(NO_STATUS, false);
  }, 120_000);

  afterAll(async () => {
    await h.client?.close();
  });

  beforeEach(async () => {
    h.calls.length = 0;
    h.posts.length = 0;
    h.next = null;
    // Each test starts with no live dispatched run left over.
    await q(`update playbook_runs set status = 'completed'`);
  });

  it("normalizes a recognized state and refuses an unknown one", () => {
    expect(
      normalizeExternalAgentStatus({
        state: "needs_input",
        summary: "Which DB?",
        prUrl: "https://gh/pr/1",
        extra: 1,
      })
    ).toEqual({
      state: "needs_input",
      summary: "Which DB?",
      prUrl: "https://gh/pr/1",
    });
    expect(normalizeExternalAgentStatus({ state: "thinking" })).toBeNull();
    expect(normalizeExternalAgentStatus(null)).toBeNull();
    expect(statusKey({ state: "running" })).not.toBe(
      statusKey({ state: "running", prUrl: "x" })
    );
  });

  it("posts ONCE per state change; an unchanged state posts nothing", async () => {
    const runId = await dispatchedRun(POLLED);
    ran({ state: "running", branch: "feat/x" });
    await pollExternalAgentRuns();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({
      verbId: "x_status",
      agentUserId: POLLED,
      userId: OWNER,
      observability: "mirror",
    });
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toMatchObject({ agentUserId: POLLED, kind: "update" });
    expect(String(h.posts[0]!.content)).toContain("feat/x");

    await pollExternalAgentRuns(); // same state
    expect(h.calls).toHaveLength(2);
    expect(h.posts).toHaveLength(1);

    ran({ state: "running", branch: "feat/x", prUrl: "https://gh/pr/9" });
    await pollExternalAgentRuns(); // changed
    expect(h.posts).toHaveLength(2);
    expect(String(h.posts[1]!.content)).toContain("https://gh/pr/9");
    expect((await runRow(runId)).status).toBe("running");
  });

  it("needs_input ⇒ a QUESTION card posted as the agent", async () => {
    const runId = await dispatchedRun(POLLED);
    ran({ state: "needs_input", summary: "Postgres or SQLite?" });
    await pollExternalAgentRuns();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toMatchObject({
      agentUserId: POLLED,
      kind: "question",
      content: "Postgres or SQLite?",
    });
    expect((await runRow(runId)).external_agent.status).toBe("needs_input");
  });

  it("done ⇒ the run capture lands (completed) and polling stops", async () => {
    const runId = await dispatchedRun(POLLED);
    ran({
      state: "done",
      summary: "Shipped the page",
      prUrl: "https://gh/pr/2",
    });
    await pollExternalAgentRuns();
    const row = await runRow(runId);
    expect(row.status).toBe("completed");
    expect(row.summary).toBe("Shipped the page");
    expect(row.external_agent.status).toBe("done");
    h.calls.length = 0;
    await pollExternalAgentRuns();
    expect(h.calls).toHaveLength(0);
  });

  it("a binding without a status verb is never polled", async () => {
    await dispatchedRun(NO_STATUS);
    await pollExternalAgentRuns();
    expect(h.calls).toHaveLength(0);
    expect(h.posts).toHaveLength(0);
  });

  it("a PROPOSED status read pauses polling while its proposal is pending", async () => {
    const runId = await dispatchedRun(POLLED);
    const proposalId = randomUUID();
    await q(`insert into proposals (id, status) values ($1, 'pending')`, [
      proposalId,
    ]);
    h.next = {
      kind: "proposed",
      proposalId,
      reviewUrl: "https://pod/open/x",
      ackState: "pending",
    };
    await pollExternalAgentRuns();
    expect((await runRow(runId)).external_agent.pollBlockedBy).toBe(proposalId);
    h.calls.length = 0;
    await pollExternalAgentRuns();
    expect(h.calls).toHaveLength(0);
  });
});
