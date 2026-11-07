/**
 * Hub `PATCH /focus-sessions/:id` files a slot list through
 * `fileableExpectedOutputs` before the membrane — the rule `updateFocusSession`
 * applies (finding 68a89ded, proposal a6a39fcd):
 *  - a CHANGED server stamp is refused to the caller (400) and never reaches
 *    the gate, so no proposal exists that only fails when the person approves;
 *  - a ROUND-TRIPPED stamp is dropped. This door's `outcomes` upsert copies
 *    the whole stored list, stamps included; frozen into a proposal they
 *    refused the approval once the slot moved on.
 *
 * Driven through the real route; the membrane is the observed seam (stubbed
 * to stop there), the harness of `focus-sessions.patch-criteria.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { db } from "@synap/database";
import type { HubHono, HubVariables } from "./_shared.js";

const USER_ID = "user-1";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OWED = {
  key: "approve",
  kind: "decision",
  label: "Approve onEnd",
  status: "pending",
  owner: "human",
  blockedReason: "permission",
  why: "Approve it on the proposal page",
  owedSince: "2026-11-06T15:01:52.792Z",
  askedBy: "c340f738-7c2f-494a-ab66-de1c775fef7d",
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

const gatedSlots = () =>
  (h.gated.at(-1)!.data as Record<string, unknown>).expectedOutputs as Array<
    Record<string, unknown>
  >;

describe("Hub PATCH — a slot list is filed without stale stamps", () => {
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
        criteria: [],
        expectedOutputs: [OWED],
      } as never);
  });
  afterEach(() => findFirstSpy.mockRestore());

  it("an outcome-only PATCH files the copied stored slot WITHOUT its stamps", async () => {
    await patch({
      outcomes: [{ key: "summary", label: "Summary", kind: "document" }],
    });
    expect(h.gated).toHaveLength(1);
    const owed = gatedSlots().find((o) => o.key === "approve")!;
    expect(owed).toBeDefined();
    expect(owed).not.toHaveProperty("owedSince");
    expect(owed).not.toHaveProperty("askedBy");
    expect(owed).toMatchObject({ owner: "human", why: OWED.why });
    expect(gatedSlots().map((o) => o.label)).toEqual([
      "Approve onEnd",
      "Summary",
    ]);
  });

  it("a CHANGED stamp is refused with 400 and never reaches the gate", async () => {
    const res = await patch({
      expectedOutputs: [{ ...OWED, owedSince: "2026-11-07T09:00:00.000Z" }],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /"Approve onEnd"\.owedSince — these are server-stamped receipts/
    );
    expect(h.gated).toEqual([]);
  });
});
