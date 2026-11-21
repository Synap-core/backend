/**
 * A lane rolls up into its parent (W7, `lane-rollup.ts`) — on PGlite: the
 * REAL close door (`completeFocusSession`) emits the close event, the REAL
 * reactor handles it, the REAL lineage read (`getParentSessionId`, routed
 * onto the same PGlite) finds the parent, and the one `done` door writes it.
 *
 * Each test names the rule it rules out:
 *   - a done lane's delivered output not meeting the parent's slot of the
 *     same key, or meeting it without `ref` evidence;
 *   - a lane closed `not_done` (cancelled, or with an explicit not-done
 *     event) rolling anything up;
 *   - the parent closing (or moving) because its slots are all met;
 *   - a lane in another space copying its pointer up (refs only: the child
 *     session is cited, nothing the parent's readers could not see);
 *   - a retried event writing again;
 *   - a step's child run (its step's reactor maps it) or another person's
 *     parent being reached.
 *
 * Stubbed, and why: governance (`checkPermissionOrPropose`: granted), the
 * transport seams of the close door (`emitSideEffects` is CAPTURED, so the
 * test hands the emitted payload to the reactor itself; sockets, Expo, the
 * event history row).
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
import { laneRollupReactor, laneSlotsWanted } from "./lane-rollup.js";

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
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, workspace_id, expected_outputs, agent_ids, metadata, criteria, created_at, updated_at, started_at)
     values ($1, $2, 'Ship', 'Ship', 'active', $3, $4::jsonb, '{}', $5::jsonb, '[]'::jsonb, now(), now(), now())`,
    [
      id,
      p.user ?? OWNER,
      p.workspaceId === undefined ? WS_A : p.workspaceId,
      JSON.stringify(p.outputs),
      JSON.stringify(p.metadata ?? {}),
    ]
  );
  return id;
}

async function spawn(child: string, parent: string) {
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
     values ($1, 'session', $2, 'session', $3, 'spawned_from', '{}'::jsonb, now())`,
    [randomUUID(), child, parent]
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

describe("a lane's outputs roll up into its parent", () => {
  it("a done lane's delivered output meets the parent's slot of the same key, by ref", async () => {
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
        // Not delivered: the parent's slot stays open.
        { key: "docs", kind: "document", label: "Docs" },
        // Delivered, but the parent declares no such slot.
        { key: "notes", kind: "document", label: "Notes", ...DONE },
      ],
    });
    await spawn(child, parent);

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
    expect((await rowOf(parent)).expected_outputs.map((s) => s.key)).toEqual([
      "api-change",
      "docs",
    ]);
  });

  it("the parent never closes, even when the lane meets every slot it has", async () => {
    const parent = await seed({
      outputs: [{ key: "pr", kind: "pull_request", label: "PR" }],
    });
    const child = await seed({
      outputs: [{ key: "pr", kind: "pull_request", label: "PR", ...DONE }],
    });
    await spawn(child, parent);
    await closeAndReact(child);

    expect((await slotOf(parent, "pr")).status).toBe("done");
    const row = await rowOf(parent);
    expect(row.status).toBe("active");
    expect(row.closed_at).toBeNull();
  });

  it("a lane closed not_done rolls up nothing", async () => {
    const parent = await seed({
      outputs: [{ key: "pr", kind: "pull_request", label: "PR" }],
    });
    const child = await seed({
      outputs: [{ key: "pr", kind: "pull_request", label: "PR", ...DONE }],
    });
    await spawn(child, parent);
    const event = await closeAndReact(child, "cancelled");
    expect(event.data).toMatchObject({ closedAs: "not_done" });
    expect((await slotOf(parent, "pr")).status).toBeUndefined();
  });

  it("a close event that says not_done rolls up nothing, whatever the row says", async () => {
    const parent = await seed({
      outputs: [{ key: "pr", kind: "pull_request", label: "PR" }],
    });
    const child = await seed({
      outputs: [{ key: "pr", kind: "pull_request", label: "PR", ...DONE }],
    });
    await spawn(child, parent);
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

  it("a lane in another space copies only the ref to itself, never its pointer", async () => {
    const parent = await seed({
      workspaceId: WS_A,
      outputs: [{ key: "brief", kind: "document", label: "Brief" }],
    });
    const child = await seed({
      workspaceId: WS_B,
      outputs: [
        {
          key: "brief",
          kind: "document",
          label: "The brief (space B)",
          ref: { url: "https://example.test/private/brief" },
          answer: { value: "space B words" },
          ...DONE,
        },
      ],
    });
    await spawn(child, parent);
    await closeAndReact(child);

    const slot = await slotOf(parent, "brief");
    expect(slot).toMatchObject({
      status: "done",
      satisfiedByEvidence: { kind: "ref", id: `focus_session:${child}` },
      label: "Brief",
    });
    expect(slot.ref).toBeUndefined();
    expect(JSON.stringify(await rowOf(parent))).not.toMatch(
      /example\.test|space B/
    );
  });

  it("a retried close event changes nothing", async () => {
    const parent = await seed({
      outputs: [{ key: "pr", kind: "pull_request", label: "PR" }],
    });
    const child = await seed({
      outputs: [{ key: "pr", kind: "pull_request", label: "PR", ...DONE }],
    });
    await spawn(child, parent);
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

  it("a step's child run is left to its step, and another person's parent is never reached", async () => {
    const parent = await seed({
      outputs: [{ key: "pr", kind: "pull_request", label: "PR" }],
    });
    const stepChild = await seed({
      outputs: [{ key: "pr", kind: "pull_request", label: "PR", ...DONE }],
      metadata: {
        stageOf: {
          sessionId: parent,
          stageKey: "build",
          stageRunId: randomUUID(),
        },
      },
    });
    await spawn(stepChild, parent);
    await closeAndReact(stepChild);
    expect((await slotOf(parent, "pr")).status).toBeUndefined();

    const theirs = await seed({
      user: OTHER,
      outputs: [{ key: "pr", kind: "pull_request", label: "PR" }],
    });
    const mine = await seed({
      outputs: [{ key: "pr", kind: "pull_request", label: "PR", ...DONE }],
    });
    await spawn(mine, theirs);
    await closeAndReact(mine);
    expect((await slotOf(theirs, "pr")).status).toBeUndefined();
  });
});

describe("laneSlotsWanted (pure)", () => {
  it("pairs a delivered output with the parent's slot of the same key; inputs never", () => {
    const wanted = laneSlotsWanted(
      [
        { key: "pr", kind: "pull_request", label: "PR" },
        { key: "grade", kind: "criterion", label: "Grade", criterionKey: "c" },
        { key: "param", kind: "playbook_param", label: "Answer: x" },
      ],
      [
        { key: "pr", kind: "pull_request", label: "The PR", status: "done" },
        { key: "grade", kind: "criterion", label: "Grade", status: "done" },
        {
          key: "param",
          kind: "playbook_param",
          label: "Answer: x",
          status: "done",
        },
        { key: "pr-2", kind: "pull_request", label: "Other", status: "done" },
      ]
    );
    expect(wanted).toEqual([
      {
        parentKey: "pr",
        parentLabel: "PR",
        childKey: "pr",
        childLabel: "The PR",
      },
    ]);
  });

  it("a retired or undelivered child slot is not a delivery", () => {
    expect(
      laneSlotsWanted(
        [{ key: "pr", kind: "pull_request", label: "PR" }],
        [
          {
            key: "pr",
            kind: "pull_request",
            label: "PR",
            status: "done",
            retiredAt: "2026-11-19T00:00:00Z",
          },
        ]
      )
    ).toEqual([]);
    expect(
      laneSlotsWanted(
        [{ key: "pr", kind: "pull_request", label: "PR" }],
        [{ key: "pr", kind: "pull_request", label: "PR", status: "pending" }]
      )
    ).toEqual([]);
  });
});
