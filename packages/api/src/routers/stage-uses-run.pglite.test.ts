/**
 * A STEP THAT IS A PLAYBOOK (runner engine slice 4, spec 7111934d §3.2): the
 * child run that works it, and what its close does to the parent.
 *
 * Driven through the REAL doors on PGlite: `playbooksRouter.run` (the parent's
 * birth), `advanceSessionStage` (entering the step), the stage runner,
 * `runPlaybook` (the child, pinned), `setSessionStatus` (the parent's hold),
 * the spawn and `blocked_by` edges, the room post door, the slot door
 * (`satisfyStageSlotsFromChild`) and `settleStageChild` (the reactor's body).
 * Stubbed: the executor registry, the IS turn door (recorded), and the
 * run-choice suite's governance and side-effect stubs.
 *
 * Asserted (each rules out a rule the others would pass):
 *   - the child follows the PINNED version after the used playbook changed:
 *     its stages, slots and prompt are version 1's, its snapshot says 1;
 *   - the child is stamped `stageOf`, the person's run (not an agent draft),
 *     the parent pauses on it, its step row waits on it, the parent is
 *     `blocked_by` it;
 *   - the child closes delivered: the parent step's slot is done with the
 *     child's pointer, the row is done, the parent resumes and moves into the
 *     next (ungated) step;
 *   - the next step is gated: no advance, the room says so;
 *   - a cancelled child: nothing advances, the parent stays paused; with the
 *     step's `onFail`, the run goes back there and stops waiting;
 *   - a replayed close settles nothing twice.
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
import {
  settleStageChild,
  stageChildReactor,
} from "../services/playbooks/stage-child.js";

const USER = randomUUID();
const WS = randomUUID();
const CHILD = randomUUID();
const PARENT = randomUUID();
const PARENT_GATED = randomUUID();
const PARENT_ON_FAIL = randomUUID();

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

async function startParent(playbookId: string) {
  const out = await asPerson().run({ playbookId });
  const sessionId = out.session!.id;
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

/** The child ends: its "Final cut" slot done (when delivered), then its status. */
async function endChild(
  childId: string,
  status: "closed" | "cancelled",
  deliver = true
) {
  const s = await session(childId);
  const outputs = s.expected_outputs.map((o) =>
    deliver && o.label === "Final cut"
      ? { ...o, status: "done", ref: { url: "https://example.test/cut.mp4" } }
      : o
  );
  await q(
    `update focus_sessions set status = $2, expected_outputs = $3::jsonb, closed_at = now() where id = $1`,
    [childId, status, JSON.stringify(outputs)]
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
  await insertPlaybook(PARENT_GATED, "Make a reviewed video", {
    goalTemplate: "Make the video",
    stages: [
      STAGES[0],
      renderStep(),
      { ...STAGES[2], gate: { kind: "human" } },
    ],
    expectedOutputs: [],
  });
  await insertPlaybook(PARENT_ON_FAIL, "Make a video, retry the brief", {
    goalTemplate: "Make the video",
    stages: [
      STAGES[0],
      renderStep({ onFail: { toStage: "brief" } }),
      STAGES[2],
    ],
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

describe("entering a step that is a playbook", () => {
  it("starts the child at the pinned version, stamped, the person's; the parent waits on it", async () => {
    const { sessionId, entered } = await startParent(PARENT);
    const childId = entered.stageRun?.childSessionId;
    expect(childId).toBeTruthy();

    const child = await session(childId!);
    // Version 1's definition, though the playbook is at version 2 now.
    expect(child.playbook_id).toBe(CHILD);
    expect(child.current_stage).toBe("rough");
    expect(child.metadata.prompt).toBe("Render the rough cut (v1)");
    const [run] = (
      await q<{ definition_snapshot: { version: number; stages: unknown } }>(
        `select definition_snapshot from playbook_runs where session_id = $1`,
        [childId]
      )
    ).rows;
    expect(run!.definition_snapshot.version).toBe(1);
    expect(run!.definition_snapshot.stages).toEqual(V1.stages);

    const step = await stepRow(sessionId, "render");
    expect(child.metadata.stageOf).toEqual({
      sessionId,
      stageKey: "render",
      stageRunId: step.id,
    });
    // The person's run, never an agent draft.
    expect(child.user_id).toBe(USER);
    expect(child.origin).not.toBe("agent");

    expect(step).toMatchObject({
      status: "waiting_child",
      child_session_id: childId,
    });
    expect((await session(sessionId)).status).toBe("paused");
    // The hold waits on the child closing (the hold-resume worker's form).
    const moves = (
      await q<{ transition: Record<string, unknown> }>(
        `select transition from lifecycle_transition_outbox`
      )
    ).rows.map((r) => JSON.stringify(r.transition));
    expect(
      moves.filter(
        (m) =>
          m.includes(sessionId) &&
          m.includes(`"moves":"focus_session:${childId}"`)
      )
    ).toHaveLength(1);
  });
});

describe("the child closes", () => {
  it("delivered: the step's slot gets the child's output, the run resumes and moves on", async () => {
    const { sessionId, entered } = await startParent(PARENT);
    const childId = entered.stageRun!.childSessionId!;
    await endChild(childId, "closed");
    expect(
      stageChildReactor.match?.({
        subjectType: "focus_session",
        action: "closed",
        subjectId: childId,
      } as never)
    ).toBe(true);

    const out = await settleStageChild(childId);
    expect(out).toMatchObject({
      status: "advanced",
      satisfied: ["Final cut"],
      toStage: "publish",
    });
    const parent = await session(sessionId);
    expect(parent.current_stage).toBe("publish");
    expect(parent.status).toBe("active");
    expect(
      parent.expected_outputs.find((o) => o.label === "Final cut")
    ).toMatchObject({
      status: "done",
      ref: { url: "https://example.test/cut.mp4" },
    });
    expect((await stepRow(sessionId, "render")).status).toBe("done");

    // A replayed close settles nothing twice.
    expect(await settleStageChild(childId)).toEqual({
      status: "settled_already",
    });
  });

  it("delivered, the next step gated: no advance, the run is told", async () => {
    const { sessionId, channelId, entered } = await startParent(PARENT_GATED);
    const childId = entered.stageRun!.childSessionId!;
    await endChild(childId, "closed");
    const out = await settleStageChild(childId);
    expect(out).toMatchObject({ status: "told", satisfied: ["Final cut"] });
    expect((await session(sessionId)).current_stage).toBe("render");
    expect((await systemLines(channelId)).at(-1)).toContain(
      "the next step, Publish, is gated"
    );
    // The run's Synap AI gets ONE turn, answering that room line: the turn
    // door needs the line's id, without it no turn starts.
    const told = await q<{ id: string }>(
      `select id from messages where channel_id = $1 and role = 'system' and content like '%the next step, Publish, is gated%'`,
      [channelId]
    );
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]).toMatchObject({
      channelId,
      focusSessionId: sessionId,
      userMessageId: told.rows[0]!.id,
    });
  });

  it("closed without the output: no advance, the run is told what is missing", async () => {
    const { sessionId, channelId, entered } = await startParent(PARENT);
    const childId = entered.stageRun!.childSessionId!;
    await endChild(childId, "closed", false);
    const out = await settleStageChild(childId);
    expect(out).toMatchObject({ status: "told", satisfied: [] });
    expect((await session(sessionId)).current_stage).toBe("render");
    expect((await systemLines(channelId)).at(-1)).toContain(
      "it did not deliver Final cut"
    );
  });

  it("cancelled: nothing advances, the run keeps waiting", async () => {
    const { sessionId, entered } = await startParent(PARENT);
    const childId = entered.stageRun!.childSessionId!;
    await endChild(childId, "cancelled", false);
    const out = await settleStageChild(childId);
    expect(out).toMatchObject({ status: "dropped" });
    const parent = await session(sessionId);
    expect(parent.current_stage).toBe("render");
    expect(parent.status).toBe("paused");
    expect((await stepRow(sessionId, "render")).status).toBe("cancelled");
  });

  it("cancelled, the step declares onFail: the run goes back there and stops waiting", async () => {
    const { sessionId, entered } = await startParent(PARENT_ON_FAIL);
    const childId = entered.stageRun!.childSessionId!;
    await endChild(childId, "cancelled", false);
    // The spawn's `blocked_by` edge (written through the pg client, which
    // this suite does not reach: seeded as the spawn writes it).
    await q(
      `insert into links (id, workspace_id, from_type, from_id, to_type, to_id, link_type, metadata, created_at) values ($1, $2, 'session', $3, 'session', $4, 'blocked_by', '{}'::jsonb, now())`,
      [randomUUID(), WS, sessionId, childId]
    );
    const out = await settleStageChild(childId);
    expect(out).toMatchObject({ status: "on_fail", toStage: "brief" });
    const parent = await session(sessionId);
    expect(parent.current_stage).toBe("brief");
    expect(parent.status).toBe("active");
    const blocked = await q(
      `select 1 from links where from_id = $1 and to_id = $2 and link_type = 'blocked_by'`,
      [sessionId, childId]
    );
    expect(blocked.rows).toHaveLength(0);
  });
});
