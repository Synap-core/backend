/**
 * NO SECOND WORKER under a session its own coding agent works (finding
 * 44af412e) — on PGlite through the REAL doors: `playbooksRouter.run` (the
 * parent's birth), `advanceSessionStage` (entering the step), the stage
 * runner (`enterStage`), the child door (`startStageChild`).
 *
 * What happened (20 Nov 2026, four times): a Claude Code lane started a
 * session on "Fix a finding" to fix the finding by hand. Its `fix` step
 * `uses` "Fix in code", run by Claude Code on the devbox, so the stage runner
 * started a child run on a SECOND coding agent: it coded the same fix, two
 * of them opened duplicate PRs (backend#1216), and the lane's own session
 * was paused waiting on its double.
 *
 *  - a session a coding agent started, the step's runner the same kind:
 *    no child run, the step stays with that agent, the room says why, the
 *    session is not paused;
 *  - CONTROL: a session a PERSON started still hands the step to its
 *    runner (whether the child then starts is `stage-uses-run`'s suite);
 *  - a session an agent of ANOTHER kind started still hands the step on.
 *
 * Stubbed, and why: who the runner resolves to (`resolveRunner`, its own
 * suite: the roster and computers), the executor registry, the IS turn door,
 * and governance / side-effect stubs, as in `stage-uses-run.pglite.test.ts`.
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
  /** The coding agent on the devbox the step's runner resolves to. */
  devbox: "00000000-0000-4000-8000-00000000d0b0",
  turns: [] as Array<Record<string, unknown>>,
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
vi.mock("../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: async (p: Record<string, unknown>) => {
    h.turns.push(p);
    return true;
  },
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
// Who takes the step: the roster and computers lookup has its own suite.
// Here the step's runner resolves to the coding agent on the devbox, as
// "Fix a finding"'s `fix` step (`uses` "Fix in code", claude-code@devbox) did.
// Not `importOriginal`: the real module's graph reaches the stage runner,
// which would bind the ORIGINAL `resolveRunner` while this factory runs.
vi.mock("../services/agent-dispatch/runner.js", () => ({
  requiresOnComputer: async () => ({}),
  resolveRunner: async (p: { runner?: unknown }) =>
    p.runner
      ? {
          chosen: {
            kind: "agent",
            agentUserId: h.devbox,
            name: "Claude Code (devbox)",
            reach: "pull",
            computerUserId: null,
            preset: null,
            requires: {},
            missing: [],
            choice: 0,
          },
          passedOver: [],
        }
      : { chosen: null, passedOver: [] },
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
import { advanceSessionStage } from "../services/focus-sessions/advance-stage.js";

const USER = randomUUID();
const WS = randomUUID();
const CHILD = randomUUID();
const PARENT = randomUUID();
/** A coding agent that starts a session to work it by hand (a Claude Code lane). */
const LANE = randomUUID();
/** An agent of another kind. */
const OTHER = randomUUID();

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

const FINAL_CUT = { kind: "document", label: "Final cut" };
/** The used playbook, version 1 (kept) and version 2 (live). */
const V1 = {
  goalTemplate: "Render the rough cut (v1)",
  stages: [{ key: "rough", name: "Rough", category: "started" }],
  expectedOutputs: [FINAL_CUT],
};
const V2 = {
  goalTemplate: "Render the graded cut (v2)",
  stages: [{ key: "grade", name: "Grade", category: "started" }],
  expectedOutputs: [FINAL_CUT],
};
const renderStep = (extra: Record<string, unknown> = {}) => ({
  key: "render",
  name: "Render",
  category: "started",
  uses: { playbookId: CHILD, version: 1 },
  runner: { agentId: h.devbox },
  expectedOutputs: [FINAL_CUT],
  ...extra,
});
const STAGES = [
  { key: "brief", name: "Brief", category: "started" },
  renderStep(),
  { key: "publish", name: "Publish", category: "completed" },
];

async function insertPlaybook(
  id: string,
  name: string,
  def: { goalTemplate: string; stages: unknown; expectedOutputs: unknown },
  version = 1
) {
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, executor, status, metadata, params, input_strategy, channel_spec, expected_outputs, stages, criteria, requires, version)
     values ($1, $2, $3, $4, $5, 'is-agent', 'active', '{}'::jsonb, '[]'::jsonb, '{"kind":"none"}'::jsonb, '{}'::jsonb, $6::jsonb, $7::jsonb, '[]'::jsonb, '[]'::jsonb, $8)`,
    [
      id,
      WS,
      USER,
      name,
      def.goalTemplate,
      JSON.stringify(def.expectedOutputs),
      JSON.stringify(def.stages),
      version,
    ]
  );
}

async function startParent(playbookId: string, startedByAgentId?: string) {
  const out = await asPerson().run({ playbookId });
  const sessionId = out.session!.id;
  // The stamp the start doors write for a session an agent starts
  // (`startedByAgentPatch`): the session's own agent works it.
  if (startedByAgentId) {
    await q(
      `update focus_sessions set metadata = coalesce(metadata, '{}'::jsonb) || $2::jsonb where id = $1`,
      [sessionId, JSON.stringify({ startedByAgentId })]
    );
  }
  const s = await q<Record<string, unknown>>(
    `select id, current_stage as "currentStage", workspace_id as "workspaceId", project_id as "projectId", channel_id as "channelId", playbook_id as "playbookId", subject_entity_id as "subjectEntityId" from focus_sessions where id = $1`,
    [sessionId]
  );
  const entered = await advanceSessionStage({
    session: s.rows[0] as never,
    toStage: "render",
    userId: USER,
    stageWrite: "door",
  });
  return {
    sessionId,
    channelId: out.session!.channelId as string,
    entered,
  };
}

const session = (id: string) =>
  q<{
    status: string;
    current_stage: string | null;
    expected_outputs: Array<Record<string, unknown>>;
    metadata: Record<string, unknown>;
    origin: string | null;
    user_id: string;
    playbook_id: string;
  }>(
    `select status, current_stage, expected_outputs, metadata, origin, user_id, playbook_id from focus_sessions where id = $1`,
    [id]
  ).then((r) => r.rows[0]!);

const stepRow = (sessionId: string, stageKey: string) =>
  q<{ id: string; status: string; child_session_id: string | null }>(
    `select id, status, child_session_id from session_stage_runs where session_id = $1 and stage_key = $2 order by started_at desc limit 1`,
    [sessionId, stageKey]
  ).then((r) => r.rows[0]!);

const systemLines = (channelId: string) =>
  q<{ content: string }>(
    `select content from messages where channel_id = $1 and role = 'system' order by "timestamp"`,
    [channelId]
  ).then((r) => r.rows.map((m) => m.content));

beforeAll(async () => {
  const seen = new Set<string>();
  for (const t of Object.values(database)) {
    if (!is(t, PgTableClass)) continue;
    const name = getTableConfig(t as PgTable).name;
    if (seen.has(name)) continue;
    seen.add(name);
    await h.client!.exec(ddlFor(t as PgTable));
  }
  expect(seen.has("playbook_versions")).toBe(true);
  await h.client!.exec(
    `create unique index on links (from_type, from_id, to_type, to_id, link_type)`
  );
  await h.client!.exec(
    `create unique index on channel_members (channel_id, member_id)`
  );
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'a@x.test', 'Antoine', 'human')`,
    [USER]
  );
  for (const [id, name, type] of [
    [h.devbox, "Claude Code (devbox)", "claude-code"],
    [LANE, "Claude Code (lane)", "claude-code"],
    [OTHER, "Another engine", "openclaw"],
  ] as const) {
    await q(
      `insert into users (id, email, name, user_type, agent_type) values ($1, $2, $3, 'agent', $4)`,
      [id, `${id}@agents.test`, name, type]
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
  // The used playbook is at version 2; version 1 is kept.
  await insertPlaybook(CHILD, "Render a cut", V2, 2);
  for (const [version, def] of [
    [1, V1],
    [2, V2],
  ] as const) {
    await q(
      `insert into playbook_versions (playbook_id, version, definition, created_at) values ($1, $2, $3::jsonb, now())`,
      [CHILD, version, JSON.stringify({ ...def, name: "Render a cut" })]
    );
  }
  await insertPlaybook(PARENT, "Make a video", {
    goalTemplate: "Make the video",
    stages: STAGES,
    expectedOutputs: [],
  });
});

beforeEach(async () => {
  h.dispatched.length = 0;
  h.turns.length = 0;
  await h.client!.exec(
    "delete from focus_sessions; delete from playbook_runs; delete from channels; delete from messages; delete from links; delete from proposals; delete from session_stage_runs; delete from lifecycle_transition_outbox;"
  );
});

afterAll(async () => {
  await h.client?.close();
});

const childRuns = () =>
  q<{ n: number }>(
    `select count(*)::int as n from focus_sessions where metadata ? 'stageOf'`
  ).then((r) => r.rows[0]!.n);

describe("a step that uses a playbook, under a session its own agent works", () => {
  it("a coding agent's session: no second worker, the step stays with it, and the room says why", async () => {
    const { sessionId, channelId, entered } = await startParent(PARENT, LANE);

    expect(entered.stageRun?.childSessionId).toBeUndefined();
    expect(await childRuns()).toBe(0);
    expect(entered.stageRun).toMatchObject({
      status: "entered",
      runnerAgentUserId: LANE,
      handOff: "none",
    });
    expect(entered.stageRun?.reason).toContain("already working it");
    const step = await stepRow(sessionId, "render");
    expect(step.child_session_id).toBeNull();
    expect(step.status).toBe("running");
    expect((await session(sessionId)).status).toBe("active");
    expect(
      (await systemLines(channelId)).some((l) =>
        l.includes("no second worker was started for step Render")
      )
    ).toBe(true);
  });

  // Whether the child run then starts is the child door's (its own suite,
  // `stage-uses-run.pglite.test.ts`); here the step goes TO the runner.
  it("CONTROL: a session a person started still hands the step to its runner", async () => {
    const { entered } = await startParent(PARENT);

    expect(entered.stageRun).toMatchObject({
      status: "entered",
      runnerAgentUserId: h.devbox,
      handOff: "attached",
    });
    expect(entered.stageRun?.reason ?? "").not.toContain("already working");
  });

  it("a session an agent of another kind started still hands the step to its runner", async () => {
    const { entered } = await startParent(PARENT, OTHER);

    expect(entered.stageRun).toMatchObject({
      runnerAgentUserId: h.devbox,
      handOff: "attached",
    });
  });
});
