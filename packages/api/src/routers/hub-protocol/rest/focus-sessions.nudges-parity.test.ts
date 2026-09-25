/**
 * Hub REST parity for session NUDGES — driven through the REAL routes.
 *
 * `loadSessionNudges` answered only the MCP `update_session` /
 * `complete_session` doors, so an IS, CLI or Raycast agent on the Hub doors was
 * never told what its session still owed (founder decision 2026-09-25: every
 * door, server-side). This mounts the real `registerFocusSessionsRoutes` and
 * asserts `PATCH /focus-sessions/:id` and `POST /focus-sessions/:id/complete`
 * carry the SAME `nudges` the shared loader computes.
 *
 * Real: both routes (parsing, acting context, reply shaping),
 * `loadSessionNudges`, `computeSessionNudges`, `summarizeEvaluations`.
 * Stubbed, and why: the database (a fake row + a chainable update — the reply
 * shape is under test), governance (applied), `completeFocusSession` (its own
 * suites; it returns the row the loader reads), the evaluation-row READ
 * (re-wired onto the real `summarizeEvaluations` over no rows, so the current-
 * row decision stays the shared one), the realtime bridge (no transport).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HUMAN = "0aaaaaaa-0000-4000-8000-000000000001";
const AGENT = "0ccccccc-0000-4000-8000-000000000003";
const SID = "11111111-2222-4333-8444-555555555555";

const h = vi.hoisted(() => ({ session: {} as Record<string, unknown> }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain = {
    set: () => chain,
    where: () => chain,
    returning: async () => [h.session],
  };
  return {
    ...actual,
    db: {
      query: {
        focusSessions: { findFirst: vi.fn(async () => h.session) },
        workspaces: { findFirst: vi.fn(async () => undefined) },
      },
      update: () => chain,
    },
    getWorkspaceMembership: vi.fn(async () => null),
  };
});
vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../utils/permission-check.js")>();
  return {
    ...actual,
    checkPermissionOrPropose: vi.fn(async () => ({ status: "applied" })),
  };
});
vi.mock("../../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: () => undefined,
}));
vi.mock("../../../services/capture-agent/resolve-capture-actor.js", () => ({
  resolveCaptureActorUserId: async (_c: unknown, ctxAgent?: string) => ctxAgent,
}));
vi.mock(
  "../../../services/focus-sessions/complete-session.js",
  async (orig) => {
    const actual = await orig<Record<string, unknown>>();
    return {
      ...actual,
      completeFocusSession: async () => ({
        session: { ...h.session, status: "closed" },
        pendingProposals: [],
        counts: {
          pending: 0,
          unfinishedOutputs: 0,
          expiredEphemerals: 0,
          retiredSlots: 0,
        },
        warnings: [],
      }),
    };
  }
);
vi.mock(
  "../../../services/focus-sessions/evaluations/record.js",
  async (orig) => {
    const actual = await orig<{
      summarizeEvaluations: (c: unknown, r: unknown[]) => unknown;
    }>();
    return {
      ...actual,
      loadSessionEvaluationSummary: async (s: { criteria: unknown }) =>
        actual.summarizeEvaluations(s.criteria, []),
    };
  }
);

const { registerFocusSessionsRoutes } = await import("./focus-sessions.js");

function makeApp() {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set("userId" as never, HUMAN as never);
    c.set(
      "scopes" as never,
      ["hub-protocol.write", "hub-protocol.read"] as never
    );
    c.set("agentUserId" as never, AGENT as never);
    await next();
  });
  registerFocusSessionsRoutes(app as never);
  return app;
}

const call = (method: string, path: string, body: unknown) =>
  makeApp().request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  h.session = {
    id: SID,
    userId: HUMAN,
    workspaceId: null,
    title: "Ship W5",
    goal: "Ship W5",
    status: "active",
    // Bound: no playbook offer, so the route never reaches the offer stamp.
    playbookId: "pb-bound",
    origin: "playbook",
    currentStage: null,
    stages: [
      { key: "plan", name: "Plan" },
      { key: "ship", name: "Ship" },
    ],
    expectedOutputs: [],
    metadata: {},
    criteria: [
      {
        key: "tsc",
        statement: "Typecheck passes",
        check: { kind: "evidence", evidenceKey: "tsc" },
      },
    ],
  };
});

describe("Hub REST focus-session doors carry nudges (parity with MCP)", () => {
  it("PATCH /focus-sessions/:id answers with the shared nudges", async () => {
    const res = await call("PATCH", `/focus-sessions/${SID}`, {
      progress: 40,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // The applied row is still the reply (additive field, not a new envelope).
    expect(body.id).toBe(SID);
    const nudges = body.nudges as Record<string, unknown> | undefined;
    expect(nudges).toBeDefined();
    expect(nudges!.ungradedCriteria).toEqual(["tsc"]);
    expect(nudges!.stage).toMatchObject({ state: "unset" });
    expect(Array.isArray(nudges!.hints)).toBe(true);
  });

  it("POST /focus-sessions/:id/complete answers with the shared nudges (close never blocked)", async () => {
    const res = await call("POST", `/focus-sessions/${SID}/complete`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("closed");
    const nudges = body.nudges as Record<string, unknown> | undefined;
    expect(nudges).toBeDefined();
    expect(nudges!.ungradedCriteria).toEqual(["tsc"]);
  });

  it("a criteria-less session gets noCriteria, never an empty ungraded list", async () => {
    h.session = {
      ...h.session,
      stages: [],
      criteria: [],
    };
    const res = await call("PATCH", `/focus-sessions/${SID}`, {
      progress: 40,
    });
    const body = (await res.json()) as Record<string, unknown>;
    // noCriteria is itself a nudge — the session can only be announced done.
    const nudges = body.nudges as Record<string, unknown> | undefined;
    expect(nudges?.noCriteria).toBe(true);
    expect(nudges?.ungradedCriteria).toBeUndefined();
  });
});
