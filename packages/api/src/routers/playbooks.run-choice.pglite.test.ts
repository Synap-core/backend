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
  /** What the governance gate was asked, and what it answers this test. */
  gateCalls: [] as Array<Record<string, unknown>>,
  gateAnswer: null as null | Record<string, unknown>,
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
    checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
      h.gateCalls.push(opts);
      return h.gateAnswer ?? { allowed: true };
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { PgTable as PgTableClass } from "drizzle-orm/pg-core";
import * as database from "@synap/database";
import { playbooksRouter } from "./playbooks.js";
import type { Context } from "../types/context.js";
import { runPlaybook } from "../services/playbooks/run-playbook.js";
import { registerPlaybookExecutors } from "./proposals/executors/playbook.js";
import {
  proposalExecRegistry,
  type ProposalExecutorArgs,
} from "./proposals/execution-registry.js";

const USER = randomUUID();
/** Claude Code on the person's devbox: its runner served it 30 s ago — awake. */
const RUNNING = randomUUID();
/** Codex: a key, never served by a runner — not awake (cant_wake). */
const IDLE = randomUUID();
/** The IS orchestrator registry row: what a Synap AI choice is stored from. */
const SYNAP_AI_ROW = randomUUID();
/** An agent the pod runs itself (an IS persona user, no key): `pod` reach. */
const HOUSE = randomUUID();
/** A second "Claude Code", on another computer (the founder's two, finding 2288ffce). */
const TWIN = randomUUID();
const WS = randomUUID();
const PLAYBOOK = randomUUID();
/** A playbook that runs only on agents (`external-agent`). */
const AGENTS_ONLY = randomUUID();
/** A second person in the space, with no agents of their own. */
const NEWCOMER = randomUUID();

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
const asNewcomer = () =>
  playbooksRouter.createCaller({
    authenticated: true,
    userId: NEWCOMER,
    workspaceId: WS,
  } as unknown as Context);
/** An agent key acting for the person (Claude Code, or a third-party app). */
const asAgent = () =>
  playbooksRouter.createCaller({
    authenticated: true,
    userId: USER,
    agentUserId: RUNNING,
    workspaceId: WS,
  } as unknown as Context);

/** What the one run recorded about who ran it (each step clears the table). */
const lastRun = () =>
  q<{ executor: string; run_on: Record<string, unknown> | null }>(
    `select executor, run_on from playbook_runs`
  ).then((r) => {
    expect(r.rows).toHaveLength(1);
    return r.rows[0];
  });
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
      ($3, 'cx@x.test', 'Codex', 'agent', 'codex', $1),
      ($4, 'meta@x.test', 'General Agent', 'agent', 'meta', $1),
      ($5, 'cc2@x.test', 'Claude Code', 'agent', 'claude-code', $1),
      ($6, 'n@x.test', 'Newcomer', 'human', null, null)`,
    [USER, RUNNING, IDLE, HOUSE, TWIN, NEWCOMER]
  );
  await q(
    `insert into api_keys (id, user_id, key_type, is_active, linked_user_id, last_used_at, instance_label, worker_served_at, created_at) values
      ($1, $2, 'hub_inbound', true, $4, now(), 'devbox', now() - interval '30 seconds', now()),
      ($3, $5, 'hub_inbound', true, $4, now(), 'MacBook', null, now()),
      ($6, $7, 'hub_inbound', true, $4, now(), 'Studio', now() - interval '30 seconds', now())`,
    [randomUUID(), RUNNING, randomUUID(), USER, IDLE, randomUUID(), TWIN]
  );
  await q(
    `insert into agents (id, name, agent_slug, active, owner_type) values ($1, 'Meta', 'meta', true, 'system')`,
    [SYNAP_AI_ROW]
  );
  await q(`insert into workspaces (id, name) values ($1, 'Content OS')`, [WS]);
  await q(
    `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'editor')`,
    [WS, USER, NEWCOMER]
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
  h.gateCalls.length = 0;
  h.gateAnswer = null;
  await h.client!.exec(
    "delete from focus_sessions; delete from playbook_runs; delete from channels; delete from links; delete from proposals; delete from ai_providers; delete from ai_provider_credentials;"
  );
});

afterAll(async () => {
  await h.client?.close();
});

describe("nothing remembered yet", () => {
  it("the read asks, offers Synap AI first then the person's agents that can run it, and the next run is the default", async () => {
    const read = await asPerson().runChoice({ playbookId: PLAYBOOK });
    expect(read.stored).toBeNull();
    expect(read.ask).toBe(true);
    expect(read.synapAiAllowed).toBe(true);
    // No AI provider of the pod's own: Synap AI runs on Synap credits.
    expect(read.options[0]).toEqual({
      choice: { executor: "is-agent" },
      name: null,
      label: "Synap AI · using Synap credits",
      wake: null,
      wakeLabel: "Runs in Synap",
      recommended: true,
      provider: { providerId: null, name: "Synap credits", key: "synap" },
    });
    expect(read.options.slice(1).map((o) => [o.choice, o.wake?.state])).toEqual(
      expect.arrayContaining([
        [{ executor: "external-agent", agentUserId: RUNNING }, "awake"],
        [{ executor: "external-agent", agentUserId: TWIN }, "awake"],
      ])
    );
    // The words come from the pod, so an app never writes its own; two agents
    // with one name carry their computer (finding 2288ffce), a unique one
    // stays bare.
    const agentLabels = read.options
      .filter((o) => o.choice.executor === "external-agent")
      .map((o) => [o.label, o.wakeLabel]);
    expect(agentLabels).toEqual(
      expect.arrayContaining([
        [expect.stringMatching(/^Claude Code · devbox$/i), "Awake"],
        [expect.stringMatching(/^Claude Code · Studio$/i), "Awake"],
      ])
    );
    expect(new Set(read.options.map((o) => o.label)).size).toBe(
      read.options.length
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
    await q(`delete from playbook_runs`);
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
    await q(`delete from playbook_runs`);
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

describe("an assignment written before choices were remembered", () => {
  it("Settings' edge to an agent the pod runs itself reads as Synap AI, stored: no ask, Synap AI runs it", async () => {
    // What Content Studio's Settings wrote (PUT /agent-users/:id/assignment)
    // when the person picked the pod's own agent: a participant edge.
    await q(
      `insert into links (from_type, from_id, to_type, to_id, link_type, metadata) values ('participant', $1, 'playbook', $2, 'assigned_to', $3)`,
      [HOUSE, PLAYBOOK, JSON.stringify({ ownerId: USER, assignedBy: USER })]
    );
    const read = await asPerson().runChoice({ playbookId: PLAYBOOK });
    expect(read.stored).toEqual({ executor: "is-agent" });
    expect(read.ask).toBe(false);
    expect(read.next).toEqual({
      executor: "is-agent",
      agentUserId: null,
      via: "stored",
      passedOver: null,
    });
    await asPerson().run({ playbookId: PLAYBOOK });
    expect(h.dispatched.map((d) => d.ref)).toEqual(["is-agent"]);
    expect((await lastRun())?.run_on).toMatchObject({ via: "stored" });
  });
});

describe("one choice per person per playbook", () => {
  it("choosing again replaces the remembered one", async () => {
    await asPerson().setRunChoice({
      playbookId: PLAYBOOK,
      choice: { executor: "external-agent", agentUserId: RUNNING },
    });
    const saved = await asPerson().setRunChoice({
      playbookId: PLAYBOOK,
      choice: { executor: "is-agent" },
    });
    expect(saved.status).toBe("applied");
    expect(saved.runChoice?.stored).toEqual({ executor: "is-agent" });
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

describe("only agents that can run it are offered; the others are hidden with why (D3)", () => {
  it("an agent that can't wake is not an option: it is listed under hidden, grouped by its reason", async () => {
    const read = await asPerson().runChoice({ playbookId: PLAYBOOK });
    const offered = read.options.map((o) =>
      o.choice.executor === "external-agent" ? o.choice.agentUserId : "synap"
    );
    expect(offered).not.toContain(IDLE);
    expect(read.options.every((o) => o.wake?.state !== "cant_wake")).toBe(true);
    expect(read.hidden).toEqual([
      {
        why: "no_waker",
        label: "Nothing can start it yet",
        count: 1,
        names: ["Codex"],
      },
    ]);
    expect(read.hiddenLabel).toBe("1 more can't run now");
    // The pod's own agents are Synap AI, never hidden nor offered one by one.
    expect(JSON.stringify(read)).not.toContain(HOUSE);
  });

  it("nothing hidden: no group and no line", async () => {
    const read = await asNewcomer().runChoice({ playbookId: PLAYBOOK });
    expect(read.hidden).toEqual([]);
    expect(read.hiddenLabel).toBeNull();
  });
});

describe("never a silent default (D4)", () => {
  it("a person with no agents is still asked, with Synap AI the one option", async () => {
    const read = await asNewcomer().runChoice({ playbookId: PLAYBOOK });
    expect(read.stored).toBeNull();
    expect(read.options.map((o) => o.choice)).toEqual([
      { executor: "is-agent" },
    ]);
    expect(read.ask).toBe(true);
  });

  it("a headless run (an automation, a schedule) with nothing stored takes the default and records it", async () => {
    await runPlaybook({ playbookId: PLAYBOOK, workspaceId: WS, userId: USER });
    expect(h.dispatched.map((d) => d.ref)).toEqual(["is-agent"]);
    expect((await lastRun())?.run_on).toEqual({
      executor: "is-agent",
      agentUserId: null,
      via: "default",
      passedOver: null,
    });
  });
});

describe("the provider Synap AI runs on: one global read, the IS default's rule", () => {
  const provider = (
    providerId: string,
    name: string,
    priority: number,
    opts: { enabled?: boolean; podKey?: boolean } = {}
  ) =>
    q(
      `insert into ai_providers (id, provider_id, name, base_url, api_key_env_var, encrypted_api_key, enabled, priority, tags, models, created_at, updated_at)
       values (gen_random_uuid(), $1, $2, 'https://x.test', 'PROVIDER_API_KEY', $3, $4, $5, '[]'::jsonb, '[]'::jsonb, now(), now())`,
      [
        providerId,
        name,
        opts.podKey === false ? null : "enc:pod",
        opts.enabled ?? true,
        priority,
      ]
    );
  const credential = (
    providerId: string,
    scope: { userId?: string; workspaceId?: string }
  ) =>
    q(
      `insert into ai_provider_credentials (id, provider_id, workspace_id, user_id, encrypted_api_key, enabled, priority, created_by, created_at, updated_at)
       values (gen_random_uuid(), $1, $2, $3, 'enc:own', true, 10, $4, now(), now())`,
      [providerId, scope.workspaceId ?? null, scope.userId ?? null, USER]
    );
  const synapAi = async (as = asPerson) =>
    (await as().runChoice({ playbookId: PLAYBOOK })).options[0];

  it("the pod's first enabled provider with a key: 'Synap AI · using Anthropic (your key)'", async () => {
    await provider("openai", "OpenAI", 2);
    await provider("anthropic", "Anthropic", 1);
    await provider("mistral", "Mistral", 0, { enabled: false });
    const option = await synapAi();
    expect(option.label).toBe("Synap AI · using Anthropic (your key)");
    expect(option.provider).toEqual({
      providerId: "anthropic",
      name: "Anthropic",
      key: "pod",
    });
  });

  it("a provider with no key at any tier cannot answer: the next one runs", async () => {
    await provider("anthropic", "Anthropic", 1, { podKey: false });
    await provider("openai", "OpenAI", 2);
    expect((await synapAi()).provider?.providerId).toBe("openai");
  });

  it("the person's own key, then the space's, before the pod's (person > space > pod)", async () => {
    await provider("anthropic", "Anthropic", 1, { podKey: false });
    await credential("anthropic", { workspaceId: WS });
    expect((await synapAi()).label).toBe(
      "Synap AI · using Anthropic (this space's key)"
    );
    await credential("anthropic", { userId: USER });
    expect((await synapAi()).provider).toEqual({
      providerId: "anthropic",
      name: "Anthropic",
      key: "person",
    });
    // Another person's own key is not this person's.
    expect((await synapAi(asNewcomer)).provider?.key).toBe("space");
  });

  it("none of the pod's own: Synap credits", async () => {
    await provider("anthropic", "Anthropic", 1, { podKey: false });
    expect((await synapAi()).label).toBe("Synap AI · using Synap credits");
  });
});

describe("an agent or app may only ask to remember the choice (D7)", () => {
  it("an agent key's choice goes to the gate as playbook/set_run_choice and stores nothing", async () => {
    h.gateAnswer = { proposalId: "11111111-1111-4111-8111-111111111111" };
    const answer = await asAgent().setRunChoice({
      playbookId: PLAYBOOK,
      choice: { executor: "external-agent", agentUserId: RUNNING },
    });
    expect(answer).toEqual({
      status: "proposed",
      proposalId: "11111111-1111-4111-8111-111111111111",
      message: "Saved once you approve it in your pod.",
      runChoice: null,
    });
    expect(h.gateCalls).toHaveLength(1);
    expect(h.gateCalls[0]).toMatchObject({
      userId: USER,
      agentUserId: RUNNING,
      workspaceId: WS,
      subjectType: "playbook",
      action: "set_run_choice",
      data: {
        id: PLAYBOOK,
        playbookId: PLAYBOOK,
        choice: { executor: "external-agent", agentUserId: RUNNING },
        ownerId: USER,
      },
    });
    expect(await choiceEdges()).toEqual([]);
  });

  it("a person's choice never asks the gate: it applies", async () => {
    const answer = await asPerson().setRunChoice({
      playbookId: PLAYBOOK,
      choice: { executor: "external-agent", agentUserId: RUNNING },
    });
    expect(answer.status).toBe("applied");
    expect(h.gateCalls).toEqual([]);
    expect(await choiceEdges()).toEqual([
      { from_type: "participant", from_id: RUNNING },
    ]);
  });

  describe("approving the proposal", () => {
    registerPlaybookExecutors();
    const executor = proposalExecRegistry.resolveExact(
      "playbook/set_run_choice"
    );
    const approve = (approver: string) =>
      executor!.execute({
        proposal: {
          id: randomUUID(),
          workspaceId: WS,
          agentUserId: RUNNING,
          targetType: "playbook",
          proposalType: "set_run_choice",
          sourceMessageId: null,
          data: {
            data: {
              id: PLAYBOOK,
              playbookId: PLAYBOOK,
              choice: { executor: "external-agent", agentUserId: RUNNING },
              ownerId: USER,
            },
          },
        },
        payload: null,
        userId: approver,
        input: { proposalId: randomUUID() },
        ctx: {} as Context,
        deps: {
          db: null,
          emitProposalReviewed: () => undefined,
          reportProposalOutcome: () => undefined,
          stampProjectMembership: async () => undefined,
          resolveMessagingAccountForPlatform: async () => null,
        },
      } as unknown as ProposalExecutorArgs);

    it("saves it for the person, as the person (the gate is not asked again)", async () => {
      expect(executor).toBeDefined();
      await approve(USER);
      expect(await choiceEdges()).toEqual([
        { from_type: "participant", from_id: RUNNING },
      ]);
      expect(h.gateCalls).toEqual([]);
      const read = await asPerson().runChoice({ playbookId: PLAYBOOK });
      expect(read.stored).toEqual({
        executor: "external-agent",
        agentUserId: RUNNING,
      });
      expect(read.ask).toBe(false);
    });

    it("another person cannot approve someone's choice", async () => {
      await expect(approve(NEWCOMER)).rejects.toThrow(
        /only they can approve it/
      );
      expect(await choiceEdges()).toEqual([]);
    });
  });
});
