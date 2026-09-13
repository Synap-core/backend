/**
 * Hub REST — POST /capture/structure carries the AGENT into the caller context.
 *
 * THE INCIDENT (deployed pod, 2026-09-13): an agent-key `/capture/structure`
 * minted its run room with `origin:"human"`. `capture.structure` records the
 * room from `ctx.agentUserId` (`agentUserId ? "agent" : "human"`, pinned on real
 * Postgres in `intake-run.pglite.test.ts`), but this door built the caller
 * context WITHOUT the agent id — so the rule never saw one.
 *
 * DB-free door test (same harness as capture.enqueue-corpus.test.ts): the REAL
 * route handler runs; the caller-context factory is spied so the test reads
 * the context the procedure actually receives.
 *
 * NOT covered: the procedure's own recording (the pglite suite owns it).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const USER_ID = "e418d146-0000-4000-8000-000000000001";
const AGENT_ID = "0e0403a8-0000-4000-8000-000000000002";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

const resolveActingContextMock = vi.fn();
const receivedCtx: Array<Record<string, unknown>> = [];

vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    resolveActingContext: (...args: unknown[]) =>
      resolveActingContextMock(...args),
  };
});

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Real positional contract, no DB: build the same fields the real factory
    // derives from its arguments.
    createHubProtocolCallerContext: async (
      userId: string,
      scopes: string[],
      workspaceId?: string | null,
      sourceMessageId?: string | null,
      sessionId?: string | null,
      agentUserId?: string | null
    ) => ({
      userId,
      scopes,
      workspaceId: workspaceId ?? null,
      sourceMessageId: sourceMessageId ?? null,
      sessionId: sessionId ?? null,
      agentUserId: agentUserId ?? null,
    }),
  };
});

vi.mock("../../capture.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    captureRouter: {
      createCaller: (ctx: Record<string, unknown>) => {
        receivedCtx.push(ctx);
        return {
          structure: async () => ({
            proposals: [],
            relations: [],
            followUp: "Which Alice?",
          }),
        };
      },
    },
  };
});

import { OpenAPIHono } from "@hono/zod-openapi";
import { registerCaptureRoutes } from "./capture.js";
import type { HubHono, HubVariables } from "./_shared.js";

function buildApp(agentUserId?: string): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", USER_ID);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    if (agentUserId)
      (c as unknown as { set: (k: string, v: unknown) => void }).set(
        "agentUserId",
        agentUserId
      );
    await next();
  });
  registerCaptureRoutes(app);
  return app;
}

async function post(app: HubHono) {
  return app.request("/capture/structure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: "Lunch with Alice",
      workspaceId: WORKSPACE_ID,
    }),
  });
}

beforeEach(() => {
  receivedCtx.length = 0;
  resolveActingContextMock.mockResolvedValue({
    ok: true,
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    role: "editor",
  });
});

describe("POST /capture/structure — the caller context names the acting agent", () => {
  it("an AGENT key reaches capture.structure with ctx.agentUserId set", async () => {
    const res = await post(buildApp(AGENT_ID));
    expect(res.status).toBe(200);
    expect(receivedCtx).toHaveLength(1);
    expect(receivedCtx[0]!.agentUserId).toBe(AGENT_ID);
    expect(receivedCtx[0]!.userId).toBe(USER_ID);
  });

  it("NON-VACUOUS: a human key reaches it with no agent", async () => {
    const res = await post(buildApp());
    expect(res.status).toBe(200);
    expect(receivedCtx).toHaveLength(1);
    expect(receivedCtx[0]!.agentUserId).toBeNull();
  });
});
