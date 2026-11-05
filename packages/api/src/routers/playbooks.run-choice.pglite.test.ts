/**
 * WHO RUNS IT — asked once, then remembered (slice 5a, plan v2 66d229dc;
 * founder Q1: "ask once, save as the playbook's list"). Content Studio's
 * "Package ideas" asks on the first press and the pod remembers the answer.
 *
 * Driven through the REAL doors (`playbooksRouter.run` with `runOn` /
 * `handToAgentId` + `remember`, `playbooksRouter.runChoice`,
 * `playbooksRouter.setRunChoice`) into the real spine (`runPlaybook` →
 * `resolveRunChoice`), the real store (`setRunChoice` / `readStoredRunChoice`,
 * the `assigned_to` edge) and the real roster (`readAgentsForHandoff`, its
 * wake marks), on PGlite.
 *
 * Asserted (each row rules out a rule that would pass the others):
 *   - nothing stored: the read says ASK, offers Synap AI first (recommended)
 *     then the person's agents, and the next run is the playbook's default;
 *   - answering with Synap AI + remember: this run is Synap AI, the next read
 *     does not ask, and a later run with NO field runs on Synap AI `stored`
 *     (rules out "remember writes nothing");
 *   - answering with an AWAKE agent + remember: a later bare run is handed to
 *     it, nothing dispatched (rules out "stored is ignored");
 *   - a remembered agent NOT awake: a later bare run goes to Synap AI as a
 *     `fallback`, naming the agent passed over and why (rules out "hand it
 *     to an agent nothing runs");
 *   - a playbook that runs only on agents never falls to Synap AI, and refuses
 *     Synap AI for a run;
 *   - one choice per person per playbook: choosing again replaces it;
 *   - remember is a person's act: an agent's run with remember is refused and
 *     nothing is stored.
 *
 * Stubbed as in `playbooks.run-hand-off.pglite.test.ts`: the governance gate
 * (allows), the skill preflight, the workspace write floor, the read-only and
 * audit middlewares, the executor registry (a spy: what "dispatched" means),
 * the needs-you notifier, the recall enqueue and realtime.
 *
 * NOT COVERED: a `dispatch`-reach agent (its wake comes from its binding,
 * pinned in `agent-wake.test.ts`); the Hub REST and MCP doors reach this
 * procedure through `runPlaybookDoor` (`playbooks.doors.test.ts`).
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
  dispatched: [] as Array<{ ref: string }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  const mocked = { ...actual, getDb: async () => db };
  Object.defineProperty(mocked, "db", { get: () => db, enumerable: true });
  return mocked;
});
vi.mock("../services/playbooks/executors/registry.js", () => ({
  resolveExecutor: (ref: string) => ({
    ref,
    run: async () => {
      h.dispatched.push({ ref });
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
vi.mock("../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async () => ({ allowed: true }),
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { PgTable as PgTableClass } from "drizzle-orm/pg-core";
import * as database from "@synap/database";
import { playbooksRouter } from "./playbooks.js";
import type { Context } from "../types/context.js";

const USER = randomUUID();
/** Claude Code on the person's devbox: its runner served it 30 s ago — awake. */
const RUNNING = randomUUID();
/** Codex: a key, never served by a runner — not awake (cant_wake). */
const IDLE = randomUUID();
/** The IS orchestrator registry row: what a Synap AI choice is stored from. */
const SYNAP_AI_ROW = randomUUID();
const WS = randomUUID();
const PLAYBOOK = randomUUID();
/** A playbook that runs only on agents (`external-agent`). */
const AGENTS_ONLY = randomUUID();

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

const asPerson = () =>
  playbooksRouter.createCaller({
    authenticated: true,
    userId: USER,
    workspaceId: WS,
  } as unknown as Context);

/** What the newest run recorded about who ran it. */
const lastRun = () =>
  q<{ executor: string; run_on: Record<string, unknown> | null }>(
    `select executor, run_on from playbook_runs order by started_at desc limit 1`
  ).then((r) => r.rows[0]);
const choiceEdges = () =>
  q<{ from_type: string; from_id: string }>(
    `select from_type, from_id from links where link_type = 'assigned_to' and to_id = $1`,
    [PLAYBOOK]
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
  // 0329: one choice per person per target.
  await h.client!.exec(
    `create unique index on links (to_type, to_id, (coalesce(metadata->>'ownerId', ''))) where link_type = 'assigned_to'`
  );
  await q(
    `insert into users (id, email, name, user_type, agent_type, created_by_user_id) values
      ($1, 'a@x.test', 'Antoine', 'human', null, null),
      ($2, 'cc@x.test', 'Claude Code', 'agent', 'claude-code', $1),
      ($3, 'cx@x.test', 'Codex', 'agent', 'codex', $1)`,
    [USER, RUNNING, IDLE]
  );
  await q(
    `insert into api_keys (id, user_id, key_type, is_active, linked_user_id, last_used_at, instance_label, worker_served_at, created_at) values
      ($1, $2, 'hub_inbound', true, $4, now(), 'devbox', now() - interval '30 seconds', now()),
      ($3, $5, 'hub_inbound', true, $4, now(), 'MacBook', null, now())`,
    [randomUUID(), RUNNING, randomUUID(), USER, IDLE]
  );
  await q(
    `insert into agents (id, name, agent_slug, active, owner_type) values ($1, 'Meta', 'meta', true, 'system')`,
    [SYNAP_AI_ROW]
  );
  await q(`insert into workspaces (id, name) values ($1, 'Content OS')`, [WS]);
  await q(
    `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`,
    [WS, USER]
  );
  for (const [id, name, executor] of [
    [PLAYBOOK, "Package ideas", "is-agent"],
    [AGENTS_ONLY, "Make a video", "external-agent"],
  ]) {
    await q(
      `insert into playbooks (id, workspace_id, created_by, name, goal_template, executor, status, metadata, params, input_strategy, channel_spec, expected_outputs, stages, criteria)
       values ($1, $2, $3, $4, 'Package the bank', $5, 'active', '{}'::jsonb, '[]'::jsonb, '{"kind":"none"}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)`,
      [id, WS, USER, name, executor]
    );
  }
});

beforeEach(async () => {
  h.dispatched.length = 0;
  await h.client!.exec(
    "delete from focus_sessions; delete from playbook_runs; delete from channels; delete from links; delete from proposals;"
  );
});

afterAll(async () => {
  await h.client?.close();
});

describe("nothing remembered yet", () => {
  it("the read asks, offers Synap AI first then the person's agents, and the next run is the default", async () => {
    const read = await asPerson().runChoice({ playbookId: PLAYBOOK });
    expect(read.stored).toBeNull();
    expect(read.ask).toBe(true);
    expect(read.synapAiAllowed).toBe(true);
    expect(read.options[0]).toEqual({
      choice: { executor: "is-agent" },
      name: null,
      wake: null,
      recommended: true,
    });
    expect(read.options.slice(1).map((o) => [o.choice, o.wake?.state])).toEqual(
      expect.arrayContaining([
        [{ executor: "external-agent", agentUserId: RUNNING }, "awake"],
        [{ executor: "external-agent", agentUserId: IDLE }, "cant_wake"],
      ])
    );
    expect(read.next).toEqual({
      executor: "is-agent",
      agentUserId: null,
      via: "default",
      passedOver: null,
    });
  });

  it("a bare run runs the default and stores nothing", async () => {
    await asPerson().run({ playbookId: PLAYBOOK });
    expect(h.dispatched.map((d) => d.ref)).toEqual(["is-agent"]);
    expect((await lastRun())?.run_on).toMatchObject({ via: "default" });
    expect(await choiceEdges()).toEqual([]);
  });
});

describe("answer once with Synap AI, remembered", () => {
  it("this run is Synap AI, the next read does not ask, and a bare run follows the choice", async () => {
    await asPerson().run({
      playbookId: PLAYBOOK,
      runOn: "synap_ai",
      remember: true,
    });
    expect(h.dispatched.map((d) => d.ref)).toEqual(["is-agent"]);
    expect((await lastRun())?.run_on).toMatchObject({
      executor: "is-agent",
      via: "named",
    });
    expect(await choiceEdges()).toEqual([
      { from_type: "agent", from_id: SYNAP_AI_ROW },
    ]);

    const read = await asPerson().runChoice({ playbookId: PLAYBOOK });
    expect(read.stored).toEqual({ executor: "is-agent" });
    expect(read.ask).toBe(false);

    h.dispatched.length = 0;
    await asPerson().run({ playbookId: PLAYBOOK });
    expect(h.dispatched.map((d) => d.ref)).toEqual(["is-agent"]);
    expect((await lastRun())?.run_on).toEqual({
      executor: "is-agent",
      agentUserId: null,
      via: "stored",
      passedOver: null,
    });
  });
});

describe("answer once with an agent, remembered", () => {
  it("an AWAKE agent: a later bare run is handed to it, nothing dispatched", async () => {
    await asPerson().run({
      playbookId: PLAYBOOK,
      handToAgentId: RUNNING,
      remember: true,
    });
    expect(await choiceEdges()).toEqual([
      { from_type: "participant", from_id: RUNNING },
    ]);
    h.dispatched.length = 0;
    await asPerson().run({ playbookId: PLAYBOOK });
    expect(h.dispatched).toEqual([]);
    expect(await lastRun()).toEqual({
      executor: "external-agent",
      run_on: {
        executor: "external-agent",
        agentUserId: RUNNING,
        via: "stored",
        passedOver: null,
      },
    });
  });

  it("an agent NOT awake: a later bare run goes to Synap AI and says who was passed over and why", async () => {
    await asPerson().setRunChoice({
      playbookId: PLAYBOOK,
      choice: { executor: "external-agent", agentUserId: IDLE },
    });
    await asPerson().run({ playbookId: PLAYBOOK });
    expect(h.dispatched.map((d) => d.ref)).toEqual(["is-agent"]);
    expect(await lastRun()).toEqual({
      executor: "is-agent",
      run_on: {
        executor: "is-agent",
        agentUserId: null,
        via: "fallback",
        passedOver: { agentUserId: IDLE, name: "Codex", why: "no_waker" },
      },
    });
    const read = await asPerson().runChoice({ playbookId: PLAYBOOK });
    expect(read.ask).toBe(false);
    expect(read.next.via).toBe("fallback");
  });
});

describe("one choice per person per playbook", () => {
  it("choosing again replaces the remembered one", async () => {
    await asPerson().setRunChoice({
      playbookId: PLAYBOOK,
      choice: { executor: "external-agent", agentUserId: RUNNING },
    });
    const read = await asPerson().setRunChoice({
      playbookId: PLAYBOOK,
      choice: { executor: "is-agent" },
    });
    expect(read.stored).toEqual({ executor: "is-agent" });
    expect(await choiceEdges()).toEqual([
      { from_type: "agent", from_id: SYNAP_AI_ROW },
    ]);
    await asPerson().setRunChoice({
      playbookId: PLAYBOOK,
      choice: { executor: "external-agent", agentUserId: IDLE },
    });
    expect(await choiceEdges()).toEqual([
      { from_type: "participant", from_id: IDLE },
    ]);
  });
});

describe("a playbook that runs only on agents", () => {
  it("refuses Synap AI for a run and as a choice, before anything starts", async () => {
    await expect(
      asPerson().run({ playbookId: AGENTS_ONLY, runOn: "synap_ai" })
    ).rejects.toThrow(/runs only on an agent/);
    await expect(
      asPerson().setRunChoice({
        playbookId: AGENTS_ONLY,
        choice: { executor: "is-agent" },
      })
    ).rejects.toThrow(/runs only on an agent/);
    expect(h.dispatched).toEqual([]);
  });

  it("never falls to Synap AI: its remembered agent takes it, awake or not", async () => {
    await asPerson().setRunChoice({
      playbookId: AGENTS_ONLY,
      choice: { executor: "external-agent", agentUserId: IDLE },
    });
    const read = await asPerson().runChoice({ playbookId: AGENTS_ONLY });
    expect(read.options.some((o) => o.choice.executor === "is-agent")).toBe(
      false
    );
    expect(read.next).toMatchObject({
      executor: "external-agent",
      agentUserId: IDLE,
      via: "stored",
    });
  });
});

describe("remember is a person's act", () => {
  it("an agent's run with remember is refused and nothing is stored", async () => {
    await expect(
      asPerson().run({
        playbookId: PLAYBOOK,
        runOn: "synap_ai",
        remember: true,
        agentUserId: RUNNING,
      })
    ).rejects.toThrow(/Only a person can choose/);
    expect(await choiceEdges()).toEqual([]);
  });

  it("remember with nothing chosen is refused", async () => {
    await expect(
      asPerson().run({ playbookId: PLAYBOOK, remember: true })
    ).rejects.toThrow(/Nothing to remember/);
  });

  it("Synap AI and an agent for one run is refused", async () => {
    await expect(
      asPerson().run({
        playbookId: PLAYBOOK,
        runOn: "synap_ai",
        handToAgentId: RUNNING,
      })
    ).rejects.toThrow(/not both/);
  });
});
