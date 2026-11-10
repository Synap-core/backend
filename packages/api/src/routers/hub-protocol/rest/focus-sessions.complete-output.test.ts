/**
 * Hub `POST /focus-sessions/:id/outputs/complete` — the claim door an in-pod
 * run (Hub REST is its only door) needs to claim a deliverable it declared.
 * Before it, PATCH refused `completeOutput` and nothing else took it, so every
 * run "finished" with its outputs still owed (run audit 80005d94, 10 Nov 2026).
 *
 * Driven through the real route. The observed seam is `updateFocusSession`
 * (reached through `claimSessionOutput`), the ONE service the MCP door calls
 * (row lock, human-slot floor, evidence verdict, governance): stubbed here,
 * pinned by its own suites.
 *
 * Rows rule out: a claim that never reaches that service (or reaches it with
 * another field, or with a body-supplied actor); a claim on ANOTHER person's
 * session reaching it at all (owner floor); a verdict reported as success when
 * the service refused it or matched nothing; a proposal reported as done.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { db } from "@synap/database";
import type { HubHono, HubVariables } from "./_shared.js";

const USER_ID = "11111111-1111-4111-8111-111111111110";
const OTHER_ID = "11111111-1111-4111-8111-111111111119";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const OWN = "22222222-2222-4222-8222-222222222221";
const FOREIGN = "22222222-2222-4222-8222-222222222229";

const h = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  answer: null as unknown,
  owner: "" as string,
}));

vi.mock("../../../services/focus-sessions/update-session.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  updateFocusSession: async (p: Record<string, unknown>) => {
    h.calls.push(p);
    return h.answer;
  },
}));

const { registerFocusSessionsRoutes } = await import("./focus-sessions.js");

function app(): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", USER_ID);
    c.set("agentUserId", AGENT_ID);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    await next();
  });
  registerFocusSessionsRoutes(a);
  return a;
}

const claim = (sessionId: string, body: unknown) =>
  app().request(`/focus-sessions/${sessionId}/outputs/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const updated = (result: string, message?: string) => ({
  status: "updated",
  session: { id: OWN },
  completeOutput: {
    label: "brief",
    completed: result === "no_match" || result === "refused" ? 0 : 1,
    refusedHumanOwned: result === "refused" ? 1 : 0,
    result,
    ...(message ? { message } : {}),
  },
});

describe("POST /focus-sessions/:id/outputs/complete", () => {
  let findFirstSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.calls = [];
    h.answer = updated("claimed");
    h.owner = USER_ID;
    findFirstSpy = vi
      .spyOn(db.query.focusSessions, "findFirst")
      .mockImplementation((async () => ({
        id: h.owner === OTHER_ID ? FOREIGN : OWN,
        userId: h.owner,
        workspaceId: null,
        status: "active",
        expectedOutputs: [],
      })) as never);
  });
  afterEach(() => findFirstSpy.mockRestore());

  it("claims through the one session service, as the key's agent, never a body actor", async () => {
    const res = await claim(OWN, {
      output: "brief",
      agentUserId: "44444444-4444-4444-8444-444444444444",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      result: "claimed",
      output: "brief",
    });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toEqual({
      sessionId: OWN,
      userId: USER_ID,
      agentUserId: AGENT_ID,
      completeOutput: "brief",
    });
  });

  it("another person's session is 404 and never reaches the service", async () => {
    h.owner = OTHER_ID;
    const res = await claim(FOREIGN, { output: "brief" });
    expect(res.status).toBe(404);
    expect(h.calls).toHaveLength(0);
  });

  it("a refused claim (a person's slot) and no match are not ok", async () => {
    h.answer = updated("refused", "That slot is the person's.");
    let res = await claim(OWN, { output: "approval" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: false,
      result: "refused",
      message: "That slot is the person's.",
    });
    h.answer = updated("no_match");
    res = await claim(OWN, { output: "nothing" });
    expect(await res.json()).toMatchObject({ ok: false, result: "no_match" });
  });

  it("a proposed claim is reported as proposed, never as done", async () => {
    h.answer = {
      status: "proposed",
      proposalId: "55555555-5555-4555-8555-555555555555",
      reviewUrl: "https://pod.example/open/55555555",
    };
    const res = await claim(OWN, { output: "brief" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      status: "proposed",
      proposalId: "55555555-5555-4555-8555-555555555555",
    });
  });

  it("a body without the output is a 400 and claims nothing", async () => {
    const res = await claim(OWN, { completeOutput: "brief" });
    expect(res.status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });
});
