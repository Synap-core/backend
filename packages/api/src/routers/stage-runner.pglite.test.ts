/**
 * THE STAGE RUNNER (runner engine slice 3, spec 7111934d §3.1, §3.3, §3.4):
 * where a step starts, who works it, what it waits on.
 *
 * Driven through the REAL doors on PGlite: `playbooksRouter.run` (birth),
 * `advanceSessionStage` (the advance door), `enterStage`, the real roster
 * (`readAgentsForHandoff`), `attachSessionAgent`, the room post door, the
 * owed-slot door, `setSessionStatus`, `settleRunTurnEnd`, the hold-resume
 * follow-up. Stubbed: the executor registry, the IS turn door
 * (`triggerAutoRespond`, recorded) and `requestInstallation` (recorded,
 * answers "proposed": the installations door is pinned in its own suites),
 * plus the run-choice suite's governance and side-effect stubs.
 *
 * Asserted (each rules out a rule the others would pass):
 *   - birth: stage 0 with nothing new writes ONLY its row (Synap AI, self,
 *     running); the roster, the room and the proposals are untouched;
 *   - a stage naming another agent: the agent joins the roster, a room line
 *     names it and its computer, the row holds it, the step before is done;
 *   - a Synap AI step on a run an agent holds: one IS turn;
 *   - a missing tool: ONE install request per missing tool on the runner's
 *     computer, filed by the pod; the row waits, the session pauses on the
 *     request; once installed the re-check runs the step again;
 *   - nobody can take a step: the person is asked (an owed decision slot);
 *   - risk 2: a Synap AI turn that ends `completed` while a step is away
 *     leaves the run running; with no step away it completes the run;
 *   - a runner named AT the advance comes before the step's own;
 *   - a step an agent bound for dispatch works REACHES it through its binding
 *     (only the binding verb is stubbed): one `start` with the step's goal,
 *     recorded on the row; the next step goes into that live task (`send`),
 *     never a second start; a refused start is said and leaves the row
 *     `unreached`.
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
  turns: [] as Array<Record<string, unknown>>,
  installAsks: [] as Array<Record<string, unknown>>,
  /** Every binding verb the pod called, and what the provider answers `start`. */
  verbs: [] as Array<Record<string, unknown>>,
  startAnswer: null as null | Record<string, unknown>,
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
vi.mock("../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: async (p: Record<string, unknown>) => {
    h.turns.push(p);
    return true;
  },
}));
vi.mock(
  "../services/installations/request-installation.js",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      requestInstallation: async (p: Record<string, unknown>) => {
        h.installAsks.push(p);
        const proposalId = `00000000-0000-4000-8000-00000000000${h.installAsks.length}`;
        // As the door files it: a proposal under the asking session.
        await h.client!.query(
          `insert into proposals (id, session_id, status) values ($1, $2, 'pending')`,
          [proposalId, p.sessionId]
        );
        return { status: "proposed", proposalId, message: "proposed" };
      },
    };
  }
);
// The provider: only the binding verb is stubbed (the binding, the
// governance and the run/step task lookups are real).
vi.mock(
  "../services/agent-dispatch/binding-call.js",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      callBindingVerb: async (p: Record<string, unknown>) => {
        h.verbs.push(p);
        if (p.verb === "start") {
          return (
            h.startAnswer ?? {
              status: "ok",
              result: { externalId: `task-${h.verbs.length}`, url: null },
            }
          );
        }
        return { status: "ok", result: {} };
      },
    };
  }
);
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
import { advanceSessionStage } from "../services/focus-sessions/advance-stage.js";
import { stageRunnerSlotLabel } from "../services/playbooks/stage-runner.js";
import {
  completeRunBodySchema,
  settleRunTurnEnd,
} from "../services/runs/run-turn-end.js";
import { holdResumeFollowUp } from "../services/lifecycle/hold-resume-follow-up.js";

const USER = randomUUID();
const MAC = randomUUID();
const DEVBOX = randomUUID();
const EDITOR_MAC = randomUUID();
const EDITOR_DEVBOX = randomUUID();
/** A cloud agent bound for dispatch (`dispatched_via` a provider tool). */
const CLOUD = randomUUID();
const CLOUD_TOOL = randomUUID();
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

const STAGES = [
  { key: "cut", name: "Cut", category: "started" },
  {
    key: "mix",
    name: "Mix",
    category: "started",
    runner: { agentId: EDITOR_DEVBOX },
  },
  {
    key: "render",
    name: "Render",
    category: "started",
    runner: { role: "video-render", computer: "mac" },
    requires: ["media-ffmpeg"],
  },
  {
    key: "nobody",
    name: "Score",
    category: "started",
    runner: { role: "composer" },
  },
  {
    key: "brief",
    name: "Brief",
    category: "started",
    goal: "Write the brief for the edit",
    runner: { agentId: CLOUD },
  },
  {
    key: "notes",
    name: "Notes",
    category: "started",
    runner: { agentId: CLOUD },
  },
  { key: "ship", name: "Ship", category: "completed" },
];

async function startRun(): Promise<{ sessionId: string; channelId: string }> {
  const out = await asPerson().run({ playbookId: PLAYBOOK });
  return {
    sessionId: out.session!.id,
    channelId: out.session!.channelId as string,
  };
}

const rowsOf = (sessionId: string) =>
  q<{
    stage_key: string;
    status: string;
    runner_agent_user_id: string | null;
    runner_via: string;
    computer_user_id: string | null;
    requires_report: Record<
      string,
      { state: string; proposalId?: string }
    > | null;
    attempt: number;
  }>(
    `select stage_key, status, runner_agent_user_id, runner_via, computer_user_id, requires_report, attempt
     from session_stage_runs where session_id = $1 order by started_at, stage_key`,
    [sessionId]
  ).then((r) => r.rows);

const sessionRow = (sessionId: string) =>
  q<{
    status: string;
    agent_ids: string[] | null;
    current_stage: string | null;
    expected_outputs: Array<Record<string, unknown>>;
  }>(
    `select status, agent_ids, current_stage, expected_outputs from focus_sessions where id = $1`,
    [sessionId]
  ).then((r) => r.rows[0]!);

const systemLines = (channelId: string) =>
  q<{ content: string }>(
    `select content from messages where channel_id = $1 and role = 'system'`,
    [channelId]
  ).then((r) => r.rows.map((m) => m.content));

/** The cloud agent's binding edge (the suite clears `links` between tests). */
async function bindCloud(): Promise<void> {
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at) values ($1, 'participant', $2, 'tool', $3, 'dispatched_via', '{}'::jsonb, now())`,
    [randomUUID(), CLOUD, CLOUD_TOOL]
  );
}

const stepTask = (sessionId: string, stageKey: string) =>
  q<{ status: string; external_agent: Record<string, unknown> | null }>(
    `select status, external_agent from session_stage_runs where session_id = $1 and stage_key = $2`,
    [sessionId, stageKey]
  ).then((r) => r.rows[0]!);

async function advance(
  sessionId: string,
  toStage: string,
  extra: Record<string, unknown> = {}
) {
  const s = await q<Record<string, unknown>>(
    `select id, current_stage as "currentStage", workspace_id as "workspaceId", project_id as "projectId", channel_id as "channelId", playbook_id as "playbookId", subject_entity_id as "subjectEntityId" from focus_sessions where id = $1`,
    [sessionId]
  );
  return advanceSessionStage({
    session: s.rows[0] as never,
    toStage,
    userId: USER,
    stageWrite: "door",
    ...extra,
  });
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
  expect(seen.has("session_stage_runs")).toBe(true);
  await h.client!.exec(
    `create unique index on links (from_type, from_id, to_type, to_id, link_type)`
  );
  // The roster's room membership is idempotent on (channel, member).
  await h.client!.exec(
    `create unique index on channel_members (channel_id, member_id)`
  );
  await q(
    `insert into users (id, email, name, user_type, agent_type, created_by_user_id, host_user_id, agent_role) values
      ($1, 'a@x.test', 'Antoine', 'human', null, null, null, null),
      ($2, 'mac@x.test', 'MacBook-Pro', 'agent', 'machine', $1, null, null),
      ($3, 'dev@x.test', 'devbox', 'agent', 'machine', $1, null, null),
      ($4, 'em@x.test', 'Claude Code', 'agent', 'claude-code', $1, $2, 'video-render'),
      ($5, 'ed@x.test', 'Hermes', 'agent', 'hermes', $1, $3, null),
      ($6, 'cl@x.test', 'Acme agent', 'agent', 'acme', $1, null, null)`,
    [USER, MAC, DEVBOX, EDITOR_MAC, EDITOR_DEVBOX, CLOUD]
  );
  await q(
    `insert into tools (id, workspace_id, created_by, name, kind, executor, config, status, approved, metadata, input_schema, capabilities)
     values ($1, null, $2, 'acme agent tool', 'external', 'external-agent', $3::jsonb, 'active', true, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb)`,
    [
      CLOUD_TOOL,
      USER,
      JSON.stringify({
        agentBinding: {
          protocol: "a2a",
          provider: "acme-cloud-agent",
          supports: { push: false, inputRequired: true, cancel: false },
          verbs: { start: "acme_start_task", send: "acme_send_message" },
        },
      }),
    ]
  );
  for (const [agent, label] of [
    [EDITOR_MAC, "MacBook-Pro"],
    [EDITOR_DEVBOX, "devbox"],
  ] as const) {
    await q(
      `insert into api_keys (id, user_id, key_type, is_active, linked_user_id, last_used_at, instance_label, worker_served_at, created_at)
       values ($1, $2, 'hub_inbound', true, $3, now(), $4, now() - interval '30 seconds', now())`,
      [randomUUID(), agent, USER, label]
    );
  }
  await q(`insert into workspaces (id, name) values ($1, 'Studio')`, [WS]);
  await q(
    `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`,
    [WS, USER]
  );
  await q(
    `insert into agents (id, name, agent_slug, active, owner_type) values ($1, 'Meta', 'meta', true, 'system')`,
    [randomUUID()]
  );
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, executor, status, metadata, params, input_strategy, channel_spec, expected_outputs, stages, criteria, requires, version)
     values ($1, $2, $3, 'Edit a video', 'Edit the take', 'is-agent', 'active', '{}'::jsonb, '[]'::jsonb, '{"kind":"none"}'::jsonb, '{}'::jsonb, '[]'::jsonb, $4::jsonb, '[]'::jsonb, '[]'::jsonb, 1)`,
    [PLAYBOOK, WS, USER, JSON.stringify(STAGES)]
  );
});

beforeEach(async () => {
  h.verbs.length = 0;
  h.startAnswer = null;
  h.dispatched.length = 0;
  h.turns.length = 0;
  h.installAsks.length = 0;
  await h.client!.exec(
    "delete from focus_sessions; delete from playbook_runs; delete from channels; delete from messages; delete from links; delete from proposals; delete from session_stage_runs; delete from installations; delete from lifecycle_transition_outbox;"
  );
});

afterAll(async () => {
  await h.client?.close();
});

describe("birth", () => {
  it("stage 0 with nothing new writes only its row", async () => {
    const { sessionId, channelId } = await startRun();
    const before = await sessionRow(sessionId);
    expect(before.current_stage).toBe("cut");
    expect(await rowsOf(sessionId)).toEqual([
      expect.objectContaining({
        stage_key: "cut",
        status: "running",
        runner_agent_user_id: null,
        runner_via: "self",
        attempt: 1,
        requires_report: null,
      }),
    ]);
    expect(before.agent_ids ?? []).not.toContain(EDITOR_DEVBOX);
    expect(await systemLines(channelId)).toEqual([]);
    expect(h.installAsks).toEqual([]);
    expect(h.turns).toEqual([]);
  });
});

describe("a step another agent works", () => {
  it("joins the roster, the room is told who and where, the step before is done", async () => {
    const { sessionId, channelId } = await startRun();
    const out = await advance(sessionId, "mix");
    expect(out.stageRun).toMatchObject({
      status: "entered",
      handOff: "attached",
      runnerAgentUserId: EDITOR_DEVBOX,
      via: "stage",
    });
    expect((await sessionRow(sessionId)).agent_ids).toContain(EDITOR_DEVBOX);
    expect(await systemLines(channelId)).toEqual([
      "Step Mix is with Hermes on devbox; it moves on to Render when done.",
    ]);
    expect(await rowsOf(sessionId)).toEqual([
      expect.objectContaining({ stage_key: "cut", status: "done" }),
      expect.objectContaining({
        stage_key: "mix",
        status: "running",
        runner_agent_user_id: EDITOR_DEVBOX,
        computer_user_id: DEVBOX,
      }),
    ]);
  });

  it("a runner named at the advance comes before the step's own", async () => {
    const { sessionId } = await startRun();
    const out = await advance(sessionId, "mix", { stageRunner: "self" });
    expect(out.stageRun).toMatchObject({ handOff: "none", via: "entered" });
    expect((await sessionRow(sessionId)).agent_ids ?? []).not.toContain(
      EDITOR_DEVBOX
    );
  });
});

describe("a step that lacks a tool", () => {
  it("asks once per missing tool on the runner's computer, the step waits, the session pauses on the ask", async () => {
    const { sessionId } = await startRun();
    const out = await advance(sessionId, "render");
    expect(out.stageRun).toMatchObject({
      handOff: "attached",
      runnerAgentUserId: EDITOR_MAC,
      waitingTools: ["media-ffmpeg"],
    });
    expect(h.installAsks).toHaveLength(1);
    expect(h.installAsks[0]).toMatchObject({
      capabilityKey: "media-ffmpeg",
      action: "install",
      agentUserId: null,
      sessionId,
      computer: expect.objectContaining({ id: MAC }),
      filedByPod: expect.objectContaining({ author: "system:stage-runner" }),
    });
    const render = (await rowsOf(sessionId)).find(
      (r) => r.stage_key === "render"
    )!;
    expect(render.status).toBe("waiting_tools");
    expect(render.requires_report).toEqual({
      "media-ffmpeg": {
        state: "missing",
        proposalId: "00000000-0000-4000-8000-000000000001",
      },
    });
    expect((await sessionRow(sessionId)).status).toBe("paused");
    const hold = await q<{ transition: Record<string, unknown> }>(
      `select transition from lifecycle_transition_outbox where transition->>'subjectId' = $1 and transition->>'to' = 'paused'`,
      [sessionId]
    );
    expect(JSON.stringify(hold.rows[0]?.transition)).toContain(
      "proposal:00000000-0000-4000-8000-000000000001"
    );
  });

  it("once the tool is installed, the hold's resume runs the step again", async () => {
    const { sessionId } = await startRun();
    await advance(sessionId, "render");
    // Still missing: the re-check keeps it waiting.
    await holdResumeFollowUp({
      subjectType: "focus_session",
      subjectId: sessionId,
      from: "paused",
    });
    expect(
      (await rowsOf(sessionId)).find((r) => r.stage_key === "render")!.status
    ).toBe("waiting_tools");
    await q(
      `insert into installations (id, user_id, machine_user_id, capability_key, kind, status, desired_state, created_at, updated_at)
       values ($1, $2, $3, 'media-ffmpeg', 'tool', 'installed', 'present', now(), now())`,
      [randomUUID(), USER, MAC]
    );
    await holdResumeFollowUp({
      subjectType: "focus_session",
      subjectId: sessionId,
      from: "paused",
    });
    const render = (await rowsOf(sessionId)).find(
      (r) => r.stage_key === "render"
    )!;
    expect(render.status).toBe("running");
    expect(render.requires_report?.["media-ffmpeg"]?.state).toBe("installed");
  });
});

describe("nobody can take a step", () => {
  it("the person is asked who works it", async () => {
    const { sessionId } = await startRun();
    const out = await advance(sessionId, "nobody");
    expect(out.stageRun).toMatchObject({
      handOff: "nobody",
      runnerAgentUserId: null,
    });
    const slot = (await sessionRow(sessionId)).expected_outputs.find(
      (o) => o.label === stageRunnerSlotLabel("Score")
    );
    expect(slot).toMatchObject({ kind: "decision", owner: "human" });
  });
});

describe("risk 2: a Synap AI turn that ends while a step is away", () => {
  async function settle(sessionId: string) {
    const [run] = await database.db
      .select()
      .from(database.playbookRuns)
      .where(database.eq(database.playbookRuns.sessionId, sessionId));
    return settleRunTurnEnd({
      run: run as never,
      session: { id: sessionId, userId: USER, channelId: null },
      body: completeRunBodySchema.parse({ outcome: "completed" }),
      askingAgentUserId: null,
    });
  }
  const runStatus = (sessionId: string) =>
    q<{ status: string }>(
      `select status from playbook_runs where session_id = $1`,
      [sessionId]
    ).then((r) => r.rows[0]!.status);

  it("leaves the run running while another agent holds the step", async () => {
    const { sessionId } = await startRun();
    await advance(sessionId, "mix");
    expect(await settle(sessionId)).toBe("left_running");
    expect(await runStatus(sessionId)).toBe("running");
  });

  it("completes the run when no step is away", async () => {
    const { sessionId } = await startRun();
    expect(await settle(sessionId)).toBe("completed");
    expect(await runStatus(sessionId)).toBe("completed");
  });
});

describe("a Synap AI step on a run an agent holds", () => {
  it("gives Synap AI one turn on the session", async () => {
    const { sessionId } = await startRun();
    await q(
      `update playbook_runs set run_on = $2::jsonb where session_id = $1`,
      [
        sessionId,
        JSON.stringify({
          executor: "external-agent",
          agentUserId: EDITOR_MAC,
          via: "named",
          passedOver: null,
        }),
      ]
    );
    const out = await advance(sessionId, "mix", {
      stageRunner: { synapAi: { persona: "editor" } },
    });
    expect(out.stageRun).toMatchObject({ handOff: "synap_ai_turn" });
    expect(h.turns).toEqual([
      expect.objectContaining({
        focusSessionId: sessionId,
        agentType: "editor",
      }),
    ]);
  });
});

describe("a step an agent bound for dispatch works", () => {
  it("starts ONE provider task with the step's goal, as the agent, and the row records it", async () => {
    await bindCloud();
    const { sessionId } = await startRun();
    const out = await advance(sessionId, "brief");
    expect(out.stageRun).toMatchObject({
      handOff: "attached",
      runnerAgentUserId: CLOUD,
      reached: "started",
    });
    const starts = h.verbs.filter((v) => v.verb === "start");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      agentUserId: CLOUD,
      ownerId: USER,
      sessionId,
      idempotencyKey: expect.stringMatching(/^stage-start:/),
    });
    const task = (starts[0]!.parameters as { task: Record<string, unknown> })
      .task;
    expect(String(task.goal)).toContain("Write the brief for the edit");
    expect(task.currentStage).toBe("brief");
    expect(await stepTask(sessionId, "brief")).toMatchObject({
      status: "running",
      external_agent: expect.objectContaining({
        agentUserId: CLOUD,
        externalId: "task-1",
        status: "running",
      }),
    });
  });

  it("a next step it works goes INTO its live task, never a second start", async () => {
    await bindCloud();
    const { sessionId } = await startRun();
    await advance(sessionId, "brief");
    h.verbs.length = 0;
    const out = await advance(sessionId, "notes");
    expect(out.stageRun).toMatchObject({ reached: "sent" });
    expect(h.verbs.map((v) => v.verb)).toEqual(["send"]);
    expect(h.verbs[0]).toMatchObject({
      agentUserId: CLOUD,
      parameters: expect.objectContaining({ externalId: "task-1" }),
      idempotencyKey: expect.stringContaining("stage:"),
    });
    expect((await stepTask(sessionId, "notes")).status).toBe("running");
  });

  it("a start the provider refuses: the room says so and the row is unreached, never running", async () => {
    await bindCloud();
    h.startAnswer = { status: "failed", message: "provider down" };
    const { sessionId, channelId } = await startRun();
    const out = await advance(sessionId, "brief");
    expect(out.stageRun).toMatchObject({ reached: "failed" });
    const row = await stepTask(sessionId, "brief");
    expect(row.status).toBe("unreached");
    expect(row.external_agent).toBeNull();
    expect(
      (await systemLines(channelId)).some((l) =>
        l.startsWith("Step Brief did not reach its agent:")
      )
    ).toBe(true);
  });
});
