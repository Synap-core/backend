/**
 * ONE LIVE RUN PER OBJECT (founder, 2026-11-16, plan ec581c1d slice A): a
 * person who runs a playbook on an object while a run of it is still live
 * there gets that run back (`already_running`), not a second run.
 *
 * Driven through the REAL doors on PGlite: `playbooksRouter.run` (the run
 * door every surface reaches: tRPC, Hub REST and MCP through
 * `runPlaybookDoor`, the approved replay through `createCaller`), the real
 * spine (`runPlaybook` → `instantiateSession` → `insertFocusSessionRow`), the
 * real live-run read, the REAL partial unique index (migration 0427's own
 * SQL, run against the table), the forEach and `uses` step runners
 * (`advanceSessionStage`), and the reopen door (`reopenCancelledSession`).
 * Stubbed as in `stage-for-each-run.pglite.test.ts`: the executor registry,
 * the IS turn door, governance (allows), the skill preflight, the write
 * floor, the read-only and audit middlewares, notify, recall, realtime.
 *
 * Asserted (each row rules out a rule the others would pass):
 *   - a second click answers `already_running` with the FIRST run (session +
 *     run), starts nothing (rules out the old fall-through "started", run null);
 *   - two concurrent clicks that both read "nothing live" start ONE run: the
 *     index refuses the second insert and the door answers with the winner
 *     (rules out a read-only guard);
 *   - `startAnother` starts a second run, which does not hold the slot: the
 *     next plain click still answers with the slot-holder;
 *   - another person's live run on the same object is never returned and
 *     never blocks them (rules out a key without the owner);
 *   - a forEach step's N children on the parent's object are N runs, and a
 *     `uses` step's child starts its own run even while the person has a live
 *     run of that playbook on the object (rules out reuse as runPlaybook's
 *     default);
 *   - a FAILED run does not block a click (rules out the automation cooldown
 *     on a person's run);
 *   - ending a run (closed, failed, cancelled) frees the object; reopening the
 *     ended run while another is live is refused by name;
 *   - an agent's draft waiting for the person counts as live, said as such;
 *   - runs with no object are untouched: two clicks, two runs.
 *
 * NOT COVERED here: the Hub REST / MCP schemas carrying `startAnother` (pass-
 * through to this door, `playbook-doors.ts`); production Postgres.
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
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
      close: () => Promise<void>;
    },
    /**
     * The race: the first `barrierReads` live-run reads wait for each other in
     * pairs, so two clicks both read "nothing live" before either inserts.
     */
    barrierReads: 0,
    /**
     * The race LOST: the next `blindReads` live-run reads answer "nothing
     * live" although a run is live, as when a concurrent click inserted just
     * after both of this click's reads. The click then reaches the 0427 index.
     */
    blindReads: 0,
    waiting: [] as Array<() => void>,
    async arrive(): Promise<void> {
      if (state.barrierReads <= 0) return;
      state.barrierReads--;
      await new Promise<void>((resolve) => {
        state.waiting.push(resolve);
        if (state.waiting.length >= 2) {
          for (const release of state.waiting.splice(0)) release();
        }
      });
    },
  };
  return state;
});

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
vi.mock(
  "../services/playbooks/live-run-of-subject.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../services/playbooks/live-run-of-subject.js")
      >();
    return {
      ...actual,
      findLiveRunOfSubject: async (
        input: Parameters<typeof actual.findLiveRunOfSubject>[0]
      ) => {
        if (h.blindReads > 0) {
          h.blindReads--;
          return null;
        }
        const live = await actual.findLiveRunOfSubject(input);
        await h.arrive();
        return live;
      },
    };
  }
);
vi.mock("../services/playbooks/executors/registry.js", () => ({
  resolveExecutor: (ref: string) => ({
    ref,
    run: async () => ({ status: "running" }),
  }),
}));
vi.mock("../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: async () => true,
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

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { PgTable as PgTableClass } from "drizzle-orm/pg-core";
import * as database from "@synap/database";
import { playbooksRouter } from "./playbooks.js";
import type { Context } from "../types/context.js";
import { advanceSessionStage } from "../services/focus-sessions/advance-stage.js";
import { reopenCancelledSession } from "../services/focus-sessions/reopen-session.js";
import { runPlaybook } from "../services/playbooks/run-playbook.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0427 = readFileSync(
  resolve(
    HERE,
    "../../../database/migrations/0427_one_live_run_per_subject.sql"
  ),
  "utf8"
);

const USER = randomUUID();
const OTHER = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID();
const SUBJECT = randomUUID();
const PB = randomUUID();
const FOR_EACH = randomUUID();
const ONE_AREA = randomUUID();
const USES = randomUUID();
const ROTATING = randomUUID();

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

const as = (userId: string) =>
  playbooksRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId: WS,
  } as unknown as Context);

/** Every session of a playbook, oldest first. */
const sessionsOf = (playbookId: string) =>
  q<{
    id: string;
    user_id: string;
    status: string;
    one_live_per_subject: boolean | null;
    subject_entity_id: string | null;
    metadata: Record<string, unknown>;
  }>(
    `select id, user_id, status, one_live_per_subject, subject_entity_id, metadata from focus_sessions where playbook_id = $1 order by started_at, created_at`,
    [playbookId]
  ).then((r) => r.rows);

const runCount = async () =>
  (await q<{ n: number }>(`select count(*)::int as n from playbook_runs`))
    .rows[0]!.n;

const setStatus = (id: string, status: string) =>
  q(`update focus_sessions set status = $2, closed_at = now() where id = $1`, [
    id,
    status,
  ]);

async function insertPlaybook(
  id: string,
  name: string,
  stages: unknown,
  goalTemplate = "Work on it"
) {
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, executor, status, metadata, params, input_strategy, channel_spec, expected_outputs, stages, criteria, requires, version)
     values ($1, $2, $3, $4, $5, 'is-agent', 'active', '{}'::jsonb, '[]'::jsonb, '{"kind":"none"}'::jsonb, '{}'::jsonb, '[]'::jsonb, $6::jsonb, '[]'::jsonb, '[]'::jsonb, 1)`,
    [id, WS, USER, name, goalTemplate, JSON.stringify(stages)]
  );
}

/** Enter `toStage` of a live run (the stage runner starts its children). */
async function enter(sessionId: string, toStage: string) {
  const s = await q<Record<string, unknown>>(
    `select id, current_stage as "currentStage", workspace_id as "workspaceId", project_id as "projectId", channel_id as "channelId", playbook_id as "playbookId", subject_entity_id as "subjectEntityId" from focus_sessions where id = $1`,
    [sessionId]
  );
  await advanceSessionStage({
    session: s.rows[0] as never,
    toStage,
    userId: USER,
    stageWrite: "door",
  });
}

const childrenOf = (parentId: string) =>
  q<{
    id: string;
    playbook_id: string;
    subject_entity_id: string | null;
    one_live_per_subject: boolean | null;
  }>(
    `select id, playbook_id, subject_entity_id, one_live_per_subject from focus_sessions where metadata -> 'stageOf' ->> 'sessionId' = $1`,
    [parentId]
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
  // The REAL floor: migration 0427's own statements (its ADD COLUMN is a
  // no-op on this table, its CREATE UNIQUE INDEX is the one a pod gets).
  await h.client!.exec(M0427);
  await h.client!.exec(
    `create unique index on links (from_type, from_id, to_type, to_id, link_type)`
  );
  await h.client!.exec(
    `create unique index on channel_members (channel_id, member_id)`
  );
  await q(
    `insert into users (id, email, name, user_type, agent_type, created_by_user_id) values
      ($1, 'a@x.test', 'Antoine', 'human', null, null),
      ($2, 'b@x.test', 'Bea', 'human', null, null),
      ($3, 'cc@x.test', 'Claude Code', 'agent', 'claude-code', $1)`,
    [USER, OTHER, AGENT]
  );
  await q(`insert into workspaces (id, name) values ($1, 'Sales')`, [WS]);
  await q(
    `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'editor')`,
    [WS, USER, OTHER]
  );
  await q(
    `insert into agents (id, name, agent_slug, active, owner_type) values ($1, 'Meta', 'meta', true, 'system')`,
    [randomUUID()]
  );
  await q(
    `insert into entities (id, workspace_id, user_id, type, title, properties) values ($1, $2, $3, 'person', 'Ada Lovelace', '{}'::jsonb)`,
    [SUBJECT, WS, USER]
  );
  await insertPlaybook(PB, "Search a LinkedIn profile", [
    { key: "search", name: "Search", category: "started" },
  ]);
  await insertPlaybook(
    FOR_EACH,
    "Research each lead",
    [
      { key: "brief", name: "Brief", category: "started" },
      {
        key: "review",
        name: "Review",
        category: "started",
        goal: "Review @{arg:area:text}",
        forEach: { over: "areas", as: "area", batch: 1 },
      },
      { key: "done", name: "Done", category: "completed" },
    ],
    "Research the leads"
  );
  const oneAreaStages = [{ key: "read", name: "Read", category: "started" }];
  await insertPlaybook(ONE_AREA, "Review one area", oneAreaStages);
  await q(
    `insert into playbook_versions (playbook_id, version, definition, created_at) values ($1, 1, $2::jsonb, now())`,
    [
      ONE_AREA,
      JSON.stringify({
        name: "Review one area",
        goalTemplate: "Work on it",
        stages: oneAreaStages,
        expectedOutputs: [],
      }),
    ]
  );
  await insertPlaybook(USES, "Review then publish", [
    { key: "brief", name: "Brief", category: "started" },
    {
      key: "review",
      name: "Review",
      category: "started",
      uses: { playbookId: ONE_AREA, version: 1 },
    },
    { key: "publish", name: "Publish", category: "completed" },
  ]);
  await insertPlaybook(ROTATING, "Post the next topic", [
    { key: "post", name: "Post", category: "started" },
  ]);
});

beforeEach(async () => {
  h.barrierReads = 0;
  h.blindReads = 0;
  h.waiting.length = 0;
  await h.client!.exec(
    "delete from focus_sessions; delete from playbook_runs; delete from channels; delete from messages; delete from links; delete from proposals; delete from session_stage_runs; delete from lifecycle_transition_outbox;"
  );
});

afterAll(async () => {
  await h.client?.close();
});

describe("a second run of a playbook on the same object", () => {
  it("answers already_running with the first run and starts nothing", async () => {
    const first = await as(USER).run({ playbookId: PB, subjectId: SUBJECT });
    expect(first.status).toBe("running");
    const second = await as(USER).run({ playbookId: PB, subjectId: SUBJECT });
    expect(second).toMatchObject({
      status: "already_running",
      reason: "live_run",
      proposalId: null,
    });
    expect(second.session?.id).toBe(first.session!.id);
    expect(second.run?.id).toBe(first.run!.id);
    expect(second.message).toMatch(/already running on this record/);
    const sessions = await sessionsOf(PB);
    expect(sessions).toHaveLength(1);
    // The run door's person run holds the object's slot.
    expect(sessions[0]!.one_live_per_subject).toBe(true);
    expect(await runCount()).toBe(1);
  });

  it("two concurrent clicks that both read 'nothing live' start ONE run", async () => {
    // Two reads per click (the door, then the spine): every one of them is
    // made before either click inserts.
    h.barrierReads = 4;
    const [a, b] = await Promise.all([
      as(USER).run({ playbookId: PB, subjectId: SUBJECT }),
      as(USER).run({ playbookId: PB, subjectId: SUBJECT }),
    ]);
    expect(h.barrierReads).toBe(0);
    expect([a.status, b.status].sort()).toEqual(["already_running", "running"]);
    expect(a.session?.id).toBe(b.session?.id);
    expect(await sessionsOf(PB)).toHaveLength(1);
    expect(await runCount()).toBe(1);
  });

  it("startAnother starts a second run that does not hold the slot", async () => {
    const first = await as(USER).run({ playbookId: PB, subjectId: SUBJECT });
    const another = await as(USER).run({
      playbookId: PB,
      subjectId: SUBJECT,
      startAnother: true,
    });
    expect(another.status).toBe("running");
    expect(another.session?.id).not.toBe(first.session!.id);
    const stamp = new Map(
      (await sessionsOf(PB)).map((s) => [s.id, s.one_live_per_subject])
    );
    expect(stamp.size).toBe(2);
    expect(stamp.get(first.session!.id)).toBe(true);
    expect(stamp.get(another.session!.id)).toBe(false);
    // A plain click still answers with the slot-holder.
    const third = await as(USER).run({ playbookId: PB, subjectId: SUBJECT });
    expect(third.status).toBe("already_running");
    expect(third.session?.id).toBe(first.session!.id);
    expect(await sessionsOf(PB)).toHaveLength(2);
  });
});

describe("whose run it is", () => {
  it("another person's live run is never returned and never blocks them", async () => {
    const mine = await as(USER).run({ playbookId: PB, subjectId: SUBJECT });
    const theirs = await as(OTHER).run({ playbookId: PB, subjectId: SUBJECT });
    expect(theirs.status).toBe("running");
    expect(theirs.session?.id).not.toBe(mine.session!.id);
    expect(theirs.session?.userId).toBe(OTHER);
    // Each person's second click gets their OWN run back.
    const mineAgain = await as(USER).run({
      playbookId: PB,
      subjectId: SUBJECT,
    });
    const theirsAgain = await as(OTHER).run({
      playbookId: PB,
      subjectId: SUBJECT,
    });
    expect(mineAgain.session?.id).toBe(mine.session!.id);
    expect(theirsAgain.session?.id).toBe(theirs.session!.id);
  });

  it("an agent's draft waiting for the person counts as live", async () => {
    const draft = await as(USER).run({
      playbookId: PB,
      subjectId: SUBJECT,
      agentUserId: AGENT,
    });
    expect(draft.status).toBe("draft");
    const click = await as(USER).run({ playbookId: PB, subjectId: SUBJECT });
    expect(click).toMatchObject({
      status: "already_running",
      reason: "draft_awaiting_acceptance",
      run: null,
    });
    expect(click.session?.id).toBe(draft.session!.id);
    expect(click.message).toMatch(/waits for you to accept it/);
    expect(await sessionsOf(PB)).toHaveLength(1);
  });
});

describe("runs that are not a second click", () => {
  it("a forEach step's children on the parent's object are one run each", async () => {
    const parent = await as(USER).run({
      playbookId: FOR_EACH,
      subjectId: SUBJECT,
      params: { areas: ["billing", "auth", "search"] },
    });
    expect(parent.status).toBe("running");
    await enter(parent.session!.id, "review");
    const kids = await childrenOf(parent.session!.id);
    expect(kids).toHaveLength(3);
    for (const kid of kids) {
      expect(kid.playbook_id).toBe(FOR_EACH);
      expect(kid.subject_entity_id).toBe(SUBJECT);
      expect(kid.one_live_per_subject).toBe(false);
    }
  });

  it("a uses step's child starts its own run while the person has a live run of that playbook on the object", async () => {
    const direct = await as(USER).run({
      playbookId: ONE_AREA,
      subjectId: SUBJECT,
    });
    expect(direct.status).toBe("running");
    const parent = await as(USER).run({ playbookId: USES, subjectId: SUBJECT });
    await enter(parent.session!.id, "review");
    const [child] = await childrenOf(parent.session!.id);
    expect(child).toBeDefined();
    expect(child!.id).not.toBe(direct.session!.id);
    expect(child!.playbook_id).toBe(ONE_AREA);
    expect(child!.subject_entity_id).toBe(SUBJECT);
    expect(await sessionsOf(ONE_AREA)).toHaveLength(2);
  });

  it("runs with no object are untouched: two clicks, two runs", async () => {
    const a = await as(USER).run({ playbookId: PB });
    const b = await as(USER).run({ playbookId: PB });
    expect([a.status, b.status]).toEqual(["running", "running"]);
    expect(a.session?.id).not.toBe(b.session?.id);
    const sessions = await sessionsOf(PB);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.one_live_per_subject === false)).toBe(true);
  });
});

describe("when the run ends", () => {
  it("a FAILED run does not block a click (no cooldown on a person's run)", async () => {
    const first = await as(USER).run({ playbookId: PB, subjectId: SUBJECT });
    await setStatus(first.session!.id, "failed");
    await q(
      `update playbook_runs set status = 'failed', completed_at = now() where id = $1`,
      [first.run!.id]
    );
    const again = await as(USER).run({ playbookId: PB, subjectId: SUBJECT });
    expect(again.status).toBe("running");
    expect(again.session?.id).not.toBe(first.session!.id);
  });

  it("ending the run (closed, cancelled) frees the object", async () => {
    for (const ended of ["closed", "cancelled"]) {
      const first = await as(USER).run({ playbookId: PB, subjectId: SUBJECT });
      expect(first.status).toBe("running");
      await setStatus(first.session!.id, ended);
      const next = await as(USER).run({ playbookId: PB, subjectId: SUBJECT });
      expect(next.status).toBe("running");
      expect(next.session?.id).not.toBe(first.session!.id);
      await setStatus(next.session!.id, "closed");
    }
  });

  it("reopening a cancelled run while another is live is refused by name", async () => {
    const first = await as(USER).run({ playbookId: PB, subjectId: SUBJECT });
    await setStatus(first.session!.id, "cancelled");
    const next = await as(USER).run({ playbookId: PB, subjectId: SUBJECT });
    await expect(
      reopenCancelledSession({ sessionId: first.session!.id, userId: USER })
    ).rejects.toThrow(
      new RegExp(
        `cannot be reopened: another run of the same playbook is live on this record \\(session ${next.session!.id}\\)`
      )
    );
    const [row] = (await sessionsOf(PB)).filter(
      (s) => s.id === first.session!.id
    );
    expect(row!.status).toBe("cancelled");
  });
});

describe("edges of the one live run (backend#1079 follow-up)", () => {
  it("'run it this way and remember' is kept when the run is already live", async () => {
    const first = await as(USER).run({ playbookId: PB, subjectId: SUBJECT });
    expect(first.status).toBe("running");
    const again = await as(USER).run({
      playbookId: PB,
      subjectId: SUBJECT,
      runOn: "synap_ai",
      remember: true,
    });
    expect(again.status).toBe("already_running");
    expect(again.session?.id).toBe(first.session!.id);
    // The person's choice for this playbook is stored (the assignment edge
    // `readStoredRunChoice` reads), although this click started nothing.
    const edges = await q<{ from_type: string }>(
      `select from_type from links where link_type = 'assigned_to' and to_type = 'playbook' and to_id = $1 and metadata ->> 'ownerId' = $2`,
      [PB, USER]
    );
    expect(edges.rows.map((r) => r.from_type)).toEqual(["agent"]);
    expect(await sessionsOf(PB)).toHaveLength(1);
  });

  it("a click that loses the index race does not advance a rotating cursor", async () => {
    await q(`update playbooks set input_strategy = $2::jsonb where id = $1`, [
      ROTATING,
      JSON.stringify({ kind: "rotating", items: ["a", "b", "c"], cursor: 0 }),
    ]);
    const cursor = async () =>
      (
        await q<{ c: number }>(
          `select (input_strategy ->> 'cursor')::int as c from playbooks where id = $1`,
          [ROTATING]
        )
      ).rows[0]!.c;
    const first = await as(USER).run({
      playbookId: ROTATING,
      subjectId: SUBJECT,
    });
    expect(first.status).toBe("running");
    // A run that started moves the cursor on.
    expect(await cursor()).toBe(1);
    // Both reads of the next click miss the live run: it reaches the insert,
    // the index refuses it, and the door answers with the live run.
    h.blindReads = 2;
    const lost = await as(USER).run({
      playbookId: ROTATING,
      subjectId: SUBJECT,
    });
    expect(h.blindReads).toBe(0);
    expect(lost.status).toBe("already_running");
    expect(lost.session?.id).toBe(first.session!.id);
    expect(await sessionsOf(ROTATING)).toHaveLength(1);
    // Nothing started, so no item was used up.
    expect(await cursor()).toBe(1);
  });

  it("an automation's reuse never returns another person's session", async () => {
    // Bea's own run of the pod's playbook on the shared record.
    const theirs = await as(OTHER).run({ playbookId: PB, subjectId: SUBJECT });
    expect(theirs.status).toBe("running");
    const automation = () =>
      runPlaybook({
        playbookId: PB,
        workspaceId: WS,
        userId: USER,
        subjectId: SUBJECT,
        idempotentBySubject: true,
      } as never);
    // Antoine's automation on the same record starts HIS run.
    const mine = await automation();
    expect(mine.reused).toBeUndefined();
    expect(mine.session?.id).not.toBe(theirs.session!.id);
    expect(mine.session?.userId).toBe(USER);
    // Reuse still works for the owner: the next fire answers with his run.
    const again = await automation();
    expect(again.reused).toBe(true);
    expect(again.session?.id).toBe(mine.session!.id);
    expect(await sessionsOf(PB)).toHaveLength(2);
  });
});
