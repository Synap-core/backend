/**
 * THE RUN JOURNEY, through the real doors, read back out of PGlite:
 *   1. cron → playbook → an external agent: the playbook's schedule compiles to
 *      its backing automation (`materializePlaybookCronAutomation`), the stored
 *      node runs through the real `playbook_run` step into the one spine
 *      (`runPlaybook`, registered as apps/api does at boot), handed to the
 *      person's agent: the run is born `queued`, that agent its holder;
 *   2. the agent's first post in the session room claims it: `running`;
 *   3. its output, captured through the run's capture door
 *      (`applyRunCapture`), completes the run and links what it produced;
 *   4. the same schedule handed to nobody runs on Synap AI: born `queued` for
 *      Synap AI, claimed when its turn starts, and a turn that wrote nothing
 *      ends `failed` with `stop_reason = no_effect` through the IS's turn-end
 *      door (`POST /focus-sessions/:id/complete-run`).
 *
 * Stubbed, and why: the executor registry (a spy that answers `queued` as the
 * real executors do for a run not yet claimed), the A2AI worker (its claim is
 * reproduced with the same `claimRun` call, pinned in its own suite), the
 * governance membrane (granted), notifications, realtime, event appends and
 * the parent-automation settle (no transport).
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

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
      close: () => Promise<void>;
    },
    db: null as unknown,
    dispatched: [] as Array<{ ref: string; input: Record<string, unknown> }>,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: await h.init(),
    getDb: async () => h.init(),
    eventRepository: { append: async () => undefined },
    emitMessageEvent: async () => undefined,
  };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => undefined,
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  settleParentAutomationRunFromChild: async () => undefined,
}));
// "Dispatched" = an executor was asked to run: recorded, answered `queued`.
vi.mock("../executors/registry.js", () => ({
  resolveExecutor: (ref: string) => ({
    ref,
    run: async (ctx: { input: Record<string, unknown> }) => {
      h.dispatched.push({ ref, input: ctx.input });
      return { status: "queued" };
    },
  }),
}));
vi.mock("../../focus-sessions/notify-needs-you.js", () => ({
  notifySessionNeedsYou: async () => undefined,
}));
vi.mock("../../focus-sessions/session-recall.js", () => ({
  enqueueSessionRecall: async () => undefined,
}));
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: () => undefined,
}));
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: async () => ({ granted: true }),
}));
vi.mock(
  "../../proposals/expire-lapsed-proposals.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    expireSessionEphemerals: async () => 0,
  })
);
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => "evt",
}));
vi.mock("../../../notifications/expo-push.js", () => ({
  sendExpoPush: async () => ({ sent: 1, revoked: 0, failed: 0 }),
}));
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: async () => false,
}));
vi.mock("../../../utils/channel-visibility.js", async (importOriginal) => {
  const { sql } = await import("drizzle-orm");
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    channelVisibilityWhere: () => sql`true`,
  };
});
vi.mock("../../../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: async () => true,
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import type { PgTable } from "drizzle-orm/pg-core";
import {
  and,
  claimRun,
  drizzleSql,
  eq,
  playbookRuns,
  type FlowDefinition,
} from "@synap/database";
import { executePlaybookRun } from "@synap/jobs/workers/steps/playbook-run.js";
import { registerPlaybookRunner } from "@synap/jobs/workers/capability-dispatch.js";
import {
  allSchemaTables,
  pgliteTableDdl,
} from "../../../__tests__/pglite-ddl.js";
import { registerFocusSessionsRoutes } from "../../../routers/hub-protocol/rest/focus-sessions.js";
import { materializePlaybookCronAutomation } from "../cron-automation.js";
import { runPlaybook } from "../run-playbook.js";
import { postChannelMessage } from "../../messaging/post-message.js";
import { applyRunCapture } from "../../runs/apply-run-capture.js";
import { createFocusSession } from "../../focus-sessions/create-session.js";

const USER = "11111111-1111-4111-8111-111111111111";
/** The person's agent with its own key (`pull`): `synap worker` runs it. */
const AGENT = "22222222-2222-4222-8222-222222222222";
/** Synap AI's agent, as the IS's key reports it. */
const IS_AGENT = "33333333-3333-4333-8333-333333333333";
const WS = "88888888-8888-4888-8888-888888888888";
const PLAYBOOK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

type RunRow = {
  id: string;
  status: string;
  executor: string;
  stop_reason: string | null;
  holder: {
    kind: string;
    id: string | null;
    claimedAt: string | null;
  } | null;
  session_id: string;
};
const theRun = async (): Promise<RunRow> => {
  const rows = (
    await q<RunRow>(
      `select id, status, executor, stop_reason, holder, session_id from playbook_runs`
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return rows[0]!;
};
const sessionOf = async (id: string) =>
  (
    await q<{ channel_id: string | null; status: string }>(
      `select channel_id, status from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!;

/** One cron slot of the playbook's schedule, through the stored node. */
async function fireSlot(schedule: { handToAgentId?: string }) {
  const automationId = await materializePlaybookCronAutomation(
    {
      id: PLAYBOOK,
      workspaceId: WS,
      name: "Weekly account review",
      status: "active",
      subjectProfile: { profileSlug: "company", filter: "status = active" },
      schedule: { cron: "0 9 * * MON", enabled: true, ...schedule },
    },
    { userId: USER }
  );
  if (!automationId) throw new Error("no backing automation was written");
  const row = await q<{ flow_definition: FlowDefinition }>(
    `select flow_definition from automations where id = $1`,
    [automationId]
  );
  const node = row.rows[0]?.flow_definition.nodes.find(
    (n) => n.type === "playbook_run"
  );
  if (!node) throw new Error("compiler emitted no playbook_run node");
  const automationRunId = randomUUID();
  return executePlaybookRun(
    node.data as unknown as Parameters<typeof executePlaybookRun>[0],
    {
      trigger: { payload: { scheduledAt: new Date().toISOString() } },
      steps: {},
      loop: { item: { id: COMPANY }, index: 0 },
    } as unknown as Parameters<typeof executePlaybookRun>[1],
    WS,
    USER,
    {
      automationId,
      automationRunId,
      chainDepth: 0,
      rootRunId: automationRunId,
      chainAutomationIds: [automationId],
    }
  );
}

/** The IS's internal key: acting for the person, its agent verified. */
function isApp() {
  const a = new OpenAPIHono();
  a.use("*", async (c, next) => {
    c.set("userId" as never, USER as never);
    c.set(
      "scopes" as never,
      ["hub-protocol.write", "hub-protocol.read"] as never
    );
    c.set("agentUserId" as never, IS_AGENT as never);
    await next();
  });
  registerFocusSessionsRoutes(a as never);
  return a;
}

beforeAll(async () => {
  await h.init();
  const seen = new Set<string>();
  for (const t of allSchemaTables()) {
    const ddl = pgliteTableDdl(t as PgTable);
    const name = /create table "([^"]+)"/.exec(ddl)?.[1] ?? ddl;
    if (seen.has(name)) continue;
    seen.add(name);
    await h.client!.exec(ddl);
  }
  expect(seen.size).toBeGreaterThan(50);
  await h.client!.exec(
    `create unique index on links (from_type, from_id, to_type, to_id, link_type)`
  );
  await q(
    `insert into users (id, email, name, timezone, user_type, agent_type) values
      ($1, 'a@x.test', 'Antoine', 'UTC', 'human', null),
      ($2, 'cc@x.test', 'claude-code-devbox', 'UTC', 'agent', null),
      ($3, 'is@x.test', 'Synap AI', 'UTC', 'agent', 'meta')`,
    [USER, AGENT, IS_AGENT]
  );
  await q(
    `insert into api_keys (id, user_id, key_type, is_active, linked_user_id) values ($1, $2, 'hub_inbound', true, $3)`,
    [randomUUID(), AGENT, USER]
  );
  await q(
    `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`,
    [WS, USER]
  );
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, executor, status, metadata, params, input_strategy, channel_spec, expected_outputs, stages, criteria)
     values ($1, $2, $3, 'Weekly account review', 'Review the account', 'is-agent', 'active', '{}'::jsonb, '[]'::jsonb, '{"kind":"none"}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)`,
    [PLAYBOOK, WS, USER]
  );
  await q(
    `insert into entities (id, workspace_id, user_id, title, type) values ($1, $2, $3, 'Acme', 'company')`,
    [COMPANY, WS, USER]
  );
  registerPlaybookRunner((input) => runPlaybook(input as never) as never);
});

beforeEach(async () => {
  h.dispatched.length = 0;
  await h.client!.exec(
    "delete from focus_sessions; delete from playbook_runs; delete from channels; delete from messages; delete from links; delete from automations;"
  );
});

afterAll(async () => {
  await h.client?.close();
});

describe("the run journey: cron → playbook → an external agent → its output", () => {
  it("born queued for the agent, claimed by its first room post, completed by its captured output", async () => {
    const out = await fireSlot({ handToAgentId: AGENT });
    expect(out.status).toBe("queued");

    // 1. Born queued, the agent its holder, nobody working it yet.
    const born = await theRun();
    expect(born).toMatchObject({
      status: "queued",
      executor: "external-agent",
    });
    expect(born.holder).toMatchObject({ kind: "agent", id: AGENT });
    expect(born.holder?.claimedAt ?? null).toBeNull();
    // The built-in AI is not ALSO dispatched for a handed run.
    expect(h.dispatched).toEqual([]);

    // 2. The agent's first post in the session room claims it.
    const { channel_id: channelId } = await sessionOf(born.session_id);
    expect(channelId).not.toBeNull();
    await postChannelMessage({
      channelId: channelId!,
      content: "Picking this up.",
      userId: USER,
      agentUserId: AGENT,
    });
    const claimed = await theRun();
    expect(claimed.status).toBe("running");
    expect(claimed.holder?.claimedAt).not.toBeNull();

    // 3. Its output completes the run, the produced record linked.
    const [row] = await q<Parameters<typeof applyRunCapture>[0]["run"]>(
      `select id, status, summary, error, completed_at as "completedAt", session_id as "sessionId", workspace_id as "workspaceId" from playbook_runs where id = $1`,
      [claimed.id]
    ).then((r) => r.rows);
    await applyRunCapture({
      run: row!,
      status: "completed",
      summary: "Reviewed Acme.",
      producedEntityIds: [COMPANY],
    });
    expect((await theRun()).status).toBe("completed");
    const produced = await q<{ to_id: string }>(
      `select to_id from links where from_type = 'session' and from_id = $1 and link_type = 'produced'`,
      [born.session_id]
    );
    expect(produced.rows).toEqual([{ to_id: COMPANY }]);
  });

  it("a post by ANOTHER agent claims nothing (only the run handed to that agent)", async () => {
    await fireSlot({ handToAgentId: AGENT });
    const born = await theRun();
    const { channel_id: channelId } = await sessionOf(born.session_id);
    await postChannelMessage({
      channelId: channelId!,
      content: "Not mine.",
      userId: USER,
      agentUserId: IS_AGENT,
    });
    expect((await theRun()).status).toBe("queued");
  });
});

describe("the run journey: Synap AI, a turn with no effect", () => {
  it("born queued for Synap AI, claimed at its turn's start, and a turn that wrote nothing ends failed(no_effect)", async () => {
    await fireSlot({});
    expect(h.dispatched.map((d) => d.ref)).toEqual(["is-agent"]);
    const born = await theRun();
    expect(born.status).toBe("queued");
    expect(born.holder).toMatchObject({ kind: "synap_ai" });

    // The A2AI worker's claim as its turn starts (a2ai-response-trigger.ts).
    await claimRun(h.db as never, {
      where: and(
        eq(playbookRuns.sessionId, born.session_id),
        drizzleSql`${playbookRuns.holder} ->> 'kind' = 'synap_ai'`
      ),
      holder: { kind: "synap_ai", id: IS_AGENT },
      reason: "Synap AI started its turn.",
    });
    expect((await theRun()).status).toBe("running");

    // The IS reports the turn's end; nothing was written on the session.
    const res = await isApp().request(
      `/focus-sessions/${born.session_id}/complete-run`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome: "completed", turnKey: randomUUID() }),
      }
    );
    expect(res.status).toBe(200);
    const ended = await theRun();
    expect(ended.status).toBe("failed");
    expect(ended.stop_reason).toBe("no_effect");
  });
});

describe("a person's start that names an agent takes the one launch path", () => {
  it("the run is handed to that agent by the run choice, born queued for it", async () => {
    const res = await createFocusSession({
      userId: USER,
      goal: `Review Acme ${randomUUID()}`,
      workspaceId: WS,
      templateId: PLAYBOOK,
      agentIds: [AGENT],
      forceCreate: true,
    });
    if (res.status !== "created") throw new Error(res.status);
    const run = await theRun();
    expect(run).toMatchObject({
      status: "queued",
      executor: "external-agent",
      session_id: res.session.id,
    });
    expect(run.holder).toMatchObject({ kind: "agent", id: AGENT });
    // A pull agent finds it handed to it: no executor is dispatched.
    expect(h.dispatched).toEqual([]);
  });

  it("an agent that cannot take it refuses the start by name, nothing written", async () => {
    await expect(
      createFocusSession({
        userId: USER,
        goal: `Review Acme ${randomUUID()}`,
        workspaceId: WS,
        templateId: PLAYBOOK,
        agentIds: [randomUUID()],
        forceCreate: true,
      })
    ).rejects.toThrow(/No agent .* to hand this run to/);
    expect((await q(`select id from focus_sessions`)).rows).toEqual([]);
  });
});
