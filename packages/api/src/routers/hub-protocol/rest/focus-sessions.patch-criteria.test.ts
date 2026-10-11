/**
 * Hub `PATCH /focus-sessions/:id` carries `criteria` to the membrane only when
 * they DIFFER from the stored list — the rule `updateFocusSession` applies,
 * through the same `criteriaDiffer`.
 *
 * This door has its own `outcomes` merge, which always re-sends the merged
 * criteria: an outcome-only PATCH used to reach the gate carrying `criteria`
 * and was proposed as a CRITERIA_CHANGE for nothing. Driven through the real
 * route; the membrane is the observed seam (stubbed to stop there).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { db } from "@synap/database";
import type { HubHono, HubVariables } from "./_shared.js";

const USER_ID = "user-1";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const C1 = {
  key: "report",
  statement: "A report exists",
  check: { kind: "human" },
};

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

describe("Hub PATCH — criteria reach the membrane only when they change", () => {
  let findFirstSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.gated = [];
    findFirstSpy = vi
      .spyOn(db.query.focusSessions, "findFirst")
      .mockResolvedValue({
        id: SESSION_ID,
        userId: USER_ID,
        workspaceId: null,
        goal: "g",
        status: "active",
        criteria: [C1],
        expectedOutputs: [],
      } as never);
  });
  afterEach(() => findFirstSpy.mockRestore());

  it("an outcome-only PATCH (a new output) carries no criteria", async () => {
    await patch({
      outcomes: [{ key: "summary", label: "Summary", kind: "document" }],
    });
    expect(h.gated).toHaveLength(1);
    expect(gateData().criteria).toBeUndefined();
    expect(gateData().expectedOutputs).toEqual([
      expect.objectContaining({ label: "Summary" }),
    ]);
  });

  it("an unchanged wholesale criteria list is dropped too", async () => {
    await patch({ criteria: [C1], progress: 40 });
    expect(gateData().criteria).toBeUndefined();
    expect(gateData().progress).toBe(40);
  });

  it("a CHANGED criterion still rides to the membrane", async () => {
    const changed = [{ ...C1, statement: "A signed report exists" }];
    await patch({ criteria: changed });
    expect(gateData().criteria).toEqual(changed);
  });
});
