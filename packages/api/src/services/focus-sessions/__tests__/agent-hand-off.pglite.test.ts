/**
 * AGENT HAND-OFF — an AI agent putting ANOTHER agent on a session's roster is
 * a governed write of its own (`focus_session/assign_agent`), proposed unless
 * a governance rule says auto (founder, 2026-10-12: "if not overridden, ask
 * for approval for non-cancelable actions").
 *
 * Live defect it closes: an agent's `synap_start_session` with
 * `agentIds:[self, other]` and `synap_update_session` `addAgentId: other` both
 * APPLIED, and the other agent's worker started at once.
 *
 * Real: `updateFocusSession`, `createFocusSession`, `attachSessionAgent` and
 * the `focus_session/assign_agent` approval executor, on PGlite with every
 * @synap/database table.
 * Stubbed: `checkPermissionOrPropose` — routed by ACTION, so the stub answers
 * what the ladder answers for each door (the ladder's own half — assign_agent
 * proposes by default, an `auto` rule executes it — is pinned in
 * `governance-policy/src/agent-hand-off.test.ts`). The session room, realtime,
 * project placement and spawn lineage are stubbed as in the sibling suites.
 *
 * THE route, before governance (`handOffRefusal` → `route()`): a PAUSED
 * agent, and one that does not act for the session's owner, are DENIED by
 * name and never reach the governance gate; a pod agent (a room member, not a
 * hand-off) passes through to governance as before; and approving a hand-off
 * re-asks the route, so an agent paused since the proposal is refused there.
 *
 * NOT covered here, measured: the Hub `PATCH /focus-sessions/:id` door (it
 * calls the same `gateAgentHandOff`; typecheck only).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, { schema }),
    recordSessionSpawn: async () => ({
      linked: false,
      suspendedIntentRecorded: false,
    }),
    resolveSessionProjectPlacement: async () => ({ projectId: null }),
  };
});

type PermArgs = Record<string, unknown> & {
  action?: string;
  agentUserId?: string;
  data?: Record<string, unknown>;
};
const { permSpy } = vi.hoisted(() => ({
  permSpy: vi.fn(async (_args: PermArgs) => ({}) as Record<string, unknown>),
}));
vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, checkPermissionOrPropose: permSpy };
});
vi.mock("../ensure-session-channel.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ensureSessionChannel: async () => null };
});
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitHubRealtimeEvent: () => undefined };
});
vi.mock("../block-guidelines.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  guidanceForBlockedSlots: vi.fn(async () => undefined),
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { createFocusSession } from "../create-session.js";
import { updateFocusSession } from "../update-session.js";
import { registerFocusSessionExecutors } from "../../../routers/proposals/executors/focus-session.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const WORKER = "33333333-3333-4333-8333-333333333333";
/** USER's worker, paused by a person. */
const PAUSED = "44444444-4444-4444-8444-444444444444";
/** A worker that acts for someone else. */
const STRANGER = "55555555-5555-4555-8555-555555555555";
/** USER's house agent (agentType, no key): the pod runs it. */
const HOUSE = "66666666-6666-4666-8666-666666666666";
const OTHER_PERSON = "77777777-7777-4777-8777-777777777777";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const roster = async (id: string): Promise<string[]> =>
  (
    await h.client!.query<{ agent_ids: string[] | null }>(
      `select agent_ids from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!.agent_ids ?? [];

async function seedSession(agentIds: string[] = [AGENT]): Promise<string> {
  const id = randomUUID();
  await h.client!.query(
    `insert into focus_sessions
       (id, user_id, title, goal, status, origin, expected_outputs, criteria, metadata, agent_ids, progress, started_at, updated_at)
     values ($1, $2, 'Hand-off', 'Ship the hand-off', 'active', 'agent',
             '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, $3, 0, now(), now())`,
    [id, USER, agentIds]
  );
  return id;
}

/** The ladder's default: the hand-off door proposes, every other door applies. */
function ladderDefault() {
  permSpy.mockImplementation(async (args: PermArgs) =>
    args.action === "assign_agent" && args.agentUserId
      ? {
          granted: false,
          proposalId: randomUUID(),
          proposalType: "assign_agent",
          summary: "Hand session to an agent",
          reviewPath: "/open/x",
          reviewUrl: "https://pod.test/open/x",
        }
      : { granted: true }
  );
}

const handOffCalls = () =>
  permSpy.mock.calls
    .map((c) => c[0])
    .filter((a) => a.action === "assign_agent");

async function approveHandOff(
  sessionId: string,
  data: Record<string, unknown>
) {
  const executor = proposalExecRegistry.resolveExact(
    "focus_session/assign_agent"
  )!;
  expect(executor).toBeTruthy();
  return executor.execute({
    proposal: {
      id: randomUUID(),
      targetId: sessionId,
      workspaceId: null,
      projectId: null,
      subjectUserId: USER,
      data: { data },
      targetType: "focus_session",
      proposalType: "assign_agent",
    },
    payload: null,
    userId: USER,
    input: { proposalId: randomUUID() },
    deps: {
      reportProposalOutcome: () => undefined,
      emitProposalReviewed: () => undefined,
      emitSideEffects: () => undefined,
      notify: async () => undefined,
    },
  } as never);
}

beforeAll(async () => {
  for (const t of Object.values(schema)) {
    if (is(t, PgTable)) await h.client!.exec(ddlFor(t));
  }
  await h.client!.query(
    `insert into users (id, email, name, user_type) values
      ($1, 'a@x.test', 'Antoine', 'human'),
      ($2, 'c@x.test', 'Claude Code', 'agent'),
      ($3, 'w@x.test', 'Worker', 'agent')`,
    [USER, AGENT, WORKER]
  );
  await h.client!.query(
    `insert into users (id, email, name, user_type, agent_type, created_by_user_id, agent_paused_at) values
      ($1, 'p@x.test', 'Paused worker', 'agent', null, $5, now()),
      ($2, 's@x.test', 'Stranger', 'agent', null, $4, null),
      ($3, 'h@x.test', 'Twin', 'agent', 'meta', $5, null),
      ($4, 'o@x.test', 'Other', 'human', null, null, null)`,
    [PAUSED, STRANGER, HOUSE, OTHER_PERSON, USER]
  );
  // A pulling agent acts for the person its key is linked to — THE route's
  // floor for reach 'pull' (`agentsOperatedBy`).
  const key = (agentId: string, personId: string) =>
    h.client!.query(
      `insert into api_keys (id, user_id, key_type, linked_user_id, is_active) values ($1, $2, 'hub_inbound', $3, true)`,
      [randomUUID(), agentId, personId]
    );
  await key(AGENT, USER);
  await key(WORKER, USER);
  await key(PAUSED, USER);
  await key(STRANGER, OTHER_PERSON);
  registerFocusSessionExecutors();
}, 120_000);

beforeEach(() => {
  permSpy.mockReset();
  ladderDefault();
});

describe("update_session addAgentId — an agent handing the session on", () => {
  it("an agent adding ANOTHER agent is PROPOSED; the roster is unchanged until approval, which attaches it", async () => {
    const sessionId = await seedSession();
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      addAgentId: WORKER,
    });
    expect(res.status).toBe("proposed");
    expect(await roster(sessionId)).toEqual([AGENT]);

    const [gate] = handOffCalls();
    expect(gate).toMatchObject({
      subjectType: "focus_session",
      action: "assign_agent",
      agentUserId: AGENT,
      // Filed on the session, naming the agent the reviewer hands it to.
      sessionId,
      data: { id: sessionId, addAgentId: WORKER, agentName: "Worker" },
    });
    // The roster-only patch never reached the update membrane, which would
    // have auto-approved it.
    expect(permSpy.mock.calls.map((c) => c[0].action)).toEqual([
      "assign_agent",
    ]);

    const approved = await approveHandOff(sessionId, gate!.data!);
    expect(approved).toMatchObject({ success: true });
    expect(await roster(sessionId)).toEqual([AGENT, WORKER]);
  });

  it("the rest of a mixed patch lands; only the hand-off waits, and is said back", async () => {
    const sessionId = await seedSession();
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      addAgentId: WORKER,
      progress: 40,
    });
    expect(res.status).toBe("updated");
    if (res.status !== "updated") throw new Error("unreachable");
    expect(res.session.progress).toBe(40);
    expect(res.handOff).toMatchObject({ status: "proposed", agentId: WORKER });
    expect(await roster(sessionId)).toEqual([AGENT]);
    // The update the membrane saw no longer carries the held agent.
    const update = permSpy.mock.calls
      .map((c) => c[0])
      .find((a) => a.action === "update")!;
    expect(update.data?.addAgentId).toBeUndefined();
  });

  it("an `auto` rule for the hand-off door applies it directly", async () => {
    // What the ladder answers when a governance_rules row says auto (rung 2.8).
    permSpy.mockImplementation(async () => ({ granted: true }));
    const sessionId = await seedSession();
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      addAgentId: WORKER,
    });
    expect(res.status).toBe("updated");
    expect(handOffCalls()).toHaveLength(1);
    expect(await roster(sessionId)).toEqual([AGENT, WORKER]);
  });

  it("CONTROL — an agent adding ITSELF is not a hand-off: applied, never asked", async () => {
    const sessionId = await seedSession([]);
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      addAgentId: AGENT,
    });
    expect(res.status).toBe("updated");
    expect(handOffCalls()).toHaveLength(0);
    expect(await roster(sessionId)).toEqual([AGENT]);
  });

  it("CONTROL — a PERSON staffing their own session applies directly", async () => {
    const sessionId = await seedSession([]);
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      addAgentId: WORKER,
    });
    expect(res.status).toBe("updated");
    expect(handOffCalls()).toHaveLength(0);
    expect(await roster(sessionId)).toEqual([WORKER]);
  });
});

describe("start_session agentIds — an agent's start naming other agents", () => {
  it("the session starts with the starter only; the named agent waits on a proposal, and approval attaches it", async () => {
    const res = await createFocusSession({
      userId: USER,
      goal: `Hand to the worker ${randomUUID()}`,
      agentUserId: AGENT,
      agentIds: [AGENT, WORKER],
      matchTemplate: false,
      forceCreate: true,
    });
    expect(res.status).toBe("created");
    if (res.status !== "created") throw new Error("unreachable");
    const sessionId = res.session.id;
    expect(await roster(sessionId)).toEqual([AGENT]);
    expect(res.handOffs).toEqual([
      expect.objectContaining({ status: "proposed", agentId: WORKER }),
    ]);

    const [gate] = handOffCalls();
    expect(gate!.data).toMatchObject({ id: sessionId, addAgentId: WORKER });
    await approveHandOff(sessionId, gate!.data!);
    expect(await roster(sessionId)).toEqual([AGENT, WORKER]);
  });

  it("an `auto` rule for the hand-off door puts the named agent on at start", async () => {
    permSpy.mockImplementation(async () => ({ granted: true }));
    const res = await createFocusSession({
      userId: USER,
      goal: `Auto hand-off ${randomUUID()}`,
      agentUserId: AGENT,
      agentIds: [WORKER],
      matchTemplate: false,
      forceCreate: true,
    });
    if (res.status !== "created") throw new Error(`got ${res.status}`);
    expect(res.handOffs).toEqual([
      expect.objectContaining({ status: "granted", agentId: WORKER }),
    ]);
    expect(await roster(res.session.id)).toEqual([AGENT, WORKER]);
  });

  it("CONTROL — a person's start names agents directly, no hand-off asked", async () => {
    const res = await createFocusSession({
      userId: USER,
      goal: `Person hands it ${randomUUID()}`,
      agentIds: [WORKER],
      matchTemplate: false,
      forceCreate: true,
    });
    if (res.status !== "created") throw new Error(`got ${res.status}`);
    expect(handOffCalls()).toHaveLength(0);
    expect(res.handOffs).toBeUndefined();
    expect(await roster(res.session.id)).toEqual([WORKER]);
  });
});

describe("THE route decides which agent may take the session", () => {
  it("update: a PAUSED agent is denied by name and never reaches governance", async () => {
    const sessionId = await seedSession();
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      addAgentId: PAUSED,
    });
    expect(res).toMatchObject({ status: "denied" });
    expect((res as { reason: string }).reason).toMatch(
      /^Paused worker is paused/
    );
    expect(handOffCalls()).toHaveLength(0);
    expect(await roster(sessionId)).toEqual([AGENT]);
  });

  it("start: an agent that does not act for the person is denied; the session still starts", async () => {
    const res = await createFocusSession({
      userId: USER,
      goal: `Hand to a stranger ${randomUUID()}`,
      agentUserId: AGENT,
      agentIds: [AGENT, STRANGER],
      matchTemplate: false,
      forceCreate: true,
    });
    if (res.status !== "created") throw new Error(`got ${res.status}`);
    expect(res.handOffs).toEqual([
      expect.objectContaining({
        status: "denied",
        agentId: STRANGER,
        reason: expect.stringMatching(/^Stranger does not act for/),
      }),
    ]);
    expect(handOffCalls()).toHaveLength(0);
    expect(await roster(res.session.id)).toEqual([AGENT]);
  });

  it("an unknown id is denied like a foreign one, never put on the roster", async () => {
    const sessionId = await seedSession();
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      addAgentId: randomUUID(),
    });
    expect(res).toMatchObject({ status: "denied" });
    expect(await roster(sessionId)).toEqual([AGENT]);
  });

  it("CONTROL — a pod agent is a room member, not a hand-off: governance decides as before", async () => {
    const sessionId = await seedSession();
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      addAgentId: HOUSE,
    });
    expect(res.status).toBe("proposed");
    expect(handOffCalls()).toHaveLength(1);
  });

  it("approval re-asks the route: an agent paused since the proposal is refused, not attached", async () => {
    const sessionId = await seedSession();
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      addAgentId: WORKER,
    });
    expect(res.status).toBe("proposed");
    const [gate] = handOffCalls();
    await h.client!.query(
      `update users set agent_paused_at = now() where id = $1`,
      [WORKER]
    );
    try {
      await expect(approveHandOff(sessionId, gate!.data!)).rejects.toThrow(
        /^Worker is paused/
      );
      expect(await roster(sessionId)).toEqual([AGENT]);
    } finally {
      await h.client!.query(
        `update users set agent_paused_at = null where id = $1`,
        [WORKER]
      );
    }
  });
});
