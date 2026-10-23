/**
 * A SCHEDULED playbook hands each run's session to a named agent, and that
 * agent's orient finds it (`handedToYou`) — the loop `synap worker` polls.
 *
 * Driven from the schedule, not from a hand-built node: the playbook's
 * `schedule.handToAgentId` goes through the real reconciler
 * (`materializePlaybookCronAutomation` → `buildPlaybookRunFlowDefinition`,
 * kind-bound → query → loop → playbook_run) onto a stored automation row, the
 * stored node's `data` goes WHOLE into the real `playbook_run` step
 * (`executePlaybookRun`, @synap/jobs) with a loop item as the subject, the step
 * reaches the real spine (`runPlaybook`, registered as the runner exactly as
 * apps/api does at boot), and the session row is read back out of PGlite and
 * through the real orient read (`buildStartHere` → `handedToYou`).
 *
 * Asserted:
 *   - the session is the PERSON's, its roster carries the agent, the agent's
 *     orient lists it, another agent's does not;
 *   - the playbook's own executor (the built-in AI for `is-agent`) is NOT
 *     dispatched for a handed run — while the same schedule without the field
 *     dispatches it once (the row that rules out "never dispatches");
 *   - an unknown, a paused, a foreign and a pod-run agent each FAIL the step by
 *     name and write no session (the rows that rule out "skip the route").
 *
 * Stubbed: the executor registry (a spy — what "dispatched" means here), the
 * needs-you notifier and the recall enqueue (pg-boss), realtime.
 *
 * NOT COVERED: a `dispatch`-reach hand-off (the external-agent executor's own
 * binding path, `external-agent-executor.dispatch.pglite.test.ts`); only that
 * such a run is routed to that executor, which the spy records.
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

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
  dispatched: [] as Array<{ ref: string; input: Record<string, unknown> }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, {
    schema: {
      focusSessions: actual.focusSessions as never,
      playbooks: actual.playbooks as never,
      entities: actual.entities as never,
      channels: actual.channels as never,
      users: actual.users as never,
      workspaceMembers: actual.workspaceMembers as never,
      apiKeys: actual.apiKeys as never,
    },
  });
  const mocked = { ...actual, getDb: async () => db };
  Object.defineProperty(mocked, "db", { get: () => db, enumerable: true });
  return mocked;
});
// "Dispatched" = an executor was asked to run. Recorded, never run.
vi.mock("../executors/registry.js", () => ({
  resolveExecutor: (ref: string) => ({
    ref,
    run: async (ctx: { input: Record<string, unknown> }) => {
      h.dispatched.push({ ref, input: ctx.input });
      return { status: "running" };
    },
  }),
}));
vi.mock("../../focus-sessions/notify-needs-you.js", () => ({
  notifySessionNeedsYou: async () => undefined,
}));
vi.mock("../../focus-sessions/session-recall.js", () => ({
  enqueueSessionRecall: async () => undefined,
}));
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitHubRealtimeEvent: () => undefined };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { PgTable as PgTableClass } from "drizzle-orm/pg-core";
import * as database from "@synap/database";
import type { FlowDefinition } from "@synap/database";
import { executePlaybookRun } from "@synap/jobs/workers/steps/playbook-run.js";
import { registerPlaybookRunner } from "@synap/jobs/workers/capability-dispatch.js";
import { materializePlaybookCronAutomation } from "../cron-automation.js";
import { runPlaybook } from "../run-playbook.js";
import { buildStartHere } from "../../discover/start-here.js";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
/** `claude-code-devbox`: an agent with its own key, acting for USER — `pull`. */
const AGENT = "22222222-2222-4222-8222-222222222222";
/** Another of USER's agents — its orient must not list AGENT's work. */
const AGENT_B = "33333333-3333-4333-8333-333333333333";
const PAUSED = "44444444-4444-4444-8444-444444444444";
/** Acts for OTHER, not USER. */
const THEIRS = "55555555-5555-4555-8555-555555555555";
/** An IS agent the pod runs itself (agentType, no key) — `pod` reach. */
const HOUSE = "66666666-6666-4666-8666-666666666666";
const WS = "88888888-8888-4888-8888-888888888888";
const PLAYBOOK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/**
 * The playbook_run node the stored SCHEDULE compiles to: the playbook's jsonb
 * `schedule` through the real reconciler (`materializePlaybookCronAutomation`
 * → `readSchedule` → `buildPlaybookRunFlowDefinition`), read back off the
 * backing automation row it writes. Kind-bound, so the node sits in a loop.
 */
async function compiledRunNode(schedule: { handToAgentId?: string }) {
  const automationId = await materializePlaybookCronAutomation(
    {
      id: PLAYBOOK,
      workspaceId: WS,
      name: "Weekly account review",
      status: "active",
      flowAutomationId: null,
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
  return node;
}

/** One cron slot's loop iteration over COMPANY, through the real step. */
async function fireSlot(schedule: { handToAgentId?: string }) {
  const node = await compiledRunNode(schedule);
  return executePlaybookRun(
    node.data as unknown as Parameters<typeof executePlaybookRun>[0],
    {
      trigger: { payload: { scheduledAt: new Date().toISOString() } },
      steps: {},
      loop: { item: { id: COMPANY }, index: 0 },
    } as unknown as Parameters<typeof executePlaybookRun>[1],
    WS,
    USER
  );
}

const handedTo = async (agentUserId: string) => {
  const s = await buildStartHere({
    caller: {} as never,
    userId: USER,
    agentUserId,
    pending: { status: "unavailable" },
    learnMoreSkill: "system/synap/concepts",
  });
  return s.handedToYou;
};

const sessions = () =>
  q<{ id: string; user_id: string; agent_ids: string[] }>(
    `select id, user_id, agent_ids from focus_sessions`
  ).then((r) => r.rows);

beforeAll(async () => {
  // EVERY table the database package declares (the route, the orient read and
  // the spine join across many of them; a hand list falls behind).
  const seen = new Set<string>();
  for (const t of Object.values(database)) {
    if (!is(t, PgTableClass)) continue;
    const name = getTableConfig(t as PgTable).name;
    if (seen.has(name)) continue;
    seen.add(name);
    await h.client!.exec(ddlFor(t as PgTable));
  }
  expect(seen.size).toBeGreaterThan(50);
  // createLinks upserts on the real unique edge.
  await h.client!.exec(
    `create unique index on links (from_type, from_id, to_type, to_id, link_type)`
  );
  await q(
    `insert into users (id, email, name, user_type, agent_type, agent_paused_at) values
      ($1, 'a@x.test', 'Antoine', 'human', null, null),
      ($2, 'cc@x.test', 'claude-code-devbox', 'agent', null, null),
      ($3, 'cx@x.test', 'Codex', 'agent', null, null),
      ($4, 'p@x.test', 'Paused Claude', 'agent', null, now()),
      ($5, 'o@x.test', 'Other', 'human', null, null),
      ($6, 'theirs@x.test', 'Their Claude', 'agent', null, null),
      ($7, 'house@x.test', 'Meta', 'agent', 'meta', null)`,
    [USER, AGENT, AGENT_B, PAUSED, OTHER, THEIRS, HOUSE]
  );
  // Operator links: AGENT, AGENT_B, PAUSED act for USER; THEIRS for OTHER.
  for (const [agent, operator] of [
    [AGENT, USER],
    [AGENT_B, USER],
    [PAUSED, USER],
    [THEIRS, OTHER],
  ]) {
    await q(
      `insert into api_keys (id, user_id, key_type, is_active, linked_user_id) values ($1, $2, 'hub_inbound', true, $3)`,
      [randomUUID(), agent, operator]
    );
  }
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
  // What apps/api does at boot: the step reaches the ONE spine.
  registerPlaybookRunner((input) => runPlaybook(input as never) as never);
});

beforeEach(async () => {
  h.dispatched.length = 0;
  await h.client!.exec(
    "delete from focus_sessions; delete from playbook_runs; delete from channels; delete from links; delete from automations;"
  );
});

afterAll(async () => {
  await h.client?.close();
});

describe("a scheduled playbook run handed to an agent", () => {
  it("the compiler carries the schedule's agent onto the playbook_run node", async () => {
    const handed = await compiledRunNode({ handToAgentId: AGENT });
    expect((handed.data as Record<string, unknown>).handToAgentId).toBe(AGENT);
    // Absent ⇒ the key is absent (existing definitions stay byte-identical).
    expect("handToAgentId" in (await compiledRunNode({})).data).toBe(false);
  });

  it("the session is the person's, the agent is on its roster, and the agent's orient lists it", async () => {
    const out = await fireSlot({ handToAgentId: AGENT });
    expect(out.status).toBe("running");
    const rows = await sessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: USER, agent_ids: [AGENT] });
    expect(out.sessionId).toBe(rows[0]!.id);

    expect(await handedTo(AGENT)).toMatchObject({
      count: 1,
      items: [{ id: rows[0]!.id }],
    });
    expect(await handedTo(AGENT_B)).toMatchObject({ count: 0, items: [] });
  });

  it("does NOT dispatch the playbook's own executor (the agent does the work)", async () => {
    await fireSlot({ handToAgentId: AGENT });
    expect(h.dispatched).toEqual([]);
    const run = await q<{ executor: string; status: string }>(
      `select executor, status from playbook_runs`
    );
    expect(run.rows).toEqual([
      { executor: "external-agent", status: "running" },
    ]);
  });

  it("control: the same schedule WITHOUT the field dispatches the built-in executor once and hands nobody", async () => {
    await fireSlot({});
    expect(h.dispatched.map((d) => d.ref)).toEqual(["is-agent"]);
    const rows = await sessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent_ids).toEqual([]);
    expect(await handedTo(AGENT)).toMatchObject({ count: 0 });
  });

  it.each([
    ["an unknown agent", randomUUID(), /No agent .* to hand this run to/],
    ["a paused agent", PAUSED, /Paused Claude is paused/],
    ["an agent acting for someone else", THEIRS, /does not act for the person/],
    ["a pod-run agent", HOUSE, /is run by the pod/],
  ])(
    "%s FAILS the step by name and starts nothing",
    async (_label, agentId, message) => {
      await expect(fireSlot({ handToAgentId: agentId })).rejects.toThrow(
        message
      );
      expect(await sessions()).toEqual([]);
      expect(h.dispatched).toEqual([]);
    }
  );
});
