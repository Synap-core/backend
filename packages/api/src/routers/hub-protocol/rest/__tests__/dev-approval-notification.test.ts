/**
 * DEV APPROVAL — exactly ONE human is told, exactly ONCE, in EITHER scope.
 *
 * Two live defects, observed against the running pod on 2026-09-12:
 *
 *   D2a — a WORKSPACE-scoped `dev.plan_approval` notified NOBODY. The route
 *         passed `userId: agentUserId ?? c.get("userId")`, so the proposal's
 *         `userId` — the human the workspace path notifies, and the OWNER FLOOR
 *         subject — was the AGENT principal. The gate waited on a human who was
 *         never told.
 *   D2b — a POD-scoped one notified TWICE, 5 ms apart: `notifyProposalCreated`
 *         fired `emitSideEffects` (which runs the pod-wide reactor in-process)
 *         BEFORE its own un-awaited `notifyPodWideProposal`, so both arms read
 *         the idempotency SELECT before either INSERT landed.
 *
 * Driven through the REAL route + REAL service + REAL `createPendingProposal` +
 * REAL `NotificationService`. Only the edges are faked: the database, the queue,
 * and the push transport. What is asserted is the notification ROW that would be
 * written and the push that would be sent — recipient and deep link — not that a
 * function was called.
 *
 * `emitSideEffects` is replaced by a stub that RUNS the pod-wide reactor's own
 * handler for a matching payload. That is what `@synap/events`'s real
 * `emitSideEffects` does (it awaits each registered reactor in-process); it is
 * stubbed only because the real one bails out when pg-boss is unavailable, which
 * would hide the second arm entirely and make this file green for the wrong
 * reason.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HUMAN = "0aaaaaaa-0000-4000-8000-000000000001";
const AGENT = "0bbbbbbb-0000-4000-8000-000000000002";
const WORKSPACE = "0ccccccc-0000-4000-8000-000000000003";
const SESSION = "0ddddddd-0000-4000-8000-000000000004";
const PROPOSAL = "0eeeeeee-0000-4000-8000-000000000005";

interface NotificationRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  type: string;
  sourceType: string;
  sourceId?: string;
}

const state = {
  notifications: [] as NotificationRow[],
  /** The proposal row the reactor re-reads. */
  proposal: null as Record<string, unknown> | null,
  pushes: [] as Record<string, unknown>[],
};

/**
 * Write latency, in ms. Load-bearing: the duplicate is a RACE — two arms read
 * the idempotency SELECT before either INSERT commits. A fake whose INSERT
 * lands in the same microtask has a zero-width window and cannot reproduce it,
 * which would make this file green against the live defect.
 */
const WRITE_LATENCY_MS = 5;

const fakeDb: any = {
  insert: () => ({
    values: (row: Record<string, unknown>) => ({
      returning: async () => {
        await new Promise((r) => setTimeout(r, WRITE_LATENCY_MS));
        const stored: NotificationRow = {
          id: `notif-${state.notifications.length + 1}`,
          userId: row.userId as string,
          workspaceId: (row.workspaceId ?? null) as string | null,
          type: row.type as string,
          sourceType: row.sourceType as string,
          sourceId: row.sourceId as string | undefined,
        };
        state.notifications.push(stored);
        return [{ id: stored.id }];
      },
    }),
  }),
  query: {
    notificationPreferences: { findFirst: async () => undefined },
    notifications: {
      // The idempotency SELECT inside `notifyPodWideProposal`. Filtering is done
      // here rather than by interpreting the drizzle predicate: the fan-out asks
      // exactly one question — "who already has a proposal.created row for this
      // proposal" — so the fake answers that question over the rows it holds.
      findMany: async () =>
        state.notifications
          .filter(
            (n) =>
              n.sourceType === "proposal" &&
              n.type === "proposal.created" &&
              n.sourceId === state.proposal?.id
          )
          .map((n) => ({ userId: n.userId })),
    },
    proposals: { findFirst: async () => state.proposal },
  },
};

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: fakeDb,
    eventRepository: { append: async () => undefined },
    insertPendingProposal: async (input: Record<string, unknown>) => {
      state.proposal = {
        ...input,
        id: PROPOSAL,
        status: "pending",
        workspaceId: input.workspaceId ?? null,
      };
      return { proposal: state.proposal, deduped: false };
    },
    findExistingPendingDuplicate: async () => null,
    resolveOrCreateAgentProposalSession: async () => null,
    deriveAgentProposalSessionGoal: () => "goal",
    deriveProposalProjectId: async (i: { projectId?: string | null }) =>
      i.projectId ?? null,
  };
});

vi.mock("@synap/jobs", () => ({
  broadcastNotification: vi.fn(async () => {}),
}));

const { podWideProposalNotifyReactor } =
  await import("../../../../notifications/pod-wide-proposal-reactor.js");

vi.mock("@synap/events", () => ({
  emitSideEffects: async (payload: any) => {
    const { podWideProposalNotifyReactor: reactor } =
      await import("../../../../notifications/pod-wide-proposal-reactor.js");
    if (reactor.match?.(payload)) await reactor.handler(payload, {} as never);
  },
  registerReactor: () => {},
}));

vi.mock("../../../../notifications/expo-push.js", () => ({
  sendExpoPush: async (opts: Record<string, unknown>) => {
    state.pushes.push(opts);
  },
}));

vi.mock("../../../../services/capabilities/pod-owner.js", () => ({
  resolvePodAdminUserIds: async () => [HUMAN],
}));

vi.mock("../../../../utils/audit-log.js", () => ({
  auditLog: async () => ({ id: "event-1" }),
}));

vi.mock("../../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => {},
}));

vi.mock("../../../../services/agent-identity-service.js", () => ({
  getAgentFocusProjectId: async () => null,
  resolveAgentIdentity: async () => null,
}));

const { registerProposalsRoutes } = await import("../proposals.js");
const { openLink } = await import("../../../../utils/deep-links.js");

function makeApp() {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set("scopes" as never, ["hub-protocol.write"] as never);
    c.set("userId" as never, HUMAN as never);
    c.set("agentUserId" as never, AGENT as never);
    await next();
  });
  registerProposalsRoutes(app as never);
  return app;
}

const fileGate = (app: OpenAPIHono, workspaceId: string | undefined) =>
  app.request("/proposals/dev-approval", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "dev.plan_approval",
      ...(workspaceId ? { workspaceId } : {}),
      payload: {
        sessionId: SESSION,
        repo: "synap/synap-backend",
        branch: "fix/notifications",
        planMarkdown: "## Plan\nDo the thing.",
        gateCommand: "pnpm --filter @synap/api typecheck",
      },
    }),
  });

/** Let every fire-and-forget arm settle before counting rows. */
const flush = async () => {
  for (let i = 0; i < 10; i++)
    await new Promise((r) => setTimeout(r, WRITE_LATENCY_MS));
};

/**
 * The push's deep link, as the producer mints it: `openLink(id, {client:
 * "mobile"})`. That is the pod's `/open` bounce with the mobile flavour — the
 * one that hands the tap to relay as `synap://open/proposal/<id>` instead of
 * 302-ing to the desktop review page. Asserted through the SAME helper rather
 * than as a literal, because the absolute prefix comes from pod config that is
 * unset in a unit process; the two load-bearing halves (this proposal's id, and
 * the mobile flavour) are pinned below.
 */
const expectedDeepLink = () => openLink(PROPOSAL, { client: "mobile" });

const proposalCreatedRows = () =>
  state.notifications.filter((n) => n.type === "proposal.created");

beforeEach(() => {
  state.notifications = [];
  state.proposal = null;
  state.pushes = [];
});

describe("dev approval notifies exactly one human, exactly once", () => {
  it("has a reactor to race against (non-vacuity)", () => {
    expect(
      podWideProposalNotifyReactor.match?.({
        subjectType: "proposal",
        action: "created",
        subjectId: PROPOSAL,
      } as never)
    ).toBe(true);
  });

  it("WORKSPACE-scoped: one notification, to the HUMAN, with the proposal deep link", async () => {
    const res = await fileGate(makeApp(), WORKSPACE);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: PROPOSAL, status: "pending" });
    await flush();

    const rows = proposalCreatedRows();
    expect(rows).toHaveLength(1);
    // D2a: this was the AGENT principal, so the human was never told.
    expect(rows[0]!.userId).toBe(HUMAN);
    expect(rows[0]!.sourceId).toBe(PROPOSAL);
    expect(rows[0]!.workspaceId).toBe(WORKSPACE);

    expect(state.pushes).toHaveLength(1);
    expect(state.pushes[0]).toMatchObject({
      userId: HUMAN,
      data: { deepLink: expectedDeepLink() },
    });
  });

  it("POD-scoped: one notification, to the HUMAN, with the proposal deep link", async () => {
    const res = await fileGate(makeApp(), undefined);
    expect(res.status).toBe(200);
    await flush();

    const rows = proposalCreatedRows();
    // D2b: two rows, 5 ms apart — the direct arm and the reactor arm both read
    // the idempotency SELECT before either INSERT landed.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(HUMAN);
    expect(rows[0]!.sourceId).toBe(PROPOSAL);
    expect(rows[0]!.workspaceId).toBeNull();

    expect(state.pushes).toHaveLength(1);
    expect(state.pushes[0]).toMatchObject({
      userId: HUMAN,
      data: { deepLink: expectedDeepLink() },
    });
  });
});

describe("the deep link the push carries", () => {
  it("names THIS proposal and the mobile flavour", () => {
    const link = expectedDeepLink();
    expect(link).toContain(`/open/${PROPOSAL}`);
    expect(link).toContain("client=mobile");
  });
});

/**
 * The GENERIC agent door carries the SAME defect as the typed one: `const
 * userId = resolvedAgentUserId ?? c.get("userId")` addressed every proposal it
 * files to the agent that raised it, so a workspace-scoped agent write notified
 * nobody. Its `data.sourceId` must NOT move with the fix — that door's
 * documented principal is the acting one (`proposal-source-id-principal`), so
 * it is derived from `resolvedAgentUserId` explicitly rather than riding a
 * variable that now means the human.
 */
const fileGeneric = (app: OpenAPIHono, workspaceId: string | undefined) =>
  app.request("/proposals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(workspaceId ? { workspaceId } : {}),
      targetType: "entity",
      targetId: SESSION,
      proposalType: "entity.create",
      data: { title: "A thing" },
      summary: "Create a thing",
    }),
  });

describe("the generic POST /proposals door notifies the human, once", () => {
  it("WORKSPACE-scoped: one notification, to the HUMAN", async () => {
    const res = await fileGeneric(makeApp(), WORKSPACE);
    expect(res.status).toBe(200);
    await flush();

    const rows = proposalCreatedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(HUMAN);
    expect(state.pushes).toHaveLength(1);
    expect(state.pushes[0]).toMatchObject({
      userId: HUMAN,
      data: { deepLink: expectedDeepLink() },
    });
  });

  it("POD-scoped: one notification, to the HUMAN", async () => {
    const res = await fileGeneric(makeApp(), undefined);
    expect(res.status).toBe(200);
    await flush();

    const rows = proposalCreatedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(HUMAN);
  });

  it("keeps the ACTING PRINCIPAL on attribution — agentUserId, createdBy, data.sourceId", async () => {
    await fileGeneric(makeApp(), WORKSPACE);
    await flush();

    // The row `insertPendingProposal` was handed: the human is the SUBJECT,
    // the agent is every attribution field. Moving `sourceId` onto the human
    // would silently re-point the agent-class review floor.
    expect(state.proposal).toMatchObject({
      subjectUserId: HUMAN,
      agentUserId: AGENT,
      createdBy: AGENT,
      data: { sourceId: AGENT },
    });
  });
});
