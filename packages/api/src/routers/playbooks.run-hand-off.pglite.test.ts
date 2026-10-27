/**
 * A MANUAL playbook run can be handed to a named agent, exactly as a scheduled
 * run already can (`scheduled-run-hand-off.pglite.test.ts`).
 *
 * Driven through the REAL governed door (`playbooksRouter.run`, the procedure
 * Hub REST `POST /playbooks/:id/run` and MCP `synap_run_playbook` both reach
 * through `runPlaybookDoor`) into the real spine (`runPlaybook`), the real
 * route (`agent-dispatch/route.ts`), the real approval executor
 * (`playbook/run`) and the real orient read (`buildStartHere` → handedToYou),
 * on PGlite.
 *
 * Asserted:
 *   - a person's run handed to a PULL agent dispatches NOTHING (the executor
 *     spy stays empty), the run is `external-agent` + `running`, the agent is
 *     on the roster and its orient lists the session; the same run WITHOUT
 *     the field dispatches the built-in executor once (the row that rules out
 *     "never dispatches");
 *   - an unknown, paused, foreign or pod-run agent is refused BY NAME before
 *     the gate is asked, and nothing is written (the rows that rule out a
 *     silent fallback to the built-in AI);
 *   - a GATED run stores the field on its proposal, and approving it starts a
 *     handed run (nothing dispatched) — the replay keeps the hand-off;
 *   - an agent may hand a run only to itself: its run is held as the person's
 *     draft and accepting the draft starts the HANDED run, never the built-in
 *     executor (control: the same draft without the field dispatches it).
 *
 * Stubbed: the governance gate (records what reached it; proposes on demand),
 * the skill preflight (nothing to enable), the workspace write floor, the
 * read-only and audit middlewares, the executor registry (a spy — what
 * "dispatched" means here), the needs-you notifier, the recall enqueue and
 * realtime.
 *
 * NOT COVERED: a `dispatch`-reach agent (the external-agent executor's own
 * binding path); only that such a run is routed to that executor.
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
  gate: [] as Array<Record<string, unknown>>,
  propose: false,
  proposalId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
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
      workspaces: actual.workspaces as never,
      workspaceMembers: actual.workspaceMembers as never,
      apiKeys: actual.apiKeys as never,
    },
  });
  const mocked = { ...actual, getDb: async () => db };
  Object.defineProperty(mocked, "db", { get: () => db, enumerable: true });
  return mocked;
});
// "Dispatched" = an executor was asked to run. Recorded, never run.
vi.mock("../services/playbooks/executors/registry.js", () => ({
  resolveExecutor: (ref: string) => ({
    ref,
    run: async (ctx: { input: Record<string, unknown> }) => {
      h.dispatched.push({ ref, input: ctx.input });
      return { status: "running" };
    },
  }),
}));
vi.mock("../services/focus-sessions/notify-needs-you.js", () => ({
  notifySessionNeedsYou: async () => undefined,
}));
vi.mock("../services/focus-sessions/session-recall.js", () => ({
  enqueueSessionRecall: async () => undefined,
}));
vi.mock("../utils/domain-event-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitHubRealtimeEvent: () => undefined };
});
vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: async () => undefined,
}));
vi.mock("../services/playbooks/playbook-skill-preflight.js", () => ({
  findUnenabledPlaybookSkills: async () => [],
}));
// The gate: records the playbook-run asks; proposes when told to.
vi.mock("../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
      if (opts.subjectType === "playbook" && opts.action === "run") {
        h.gate.push(opts);
        if (h.propose) {
          return { proposalId: h.proposalId, proposalType: "run" };
        }
      }
      return { allowed: true };
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { PgTable as PgTableClass } from "drizzle-orm/pg-core";
import * as database from "@synap/database";
import { playbooksRouter } from "./playbooks.js";
import { startHeldRun } from "../services/playbooks/run-playbook.js";
import { buildStartHere } from "../services/discover/start-here.js";
import { registerPlaybookExecutors } from "./proposals/executors/playbook.js";
import { proposalExecRegistry } from "./proposals/execution-registry.js";
import type { Context } from "../types/context.js";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
/** `claude-code`: an agent with its own key, acting for USER — `pull`. */
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
const PROPOSAL = h.proposalId;

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

/** The person at the browser (no agent on the transport). */
const asPerson = () =>
  playbooksRouter.createCaller({
    authenticated: true,
    userId: USER,
    workspaceId: WS,
  } as unknown as Context);

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
const runs = () =>
  q<{ executor: string; status: string }>(
    `select executor, status from playbook_runs`
  ).then((r) => r.rows);

beforeAll(async () => {
  const seen = new Set<string>();
  for (const t of Object.values(database)) {
    if (!is(t, PgTableClass)) continue;
    const name = getTableConfig(t as PgTable).name;
    if (seen.has(name)) continue;
    seen.add(name);
    await h.client!.exec(ddlFor(t as PgTable));
  }
  expect(seen.size).toBeGreaterThan(50);
  await h.client!.exec(
    `create unique index on links (from_type, from_id, to_type, to_id, link_type)`
  );
  await q(
    `insert into users (id, email, name, user_type, agent_type, agent_paused_at) values
      ($1, 'a@x.test', 'Antoine', 'human', null, null),
      ($2, 'cc@x.test', 'claude-code', 'agent', null, null),
      ($3, 'cx@x.test', 'Codex', 'agent', null, null),
      ($4, 'p@x.test', 'Paused Claude', 'agent', null, now()),
      ($5, 'o@x.test', 'Other', 'human', null, null),
      ($6, 'theirs@x.test', 'Their Claude', 'agent', null, null),
      ($7, 'house@x.test', 'Meta', 'agent', 'meta', null)`,
    [USER, AGENT, AGENT_B, PAUSED, OTHER, THEIRS, HOUSE]
  );
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
  await q(`insert into workspaces (id, name) values ($1, 'CRM')`, [WS]);
  await q(
    `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`,
    [WS, USER]
  );
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, executor, status, metadata, params, input_strategy, channel_spec, expected_outputs, stages, criteria)
     values ($1, $2, $3, 'Score a list', 'Score every lead of the list', 'is-agent', 'active', '{}'::jsonb, '[]'::jsonb, '{"kind":"none"}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)`,
    [PLAYBOOK, WS, USER]
  );
  registerPlaybookExecutors();
});

beforeEach(async () => {
  h.dispatched.length = 0;
  h.gate.length = 0;
  h.propose = false;
  await h.client!.exec(
    "delete from focus_sessions; delete from playbook_runs; delete from channels; delete from links; delete from proposals;"
  );
});

afterAll(async () => {
  await h.client?.close();
});

describe("a manual playbook run handed to an agent (playbooks.run)", () => {
  it("dispatches nothing: the run is the agent's, on its roster and in its orient", async () => {
    const res = await asPerson().run({
      playbookId: PLAYBOOK,
      handToAgentId: AGENT,
    });
    expect(res.status).toBe("running");
    expect(h.dispatched).toEqual([]);
    expect(await runs()).toEqual([
      { executor: "external-agent", status: "running" },
    ]);
    const rows = await sessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: USER, agent_ids: [AGENT] });
    expect(await handedTo(AGENT)).toMatchObject({
      count: 1,
      items: [{ id: rows[0]!.id }],
    });
    expect(await handedTo(AGENT_B)).toMatchObject({ count: 0, items: [] });
  });

  it("control: the same run WITHOUT the field dispatches the built-in executor once and hands nobody", async () => {
    const res = await asPerson().run({ playbookId: PLAYBOOK });
    expect(res.status).toBe("running");
    expect(h.dispatched.map((d) => d.ref)).toEqual(["is-agent"]);
    const rows = await sessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent_ids).toEqual([]);
  });

  it.each([
    ["an unknown agent", randomUUID(), /No agent .* to hand this run to/],
    ["a paused agent", PAUSED, /Paused Claude is paused/],
    ["an agent acting for someone else", THEIRS, /does not act for the person/],
    ["a pod-run agent", HOUSE, /is run by the pod/],
  ])(
    "%s is refused by name before the gate, and nothing starts",
    async (_label, agentId, message) => {
      await expect(
        asPerson().run({ playbookId: PLAYBOOK, handToAgentId: agentId })
      ).rejects.toThrow(message);
      expect(h.gate).toEqual([]);
      expect(await sessions()).toEqual([]);
      expect(h.dispatched).toEqual([]);
    }
  );
});

describe("a GATED manual run keeps its hand-off through the approval", () => {
  it("the proposal carries handToAgentId and approving it starts the handed run", async () => {
    h.propose = true;
    const res = await asPerson().run({
      playbookId: PLAYBOOK,
      handToAgentId: AGENT,
    });
    expect(res.status).toBe("proposed");
    expect(await sessions()).toEqual([]);
    const data = h.gate[0]!.data as Record<string, unknown>;
    expect(data).toMatchObject({ playbookId: PLAYBOOK, handToAgentId: AGENT });

    // The person approves: the real `playbook/run` executor replays it.
    h.propose = false;
    await q(`insert into proposals (id, status) values ($1, 'pending')`, [
      PROPOSAL,
    ]);
    const executor = proposalExecRegistry.resolveExact("playbook/run")!;
    const out = (await executor.execute({
      proposal: {
        id: PROPOSAL,
        workspaceId: WS,
        targetType: "playbook",
        proposalType: "run",
        agentUserId: null,
        sourceMessageId: null,
        data: { data },
      },
      userId: USER,
      input: { proposalId: PROPOSAL },
      deps: {
        reportProposalOutcome: vi.fn(),
        emitProposalReviewed: vi.fn(),
      },
    } as never)) as Record<string, unknown>;
    expect(out).toMatchObject({ success: true });

    expect(h.dispatched).toEqual([]);
    expect(await runs()).toEqual([
      { executor: "external-agent", status: "running" },
    ]);
    const rows = await sessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: USER, agent_ids: [AGENT] });
  });
});

describe("an agent hands a run only to itself, and the hold keeps it", () => {
  const asAgent = (agentUserId: string, handToAgentId?: string) =>
    asPerson().run({
      playbookId: PLAYBOOK,
      agentUserId,
      ...(handToAgentId ? { handToAgentId } : {}),
    });

  it("handing to ANOTHER agent is refused before the gate", async () => {
    await expect(asAgent(AGENT, AGENT_B)).rejects.toThrow(/hand-off gate/);
    expect(h.gate).toEqual([]);
    expect(await sessions()).toEqual([]);
  });

  it("its own run is a draft; accepting it starts the HANDED run, nothing dispatched", async () => {
    const res = await asAgent(AGENT, AGENT);
    expect(res.status).toBe("draft");
    expect(h.dispatched).toEqual([]);
    const started = await startHeldRun(res.session!.id);
    expect(started.status).toBe("started");
    expect(h.dispatched).toEqual([]);
    expect(await runs()).toEqual([
      { executor: "external-agent", status: "running" },
    ]);
  });

  it("control: the same draft WITHOUT the field starts the built-in executor on accept", async () => {
    const res = await asAgent(AGENT);
    expect(res.status).toBe("draft");
    await startHeldRun(res.session!.id);
    expect(h.dispatched.map((d) => d.ref)).toEqual(["is-agent"]);
  });
});
