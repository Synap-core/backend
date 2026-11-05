/**
 * A SESSION DECLARES THE THINGS IT WORKS ON (`targets`, plan b38e5e64 S2) —
 * on every start and update door, as the SAME `session --targets--> entity`
 * edge a per-batch worker writes, and the machinery that already settles a
 * worker's targets settles them: process-sync stamps each one's result when
 * it moves, the close door stamps the open ones and applies `onEnd`.
 *
 * Real, on one PGlite with every table: `createFocusSession`,
 * `updateFocusSession`, the MCP `synap_start_session` / `synap_update_session`
 * handlers, tRPC `focusSessions.create` / `.update`, Hub POST / PATCH
 * `/focus-sessions`, `writeSessionTargets` / `checkSessionTargets`
 * (`isOutputRefVisible` → `scopedDb`), the REAL status door (`moveStatus`)
 * whose outbox transition is fed to the REAL process-sync
 * (`syncProcessOnEvent`, @synap/jobs), and the REAL close door.
 *
 * Each row rules something out:
 *  - start and update write a worker-target edge with no result (a door that
 *    accepted `targets` and dropped it, or wrote another role, fails);
 *  - an entity the caller cannot see is refused and NOTHING is written (no
 *    session on a start, no edge on an update);
 *  - a second update is idempotent (`already`), an input edge is promoted;
 *  - an ended session takes no targets;
 *  - an agent's PROPOSED update carries the targets on the proposal and
 *    writes nothing yet;
 *  - a hand-made session (no `metadata.worker`) has its targets settled by
 *    process-sync: its own move `done`, someone else's `skipped`;
 *  - at close, an open target gets the playbook's `onEnd` move and a settled
 *    one does not.
 *
 * Stubbed, and why: the `focus_session` gate (decided per test; every other
 * subject reaches the real gate), post-commit delivery (events, realtime,
 * notifications), the room mint, `getAgentFocusProjectId` (PGlite is one
 * connection, a transaction runs on the same handle).
 *
 * NOT COVERED: the approval executor writing proposed targets (it calls the
 * same `checkSessionTargets` + `writeSessionTargets` this file drives), and
 * the worker batch writer (`run-playbook.worker.pglite.test.ts`, unchanged).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    /** The `focus_session` gate's answer, per test. */
    focusPerm: (async () => ({ granted: true })) as (
      o: Record<string, unknown>
    ) => Promise<unknown>,
    focusCalls: [] as Array<Record<string, unknown>>,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        const db = drizzle(client, { schema });
        (db as unknown as { transaction: unknown }).transaction = async (
          fn: (tx: unknown) => Promise<unknown>
        ) => fn(db);
        state.db = db;
      }
      return state.db;
    },
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

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  await h.init();
  const sql = Object.assign(
    () => {
      throw new Error("tagged sql is not available in this suite");
    },
    {
      unsafe: async (text: string, params: unknown[] = []) =>
        (await h.client!.query(text, params)).rows,
    }
  );
  const EventRepository = actual.EventRepository as new (s: unknown) => {
    append: (e: unknown) => Promise<unknown>;
  };
  return {
    ...actual,
    db: await h.init(),
    getDb: async () => h.init(),
    eventRepository: new EventRepository(sql),
    sql,
    registerIdentitySignals: async () => undefined,
  };
});
vi.mock("../../agent-identity-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAgentFocusProjectId: async () => null,
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  broadcastNotification: vi.fn(async () => undefined),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  dispatchLifecycleTransition: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
// The `focus_session` gate is decided per test; every other subject (the end
// moves' and the status door's) reaches the REAL gate.
vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<{
    checkPermissionOrPropose: (o: { subjectType?: string }) => unknown;
  }>();
  return {
    ...actual,
    checkPermissionOrPropose: async (o: Record<string, unknown>) => {
      if (o.subjectType !== "focus_session") {
        return actual.checkPermissionOrPropose(o);
      }
      h.focusCalls.push(o);
      return h.focusPerm(o);
    },
  };
});
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => undefined,
}));
vi.mock("../../proposals/expire-lapsed-proposals.js", () => ({
  expireSessionEphemerals: async () => 0,
}));
vi.mock("../../../utils/ai-feedback-events.js", () => ({
  emitAiDecision: vi.fn(async () => undefined),
}));
vi.mock("../ensure-session-channel.js", () => ({
  ensureSessionChannel: vi.fn(async () => null),
}));
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: vi.fn(),
}));
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { pgliteAllTablesDdl } from "../../../__tests__/pglite-ddl.js";
import { createFocusSession } from "../create-session.js";
import { updateFocusSession } from "../update-session.js";
import { completeFocusSession } from "../complete-session.js";
import { moveStatus } from "../../lifecycle/move-status.js";
import { focusSessionsRouter } from "../../../routers/focus-sessions.js";
import { registerFocusSessionsRoutes } from "../../../routers/hub-protocol/rest/focus-sessions.js";
import type {
  HubHono,
  HubVariables,
} from "../../../routers/hub-protocol/rest/_shared.js";
import { syncProcessOnEvent } from "@synap/jobs/utils/process-sync.js";

const { sessionHandlers } =
  await import("../../../routers/mcp/handlers/session.js");

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = randomUUID();
const AGENT = randomUUID();
const STRANGER = randomUUID();
const MY_SPACE = randomUUID();
const THEIR_SPACE = randomUUID();
const THEIR_ENTITY = randomUUID();
const FINDING = randomUUID();
const STATUS_DEF = randomUUID();

async function seedFinding(status = "fixing"): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, type, profile_id, title, workspace_id, status, status_category, properties, created_at, updated_at)
     values ($1, $2, 'finding', $3, 'A finding', null, $4, 'open', $5::jsonb, now(), now())`,
    [id, USER, FINDING, status, JSON.stringify({ status })]
  );
  return id;
}

/** A bare session of USER (no playbook), straight in the table. */
async function seedBareSession(
  status = "active",
  workspaceId: string | null = null
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, workspace_id, title, goal, status, origin, expected_outputs, criteria, metadata, agent_ids, started_at, created_at, updated_at)
     values ($1, $2, $3, 'Work', $4, $5, 'human', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}', now(), now(), now())`,
    [id, USER, workspaceId, `Work ${id}`, status]
  );
  return id;
}

/** Every `targets` edge of a session, with its metadata. */
const edgesOf = async (sessionId: string) =>
  (
    await q<{ to_id: string; metadata: Record<string, unknown> }>(
      `select to_id, metadata from links where from_type = 'session' and from_id = $1 and link_type = 'targets' order by to_id`,
      [sessionId]
    )
  ).rows;

/** The ids a session works on as worker targets, sorted. */
const targetIdsOf = async (sessionId: string) =>
  (await edgesOf(sessionId))
    .filter((e) => e.metadata?.role === "worker_target")
    .map((e) => e.to_id)
    .sort();

const sorted = (ids: string[]) => [...ids].sort();

const statusOf = async (id: string) =>
  (
    await q<{ status: string }>(`select status from entities where id = $1`, [
      id,
    ])
  ).rows[0]?.status;

const sessionsWithGoal = async (goal: string) =>
  (
    await q<{ id: string }>(`select id from focus_sessions where goal = $1`, [
      goal,
    ])
  ).rows;

const mcpText = (res: unknown) =>
  JSON.parse(
    ((res as { content: Array<{ text: string }> }).content[0] ?? { text: "{}" })
      .text
  ) as Record<string, unknown>;

const mcp = {
  start: (args: Record<string, unknown>) =>
    sessionHandlers.synap_start_session!({
      toolName: "synap_start_session",
      args: {
        templateId: null,
        forceCreate: true,
        criteria: [
          { key: "done", statement: "The test ran", check: { kind: "human" } },
        ],
        ...args,
      },
      userId: USER,
      agentUserId: AGENT,
      apiKeyScopes: ["mcp.read", "mcp.write"],
    } as never).then(mcpText),
  update: (args: Record<string, unknown>) =>
    sessionHandlers.synap_update_session!({
      toolName: "synap_update_session",
      args,
      userId: USER,
      agentUserId: AGENT,
      apiKeyScopes: ["mcp.read", "mcp.write"],
    } as never).then(mcpText),
};

const trpc = () =>
  focusSessionsRouter.createCaller({
    userId: USER,
    authenticated: true,
  } as never);

function hub(): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", USER);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    await next();
  });
  registerFocusSessionsRoutes(a);
  return a;
}

const hubRequest = (
  method: "POST" | "PATCH",
  path: string,
  body: Record<string, unknown>
) =>
  hub().request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Move a finding through the REAL status door, then feed its transition to process-sync. */
async function moveAndSync(input: {
  entityId: string;
  to: string;
  sessionId?: string;
}) {
  const moved = await moveStatus({
    entityId: input.entityId,
    to: input.to,
    actor: { kind: "human", userId: USER },
    sessionId: input.sessionId ?? null,
  });
  expect(moved.status).toBe("moved");
  const [row] = (
    await q<{ transition: Record<string, unknown> }>(
      `select transition from lifecycle_transition_outbox
        where transition->>'subjectId' = $1 and transition->>'to' = $2
        order by created_at desc limit 1`,
      [input.entityId, input.to]
    )
  ).rows;
  expect(row).toBeDefined();
  const t = row!.transition;
  // The event the trigger hop hands process-sync (`emitLifecycleTransition`).
  return syncProcessOnEvent({
    eventType: "entity.transition.completed",
    subjectId: input.entityId,
    userId: USER,
    data: { ...t, lifecycleProfile: t.role ?? t.profileSlug },
  });
}

beforeAll(async () => {
  await h.init();
  await h.client!.exec(pgliteAllTablesDdl());
  await q(
    `insert into users (id, name, email, user_type) values
       ($1, 'Founder', 'f@x', 'human'), ($2, 'Stranger', 's@x', 'human')`,
    [USER, STRANGER]
  );
  await q(
    `insert into users (id, name, email, user_type, agent_type, agent_metadata, created_by_user_id)
     values ($1, 'Agent', 'a@x', 'agent', 'claude-code', '{}'::jsonb, $2)`,
    [AGENT, USER]
  );
  for (const [space, owner, name] of [
    [MY_SPACE, USER, "Mine"],
    [THEIR_SPACE, STRANGER, "Theirs"],
  ] as const) {
    await q(`insert into workspaces (id, name, owner_id) values ($1, $2, $3)`, [
      space,
      name,
      owner,
    ]);
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [randomUUID(), space, owner]
    );
  }
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints, created_at, updated_at)
     values ($1, 'finding', 'Finding', 'kind', 'system', 'pod', null, true, '{}'::jsonb, now(), now())`,
    [FINDING]
  );
  await q(
    `insert into property_defs (id, slug, value_type, constraints, created_at, updated_at)
     values ($1, 'status', 'enum', $2::jsonb, now(), now())`,
    [
      STATUS_DEF,
      JSON.stringify({
        enumOptions: [
          { key: "open", label: "Open", category: "open" },
          { key: "fixing", label: "Fixing", category: "active" },
          { key: "triaged", label: "Triaged", category: "active" },
          { key: "fixed", label: "Fixed", category: "done" },
        ],
      }),
    ]
  );
  await q(
    `insert into profile_properties (profile_id, property_def_id, is_lifecycle) values ($1, $2, true)`,
    [FINDING, STATUS_DEF]
  );
  // An entity only the stranger can see.
  await q(
    `insert into entities (id, user_id, type, profile_id, title, workspace_id, properties, created_at, updated_at)
     values ($1, $2, 'finding', $3, 'Their secret', $4, '{}'::jsonb, now(), now())`,
    [THEIR_ENTITY, STRANGER, FINDING, THEIR_SPACE]
  );
}, 120_000);

beforeEach(() => {
  h.focusPerm = async () => ({ granted: true });
  h.focusCalls.length = 0;
});

describe("start: the service door", () => {
  it("writes one worker-target edge per thing, no result, deduplicated", async () => {
    const [a, b] = [await seedFinding(), await seedFinding()];
    const res = await createFocusSession({
      userId: USER,
      goal: `Batch ${randomUUID()}`,
      targets: [a, b, a],
      matchTemplate: false,
      forceCreate: true,
    });
    expect(res.status).toBe("created");
    if (res.status !== "created") return;
    expect(res.targets).toEqual({ added: [a, b], already: [] });
    const edges = await edgesOf(res.session.id);
    expect(sorted(edges.map((e) => e.to_id))).toEqual(sorted([a, b]));
    for (const e of edges) {
      expect(e.metadata).toEqual({ role: "worker_target" });
    }
  });

  it("refuses an entity the caller cannot see: NOT_FOUND, no session, no edge", async () => {
    const mine = await seedFinding();
    const goal = `Peek ${randomUUID()}`;
    await expect(
      createFocusSession({
        userId: USER,
        goal,
        targets: [mine, THEIR_ENTITY],
        matchTemplate: false,
        forceCreate: true,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await sessionsWithGoal(goal)).toEqual([]);
    const stray = await q(`select 1 from links where to_id = $1`, [mine]);
    expect(stray.rows).toEqual([]);
  });
});

describe("update: the service door", () => {
  it("adds targets, idempotently", async () => {
    const sessionId = await seedBareSession();
    const [a, b] = [await seedFinding(), await seedFinding()];
    const first = await updateFocusSession({
      sessionId,
      userId: USER,
      targets: [a],
    });
    expect(first).toMatchObject({
      status: "updated",
      targets: { added: [a], already: [] },
    });
    const second = await updateFocusSession({
      sessionId,
      userId: USER,
      targets: [a, b],
    });
    expect(second).toMatchObject({
      status: "updated",
      targets: { added: [b], already: [a] },
    });
    expect(await targetIdsOf(sessionId)).toEqual(sorted([a, b]));
  });

  it("refuses an entity the caller cannot see, and writes nothing", async () => {
    const sessionId = await seedBareSession();
    const mine = await seedFinding();
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      targets: [mine, THEIR_ENTITY],
    });
    expect(res.status).toBe("denied");
    expect((res as { reason: string }).reason).toContain(THEIR_ENTITY);
    expect(await edgesOf(sessionId)).toEqual([]);
  });

  it("refuses targets on a session that has ended", async () => {
    const sessionId = await seedBareSession("closed");
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      targets: [await seedFinding()],
    });
    expect(res.status).toBe("denied");
    expect(await edgesOf(sessionId)).toEqual([]);
  });

  it("promotes an input edge to the same thing into a target", async () => {
    const sessionId = await seedBareSession();
    const thing = await seedFinding();
    await q(
      `insert into links (from_type, from_id, to_type, to_id, link_type, metadata)
       values ('session', $1, 'entity', $2, 'targets', '{"role":"input","via":"capture"}'::jsonb)`,
      [sessionId, thing]
    );
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      targets: [thing],
    });
    expect(res).toMatchObject({ targets: { added: [thing], already: [] } });
    const [edge] = await edgesOf(sessionId);
    expect(edge?.metadata).toEqual({ role: "worker_target", via: "capture" });
  });

  it("an agent's PROPOSED update carries the targets on the proposal and writes nothing yet", async () => {
    h.focusPerm = async () => ({
      proposalId: randomUUID(),
      proposalType: "focus_session.update",
      reviewPath: "/review",
      reviewUrl: "https://pod/review",
    });
    const sessionId = await seedBareSession();
    const thing = await seedFinding();
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      targets: [thing],
    });
    expect(res.status).toBe("proposed");
    const update = h.focusCalls.find((c) => c.action === "update");
    expect((update?.data as Record<string, unknown>)?.targets).toEqual([thing]);
    expect(await edgesOf(sessionId)).toEqual([]);
  });
});

describe("every door says `targets`", () => {
  it("MCP synap_start_session and synap_update_session", async () => {
    const [a, b] = [await seedFinding(), await seedFinding()];
    const started = await mcp.start({
      goal: `MCP batch ${randomUUID()}`,
      targets: [a],
    });
    expect(started.targets).toEqual({ added: [a], already: [] });
    const sessionId = (started.session as { id: string }).id;
    const updated = await mcp.update({ sessionId, targets: [b] });
    expect(updated.targets).toEqual({ added: [b], already: [] });
    expect(await targetIdsOf(sessionId)).toEqual(sorted([a, b]));
    // A malformed list is refused in words, nothing written.
    const bad = await mcp.update({ sessionId, targets: ["not-a-uuid"] });
    expect(String(bad.error)).toMatch(/targets must be an array/);
  });

  it("MCP: an invisible target refuses the start", async () => {
    const goal = `MCP peek ${randomUUID()}`;
    await expect(
      mcp.start({ goal, targets: [THEIR_ENTITY] })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await sessionsWithGoal(goal)).toEqual([]);
  });

  it("tRPC focusSessions.create and .update", async () => {
    const [a, b] = [await seedFinding(), await seedFinding()];
    const created = (await trpc().create({
      goal: `tRPC batch ${randomUUID()}`,
      targets: [a],
      forceCreate: true,
    })) as { id: string; targets?: unknown };
    expect(created.targets).toEqual({ added: [a], already: [] });
    const updated = (await trpc().update({
      id: created.id,
      targets: [b],
    })) as { targets?: unknown };
    expect(updated.targets).toEqual({ added: [b], already: [] });
    expect(await targetIdsOf(created.id)).toEqual(sorted([a, b]));
    await expect(
      trpc().update({ id: created.id, targets: [THEIR_ENTITY] })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("Hub POST and PATCH /focus-sessions", async () => {
    const [a, b] = [await seedFinding(), await seedFinding()];
    const post = await hubRequest("POST", "/focus-sessions", {
      userId: USER,
      workspaceId: MY_SPACE,
      goal: `Hub batch ${randomUUID()}`,
      targets: [a],
      forceCreate: true,
    });
    expect(post.status).toBe(200);
    const created = (await post.json()) as { id: string; targets?: unknown };
    expect(created.targets).toEqual({ added: [a], already: [] });
    const patch = await hubRequest("PATCH", `/focus-sessions/${created.id}`, {
      targets: [b],
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { targets?: unknown }).targets).toEqual({
      added: [b],
      already: [],
    });
    expect(await targetIdsOf(created.id)).toEqual(sorted([a, b]));
    const peek = await hubRequest("PATCH", `/focus-sessions/${created.id}`, {
      targets: [THEIR_ENTITY],
    });
    expect(peek.status).toBe(404);
    expect(await targetIdsOf(created.id)).toEqual(sorted([a, b]));
  });
});

describe("process-sync settles a hand-made session's targets (no metadata.worker)", () => {
  it("moved by the session: done; moved by someone else: skipped", async () => {
    const [mine, theirs] = [await seedFinding(), await seedFinding()];
    const res = await createFocusSession({
      userId: USER,
      goal: `Hand batch ${randomUUID()}`,
      targets: [mine, theirs],
      matchTemplate: false,
      forceCreate: true,
    });
    if (res.status !== "created") throw new Error(res.status);
    const sessionId = res.session.id;
    expect(
      (res.session.metadata as Record<string, unknown> | null)?.worker
    ).toBeUndefined();

    const own = await moveAndSync({ entityId: mine, to: "triaged", sessionId });
    expect(own).toContainEqual({
      kind: "target_settled",
      sessionId,
      entityId: mine,
      result: "done",
    });
    const other = await moveAndSync({ entityId: theirs, to: "triaged" });
    expect(other).toContainEqual({
      kind: "target_settled",
      sessionId,
      entityId: theirs,
      result: "skipped",
    });
    const byId = Object.fromEntries(
      (await edgesOf(sessionId)).map((e) => [e.to_id, e.metadata])
    );
    expect(byId[mine]).toMatchObject({ result: "done" });
    expect(byId[theirs]).toMatchObject({
      result: "skipped",
      reason: "moved_by_person",
    });
  });
});

describe("at close, a declared target follows the playbook's onEnd", () => {
  it("an open target moves; one the session settled does not", async () => {
    const profile = {
      profileSlug: "finding",
      statusProperty: "status",
      onEnd: { cancelled: "open" },
    };
    const stages = [
      { key: "fix", name: "Fix", category: "active", subjectStatus: "fixing" },
    ];
    const playbookId = randomUUID();
    await q(
      `insert into playbooks
         (id, workspace_id, created_by, name, goal_template, executor, stages, criteria, expected_outputs, params, subject_profile, version, status, created_at, updated_at)
       values ($1, null, $2, 'Fix findings', 'Fix them', 'is-agent',
               $3::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, $4::jsonb, 1, 'active', now(), now())`,
      [playbookId, USER, JSON.stringify(stages), JSON.stringify(profile)]
    );
    const sessionId = randomUUID();
    await q(
      `insert into focus_sessions
         (id, user_id, title, goal, status, origin, playbook_id, expected_outputs, criteria, metadata, agent_ids, started_at, created_at, updated_at)
       values ($1, $2, 'Fix', $3, 'active', 'playbook', $4, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}', now(), now(), now())`,
      [sessionId, USER, `Fix batch ${sessionId}`, playbookId]
    );
    await q(
      `insert into playbook_runs (id, playbook_id, session_id, executor, status, created_by, definition_snapshot, started_at)
       values ($1, $2, $3, 'is-agent', 'running', $4, $5::jsonb, now())`,
      [
        randomUUID(),
        playbookId,
        sessionId,
        USER,
        JSON.stringify({ version: 1, stages, subjectProfile: profile }),
      ]
    );
    const [open, settled] = [await seedFinding(), await seedFinding()];
    const declared = await updateFocusSession({
      sessionId,
      userId: USER,
      targets: [open, settled],
    });
    expect(declared).toMatchObject({ status: "updated" });
    // The session moves `settled` itself: its target is done before the close.
    await moveAndSync({ entityId: settled, to: "triaged", sessionId });

    const res = await completeFocusSession({
      sessionId,
      userId: USER,
      terminalStatus: "cancelled",
    });
    expect(res?.session.status).toBe("cancelled");
    expect(await statusOf(open)).toBe("open");
    expect(await statusOf(settled)).toBe("triaged");
    expect(res?.endMoves?.moves).toEqual([
      expect.objectContaining({ entityId: open, as: "target" }),
    ]);
  });
});
