/**
 * WHO RUNS IT, when the playbook names its runner (runner engine slice 2,
 * spec 7111934d §2.5; founder's flip of D1 via the lead, 9 Nov 2026: Run
 * choice > the playbook's runner > the person's remembered choice > fallback >
 * default).
 *
 * Driven through the REAL doors (`playbooksRouter.run` / `.runChoice`) into
 * the real spine (`runPlaybook` → `resolveRunChoice` → `resolveRunner`), the
 * real roster (`readAgentsForHandoff`: the route's verdicts and the wake
 * marks), the real computers (`listPersonsComputers`, `matchComputer`) and the
 * real installations read, on PGlite. Stubbed as in
 * `playbooks.run-choice.pglite.test.ts`.
 *
 * Asserted (each row rules out a rule the others would pass):
 *   - a role resolves to the person's agent; an agent that is not theirs is
 *     never taken (the route refuses it) and the run falls to the next rung;
 *     a role nobody has is passed over as `no_agent`;
 *   - a paused first choice is passed over (`refused`), the second takes it;
 *   - Mac without ffmpeg and devbox with it → the devbox agent, through its
 *     preset, with the Mac passed over for `missing_tools` and the tool report
 *     recorded;
 *   - the playbook's runner beats the remembered choice; a choice made at Run
 *     beats the playbook's runner; a playbook whose runner can take it does
 *     not make the launch ask;
 *   - a runner nobody can take records who was passed over on the rung that
 *     took it; a runner chosen AT RUN that nobody can take is refused;
 *   - Synap AI as a persona runs as that persona;
 *   - remembering a choice the playbook's runner overrides offers to make it
 *     the playbook's runner.
 * "No runner ⇒ the same choice as before" is the whole of
 * `playbooks.run-choice.pglite.test.ts`, unchanged and green beside this.
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
  dispatched: [] as Array<{ ref: string; agentType: string | null }>,
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
    run: async (ctx: { agentType?: string | null }) => {
      h.dispatched.push({ ref, agentType: ctx.agentType ?? null });
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

const USER = randomUUID();
const OTHER = randomUUID();
/** The person's two computers. */
const MAC = randomUUID();
const DEVBOX = randomUUID();
/** Claude Code on the Mac, role video-render (`agent_role`), awake. */
const EDITOR_MAC = randomUUID();
/** Claude Code on the devbox, with a `video-render` PRESET, awake. */
const EDITOR_DEVBOX = randomUUID();
/** A video-render agent of the person's, paused. */
const PAUSED = randomUUID();
/** Another person's video-render agent. */
const FOREIGN = randomUUID();
const WS = randomUUID();
const PLAYBOOK = randomUUID();

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

const lastRun = () =>
  q<{ executor: string; run_on: Record<string, unknown> | null }>(
    `select executor, run_on from playbook_runs`
  ).then((r) => {
    expect(r.rows).toHaveLength(1);
    return r.rows[0]!;
  });
const rosterOf = () =>
  q<{ to_id: string }>(
    `select to_id from links where link_type = 'assigned_to'`
  ).then((r) => r.rows);

async function setRunner(runner: unknown, requires: string[] = []) {
  await q(
    `update playbooks set runner = $2::jsonb, requires = $3::jsonb where id = $1`,
    [
      PLAYBOOK,
      runner === null ? null : JSON.stringify(runner),
      JSON.stringify(requires),
    ]
  );
}

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
  await h.client!.exec(
    `create unique index on links (to_type, to_id, (coalesce(metadata->>'ownerId', ''))) where link_type = 'assigned_to'`
  );
  await q(
    `insert into users (id, email, name, user_type, agent_type, created_by_user_id, host_user_id, agent_role, agent_paused_at) values
      ($1, 'a@x.test', 'Antoine', 'human', null, null, null, null, null),
      ($2, 'o@x.test', 'Other', 'human', null, null, null, null, null),
      ($3, 'mac@x.test', 'MacBook-Pro', 'agent', 'machine', $1, null, null, null),
      ($4, 'dev@x.test', 'devbox', 'agent', 'machine', $1, null, null, null),
      ($5, 'em@x.test', 'Claude Code', 'agent', 'claude-code', $1, $3, 'video-render', null),
      ($6, 'ed@x.test', 'Claude Code', 'agent', 'claude-code', $1, $4, null, null),
      ($7, 'p@x.test', 'Hermes', 'agent', 'hermes', $1, null, 'video-render', now()),
      ($8, 'f@x.test', 'Their editor', 'agent', 'claude-code', $2, null, 'video-render', null)`,
    [USER, OTHER, MAC, DEVBOX, EDITOR_MAC, EDITOR_DEVBOX, PAUSED, FOREIGN]
  );
  // Each agent's runner served it 30 s ago: awake.
  for (const [agent, owner, label] of [
    [EDITOR_MAC, USER, "MacBook-Pro"],
    [EDITOR_DEVBOX, USER, "devbox"],
    [PAUSED, USER, "MacBook-Pro"],
    [FOREIGN, OTHER, "theirs"],
  ] as const) {
    await q(
      `insert into api_keys (id, user_id, key_type, is_active, linked_user_id, last_used_at, instance_label, worker_served_at, created_at)
       values ($1, $2, 'hub_inbound', true, $3, now(), $4, now() - interval '30 seconds', now())`,
      [randomUUID(), agent, owner, label]
    );
  }
  // The devbox agent's preset that makes it a video-render agent.
  await q(
    `insert into agent_configs (id, user_id, agent_type, preset_key, extra_tool_ids, disabled_tool_ids)
     values ($1, $2, 'claude-code', 'video-render', '[]'::jsonb, '[]'::jsonb)`,
    [randomUUID(), EDITOR_DEVBOX]
  );
  // ffmpeg is on the devbox, not on the Mac.
  await q(
    `insert into installations (id, user_id, machine_user_id, capability_key, kind, status, desired_state, created_at, updated_at)
     values ($1, $2, $3, 'media-ffmpeg', 'tool', 'installed', 'present', now(), now())`,
    [randomUUID(), USER, DEVBOX]
  );
  await q(`insert into workspaces (id, name) values ($1, 'Studio')`, [WS]);
  await q(
    `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`,
    [WS, USER]
  );
  await q(
    `insert into agents (id, name, agent_slug, active, owner_type) values ($1, 'Meta', 'meta', true, 'system'), ($2, 'Editor', 'editor', true, 'system')`,
    [randomUUID(), randomUUID()]
  );
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, executor, status, metadata, params, input_strategy, channel_spec, expected_outputs, stages, criteria, requires)
     values ($1, $2, $3, 'Edit a video', 'Edit the take', 'is-agent', 'active', '{}'::jsonb, '[]'::jsonb, '{"kind":"none"}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)`,
    [PLAYBOOK, WS, USER]
  );
});

beforeEach(async () => {
  h.dispatched.length = 0;
  h.gateCalls.length = 0;
  h.gateAnswer = null;
  await h.client!.exec(
    "delete from focus_sessions; delete from playbook_runs; delete from channels; delete from links; delete from proposals;"
  );
  await setRunner(null);
});

afterAll(async () => {
  await h.client?.close();
});

describe("the playbook names a role", () => {
  it("resolves to the person's agent of that role, on its computer", async () => {
    await setRunner({ role: "video-render", computer: "mac" });
    const out = await asPerson().run({ playbookId: PLAYBOOK });
    expect("handedTo" in out ? out.handedTo : undefined).toMatchObject({
      agentUserId: EDITOR_MAC,
      via: "authored",
    });
    expect(out.message).toMatch(/the runner this playbook names/);
    expect((await lastRun()).run_on).toMatchObject({
      executor: "external-agent",
      agentUserId: EDITOR_MAC,
      via: "authored",
      computerUserId: MAC,
    });
  });

  it("never takes an agent that is not the person's: the route refuses it, the run falls to the next rung", async () => {
    await setRunner({ agentId: FOREIGN });
    const out = await asPerson().run({ playbookId: PLAYBOOK });
    expect("handedTo" in out ? out.handedTo : undefined).toBeUndefined();
    expect((await lastRun()).run_on).toEqual({
      executor: "is-agent",
      agentUserId: null,
      via: "default",
      passedOver: null,
      runnerPassedOver: [
        {
          choice: 0,
          agentUserId: FOREIGN,
          name: "Their editor",
          why: "refused",
        },
      ],
    });
  });

  it("a role no agent of the person's has: passed over as no_agent", async () => {
    await setRunner({ role: "sound-mix" });
    await asPerson().run({ playbookId: PLAYBOOK });
    expect((await lastRun()).run_on).toMatchObject({
      via: "default",
      runnerPassedOver: [
        { choice: 0, agentUserId: null, name: null, why: "no_agent" },
      ],
    });
  });
});

describe("an ordered list of fallbacks", () => {
  it("a paused first choice is passed over and the second takes it", async () => {
    await setRunner([{ agentId: PAUSED }, { agentId: EDITOR_MAC }]);
    await asPerson().run({ playbookId: PLAYBOOK });
    expect((await lastRun()).run_on).toMatchObject({
      agentUserId: EDITOR_MAC,
      via: "authored",
      runnerPassedOver: [{ choice: 0, agentUserId: PAUSED, why: "refused" }],
    });
  });

  it("Mac without ffmpeg, devbox with it: the devbox agent takes it, through its preset", async () => {
    await setRunner(
      [
        { role: "video-render", computer: "mac" },
        { role: "video-render", computer: "devbox" },
      ],
      ["media-ffmpeg"]
    );
    await asPerson().run({ playbookId: PLAYBOOK });
    expect((await lastRun()).run_on).toEqual({
      executor: "external-agent",
      agentUserId: EDITOR_DEVBOX,
      via: "authored",
      passedOver: null,
      computerUserId: DEVBOX,
      preset: "video-render",
      requires: { "media-ffmpeg": "installed" },
      runnerPassedOver: [
        {
          choice: 0,
          agentUserId: EDITOR_MAC,
          name: "Claude Code",
          why: "missing_tools",
        },
      ],
    });
  });

  it("nobody has the tool: the first awake one takes it, and the run says what it lacks", async () => {
    await q(`update installations set status = 'failed'`);
    try {
      await setRunner(
        [
          { role: "video-render", computer: "mac" },
          { role: "video-render", computer: "devbox" },
        ],
        ["media-ffmpeg"]
      );
      await asPerson().run({ playbookId: PLAYBOOK });
      expect((await lastRun()).run_on).toMatchObject({
        agentUserId: EDITOR_MAC,
        via: "authored",
        requires: { "media-ffmpeg": "missing" },
      });
    } finally {
      await q(`update installations set status = 'installed'`);
    }
  });
});

describe("the order of the rungs (D1 flipped)", () => {
  it("the playbook's runner beats the person's remembered choice", async () => {
    await asPerson().setRunChoice({
      playbookId: PLAYBOOK,
      choice: { executor: "is-agent" },
    });
    await setRunner({ agentId: EDITOR_MAC });
    await asPerson().run({ playbookId: PLAYBOOK });
    expect((await lastRun()).run_on).toMatchObject({
      agentUserId: EDITOR_MAC,
      via: "authored",
    });
    // …and the read says the same, without asking.
    const read = await asPerson().runChoice({ playbookId: PLAYBOOK });
    expect(read.next).toMatchObject({
      via: "authored",
      agentUserId: EDITOR_MAC,
    });
  });

  it("with nothing remembered, a playbook whose runner takes it does not make the launch ask", async () => {
    await setRunner({ agentId: EDITOR_MAC });
    const read = await asPerson().runChoice({ playbookId: PLAYBOOK });
    expect(read.stored).toBeNull();
    expect(read.ask).toBe(false);
    await setRunner(null);
    expect((await asPerson().runChoice({ playbookId: PLAYBOOK })).ask).toBe(
      true
    );
  });

  it("a choice made at Run beats the playbook's runner", async () => {
    await setRunner({ agentId: EDITOR_MAC });
    await asPerson().run({ playbookId: PLAYBOOK, runOn: "synap_ai" });
    expect((await lastRun()).run_on).toMatchObject({
      executor: "is-agent",
      via: "named",
    });
    expect(h.dispatched.map((d) => d.ref)).toEqual(["is-agent"]);
  });

  it("a runner nobody can take falls to the remembered choice, saying who was passed over", async () => {
    await asPerson().setRunChoice({
      playbookId: PLAYBOOK,
      choice: { executor: "is-agent" },
    });
    await setRunner({ agentId: PAUSED });
    await asPerson().run({ playbookId: PLAYBOOK });
    expect((await lastRun()).run_on).toMatchObject({
      executor: "is-agent",
      via: "stored",
      runnerPassedOver: [{ choice: 0, agentUserId: PAUSED, why: "refused" }],
    });
  });
});

describe("a runner chosen AT RUN", () => {
  it("a role is resolved now, to the person's awake agent", async () => {
    await asPerson().run({
      playbookId: PLAYBOOK,
      runner: { role: "video-render", computer: "devbox" },
    });
    expect((await lastRun()).run_on).toMatchObject({
      agentUserId: EDITOR_DEVBOX,
      via: "named",
      computerUserId: DEVBOX,
    });
  });

  it("nobody it names can take it: refused, never swapped", async () => {
    await expect(
      asPerson().run({
        playbookId: PLAYBOOK,
        runner: [{ agentId: FOREIGN, preset: "x" }, { engine: "codex" }],
      })
    ).rejects.toThrow(/None of the runners you chose can take this run/);
    expect(
      (await q(`select count(*)::int as n from playbook_runs`)).rows[0]
    ).toEqual({ n: 0 });
  });

  it("never beside handToAgentId or runOn", async () => {
    await expect(
      asPerson().run({
        playbookId: PLAYBOOK,
        runner: "synap_ai",
        runOn: "synap_ai",
      })
    ).rejects.toThrow(/runner, or handToAgentId \/ runOn, not both/);
  });
});

describe("Synap AI as a persona", () => {
  it("runs as that persona when the caller named none", async () => {
    await setRunner({ synapAi: { persona: "editor" } });
    await asPerson().run({ playbookId: PLAYBOOK });
    expect((await lastRun()).run_on).toMatchObject({
      executor: "is-agent",
      via: "authored",
    });
    expect(h.dispatched).toEqual([{ ref: "is-agent", agentType: "editor" }]);
  });
});

describe("remembering a choice the playbook's runner overrides", () => {
  it("offers to make it the playbook's runner", async () => {
    await setRunner({ agentId: EDITOR_MAC });
    const out = await asPerson().run({
      playbookId: PLAYBOOK,
      runOn: "synap_ai",
      remember: true,
    });
    expect(out).toMatchObject({
      runnerOffer: { kind: "set_playbook_runner", runner: "synap_ai" },
    });
    expect(await rosterOf()).toHaveLength(1);
  });

  it("no offer when the playbook names no runner", async () => {
    const out = await asPerson().run({
      playbookId: PLAYBOOK,
      runOn: "synap_ai",
      remember: true,
    });
    expect(out).not.toHaveProperty("runnerOffer");
  });
});
