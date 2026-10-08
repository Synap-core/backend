/**
 * An approved PROPOSED agent start is recorded on its run like a direct start:
 * `externalAgent` from the approved execution's result, run back to `running`,
 * once (a double approve records once), and only for the binding's own start
 * verb on a proposed external-agent run.
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
  posts: [] as Array<Record<string, unknown>>,
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
} from "@synap/database";
import { recordApprovedAgentStart } from "../approved-start.js";

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

async function proposedRun(status = "proposed") {
  const sessionId = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, metadata, criteria, channel_id) values ($1, $2, 'g', 'active', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, $3)`,
    [sessionId, OWNER, randomUUID()]
  );
  const runId = randomUUID();
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, executor, status, input, created_by, started_at, completed_at)
     values ($1, $2, $3, 'external-agent', $4, '{}'::jsonb, $5, now(), now())`,
    [runId, randomUUID(), sessionId, status, OWNER]
  );
  return runId;
}
const row = async (id: string) =>
  (
    await q<{
      status: string;
      completed_at: unknown;
      external_agent: Record<string, unknown> | null;
    }>(
      `select status, completed_at, external_agent from playbook_runs where id = $1`,
      [id]
    )
  ).rows[0]!;

describe("recordApprovedAgentStart", () => {
  beforeAll(async () => {
    for (const t of [users, links, tools, focusSessions, playbookRuns]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await q(
      `insert into users (id, email, name, timezone, user_type, agent_type) values ($1, 'o@x', 'O', 'UTC', 'human', null), ($2, 'a@x', 'A', 'UTC', 'agent', 'cloud')`,
      [OWNER, AGENT]
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
    h.posts.length = 0;
  });

  it("records externalAgent from the approved result and puts the run back to running — once", async () => {
    const runId = await proposedRun();
    const call = () =>
      recordApprovedAgentStart({
        proposal: { agentUserId: AGENT },
        verbId: "acme_start",
        parameters: { runId },
        result: { taskId: "t-7", url: "https://acme/t/7" },
      });
    expect(await call()).toEqual({ status: "recorded", runId });
    const r = await row(runId);
    expect(r.status).toBe("running");
    expect(r.completed_at).toBeNull();
    expect(r.external_agent).toMatchObject({
      agentUserId: AGENT,
      toolId: TOOL,
      provider: "acme",
      externalId: "t-7",
      url: "https://acme/t/7",
      status: "running",
    });
    expect(h.posts).toHaveLength(1);
    expect((await call()).status).toBe("skipped");
    expect(h.posts).toHaveLength(1);
  });

  it("any other verb is not a start", async () => {
    const runId = await proposedRun();
    expect(
      await recordApprovedAgentStart({
        proposal: { agentUserId: AGENT },
        verbId: "acme_send",
        parameters: { runId },
        result: {},
      })
    ).toEqual({ status: "not_a_start" });
    expect((await row(runId)).external_agent).toBeNull();
  });

  it("a run that is not proposed is left alone", async () => {
    const runId = await proposedRun("failed");
    expect(
      (
        await recordApprovedAgentStart({
          proposal: { agentUserId: AGENT },
          verbId: "acme_start",
          parameters: { runId },
          result: { taskId: "x" },
        })
      ).status
    ).toBe("skipped");
    expect((await row(runId)).status).toBe("failed");
  });

  it("the executor's PENDING start (pending_start + proposalId) is replaced by the real hand-off; a recorded one is not", async () => {
    const runId = await proposedRun();
    await q(
      `update playbook_runs set external_agent = $2::jsonb where id = $1`,
      [
        runId,
        JSON.stringify({
          agentUserId: AGENT,
          toolId: TOOL,
          provider: "acme",
          externalId: null,
          url: null,
          status: "pending_start",
          proposalId: "p-1",
          startedAt: new Date().toISOString(),
        }),
      ]
    );
    const call = (taskId: string) =>
      recordApprovedAgentStart({
        proposal: { agentUserId: AGENT },
        verbId: "acme_start",
        parameters: { runId },
        result: { taskId },
      });
    expect(await call("t-9")).toEqual({ status: "recorded", runId });
    const r = await row(runId);
    expect(r.status).toBe("running");
    expect(r.external_agent).toMatchObject({
      status: "running",
      externalId: "t-9",
    });
    expect(r.external_agent).not.toHaveProperty("proposalId");
    // The room line names the service, never a raw link.
    expect(String(h.posts.at(-1)?.content)).not.toMatch(/https?:/);
    expect((await call("t-10")).status).toBe("skipped");
    expect((await row(runId)).external_agent).toMatchObject({
      externalId: "t-9",
    });
  });
});
