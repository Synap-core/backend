/**
 * A STEP THAT RUNS ONCE PER BATCH OF ITEMS (`forEach`, plan fbfadf54 fix 3):
 * the child runs that work it, at most three at once, and what their closes
 * do to the parent.
 *
 * Driven through the REAL doors on PGlite: `playbooksRouter.run` (the
 * parent's birth), `advanceSessionStage` (entering the step), the stage
 * runner, `runPlaybook` (each child: the step's `uses` playbook, else this
 * playbook reduced to the step), `setSessionStatus` (the parent's hold), the
 * room post door and `settleStageChild` (the reactor's body). Stubbed: the
 * executor registry, the IS turn door (recorded), and the run-choice suite's
 * governance and side-effect stubs.
 *
 * Asserted (each rules out a rule the others would pass):
 *   - 70 items, batch 30: three children of 30, 30 and 10 items, each the
 *     person's run (no proposal, not an agent draft), stamped with its batch,
 *     its items in its goal; the parent pauses, its step row waits;
 *   - 70 items, batch 10: seven batches, never more than three running, the
 *     next one starting as one ends; the last close finishes the step;
 *   - a failed child: the parent still finishes the step, moves on, stops
 *     waiting on that child, and its agent is told which part failed;
 *   - a replayed close starts nothing and settles nothing twice;
 *   - `max` caps the items; a step that `uses` a playbook runs that playbook;
 *   - `over` naming no list: the step fails and the room says why;
 *   - each child is titled by its step, part and items;
 *   - entering the step again (a second tools re-check) fans out nothing more;
 *   - a batch whose run never started is failed by the sweep, which then
 *     finishes the step; a batch claimed a minute ago is left alone.
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
    run: async () => ({ status: "running" }),
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
    checkPermissionOrPropose: async () => ({ granted: true }),
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { PgTable as PgTableClass } from "drizzle-orm/pg-core";
import * as database from "@synap/database";
import { playbooksRouter } from "./playbooks.js";
import type { Context } from "../types/context.js";
import { advanceSessionStage } from "../services/focus-sessions/advance-stage.js";
import { settleStageChild } from "../services/playbooks/stage-child.js";
import {
  startStageForEach,
  sweepOrphanedFanOuts,
} from "../services/playbooks/stage-for-each.js";

const USER = randomUUID();
const WS = randomUUID();
const REVIEW = randomUUID();
const REVIEW_CAPPED = randomUUID();
const REVIEW_SEVEN = randomUUID();
const REVIEW_USES = randomUUID();
const ONE_AREA = randomUUID();

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

const reviewStep = (forEach: Record<string, unknown>, extra = {}) => ({
  key: "review",
  name: "Review",
  category: "started",
  goal: "Review the findings of @{arg:area:text}",
  forEach,
  ...extra,
});
const stagesWith = (step: Record<string, unknown>) => [
  { key: "brief", name: "Brief", category: "started" },
  step,
  { key: "summarize", name: "Summarize", category: "completed" },
];

async function insertPlaybook(
  id: string,
  name: string,
  def: { goalTemplate: string; stages: unknown },
  version = 1
) {
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, executor, status, metadata, params, input_strategy, channel_spec, expected_outputs, stages, criteria, requires, version)
     values ($1, $2, $3, $4, $5, 'is-agent', 'active', '{}'::jsonb, '[]'::jsonb, '{"kind":"none"}'::jsonb, '{}'::jsonb, '[{"kind":"document","label":"Consolidation"}]'::jsonb, $6::jsonb, '[]'::jsonb, '[]'::jsonb, $7)`,
    [id, WS, USER, name, def.goalTemplate, JSON.stringify(def.stages), version]
  );
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `f${i + 1}`);

/** Start the parent with `params`, then enter its `forEach` step. */
async function startParent(
  playbookId: string,
  params: Record<string, unknown>
) {
  const out = await asPerson().run({ playbookId, params });
  const sessionId = out.session!.id;
  const s = await q<Record<string, unknown>>(
    `select id, current_stage as "currentStage", workspace_id as "workspaceId", project_id as "projectId", channel_id as "channelId", playbook_id as "playbookId", subject_entity_id as "subjectEntityId" from focus_sessions where id = $1`,
    [sessionId]
  );
  const entered = await advanceSessionStage({
    session: s.rows[0] as never,
    toStage: "review",
    userId: USER,
    stageWrite: "door",
  });
  return { sessionId, channelId: out.session!.channelId as string, entered };
}

const session = (id: string) =>
  q<{
    status: string;
    current_stage: string | null;
    metadata: Record<string, unknown>;
    origin: string | null;
    user_id: string;
    playbook_id: string;
    stages: Array<Record<string, unknown>>;
    expected_outputs: Array<Record<string, unknown>>;
  }>(
    `select status, current_stage, metadata, origin, user_id, playbook_id, stages, expected_outputs from focus_sessions where id = $1`,
    [id]
  ).then((r) => r.rows[0]!);

const stepRow = (sessionId: string) =>
  q<{
    id: string;
    status: string;
    fan_out: {
      batch: number;
      total: number;
      children: Array<{ items: unknown[]; status: string; sessionId?: string }>;
    } | null;
  }>(
    `select id, status, fan_out from session_stage_runs where session_id = $1 and stage_key = 'review' order by started_at desc limit 1`,
    [sessionId]
  ).then((r) => r.rows[0]!);

/** Children of the parent, oldest first, with their batch index. */
const children = (parentId: string) =>
  q<{ id: string; status: string; metadata: Record<string, unknown> }>(
    `select id, status, metadata from focus_sessions where metadata -> 'stageOf' ->> 'sessionId' = $1 order by (metadata -> 'stageOf' ->> 'forEachIndex')::int`,
    [parentId]
  ).then((r) => r.rows);

const openChildren = async (parentId: string) =>
  (await children(parentId)).filter(
    (c) => !["closed", "failed", "cancelled"].includes(c.status)
  );

const systemLines = (channelId: string) =>
  q<{ content: string }>(
    `select content from messages where channel_id = $1 and role = 'system' order by "timestamp"`,
    [channelId]
  ).then((r) => r.rows.map((m) => m.content));

async function endChild(id: string, status: "closed" | "failed" | "cancelled") {
  await q(
    `update focus_sessions set status = $2, closed_at = now() where id = $1`,
    [id, status]
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
  await insertPlaybook(REVIEW, "Consolidate findings", {
    goalTemplate: "Consolidate the findings",
    stages: stagesWith(
      reviewStep({ over: "findingIds", as: "area", batch: 30 })
    ),
  });
  await insertPlaybook(REVIEW_CAPPED, "Consolidate some findings", {
    goalTemplate: "Consolidate the findings",
    stages: stagesWith(
      reviewStep({ over: "findingIds", as: "area", batch: 10, max: 20 })
    ),
  });
  await insertPlaybook(REVIEW_SEVEN, "Consolidate findings in tens", {
    goalTemplate: "Consolidate the findings",
    stages: stagesWith(
      reviewStep({ over: "findingIds", as: "area", batch: 10 })
    ),
  });
  await insertPlaybook(ONE_AREA, "Review one area", {
    goalTemplate: "Review the area @{arg:area:text}",
    stages: [{ key: "read", name: "Read", category: "started" }],
  });
  await insertPlaybook(REVIEW_USES, "Consolidate by area", {
    goalTemplate: "Consolidate the findings",
    stages: stagesWith(
      reviewStep(
        { over: "areas", as: "area" },
        { uses: { playbookId: ONE_AREA, version: 1 } }
      )
    ),
  });
});

beforeEach(async () => {
  h.turns.length = 0;
  await h.client!.exec(
    "delete from focus_sessions; delete from playbook_runs; delete from channels; delete from messages; delete from links; delete from proposals; delete from session_stage_runs; delete from lifecycle_transition_outbox;"
  );
});

afterAll(async () => {
  await h.client?.close();
});

describe("entering a forEach step", () => {
  it("70 items, batch 30: three children of 30, 30 and 10, the person's, no proposal; the parent waits", async () => {
    const { sessionId } = await startParent(REVIEW, { findingIds: ids(70) });

    const step = await stepRow(sessionId);
    expect(step.status).toBe("waiting_child");
    expect(step.fan_out!.total).toBe(70);
    expect(step.fan_out!.children.map((c) => c.items.length)).toEqual([
      30, 30, 10,
    ]);
    expect(step.fan_out!.children.map((c) => c.status)).toEqual([
      "running",
      "running",
      "running",
    ]);

    const kids = await children(sessionId);
    expect(kids).toHaveLength(3);
    for (const [i, kid] of kids.entries()) {
      const child = await session(kid.id);
      expect(child.metadata.stageOf).toEqual({
        sessionId,
        stageKey: "review",
        stageRunId: step.id,
        forEachIndex: i,
      });
      expect(step.fan_out!.children[i]!.sessionId).toBe(kid.id);
      // The person's run, never an agent draft.
      expect(child.user_id).toBe(USER);
      expect(child.origin).not.toBe("agent");
      // This playbook reduced to the step: one stage, no fan-out of its own,
      // none of the parent's deliverables.
      expect(child.playbook_id).toBe(REVIEW);
      expect(child.stages.map((s) => s.key)).toEqual(["review"]);
      expect(child.stages[0]!.forEach).toBeUndefined();
      expect(
        child.expected_outputs.some((o) => o.label === "Consolidation")
      ).toBe(false);
    }
    // Each child is named by its step, part and items.
    expect(
      (
        await q<{ title: string }>(
          `select title from focus_sessions where id = $1`,
          [kids[1]!.id]
        )
      ).rows[0]!.title
    ).toBe("Review, part 2 of 3: f31 and 29 more");
    // Its items are in its goal; another batch's are not.
    const second = String((await session(kids[1]!.id)).metadata.prompt);
    expect(second).toContain("part 2 of 3");
    expect(second).toContain("- f31\n");
    expect(second).toContain("- f60");
    expect(second).not.toContain("- f30\n");
    expect(second).not.toContain("- f61");

    // Children inherit the parent's approval: nothing was proposed.
    expect((await q(`select id from proposals`)).rows).toHaveLength(0);
    expect((await session(sessionId)).status).toBe("paused");
  });

  it("max caps the collection: 70 items, max 20, batch 10 is two batches", async () => {
    const { sessionId } = await startParent(REVIEW_CAPPED, {
      findingIds: ids(70),
    });
    const fanOut = (await stepRow(sessionId)).fan_out!;
    expect(fanOut.total).toBe(70);
    expect(fanOut.children.map((c) => c.items.length)).toEqual([10, 10]);
  });

  it("70 items, batch 10: seven batches, never more than three running; each end starts the next; the last finishes the step", async () => {
    const { sessionId } = await startParent(REVIEW_SEVEN, {
      findingIds: ids(70),
    });
    expect((await stepRow(sessionId)).fan_out!.children).toHaveLength(7);
    expect(await openChildren(sessionId)).toHaveLength(3);
    for (let ended = 1; ended <= 7; ended++) {
      const [oldest] = await openChildren(sessionId);
      await endChild(oldest!.id, "closed");
      await settleStageChild(oldest!.id);
      const open = await openChildren(sessionId);
      expect(open.length).toBeLessThanOrEqual(3);
      // Started so far: the first three, plus one per child that ended.
      expect(await children(sessionId)).toHaveLength(
        [4, 5, 6, 7, 7, 7, 7][ended - 1]!
      );
      expect(open).toHaveLength([3, 3, 3, 3, 2, 1, 0][ended - 1]!);
    }
    expect((await stepRow(sessionId)).status).toBe("done");
    const parent = await session(sessionId);
    expect(parent.status).toBe("active");
    expect(parent.current_stage).toBe("summarize");
  });

  it("a step that uses a playbook: each child runs that playbook with its item", async () => {
    const { sessionId } = await startParent(REVIEW_USES, {
      areas: ["billing", "auth"],
    });
    const kids = await children(sessionId);
    expect(kids).toHaveLength(2);
    const first = await session(kids[0]!.id);
    expect(first.playbook_id).toBe(ONE_AREA);
    expect(String(first.metadata.prompt)).toContain("Review the area billing");
  });

  it("an empty list: no child, the step is done at once and the run moves on", async () => {
    const { sessionId } = await startParent(REVIEW, { findingIds: [] });
    expect(await children(sessionId)).toHaveLength(0);
    expect((await stepRow(sessionId)).status).toBe("done");
    const parent = await session(sessionId);
    expect(parent.status).toBe("active");
    expect(parent.current_stage).toBe("summarize");
  });

  it("over names no list: the step fails, the room says why, no child starts", async () => {
    const { sessionId, channelId } = await startParent(REVIEW, {
      findingIds: "not a list",
    });
    expect((await stepRow(sessionId)).status).toBe("failed");
    expect(await children(sessionId)).toHaveLength(0);
    expect((await systemLines(channelId)).at(-1)).toContain(
      '"findingIds" is not a list.'
    );
  });
});

describe("entering the step again", () => {
  it("a second entry of a fanned-out step starts nothing: one fan-out", async () => {
    const { sessionId } = await startParent(REVIEW, { findingIds: ids(70) });
    const step = await stepRow(sessionId);
    const again = await startStageForEach({
      session: {
        id: sessionId,
        userId: USER,
        channelId: null,
        status: "paused",
      },
      stage: reviewStep({ over: "findingIds", as: "area", batch: 30 }),
      stageRunId: step.id,
    });
    expect(again).toEqual({ status: "already_started" });
    expect(await children(sessionId)).toHaveLength(3);
    expect((await stepRow(sessionId)).fan_out).toEqual(step.fan_out);
  });
});

describe("a batch whose run never started", () => {
  async function orphan(claimedMinutesAgo: number) {
    const started = await startParent(REVIEW, { findingIds: ids(70) });
    const step = await stepRow(started.sessionId);
    const kids = await children(started.sessionId);
    // Batch 1 was claimed and the pod stopped before its run had a session;
    // batches 2 and 3 were delivered.
    const fanOut = {
      ...step.fan_out!,
      children: step.fan_out!.children.map((c, i) =>
        i === 0
          ? {
              items: c.items,
              status: "running",
              claimedAt: new Date(
                Date.now() - claimedMinutesAgo * 60_000
              ).toISOString(),
            }
          : { ...c, status: "done" }
      ),
    };
    await q(`update session_stage_runs set fan_out = $2::jsonb where id = $1`, [
      step.id,
      JSON.stringify(fanOut),
    ]);
    for (const kid of kids) await endChild(kid.id, "closed");
    return started;
  }

  it("the sweep fails it, finishes the step, resumes the parent and names the part", async () => {
    const { sessionId, channelId } = await orphan(60);
    expect(await sweepOrphanedFanOuts()).toBe(1);
    const step = await stepRow(sessionId);
    expect(step.status).toBe("done");
    expect(step.fan_out!.children[0]!.status).toBe("failed");
    const parent = await session(sessionId);
    expect(parent.status).toBe("active");
    expect(parent.current_stage).toBe("summarize");
    expect(
      (await systemLines(channelId)).find((l) =>
        l.startsWith("Step Review is done")
      )
    ).toContain("part 1 failed.");
  });

  it("a batch claimed a minute ago is still starting: the sweep leaves it", async () => {
    const { sessionId } = await orphan(1);
    expect(await sweepOrphanedFanOuts()).toBe(0);
    expect((await stepRow(sessionId)).status).toBe("waiting_child");
  });
});

describe("the children close", () => {
  it("one failed: the parent still finishes the step, stops waiting on it, moves on and names it", async () => {
    const { sessionId, channelId } = await startParent(REVIEW, {
      findingIds: ids(70),
    });
    const kids = await children(sessionId);
    // The spawn's `blocked_by` edge (written through the pg client, which
    // this suite does not reach: seeded as the spawn writes it).
    await q(
      `insert into links (id, workspace_id, from_type, from_id, to_type, to_id, link_type, metadata, created_at) values ($1, $2, 'session', $3, 'session', $4, 'blocked_by', '{}'::jsonb, now())`,
      [randomUUID(), WS, sessionId, kids[1]!.id]
    );

    await endChild(kids[1]!.id, "failed");
    expect(await settleStageChild(kids[1]!.id)).toEqual({
      status: "fan_out_waiting",
      failed: [2],
    });
    // A replayed close settles nothing twice.
    expect(await settleStageChild(kids[1]!.id)).toEqual({
      status: "settled_already",
    });
    expect(
      (
        await q(
          `select 1 from links where from_id = $1 and to_id = $2 and link_type = 'blocked_by'`,
          [sessionId, kids[1]!.id]
        )
      ).rows
    ).toHaveLength(0);
    expect((await session(sessionId)).status).toBe("paused");

    await endChild(kids[0]!.id, "closed");
    await settleStageChild(kids[0]!.id);
    await endChild(kids[2]!.id, "closed");
    expect(await settleStageChild(kids[2]!.id)).toEqual({
      status: "fan_out_done",
      failed: [2],
      toStage: "summarize",
    });

    const parent = await session(sessionId);
    expect(parent.status).toBe("active");
    expect(parent.current_stage).toBe("summarize");
    expect((await stepRow(sessionId)).status).toBe("done");
    const told = (await systemLines(channelId)).find((l) =>
      l.startsWith("Step Review is done")
    );
    expect(told).toContain("2 of 3 runs delivered; part 2 failed.");
    expect(told).toContain(`part 2 (30 items)`);
    expect(told).toContain("FAILED");
    // The run's agent gets one turn with what each child did.
    const turns = h.turns.filter((t) =>
      String(t.content).startsWith("Step Review is done")
    );
    expect(turns).toHaveLength(1);
    // The turn answers the room line it was told in (the door reads it).
    expect(turns[0]!.userMessageId).toBeTruthy();
  });
});
