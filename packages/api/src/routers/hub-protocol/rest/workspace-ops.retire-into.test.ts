/**
 * Hub `POST /workspaces/:id/retire-into` — the wire contract `synap templates
 * retire` reads (synap-cli `parseRetireResponse`):
 *
 *   dryRun          → 200 { status: "plan", plan }
 *   agent key       → 202 { status: "proposed", proposalId, reviewUrl, plan }
 *   human           → 200 { status: "applied", plan, archived, remaining, … }
 *   not retired /
 *   no replacement  → 409 { status: "refused", code, lifecycle, message, error }
 *   unreadable      → 503 (a failed read, never "nothing to move")
 *
 * Drives the real route; replaced: the door (records what reached it) and the
 * acting-user lookup.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  answer: null as unknown,
}));

vi.mock("../../../services/workspace-retire-into.js", () => ({
  retireIntoGoverned: vi.fn(async (input: Record<string, unknown>) => {
    h.calls.push(input);
    return h.answer;
  }),
}));

vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveActingContext: vi.fn(async () => ({ ok: true, userId: USER })),
  };
});

const { registerWorkspaceOpsRoutes } = await import("./workspace-ops.js");

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const WS = "33333333-3333-4333-8333-333333333333";

function post(body: unknown, agent = false) {
  const a = new OpenAPIHono();
  a.use("*", async (c, next) => {
    c.set("scopes" as never, ["hub-protocol.write"] as never);
    c.set("userId" as never, USER as never);
    if (agent) c.set("agentUserId" as never, AGENT as never);
    await next();
  });
  registerWorkspaceOpsRoutes(a as never);
  return a.request(`/workspaces/${WS}/retire-into`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const plan = { replacedBy: "ecosystem", moves: [], stays: [] };

beforeEach(() => {
  h.calls.length = 0;
  h.answer = null;
});

describe("POST /workspaces/:id/retire-into", () => {
  it("dryRun → 200 plan, the dryRun flag reaches the door", async () => {
    h.answer = { status: "plan", plan };
    const res = await post({ dryRun: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "plan", plan });
    expect(h.calls[0]).toMatchObject({
      workspaceId: WS,
      userId: USER,
      dryRun: true,
    });
  });

  it("an agent's request is a proposal → 202, agent id forwarded", async () => {
    h.answer = {
      status: "proposed",
      proposalId: "p-1",
      reviewUrl: "https://pod/open/p-1",
      plan,
    };
    const res = await post({}, true);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      status: "proposed",
      proposalId: "p-1",
    });
    expect(h.calls[0]).toMatchObject({ agentUserId: AGENT, dryRun: false });
  });

  it("a refusal is 409 with code + error; an unreadable catalog is 503", async () => {
    h.answer = {
      status: "refused",
      code: "NOT_RETIRED",
      lifecycle: "current",
      message: 'The "radar" template is not retired.',
    };
    const res = await post({});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      status: "refused",
      code: "NOT_RETIRED",
      error: 'The "radar" template is not retired.',
    });

    h.answer = { ...(h.answer as object), code: "TEMPLATE_UNREADABLE" };
    expect((await post({})).status).toBe(503);
  });

  it("a bad body never reaches the door", async () => {
    expect((await post({ dryRun: "yes" })).status).toBe(400);
    expect(h.calls).toEqual([]);
  });
});
