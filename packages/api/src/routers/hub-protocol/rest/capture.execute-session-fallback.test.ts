/**
 * Hub REST — POST /capture/execute files into the caller's run session when the
 * handle arrives on the BODY, not only on `X-Session-Id`.
 *
 * THE GAP (lane B, 2026-09-13): the door read the session only from the
 * verified header. An agent that forwarded `/capture/structure`'s `sessionId`
 * in the body — the natural thing after a degraded salvage — lost it, so the
 * raw note landed outside the run and the rerun door (`replace`) could not
 * replace it.
 *
 * DB-free door test: the REAL route and the REAL `resolveVerifiedSessionId` /
 * `ownsFocusSession` run; only the focus-session row lookup underneath is
 * stubbed, so a body handle the caller does not own is really refused.
 *
 * NOT covered: the session middleware's own header verification (it sets
 * `c.get("sessionId")`, simulated here) and execute's own session handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const USER_ID = "e418d146-0000-4000-8000-000000000001";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const HEADER_SESSION = "aaaaaaaa-0000-4000-8000-00000000000a";
const OWNED_SESSION = "bbbbbbbb-0000-4000-8000-00000000000b";
const FOREIGN_SESSION = "cccccccc-0000-4000-8000-00000000000c";

const executeMock = vi.fn();

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // `ownsFocusSession` selects WHERE id = ? AND userId = ?. The stub `eq`
    // records compared values so the chain can answer for exactly the owned row.
    eq: (_col: unknown, val: unknown) => ({ vals: [val] }),
    and: (...conds: Array<{ vals?: unknown[] }>) => ({
      vals: conds.flatMap((c) => c.vals ?? []),
    }),
    db: {
      select: () => ({
        from: () => ({
          where: (cond: { vals: unknown[] }) => ({
            limit: async () =>
              cond.vals.includes(OWNED_SESSION) && cond.vals.includes(USER_ID)
                ? [{ id: OWNED_SESSION }]
                : [],
          }),
        }),
      }),
    },
  };
});

vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    resolveActingContext: async () => ({
      ok: true,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      role: "editor",
    }),
  };
});

vi.mock("../../../services/capture-agent/resolve-capture-actor.js", () => ({
  resolveCaptureActorUserId: async () => undefined,
}));

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createHubProtocolCallerContext: async (userId: string) => ({ userId }),
  };
});

vi.mock("../../capture.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    captureRouter: {
      createCaller: () => ({
        execute: (...args: unknown[]) => executeMock(...args),
      }),
    },
  };
});

import { OpenAPIHono } from "@hono/zod-openapi";
import { registerCaptureRoutes } from "./capture.js";
import type { HubHono, HubVariables } from "./_shared.js";

function buildApp(headerSession?: string): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", USER_ID);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    // What sessionMiddleware sets after verifying X-Session-Id.
    if (headerSession) c.set("sessionId" as never, headerSession as never);
    await next();
  });
  registerCaptureRoutes(app);
  return app;
}

const execute = (app: HubHono, extra: Record<string, unknown> = {}) =>
  app.request("/capture/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      entities: [{ tempId: "t1", profileSlug: "note", title: "Raw note" }],
      ...extra,
    }),
  });

const forwardedSession = () => executeMock.mock.calls[0][0].sessionId;

beforeEach(() => {
  vi.clearAllMocks();
  executeMock.mockResolvedValue({ created: [] });
});

describe("POST /capture/execute — session handle: header wins, else an OWNED body handle", () => {
  it("a body sessionId the caller owns reaches execute", async () => {
    const res = await execute(buildApp(), { sessionId: OWNED_SESSION });
    expect(res.status).toBe(200);
    expect(forwardedSession()).toBe(OWNED_SESSION);
  });

  it("a body sessionId the caller does NOT own is dropped, not trusted", async () => {
    const res = await execute(buildApp(), { sessionId: FOREIGN_SESSION });
    expect(res.status).toBe(200);
    expect(forwardedSession()).toBeUndefined();
  });

  it("the verified header wins over a body handle", async () => {
    await execute(buildApp(HEADER_SESSION), { sessionId: OWNED_SESSION });
    expect(forwardedSession()).toBe(HEADER_SESSION);
  });

  it("no handle anywhere stays session-less", async () => {
    await execute(buildApp());
    expect(forwardedSession()).toBeUndefined();
  });

  it("a malformed body handle is a 400 from the codec", async () => {
    const res = await execute(buildApp(), { sessionId: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(executeMock).not.toHaveBeenCalled();
  });
});
