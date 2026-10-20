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

const h = vi.hoisted(() => ({ gated: [] as Array<Record<string, unknown>> }));

vi.mock("../../../utils/permission-check.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  checkPermissionOrPropose: async (p: Record<string, unknown>) => {
    h.gated.push(p);
    return { denied: true, reason: "stop here" };
  },
}));

const { registerFocusSessionsRoutes } = await import("./focus-sessions.js");

function app(): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", USER_ID);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    await next();
  });
  registerFocusSessionsRoutes(a);
  return a;
}

const patch = (body: unknown) =>
  app().request(`/focus-sessions/${SESSION_ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const gateData = () => h.gated.at(-1)!.data as Record<string, unknown>;

describe("Hub PATCH — the goal reaches the membrane only when it changes", () => {
  let findFirstSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.gated = [];
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
