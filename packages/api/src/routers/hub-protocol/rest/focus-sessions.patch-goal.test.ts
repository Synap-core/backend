/**
 * Hub `PATCH /focus-sessions/:id` carries the session's goal to the membrane
 * ONLY when it changes (with the goal it replaces), and names the session by
 * the display-only `sessionName` — the rule `updateFocusSession` applies,
 * through the same `sessionGoalPayload` (`session-update-goal.ts`). Before,
 * every PATCH copied the current goal, which approval then wrote back over any
 * goal changed since. Driven through the real route; the membrane is the
 * observed seam (stubbed to stop there).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { db } from "@synap/database";
import type { HubHono, HubVariables } from "./_shared.js";

const USER_ID = "user-1";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TRACK_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";

const STOP = { denied: true, reason: "stop here" };
const h = vi.hoisted(() => ({
  gated: [] as Array<Record<string, unknown>>,
  respond: (_p: Record<string, unknown>): Record<string, unknown> => ({
    denied: true,
    reason: "stop here",
  }),
}));

vi.mock("../../../utils/permission-check.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  checkPermissionOrPropose: async (p: Record<string, unknown>) => {
    h.gated.push(p);
    return h.respond(p);
  },
}));

// The track resolver reads tracks; the door's split is what is under test, so
// it hands back a resolved filing (its own suites pin the resolution).
vi.mock("../../../services/tracks/session-track-filing.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveSessionTrackFiling: async () => ({
    set: {
      trackId: "22222222-2222-4222-8222-222222222222",
      trackStage: "pitch",
    },
    trackName: "Win the first clients",
    stageName: "Pitch",
    projectName: null,
    projectWorkspaceId: null,
  }),
}));

const { registerFocusSessionsRoutes } = await import("./focus-sessions.js");

/** `keyAgent`: the key IS that agent — the Hub PATCH governs as the key's agent. */
function app(keyAgent?: string): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", USER_ID);
    if (keyAgent) c.set("agentUserId", keyAgent);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    await next();
  });
  registerFocusSessionsRoutes(a);
  return a;
}

const patch = (body: unknown, keyAgent?: string) =>
  app(keyAgent).request(`/focus-sessions/${SESSION_ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const gateData = () => h.gated.at(-1)!.data as Record<string, unknown>;

describe("Hub PATCH — the goal reaches the membrane only when it changes", () => {
  let findFirstSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.gated = [];
    h.respond = () => STOP;
    findFirstSpy = vi
      .spyOn(db.query.focusSessions, "findFirst")
      .mockResolvedValue({
        id: SESSION_ID,
        userId: USER_ID,
        workspaceId: null,
        title: "Shell work",
        goal: "Ship the work shell",
        status: "active",
        criteria: [],
        expectedOutputs: [],
      } as never);
  });
  afterEach(() => findFirstSpy.mockRestore());

  it("a PATCH that does not touch the goal carries none, and names the session", async () => {
    await patch({ progress: 40 });
    expect(h.gated).toHaveLength(1);
    expect(gateData()).not.toHaveProperty("goal");
    expect(gateData()).not.toHaveProperty("previousGoal");
    expect(gateData().sessionName).toBe("Shell work");
    expect(gateData().progress).toBe(40);
  });

  it("an unchanged goal is not a change", async () => {
    await patch({ goal: "Ship the work shell", progress: 40 });
    expect(gateData()).not.toHaveProperty("goal");
  });

  it("a CHANGED goal rides with the goal it replaces", async () => {
    await patch({ goal: "Win the first clients" });
    expect(gateData().goal).toBe("Win the first clients");
    expect(gateData().previousGoal).toBe("Ship the work shell");
  });
});

describe("Hub PATCH — an agent's track filing is its own proposal", () => {
  let findFirstSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.gated = [];
    // A forced filing proposes; the ordinary update stops at the stub.
    h.respond = (p) =>
      p.forcePropose
        ? {
            proposalId: "44444444-4444-4444-8444-444444444444",
            proposalType: "update",
            summary: "File",
          }
        : STOP;
    findFirstSpy = vi
      .spyOn(db.query.focusSessions, "findFirst")
      .mockResolvedValue({
        id: SESSION_ID,
        userId: USER_ID,
        workspaceId: null,
        title: "Shell work",
        goal: "Ship the work shell",
        status: "active",
        agentIds: [AGENT_ID],
        criteria: [],
        expectedOutputs: [],
      } as never);
  });
  afterEach(() => findFirstSpy.mockRestore());

  it("the filing alone is forced; the progress tick takes the ordinary decision", async () => {
    await patch({ trackId: TRACK_ID, progress: 40 }, AGENT_ID);
    expect(h.gated).toHaveLength(2);
    const [filing, rest] = h.gated;
    expect(filing!.forcePropose).toBe(true);
    expect(filing!.data).toMatchObject({
      id: SESSION_ID,
      sessionName: "Shell work",
      trackId: TRACK_ID,
      trackName: "Win the first clients",
    });
    expect(filing!.data).not.toHaveProperty("progress");
    expect(rest!.forcePropose).toBeUndefined();
    expect(rest!.data).toMatchObject({ progress: 40 });
    expect(rest!.data).not.toHaveProperty("trackId");
  });

  it("a filing-only PATCH answers with the filing proposal", async () => {
    const res = await patch({ trackId: TRACK_ID }, AGENT_ID);
    expect(h.gated).toHaveLength(1);
    expect(h.gated[0]!.forcePropose).toBe(true);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "proposed",
      proposalId: "44444444-4444-4444-8444-444444444444",
    });
  });
});
