/**
 * POST /links `blocked_by` — "floors on the authenticated principal, never a body
 * userId", proven with `resolveActingContext` UNMOCKED.
 *
 * `links.test.ts` stubs the helper to always return the authenticated user, so it
 * could not see that the real helper let ANY bearer key (an agent key included)
 * act as whatever `body.userId` named — the floor then ran as the victim, and a
 * 404-vs-200 difference leaked which sessions the victim owns. Only the database
 * and the services are mocked here; `_shared.ts` is entirely real.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HUMAN = "0aaaaaaa-0000-4000-8000-000000000001";
const VICTIM = "0bbbbbbb-0000-4000-8000-000000000002";
const AGENT = "0ccccccc-0000-4000-8000-000000000003";
const MY_SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VICTIM_SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const VICTIM_OTHER_SESSION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const sessionOwners = new Map<string, string>([
  [MY_SESSION, HUMAN],
  [VICTIM_SESSION, VICTIM],
  [VICTIM_OTHER_SESSION, VICTIM],
]);

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: { query: { workspaces: { findFirst: vi.fn(async () => undefined) } } },
    getWorkspaceMembership: vi.fn(async () => null),
  };
});

vi.mock("../../../services/links/links-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../services/links/links-service.js")
    >();
  return {
    ...actual,
    createLink: vi.fn(async (input: Record<string, unknown>) => ({
      id: "link-1",
      ...input,
    })),
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

vi.mock(
  "../../../services/focus-sessions/session-blocked-by.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../services/focus-sessions/session-blocked-by.js")
      >();
    const floor = (i: {
      sessionId: string;
      blockerSessionId: string;
      userId: string;
    }) =>
      sessionOwners.get(i.sessionId) === i.userId &&
      sessionOwners.get(i.blockerSessionId) === i.userId
        ? ({ ok: true } as const)
        : ({ ok: false, reason: "not_found" } as const);
    return {
      ...actual,
      validateSessionBlocker: vi.fn(async (i: Parameters<typeof floor>[0]) =>
        floor(i)
      ),
      addSessionBlocker: vi.fn(async () => ({ linked: true, inserted: 1 })),
    };
  }
);

const { registerLinksRoutes } = await import("./links.js");
const { validateSessionBlocker, addSessionBlocker } = await import(
  "../../../services/focus-sessions/session-blocked-by.js"
);

const agentKey = {
  userId: HUMAN,
  scopes: ["hub-protocol.write", "hub-protocol.read"],
  apiKeyId: "key-1",
  keyType: "hub_inbound",
  agentUserId: AGENT,
};

function makeApp(vars: Record<string, unknown>) {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    for (const [k, v] of Object.entries(vars)) {
      if (v !== undefined) c.set(k as never, v as never);
    }
    await next();
  });
  registerLinksRoutes(app as never);
  return app;
}

const postLinks = (app: OpenAPIHono, body: Record<string, unknown>) =>
  app.request("/links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.mocked(validateSessionBlocker).mockClear();
  vi.mocked(addSessionBlocker).mockClear();
});

describe("POST /links blocked_by — real resolveActingContext", () => {
  it("an agent key naming a victim in body.userId is refused 403 before the floor runs", async () => {
    const res = await postLinks(makeApp(agentKey), {
      userId: VICTIM,
      fromType: "session",
      fromId: VICTIM_SESSION,
      toType: "session",
      toId: VICTIM_OTHER_SESSION,
      linkType: "blocked_by",
    });

    // Before the fix this was a 200: the floor ran AS the victim, whose two
    // sessions it owns, and the edge was written.
    expect(res.status).toBe(403);
    expect(validateSessionBlocker).not.toHaveBeenCalled();
    expect(addSessionBlocker).not.toHaveBeenCalled();
  });

  it("without a body.userId the floor runs as the authenticated principal", async () => {
    const res = await postLinks(makeApp(agentKey), {
      fromType: "session",
      fromId: VICTIM_SESSION,
      toType: "session",
      toId: VICTIM_OTHER_SESSION,
      linkType: "blocked_by",
    });

    expect(res.status).toBe(404);
    expect(validateSessionBlocker).toHaveBeenCalledWith(
      expect.objectContaining({ userId: HUMAN })
    );
    expect(addSessionBlocker).not.toHaveBeenCalled();
  });
});
