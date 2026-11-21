/**
 * A lane rolls up into its parent (W7, `lane-rollup.ts`) — on PGlite: the
 * REAL close door (`completeFocusSession`) emits the close event, the REAL
 * reactor (its `match` and its handler) takes it, the REAL lineage read
 * (`getSessionSpawnTarget`, routed onto the same PGlite) finds the parent and
 * the output the child was spawned for, and the one `done` door writes it.
 *
 * Each test names the rule it rules out:
 *   - the target output not met by ref when the lane closes done;
 *   - ANY output met without a recorded target, even with matching keys
 *     (lanes inherit their parent's keys; a forged child names any parent);
 *   - a lane closed `not_done` (cancelled, or an explicit not-done event);
 *   - the parent closing because its slots are all met;
 *   - a parent that ended (cancelled, failed, closed past 24 h) rewritten;
 *   - a person's slot, or one a required criterion checks, met by a lane;
 *   - a person's answer in the lane meeting the parent's output;
 *   - a lane in another space copying its pointer up;
 *   - a retried event writing again;
 *   - a step's child run, a rerun, a child of two parents, or another
 *     person's parent being reached.
 * The spawn check itself (who may name a target) is pure, below; the door
 * that records it is driven in `create-session-lineage.pglite.test.ts`, and
 * the W6 step it can move in `advance-if-stage-met.pglite.test.ts`.
 *
 * Stubbed, and why: governance (`checkPermissionOrPropose`: granted), the
 * transport seams of the close door (`emitSideEffects` is CAPTURED, so the
 * test hands the emitted payload to the reactor; sockets, Expo, the event
 * history row).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

type Emitted = {
  subjectType?: string;
  action?: string;
  subjectId?: string;
  data?: Record<string, unknown>;
};

const h = vi.hoisted(() => {
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    emitted: [] as Emitted[],
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
    // The lineage read (`getParentSessionId`) lives inside @synap/database
    // and imports `db` from its client module, not from the package entry:
    // route that onto the same PGlite, so the REAL `spawned_from` read runs.
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const pg = await h.init();
  return {
    ...actual,
    db: pg,
    getDb: async () => pg,
    eventRepository: { append: async () => undefined },
    emitMessageEvent: async () => undefined,
  };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async (p: Emitted) => {
    h.emitted.push(p);
  },
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  settleParentAutomationRunFromChild: async () => undefined,
}));
vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: async () => ({ granted: true }),
}));
vi.mock("../../notifications/expo-push.js", () => ({
  sendExpoPush: async () => ({ sent: 1, revoked: 0, failed: 0 }),
}));
vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: () => undefined,
}));
vi.mock("../../lib/event-helpers.js", () => ({
  logEvent: async () => "evt",
}));

import { pgliteAllTablesDdl } from "../../__tests__/pglite-ddl.js";
import { completeFocusSession } from "./complete-session.js";
import { checkSpawnTarget, laneRollupReactor } from "./lane-rollup.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const WS_A = randomUUID();
const WS_B = randomUUID();
const ENTITY = randomUUID();

/** The reactor reads no deps (it queues nothing). */
const NO_DEPS = {} as never;

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  await h.init();
  await h.client!.exec(pgliteAllTablesDdl());
  await q(
    `insert into users (id, email, name, timezone, user_type) values
      ($1, 'a@example.test', 'Owner', 'UTC', 'human'),
      ($2, 'o@example.test', 'Other', 'UTC', 'human')`,
    [OWNER, OTHER]
  );
}, 120_000);

type Slot = Record<string, unknown>;

async function seed(p: {
  user?: string;
  workspaceId?: string | null;
  outputs: Slot[];
  metadata?: Record<string, unknown>;
  status?: string;
  closedHoursAgo?: number;
  criteria?: unknown[];
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, workspace_id, expected_outputs, agent_ids, metadata, criteria, created_at, updated_at, started_at, closed_at)
     values ($1, $2, 'Ship', 'Ship', $6, $3, $4::jsonb, '{}', $5::jsonb, $8::jsonb, now(), now(), now(),
             case when $7::int is null then null else now() - make_interval(hours => $7::int) end)`,
    [
      id,
      p.user ?? OWNER,
      p.workspaceId === undefined ? WS_A : p.workspaceId,
      JSON.stringify(p.outputs),
      JSON.stringify(p.metadata ?? {}),
      p.status ?? "active",
      p.closedHoursAgo ?? null,
      JSON.stringify(p.criteria ?? []),
    ]
  );
  return id;
}

/** `child --spawned_from--> parent`, spawned for `forOutput` when given. */
async function spawn(child: string, parent: string, forOutput?: string) {
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
     values ($1, 'session', $2, 'session', $3, 'spawned_from', $4::jsonb, now())`,
    [
      randomUUID(),
      child,
      parent,
      JSON.stringify(forOutput ? { forOutput } : {}),
    ]
  );
}

const rowOf = async (id: string) =>
  (
    await q<{
      status: string;
      closed_at: string | null;
      updated_at: string;
      expected_outputs: Slot[];
    }>(
      `select status, closed_at, updated_at, expected_outputs from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!;

const slotOf = async (id: string, key: string) =>
  (await rowOf(id)).expected_outputs.find((s) => s.key === key)!;

/** Close the child through the real door; hand its close event to the reactor. */
async function closeAndReact(
  child: string,
  terminalStatus: "closed" | "cancelled" = "closed"
): Promise<Emitted> {
  const result = await completeFocusSession({
    sessionId: child,
    userId: OWNER,
    terminalStatus,
  });
  expect(result?.session.status).toBe(terminalStatus);
  const event = h.emitted.find(
    (e) => e.subjectId === child && e.action === "closed"
  );
  expect(event, "the close door emitted no close event").toBeTruthy();
  // The reactor takes the event the close door really emits.
  expect(laneRollupReactor.match(event as never)).toBe(true);
  await laneRollupReactor.handler(event as never, NO_DEPS);
  return event!;
}

const DONE = {
  status: "done",
  satisfiedByEvidence: {
    kind: "output",
    id: "doc:x",
    at: "2026-11-19T00:00:00.000Z",
  },
};
const PR = { key: "pr", kind: "pull_request", label: "PR" };
const PR_DONE = { ...PR, ...DONE };

type SeedInput = Parameters<typeof seed>[0];

/** A parent owing `parentPr`, a lane spawned for it that delivered its own. */
async function laneFor(
  opts: {
    parent?: Partial<SeedInput>;
    parentPr?: Slot;
    child?: Partial<SeedInput>;
    childPr?: Slot;
    forOutput?: string | null;
  } = {}
) {
  const parent = await seed({ outputs: [opts.parentPr ?? PR], ...opts.parent });
  const child = await seed({ outputs: [opts.childPr ?? PR_DONE], ...opts.child });
  await spawn(
    child,
    parent,
    opts.forOutput === null ? undefined : (opts.forOutput ?? "pr")
  );
  return { parent, child };
}

describe("a lane's target output rolls up into its parent", () => {
  it("a done lane meets the output it was spawned for, by ref, and nothing else", async () => {
    const parent = await seed({
      outputs: [
        { key: "api-change", kind: "code", label: "API change" },
        { key: "docs", kind: "document", label: "Docs" },
      ],
    });
    const child = await seed({
      outputs: [
        {
          key: "api-change",
          kind: "code",
          label: "The API change",
          ref: { kind: "entity", id: ENTITY },
          ...DONE,
        },
        // Delivered, same key as the parent's, but not the target.
        { key: "docs", kind: "document", label: "Docs", ...DONE },
      ],
    });
    await spawn(child, parent, "api-change");

    const event = await closeAndReact(child);
    expect(event.data).toMatchObject({ closedAs: "done" });

    expect(await slotOf(parent, "api-change")).toMatchObject({
      status: "done",
      satisfiedByEvidence: { kind: "ref", id: `entity:${ENTITY}` },
      // The pointer is copied up when the parent's slot has none.
      ref: { kind: "entity", id: ENTITY },
      // The parent's own words stay its own.
      label: "API change",
    });
    expect((await slotOf(parent, "docs")).status).toBeUndefined();
  });

  it("matching keys with no recorded target roll up nothing (an inherited key, a forged child)", async () => {
    const { parent, child } = await laneFor({ forOutput: null });
    await closeAndReact(child);
    expect((await slotOf(parent, "pr")).status).toBeUndefined();
  });

  it("the parent never closes, even when the lane meets every slot it has", async () => {
    const { parent, child } = await laneFor();
    await closeAndReact(child);
    expect((await slotOf(parent, "pr")).status).toBe("done");
    const row = await rowOf(parent);
    expect(row.status).toBe("active");
    expect(row.closed_at).toBeNull();
  });

  it("a lane closed not_done rolls up nothing", async () => {
    const { parent, child } = await laneFor();
    const event = await closeAndReact(child, "cancelled");
    expect(event.data).toMatchObject({ closedAs: "not_done" });
    expect((await slotOf(parent, "pr")).status).toBeUndefined();
  });

  it("a close event that says not_done rolls up nothing, whatever the row says", async () => {
    const { parent, child } = await laneFor();
    await q(
      `update focus_sessions set status = 'closed', closed_at = now() where id = $1`,
      [child]
    );
    await laneRollupReactor.handler(
      {
        subjectType: "focus_session",
        action: "closed",
        subjectId: child,
        data: { sessionId: child, status: "closed", closedAs: "not_done" },
      } as never,
      NO_DEPS
    );
    expect((await slotOf(parent, "pr")).status).toBeUndefined();
  });

  it("a parent that ended (cancelled, failed, closed more than 24 h ago) is not rewritten", async () => {
    for (const ended of [
      { status: "cancelled" },
      { status: "failed" },
      { status: "closed", closedHoursAgo: 30 },
    ]) {
      const lane = await laneFor({ parent: ended });
      await closeAndReact(lane.child);
      expect(
        (await slotOf(lane.parent, "pr")).status,
        ended.status
      ).toBeUndefined();
    }
  });

  it("a parent slot that is the person's, or that a required criterion checks, stays open", async () => {
    const human = await laneFor({
      parentPr: { ...PR, owner: "human", owedSince: "2026-11-19T00:00:00Z" },
    });
    await closeAndReact(human.child);
    expect((await slotOf(human.parent, "pr")).status).toBeUndefined();

    const checked = await laneFor({
      parent: {
        criteria: [
          {
            key: "pr-merged",
            statement: "The PR is merged",
            check: { kind: "judge" },
            outputKey: "pr",
            required: true,
          },
        ],
      },
    });
    await closeAndReact(checked.child);
    expect((await slotOf(checked.parent, "pr")).status).toBeUndefined();
  });

  it("a person's answer in the lane never meets the parent's output", async () => {
    const { parent, child } = await laneFor({
      childPr: { ...PR_DONE, owner: "human" },
    });
    await closeAndReact(child);
    expect((await slotOf(parent, "pr")).status).toBeUndefined();
  });

  it("a lane in another space copies only the ref to itself, never its pointer", async () => {
    const { parent, child } = await laneFor({
      parent: { workspaceId: WS_A },
      child: { workspaceId: WS_B },
      childPr: {
        ...PR_DONE,
        label: "The PR (space B)",
        ref: { url: "https://example.test/private/pr" },
        answer: { value: "space B words" },
      },
    });
    await closeAndReact(child);

    const slot = await slotOf(parent, "pr");
    expect(slot).toMatchObject({
      status: "done",
      satisfiedByEvidence: { kind: "ref", id: `focus_session:${child}` },
      label: "PR",
    });
    expect(slot.ref).toBeUndefined();
    expect(JSON.stringify(await rowOf(parent))).not.toMatch(
      /example\.test|space B/
    );
  });

  it("a retried close event changes nothing", async () => {
    const { parent, child } = await laneFor();
    const event = await closeAndReact(child);
    const before = await rowOf(parent);
    const transitions = async () =>
      (
        await q<{ n: number }>(
          `select count(*)::int as n from lifecycle_transition_outbox where transition::text like $1`,
          [`%${parent}%`]
        )
      ).rows[0]!.n;
    const owed = await transitions();
    expect(before.expected_outputs[0]!.status).toBe("done");

    await laneRollupReactor.handler(event as never, NO_DEPS);
    const after = await rowOf(parent);
    expect(after.expected_outputs).toEqual(before.expected_outputs);
    expect(after.updated_at).toEqual(before.updated_at);
    expect(await transitions()).toBe(owed);
  });

  it("a step's child run, a rerun, and a child of two parents are left alone", async () => {
    const step = await laneFor({
      child: {
        metadata: {
          stageOf: {
            sessionId: randomUUID(),
            stageKey: "build",
            stageRunId: randomUUID(),
          },
        },
      },
    });
    await closeAndReact(step.child);
    expect((await slotOf(step.parent, "pr")).status).toBeUndefined();

    const rerun = await laneFor({
      child: {
        metadata: {
          run: {
            rerun: {
              parentSessionId: randomUUID(),
              mode: "replace",
              requestedAt: "2026-11-19T00:00:00Z",
            },
          },
        },
      },
    });
    await closeAndReact(rerun.child);
    expect((await slotOf(rerun.parent, "pr")).status).toBeUndefined();

    const twice = await laneFor();
    const second = await seed({ outputs: [PR] });
    await spawn(twice.child, second, "pr");
    await closeAndReact(twice.child);
    expect((await slotOf(twice.parent, "pr")).status).toBeUndefined();
    expect((await slotOf(second, "pr")).status).toBeUndefined();
  });

  it("another person's parent is never reached", async () => {
    const { parent, child } = await laneFor({ parent: { user: OTHER } });
    await closeAndReact(child);
    expect((await slotOf(parent, "pr")).status).toBeUndefined();
  });
});

describe("checkSpawnTarget (pure): who may name the output a child is spawned for", () => {
  const parent = {
    agentIds: ["agent-1"],
    expectedOutputs: [
      PR,
      { key: "grade", kind: "criterion", label: "Grade", criterionKey: "c" },
      { key: "mine", kind: "document", label: "Mine", owner: "human" },
    ],
  };

  it("the parent's owner, or an agent on its roster, names one of its deliveries", () => {
    expect(
      checkSpawnTarget({ parent, agentUserId: null, forOutput: "pr" })
    ).toEqual({ status: "recorded", key: "pr" });
    expect(
      checkSpawnTarget({ parent, agentUserId: "agent-1", forOutput: " pr " })
    ).toEqual({ status: "recorded", key: "pr" });
  });

  it("an agent the parent does not hold, or an output that is not a delivery, is refused", () => {
    expect(
      checkSpawnTarget({ parent, agentUserId: "agent-2", forOutput: "pr" })
    ).toEqual({ status: "refused", key: "pr", reason: "not_a_parent_writer" });
    for (const key of ["nope", "grade", "mine"]) {
      expect(
        checkSpawnTarget({ parent, agentUserId: null, forOutput: key })
      ).toEqual({ status: "refused", key, reason: "no_such_output" });
    }
  });
});
