/**
 * START AN ORCHESTRATOR (founder decision D5, plan b38bc224; lane doc
 * 5fccda9b) — ONE governed write files the ask; approving it creates exactly
 * one orchestrator session, one `orchestrated_by` link per picked session,
 * one hold per running picked session (waiting on the person's answer to the
 * orchestrator's `plan-approval` slot) and one handoff note per room.
 *
 * Real: `startOrchestrator`, `applyOrchestration`, `createFocusSession`,
 * `setSessionStatus` (the hold lands in the transition outbox, its only
 * store) and the `focus_session/orchestrate` executor, on PGlite with every
 * @synap/database table.
 * Stubbed: `checkPermissionOrPropose` (routed by caller: an agent proposes,
 * a person is granted, as the ladder does for a `gate` door; the ladder's
 * half is pinned in governance-policy), the room post pair (spies: what was
 * posted, to whom, with which intent), the session room and realtime.
 *
 * NOT covered here, measured: the Hub and tRPC transports (they call the
 * same service with the same schema; typecheck + grant-door tripwire), and
 * the hold-resume job waking the children on the answer (the job's own
 * suite pins `answer:` waits).
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
    resolveSessionProjectPlacement: async () => ({ projectId: null }),
  };
});

type PermArgs = Record<string, unknown> & {
  action?: string;
  agentUserId?: string;
  data?: Record<string, unknown>;
};
const { permSpy, postSpy, resolveSpy, completeSpy } = vi.hoisted(() => ({
  completeSpy: vi.fn(async (_args: Record<string, unknown>) => ({
    session: {},
  })),
  permSpy: vi.fn(async (_args: PermArgs) => ({}) as Record<string, unknown>),
  postSpy: vi.fn(async (_args: Record<string, unknown>) => ({
    success: true,
  })),
  resolveSpy: vi.fn(async (args: Record<string, unknown>) => ({
    channelId: `room-of-${String(args.toSessionId)}`,
    meta: { intent: args.intent, to: { sessionId: args.toSessionId } },
  })),
}));
vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, checkPermissionOrPropose: permSpy };
});
vi.mock("../../messaging/post-message.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postChannelMessage: postSpy,
}));
vi.mock("../../messaging/session-post.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveSessionPost: resolveSpy,
}));
// The one close door (its own suites): what the declined plan asked of it.
vi.mock("../complete-session.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  completeFocusSession: completeSpy,
}));
vi.mock("../ensure-session-channel.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ensureSessionChannel: async (a: { sessionId: string }) =>
      `room-of-${a.sessionId}`,
  };
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
import {
  startOrchestrator,
  closeOrchestratorOnDeclinedPlan,
  ORCHESTRATOR_APPROVAL_SLOT,
} from "../start-orchestrator.js";
import { grantOfScope, runWithGrant } from "@synap/database";
import { orchestratorHolding } from "@synap/jobs/utils/orchestrator-hold.js";
import { refuseUndeclaredStage } from "@synap/jobs/utils/stage-declared.js";
import { registerFocusSessionOrchestrateExecutor } from "../../../routers/proposals/executors/focus-session-orchestrate.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
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

async function seedSession(
  opts: {
    owner?: string;
    status?: string;
    title?: string;
    workspaceId?: string | null;
    stage?: string | null;
  } = {}
): Promise<string> {
  const id = randomUUID();
  await h.client!.query(
    `insert into focus_sessions
       (id, user_id, title, goal, status, origin, expected_outputs, criteria, metadata, agent_ids, progress, started_at, updated_at, workspace_id, current_stage)
     values ($1, $2, $3, $4, $5, 'agent', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, $6, 0, now(), now(), $7, $8)`,
    [
      id,
      opts.owner ?? USER,
      opts.title ?? `Lane ${id.slice(0, 4)}`,
      `Ship lane ${id}`,
      opts.status ?? "active",
      [AGENT],
      opts.workspaceId ?? null,
      opts.stage ?? null,
    ]
  );
  return id;
}

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** An app's key, granted to move sessions in space A only. */
const GRANT_A = grantOfScope(
  { permissions: ["session.update"], workspaceIds: [WS_A] },
  "app-ops"
);

const statusOf = async (id: string) =>
  (
    await h.client!.query<{ status: string }>(
      `select status from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]?.status;

const sessionsNamed = async (id: string) =>
  (
    await h.client!.query<{
      id: string;
      goal: string;
      title: string;
      expected_outputs: Array<Record<string, unknown>>;
      agent_ids: string[] | null;
    }>(
      `select id, goal, title, expected_outputs, agent_ids from focus_sessions where id = $1`,
      [id]
    )
  ).rows;

const linksTo = async (orchestratorId: string) =>
  (
    await h.client!.query<{ from_id: string; link_type: string }>(
      `select from_id, link_type from links where to_type = 'session' and to_id = $1`,
      [orchestratorId]
    )
  ).rows;

const linksFrom = async (ids: string[]) =>
  (
    await h.client!.query<{ from_id: string; link_type: string }>(
      `select from_id, link_type from links where from_id = any($1::text[])`,
      [ids]
    )
  ).rows;

/** The holds the pause recorded: the transition log is a hold's only store. */
const holdsOf = async (ids: string[]) =>
  (
    await h.client!.query<{ transition: unknown }>(
      `select transition from lifecycle_transition_outbox where transition ->> 'subjectId' = any($1::text[])`,
      [ids]
    )
  ).rows.map((r) => {
    const t = (
      typeof r.transition === "string" ? JSON.parse(r.transition) : r.transition
    ) as {
      subjectId: string;
      to?: string;
      hold?: { until?: { moves?: string }; on?: string };
    };
    return { subjectId: t.subjectId, to: t.to, hold: t.hold };
  });

/** The ladder for a gate door: an agent proposes, a person is granted. */
function ladderDefault() {
  permSpy.mockImplementation(async (args: PermArgs) =>
    args.action === "orchestrate" && args.agentUserId
      ? {
          granted: false,
          proposalId: randomUUID(),
          proposalType: "orchestrate",
          summary: "Orchestrate sessions",
          reviewPath: "/open/x",
          reviewUrl: "https://pod.test/open/x",
        }
      : { granted: true }
  );
}

const orchestrateCalls = () =>
  permSpy.mock.calls.map((c) => c[0]).filter((a) => a.action === "orchestrate");

async function approve(data: Record<string, unknown>, approver = USER) {
  const executor = proposalExecRegistry.resolveExact(
    "focus_session/orchestrate"
  )!;
  expect(executor).toBeTruthy();
  return executor.execute({
    proposal: {
      id: randomUUID(),
      targetId: data.id,
      workspaceId: null,
      projectId: null,
      subjectUserId: USER,
      agentUserId: AGENT,
      data: { data },
      targetType: "focus_session",
      proposalType: "orchestrate",
    },
    payload: null,
    userId: approver,
    input: { proposalId: randomUUID() },
    deps: {
      reportProposalOutcome: () => undefined,
      emitProposalReviewed: () => undefined,
      emitSideEffects: () => undefined,
      notify: async () => undefined,
    },
  } as never) as unknown as Promise<Record<string, unknown>>;
}

beforeAll(async () => {
  for (const t of Object.values(schema)) {
    if (is(t, PgTable)) await h.client!.exec(ddlFor(t));
  }
  // The edge's real unique index (`idx_links_unique_edge`): the producer's
  // conflict-do-nothing names it.
  await h.client!.exec(
    `create unique index if not exists idx_links_unique_edge on links (from_type, from_id, to_type, to_id, link_type);`
  );
  await h.client!.query(
    `insert into users (id, email, name, user_type) values
      ($1, 'a@x.test', 'Antoine', 'human'),
      ($2, 'c@x.test', 'Claude Code', 'agent'),
      ($3, 'o@x.test', 'Other', 'human')`,
    [USER, AGENT, OTHER_PERSON]
  );
  registerFocusSessionOrchestrateExecutor();
}, 120_000);

beforeEach(() => {
  completeSpy.mockClear();
  permSpy.mockReset();
  postSpy.mockClear();
  resolveSpy.mockClear();
  ladderDefault();
});

describe("startOrchestrator — the ask", () => {
  it("an agent's ask is PROPOSED and writes nothing: no orchestrator, no link, no hold, no note", async () => {
    const a = await seedSession();
    const b = await seedSession();
    const res = await startOrchestrator({
      userId: USER,
      agentUserId: AGENT,
      input: { sessionIds: [a, b], brief: "Merge the two lanes' plans" },
    });
    expect(res.status).toBe("proposed");
    if (res.status !== "proposed") throw new Error("unreachable");

    const [gate] = orchestrateCalls();
    expect(gate).toMatchObject({
      subjectType: "focus_session",
      action: "orchestrate",
      agentUserId: AGENT,
      data: {
        id: res.orchestratorSessionId,
        goal: "Merge the two lanes' plans",
        sessionIds: [a, b],
      },
    });
    expect(orchestrateCalls()).toHaveLength(1);

    expect(await sessionsNamed(res.orchestratorSessionId)).toHaveLength(0);
    expect(await linksFrom([a, b])).toEqual([]);
    expect(await holdsOf([a, b])).toEqual([]);
    expect(await statusOf(a)).toBe("active");
    expect(await statusOf(b)).toBe("active");
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("a gate that DENIES leaves nothing either", async () => {
    permSpy.mockImplementation(async () => ({
      denied: true,
      reason: "not allowed",
    }));
    const a = await seedSession();
    const b = await seedSession();
    await expect(
      startOrchestrator({
        userId: USER,
        agentUserId: AGENT,
        input: { sessionIds: [a, b], brief: "Nope" },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await linksFrom([a, b])).toEqual([]);
    expect(await statusOf(a)).toBe("active");
  });

  it("a session the caller does not own is NOT FOUND, and nothing is filed", async () => {
    const mine = await seedSession();
    const theirs = await seedSession({ owner: OTHER_PERSON });
    await expect(
      startOrchestrator({
        userId: USER,
        agentUserId: AGENT,
        input: { sessionIds: [mine, theirs], brief: "Reach into theirs" },
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(orchestrateCalls()).toHaveLength(0);
    expect(await statusOf(theirs)).toBe("active");
  });

  it("a session that already ended is refused by name", async () => {
    const a = await seedSession();
    const done = await seedSession({ status: "closed", title: "Old lane" });
    await expect(
      startOrchestrator({
        userId: USER,
        agentUserId: AGENT,
        input: { sessionIds: [a, done], brief: "Too late" },
      })
    ).rejects.toThrow(/"Old lane" is closed/);
    expect(orchestrateCalls()).toHaveLength(0);
  });

  it("fewer than two different sessions is refused", async () => {
    const a = await seedSession();
    await expect(
      startOrchestrator({
        userId: USER,
        agentUserId: AGENT,
        input: { sessionIds: [a, a], brief: "Alone" },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("approving it — one orchestrator, N links, N holds, N notes", () => {
  it("creates exactly one orchestrator and links, holds and notes each picked session", async () => {
    const a = await seedSession();
    const b = await seedSession();
    const paused = await seedSession({ status: "paused" });
    const res = await startOrchestrator({
      userId: USER,
      agentUserId: AGENT,
      input: {
        sessionIds: [a, b, paused],
        brief: "One plan for the three lanes",
        title: "Ops wave orchestrator",
      },
    });
    if (res.status !== "proposed") throw new Error(`got ${res.status}`);
    const [gate] = orchestrateCalls();
    const orch = res.orchestratorSessionId;

    const approved = await approve(gate!.data!);
    expect(approved).toMatchObject({
      success: true,
      status: "started",
      orchestratorSessionId: orch,
    });

    // ONE orchestrator, under the id the proposal named.
    const rows = await sessionsNamed(orch);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      goal: "One plan for the three lanes",
      title: "Ops wave orchestrator",
    });
    const gateSlot = rows[0]!.expected_outputs.find(
      (o) => o.key === ORCHESTRATOR_APPROVAL_SLOT
    );
    expect(gateSlot).toMatchObject({ owner: "human", kind: "decision" });

    // N links, child → orchestrator, and never a lineage edge.
    const edges = await linksTo(orch);
    expect(edges.map((e) => e.link_type)).toEqual([
      "orchestrated_by",
      "orchestrated_by",
      "orchestrated_by",
    ]);
    expect(edges.map((e) => e.from_id).sort()).toEqual([a, b, paused].sort());
    expect(
      (await linksFrom([a, b, paused])).filter(
        (l) => l.link_type === "spawned_from"
      )
    ).toEqual([]);

    // The running ones are paused on the person's answer; the paused one
    // keeps its own hold.
    expect(await statusOf(a)).toBe("paused");
    expect(await statusOf(b)).toBe("paused");
    expect(await statusOf(paused)).toBe("paused");
    const holds = await holdsOf([a, b, paused]);
    expect(holds.map((x) => x.subjectId).sort()).toEqual([a, b].sort());
    for (const x of holds) {
      expect(x.to).toBe("paused");
      expect(x.hold).toMatchObject({
        on: "decision",
        until: { moves: `answer:${orch}/${ORCHESTRATOR_APPROVAL_SLOT}` },
      });
      // Never open-ended: the hold door's default review date (14 days).
      const reviewBy = Date.parse(
        (x.hold as { reviewBy?: string } | undefined)?.reviewBy ?? ""
      );
      expect(reviewBy - Date.now()).toBeGreaterThan(13 * 86_400_000);
      expect(reviewBy - Date.now()).toBeLessThan(15 * 86_400_000);
    }
    expect(
      (approved.children as Array<{ sessionId: string; held: string }>)
        .map((c) => [c.sessionId, c.held])
        .sort()
    ).toEqual(
      [
        [a, "paused"],
        [b, "paused"],
        [paused, "already_paused"],
      ].sort()
    );

    // One handoff note per room, from the orchestrator.
    expect(resolveSpy).toHaveBeenCalledTimes(3);
    for (const call of resolveSpy.mock.calls) {
      expect(call[0]).toMatchObject({
        intent: "handoff",
        fromSessionId: orch,
        agentUserId: AGENT,
      });
    }
    expect(postSpy).toHaveBeenCalledTimes(3);

    // Approving twice changes nothing: still one orchestrator, N links.
    await approve(gate!.data!);
    expect(await sessionsNamed(orch)).toHaveLength(1);
    expect(await linksTo(orch)).toHaveLength(3);
    expect(await holdsOf([a, b, paused])).toHaveLength(2);
  });

  it("a session that ended between the ask and the yes is reported, neither linked nor held", async () => {
    const a = await seedSession();
    const b = await seedSession();
    const res = await startOrchestrator({
      userId: USER,
      agentUserId: AGENT,
      input: { sessionIds: [a, b], brief: "Two lanes" },
    });
    if (res.status !== "proposed") throw new Error(`got ${res.status}`);
    await h.client!.query(
      `update focus_sessions set status = 'closed' where id = $1`,
      [b]
    );
    const approved = await approve(orchestrateCalls()[0]!.data!);
    expect(approved.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: b, held: "ended", linked: false }),
      ])
    );
    expect(
      (await linksTo(res.orchestratorSessionId)).map((l) => l.from_id)
    ).toEqual([a]);
    expect(await statusOf(b)).toBe("closed");
  });

  it("a reviewer who does not own the picked sessions orchestrates nothing", async () => {
    const a = await seedSession();
    const b = await seedSession();
    const res = await startOrchestrator({
      userId: USER,
      agentUserId: AGENT,
      input: { sessionIds: [a, b], brief: "Foreign reviewer" },
    });
    if (res.status !== "proposed") throw new Error(`got ${res.status}`);
    await expect(
      approve(orchestrateCalls()[0]!.data!, OTHER_PERSON)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await sessionsNamed(res.orchestratorSessionId)).toHaveLength(0);
    expect(await statusOf(a)).toBe("active");
  });
});

describe("a person's ask — granted, applied at once", () => {
  it("starts the orchestrator directly; with no agent the notes are plain room posts", async () => {
    const a = await seedSession();
    const b = await seedSession();
    const res = await startOrchestrator({
      userId: USER,
      input: { sessionIds: [a, b], brief: "My own call" },
    });
    expect(res.status).toBe("started");
    if (res.status !== "started") throw new Error("unreachable");
    expect(await sessionsNamed(res.orchestratorSessionId)).toHaveLength(1);
    expect(await linksTo(res.orchestratorSessionId)).toHaveLength(2);
    expect(await statusOf(a)).toBe("paused");
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(postSpy).toHaveBeenCalledTimes(2);
    expect(res.children.every((c) => c.noted)).toBe(true);
  });
});

// Operations r1 (security): the gate checks the key's grant in ONE place (the
// orchestrator's), but the write pauses a session in EVERY picked space.
describe("the calling key must reach EVERY picked session", () => {
  const nothingWritten = async (ids: string[]) => {
    expect(orchestrateCalls()).toHaveLength(0);
    expect(await linksFrom(ids)).toEqual([]);
    expect(await holdsOf(ids)).toEqual([]);
    for (const id of ids) expect(await statusOf(id)).toBe("active");
    expect(postSpy).not.toHaveBeenCalled();
  };

  it("a key granted on space A that picks sessions in A and B is refused whole (403), naming nothing of B", async () => {
    const a = await seedSession({ workspaceId: WS_A });
    const b = await seedSession({ workspaceId: WS_B });
    const err = await runWithGrant(GRANT_A, () =>
      // A person's app acts as the person: without the fix it applies at once.
      startOrchestrator({
        userId: USER,
        input: { sessionIds: [a, b], brief: "Reach into B" },
      })
    ).then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string }
    );
    expect(err).toMatchObject({ code: "FORBIDDEN" });
    expect(err!.message).not.toContain(WS_B);
    await nothingWritten([a, b]);
  });

  it("the same key over sessions all in A goes on to the gate, and applies", async () => {
    const a1 = await seedSession({ workspaceId: WS_A });
    const a2 = await seedSession({ workspaceId: WS_A });
    const res = await runWithGrant(GRANT_A, () =>
      startOrchestrator({
        userId: USER,
        input: { sessionIds: [a1, a2], brief: "Both in A" },
      })
    );
    expect(res.status).toBe("started");
    expect(orchestrateCalls()).toHaveLength(1);
    expect(await statusOf(a1)).toBe("paused");
    expect(await statusOf(a2)).toBe("paused");
  });

  it("a key bound to workspace A picks only sessions in A: B, or a session in no space, is 403 and nothing is written", async () => {
    const a = await seedSession({ workspaceId: WS_A });
    const b = await seedSession({ workspaceId: WS_B });
    const loose = await seedSession({ workspaceId: null });
    for (const other of [b, loose]) {
      await expect(
        startOrchestrator({
          userId: USER,
          agentUserId: AGENT,
          boundWorkspaceId: WS_A,
          input: { sessionIds: [a, other], brief: "Out of my space" },
        })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await nothingWritten([a, b, loose]);
    const a2 = await seedSession({ workspaceId: WS_A });
    const res = await startOrchestrator({
      userId: USER,
      agentUserId: AGENT,
      boundWorkspaceId: WS_A,
      input: { sessionIds: [a, a2], brief: "Within A" },
    });
    expect(res.status).toBe("proposed");
  });
});

// Founder decision D-O1: a session an orchestrator holds changes no stage
// before the person answers its plan. The rule every stage door asks before
// it writes or files anything (`refuseUndeclaredStage`).
describe("a held session changes no stage until the plan is answered (D-O1)", () => {
  const answerPlan = (orch: string, confirmed: boolean) =>
    h.client!.query(
      `update focus_sessions set expected_outputs = (
         select jsonb_agg(case when o->>'key' = 'plan-approval'
           then o || jsonb_build_object('answer', jsonb_build_object(
             'answeredBy', user_id, 'answeredAt', now()::text,
             'value', jsonb_build_object('type', 'confirm', 'confirmed', $2::boolean)))
           else o end)
         from jsonb_array_elements(expected_outputs) o)
       where id = $1`,
      [orch, confirmed]
    );
  const move = (id: string, toStage: string) =>
    refuseUndeclaredStage({ id, playbookId: null, currentStage: null }, toStage);

  it("refuses a move of a held session with the orchestrator's name; frees it once the plan is answered", async () => {
    const a = await seedSession();
    const b = await seedSession();
    const res = await startOrchestrator({
      userId: USER,
      input: {
        sessionIds: [a, b],
        brief: "Hold the lanes",
        title: "Wave plan",
      },
    });
    if (res.status !== "started") throw new Error(`got ${res.status}`);
    const refused = await move(a, "build");
    expect(refused).toMatchObject({ code: "HELD_BY_ORCHESTRATOR" });
    expect(refused!.reason).toContain(
      "Waiting on the orchestrator's plan: Wave plan"
    );
    await answerPlan(res.orchestratorSessionId, true);
    expect(await orchestratorHolding(a)).toBeNull();
    expect(await move(a, "build")).toBeNull();
  });

  it("an orchestrator that ended unanswered frees them too; a session no orchestrator holds is never refused", async () => {
    const a = await seedSession();
    const b = await seedSession();
    const free = await seedSession();
    const res = await startOrchestrator({
      userId: USER,
      input: { sessionIds: [a, b], brief: "Ends early" },
    });
    if (res.status !== "started") throw new Error(`got ${res.status}`);
    expect(await move(b, "build")).not.toBeNull();
    expect(await move(free, "build")).toBeNull();
    await h.client!.query(
      `update focus_sessions set status = 'cancelled' where id = $1`,
      [res.orchestratorSessionId]
    );
    expect(await move(b, "build")).toBeNull();
  });

  it("an orchestrated_by edge to someone else's session never freezes yours", async () => {
    const mine = await seedSession();
    const theirs = await seedSession({ owner: OTHER_PERSON });
    await h.client!.query(
      `update focus_sessions set expected_outputs = $2::jsonb where id = $1`,
      [
        theirs,
        JSON.stringify([
          { key: "plan-approval", label: "Plan approval", kind: "decision" },
        ]),
      ]
    );
    await h.client!.query(
      `insert into links (id, from_type, from_id, to_type, to_id, link_type, created_by)
       values ($1, 'session', $2, 'session', $3, 'orchestrated_by', $4)`,
      [randomUUID(), mine, theirs, OTHER_PERSON]
    );
    expect(await move(mine, "build")).toBeNull();
  });
});

// Founder decision D-O2: a NO resumes the held sessions as they were (the
// answer ends their wait) and closes the orchestrator; a yes leaves it going.
describe("a no to the plan closes the orchestrator (D-O2)", () => {
  const SLOT = { key: ORCHESTRATOR_APPROVAL_SLOT, label: "Plan approval", kind: "decision" };
  const answer = (value: unknown) =>
    ({
      text: "no",
      messageId: null,
      answeredBy: USER,
      answeredAt: new Date().toISOString(),
      value,
    }) as never;
  async function started(): Promise<string> {
    const a = await seedSession();
    const b = await seedSession();
    const res = await startOrchestrator({
      userId: USER,
      input: { sessionIds: [a, b], brief: "Plan" },
    });
    if (res.status !== "started") throw new Error(`got ${res.status}`);
    return res.orchestratorSessionId;
  }

  it("a confirm 'no' or a refusal closes it, cancelled with 'Plan declined', through the one close door", async () => {
    for (const value of [
      { type: "confirm", confirmed: false },
      { type: "declined" },
    ]) {
      completeSpy.mockClear();
      const orch = await started();
      expect(
        await closeOrchestratorOnDeclinedPlan({
          sessionId: orch,
          userId: USER,
          slot: SLOT as never,
          answer: answer(value),
        })
      ).toEqual({ closed: true });
      expect(completeSpy).toHaveBeenCalledTimes(1);
      expect(completeSpy.mock.calls[0]![0]).toMatchObject({
        sessionId: orch,
        userId: USER,
        terminalStatus: "cancelled",
        cancelReason: "Plan declined",
      });
      // No agent on the close: it is the person's own act.
      expect(completeSpy.mock.calls[0]![0]).not.toHaveProperty("agentUserId");
    }
  });

  it("a yes, another slot, or a session no one is orchestrated by closes nothing", async () => {
    const orch = await started();
    const lone = await seedSession();
    for (const call of [
      { sessionId: orch, slot: SLOT, value: { type: "confirm", confirmed: true } },
      {
        sessionId: orch,
        slot: { ...SLOT, key: "merged-plan" },
        value: { type: "confirm", confirmed: false },
      },
      { sessionId: lone, slot: SLOT, value: { type: "confirm", confirmed: false } },
    ]) {
      expect(
        await closeOrchestratorOnDeclinedPlan({
          sessionId: call.sessionId,
          userId: USER,
          slot: call.slot as never,
          answer: answer(call.value),
        })
      ).toBeNull();
    }
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("a failed close is said, never thrown: the answer already landed", async () => {
    const orch = await started();
    completeSpy.mockRejectedValueOnce(new Error("close door down"));
    expect(
      await closeOrchestratorOnDeclinedPlan({
        sessionId: orch,
        userId: USER,
        slot: SLOT as never,
        answer: answer({ type: "confirm", confirmed: false }),
      })
    ).toEqual({ closed: false, error: "close door down" });
  });
});
