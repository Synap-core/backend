/**
 * Hub Protocol REST — POST /links workspace-endpoint membership tests.
 *
 * Wave 4 of WORKSPACE-RESOLUTION-PLAN.md added a security check: when either
 * endpoint of a link is `workspace`, the acting user must ALSO be a member of
 * THAT endpoint workspace (not just the stamped `workspaceId`). Without it, a
 * member of consumer workspace A could wire `provider(B) --feeds--> A` and
 * have the response leak B's existence/name even without belonging to B — an
 * IDOR-shaped gap the same as the one `resolveActingContext` already closes
 * for the stamped workspace.
 *
 * Strategy: isolated Hono app mounting only `registerLinksRoutes`, with
 * `@synap/database` + `_shared.js` + the links-service + permission-check
 * mocked — mirrors the auth.test.ts pattern (avoid pulling in the full
 * hub-protocol-rest orchestrator).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const CONSUMER_WS = "11111111-1111-4111-8111-111111111111";
const PROVIDER_WS = "22222222-2222-4222-8222-222222222222";
const USER_ID = "user-1";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const workspaceRowsById = new Map<string, { id: string } | undefined>();
const membershipByWsId = new Map<string, { role: string } | null>();
// The BLOCKED session's own workspace, keyed by session id — what the
// blocked_by branch stamps on the edge (see the describe block below).
const focusSessionWorkspaceById = new Map<string, string>();
// Projects the caller can see (the `uses` branch loads one on the visibility
// floor before governance).
const visibleProjectIds = new Set<string>();

vi.mock("@synap/database", () => {
  return {
    db: {
      query: {
        workspaces: {
          findFirst: vi.fn(async ({ where }: { where: unknown }) => {
            // The route ANDs `eq(workspaces.id, endpointWorkspaceId)` with
            // `isNull(workspaces.archivedAt)` — our stub `eq`/`isNull`
            // encode the compared id in the returned condition object so we
            // can read it back here without a real SQL engine.
            const cond = where as { ids?: string[] };
            const id = cond.ids?.[0];
            return id ? workspaceRowsById.get(id) : undefined;
          }),
        },
        projects: {
          findFirst: vi.fn(async ({ where }: { where: unknown }) => {
            const cond = where as { ids?: string[] };
            const id = cond.ids?.[0];
            return id && visibleProjectIds.has(id) ? { id } : undefined;
          }),
        },
        focusSessions: {
          // The route ANDs `eq(focusSessions.id, fromId)` with
          // `eq(focusSessions.userId, userId)` — same `ids` encoding, so
          // `ids[0]` is the session id being looked up.
          findFirst: vi.fn(async ({ where }: { where: unknown }) => {
            const cond = where as { ids?: string[] };
            const sessionId = cond.ids?.[0];
            const workspaceId = sessionId
              ? focusSessionWorkspaceById.get(sessionId)
              : undefined;
            return workspaceId !== undefined ? { workspaceId } : undefined;
          }),
        },
      },
    },
    eq: vi.fn((_col: unknown, val: unknown) => ({ ids: [val as string] })),
    and: vi.fn((...conds: { ids?: string[] }[]) => ({
      ids: conds.flatMap((c) => c.ids ?? []),
    })),
    isNull: vi.fn(() => ({ ids: [] })),
    ownerPrivateVisibleWhere: vi.fn(() => ({ ids: [] })),
    getWorkspaceMembership: vi.fn(
      async (_db: unknown, workspaceId: string) =>
        membershipByWsId.get(workspaceId) ?? null
    ),
    focusSessions: { id: "id", userId: "user_id", workspaceId: "workspace_id" },
  };
});

vi.mock("@synap/database/schema", () => ({
  workspaces: { id: "id", archivedAt: "archived_at" },
  projects: { id: "id", workspaceId: "workspace_id", userId: "user_id" },
}));

vi.mock("../../../services/links/links-service.js", () => ({
  createLink: vi.fn(async (input: Record<string, unknown>) => ({
    id: "link-1",
    ...input,
  })),
  getLinksFor: vi.fn(async () => []),
}));

vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async () => ({ status: "applied" })),
}));

// Session owner per id — drives the floor below. The floor's SQL is the
// service's own; this file tests that the HANDLER consults it, before
// governance, and applies through the dedicated producer.
const sessionOwners = new Map<string, string>();
// Edges the producer reports as already existing (`inserted: 0`) — keyed
// `${sessionId}::${blockerSessionId}`. Absent ⇒ a fresh insert (`inserted: 1`).
const existingEdges = new Set<string>();

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
      i.sessionId === i.blockerSessionId
        ? ({ ok: false, reason: "self_blocker" } as const)
        : sessionOwners.get(i.sessionId) === i.userId &&
            sessionOwners.get(i.blockerSessionId) === i.userId
          ? ({
              ok: true,
              workspaceId: focusSessionWorkspaceById.get(i.sessionId) ?? null,
            } as const)
          : ({ ok: false, reason: "not_found" } as const);
    return {
      ...actual,
      validateSessionBlocker: vi.fn(async (i: Parameters<typeof floor>[0]) =>
        floor(i)
      ),
      addSessionBlocker: vi.fn(async (i: Parameters<typeof floor>[0]) => {
        const v = floor(i);
        if (!v.ok) return { linked: false, reason: v.reason };
        const key = `${i.sessionId}::${i.blockerSessionId}`;
        return { linked: true, inserted: existingEdges.has(key) ? 0 : 1 };
      }),
    };
  }
);

const resolveActingContextMock = vi.fn();

vi.mock("./_shared.js", () => ({
  hasScope: (scopes: string[], required: string) => scopes.includes(required),
  logger: { error: vi.fn(), warn: vi.fn() },
  resolveActingContext: (...args: unknown[]) =>
    resolveActingContextMock(...args),
  // Mirrors the real resolver's shape: an agentUserId, when supplied,
  // resolves to itself as the actor; otherwise the actor IS the human.
  resolveActorId: vi.fn(
    async (agentUserId: string | undefined, userId: string) => ({
      actorId: agentUserId ?? userId,
    })
  ),
}));

// Imports must come AFTER vi.mock (ESM hoisting handles this).
import { OpenAPIHono } from "@hono/zod-openapi";
import { checkPermissionOrPropose } from "../../../utils/permission-check.js";
import { registerLinksRoutes } from "./links.js";
import type { HubHono, HubVariables } from "./_shared.js";

function buildTestApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", USER_ID);
    c.set("scopes", ["hub-protocol.write", "hub-protocol.read"]);
    await next();
  });
  registerLinksRoutes(app);
  return app;
}

async function postLinks(app: HubHono, body: Record<string, unknown>) {
  return app.request("/links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /links — workspace-endpoint membership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceRowsById.clear();
    membershipByWsId.clear();
    resolveActingContextMock.mockResolvedValue({
      ok: true,
      userId: USER_ID,
      workspaceId: CONSUMER_WS,
      role: "editor",
    });
  });

  it("rejects a feeds edge when the caller is a member of the consumer but not the provider workspace", async () => {
    workspaceRowsById.set(CONSUMER_WS, { id: CONSUMER_WS });
    workspaceRowsById.set(PROVIDER_WS, { id: PROVIDER_WS });
    membershipByWsId.set(CONSUMER_WS, { role: "editor" });
    membershipByWsId.set(PROVIDER_WS, null); // NOT a member of the provider

    const app = buildTestApp();
    const res = await postLinks(app, {
      workspaceId: CONSUMER_WS,
      fromType: "workspace",
      fromId: PROVIDER_WS,
      toType: "workspace",
      toId: CONSUMER_WS,
      linkType: "feeds",
    });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toMatch(new RegExp(PROVIDER_WS));
  });

  it("creates a feeds edge when the caller is a member of BOTH workspaces", async () => {
    workspaceRowsById.set(CONSUMER_WS, { id: CONSUMER_WS });
    workspaceRowsById.set(PROVIDER_WS, { id: PROVIDER_WS });
    membershipByWsId.set(CONSUMER_WS, { role: "editor" });
    membershipByWsId.set(PROVIDER_WS, { role: "viewer" });

    const app = buildTestApp();
    const res = await postLinks(app, {
      workspaceId: CONSUMER_WS,
      fromType: "workspace",
      fromId: PROVIDER_WS,
      toType: "workspace",
      toId: CONSUMER_WS,
      linkType: "feeds",
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("created");
  });

  it("rejects when the provider workspace is archived", async () => {
    workspaceRowsById.set(CONSUMER_WS, { id: CONSUMER_WS });
    // Archived provider never lands in workspaceRowsById because the mocked
    // findFirst only returns rows that pass the isNull(archivedAt) AND — a
    // real archived row would be filtered by the DB predicate.
    membershipByWsId.set(CONSUMER_WS, { role: "editor" });
    membershipByWsId.set(PROVIDER_WS, { role: "viewer" });

    const app = buildTestApp();
    const res = await postLinks(app, {
      workspaceId: CONSUMER_WS,
      fromType: "workspace",
      fromId: PROVIDER_WS,
      toType: "workspace",
      toId: CONSUMER_WS,
      linkType: "feeds",
    });

    expect(res.status).toBe(403);
  });

  it("does not membership-check a non-workspace edge beyond the stamped workspace", async () => {
    const app = buildTestApp();
    const res = await postLinks(app, {
      workspaceId: CONSUMER_WS,
      fromType: "entity",
      fromId: "entity-1",
      toType: "tool",
      toId: "tool-1",
      linkType: "about",
    });

    expect(res.status).toBe(200);
  });
});

describe("document endpoints — read here, never written here", () => {
  const DOCUMENT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  beforeEach(() => {
    vi.clearAllMocks();
    resolveActingContextMock.mockResolvedValue({
      ok: true,
      userId: USER_ID,
      workspaceId: CONSUMER_WS,
      role: "editor",
    });
  });

  it.each([
    [
      "from",
      {
        fromType: "document",
        fromId: DOCUMENT_ID,
        toType: "entity",
        toId: "entity-1",
      },
    ],
    [
      "to",
      {
        fromType: "entity",
        fromId: "entity-1",
        toType: "document",
        toId: DOCUMENT_ID,
      },
    ],
  ])(
    "refuses a %s-document edge with 400, before governance, writing nothing",
    async (_end, endpoints) => {
      const { createLink } =
        await import("../../../services/links/links-service.js");
      const { checkPermissionOrPropose } =
        await import("../../../utils/permission-check.js");
      const res = await postLinks(buildTestApp(), {
        workspaceId: CONSUMER_WS,
        linkType: "produced",
        ...endpoints,
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/document links/);
      expect(checkPermissionOrPropose).not.toHaveBeenCalled();
      expect(createLink).not.toHaveBeenCalled();
    }
  );

  it("still reads a document's links", async () => {
    const res = await buildTestApp().request(
      `/links?type=document&id=${DOCUMENT_ID}`
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ links: [] });
  });
});

describe("POST /links — blocked_by goes through the session blocker floor", () => {
  const MY_SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const MY_OTHER_SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const VICTIM_SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  // The blocked session's OWN workspace — deliberately different from the
  // request-stamped CONSUMER_WS, so a test asserting the wrong one fails.
  const SESSION_WS = "33333333-3333-4333-8333-333333333333";

  beforeEach(() => {
    vi.clearAllMocks();
    sessionOwners.clear();
    existingEdges.clear();
    focusSessionWorkspaceById.clear();
    sessionOwners.set(MY_SESSION, USER_ID);
    sessionOwners.set(MY_OTHER_SESSION, USER_ID);
    sessionOwners.set(VICTIM_SESSION, "victim-user");
    focusSessionWorkspaceById.set(MY_SESSION, SESSION_WS);
    resolveActingContextMock.mockResolvedValue({
      ok: true,
      userId: USER_ID,
      workspaceId: CONSUMER_WS,
      role: "editor",
    });
  });

  async function writeCalls() {
    const { createLink } =
      await import("../../../services/links/links-service.js");
    const { addSessionBlocker } =
      await import("../../../services/focus-sessions/session-blocked-by.js");
    const { checkPermissionOrPropose } =
      await import("../../../utils/permission-check.js");
    return {
      createLink: vi.mocked(createLink),
      addSessionBlocker: vi.mocked(addSessionBlocker),
      checkPermissionOrPropose: vi.mocked(checkPermissionOrPropose),
    };
  }

  it("refuses a cross-owner edge with 404, before governance, writing nothing", async () => {
    const res = await postLinks(buildTestApp(), {
      workspaceId: CONSUMER_WS,
      fromType: "session",
      fromId: MY_SESSION,
      toType: "session",
      toId: VICTIM_SESSION,
      linkType: "blocked_by",
    });

    expect(res.status).toBe(404);
    const calls = await writeCalls();
    expect(calls.checkPermissionOrPropose).not.toHaveBeenCalled();
    expect(calls.createLink).not.toHaveBeenCalled();
    expect(calls.addSessionBlocker).not.toHaveBeenCalled();
  });

  it("refuses a self-edge with 400", async () => {
    const res = await postLinks(buildTestApp(), {
      fromType: "session",
      fromId: MY_SESSION,
      toType: "session",
      toId: MY_SESSION,
      linkType: "blocked_by",
    });

    expect(res.status).toBe(400);
    const calls = await writeCalls();
    expect(calls.checkPermissionOrPropose).not.toHaveBeenCalled();
    expect(calls.createLink).not.toHaveBeenCalled();
  });

  it("refuses a non-session endpoint with 400", async () => {
    const res = await postLinks(buildTestApp(), {
      fromType: "entity",
      fromId: "entity-1",
      toType: "session",
      toId: MY_SESSION,
      linkType: "blocked_by",
    });

    expect(res.status).toBe(400);
    const calls = await writeCalls();
    expect(calls.checkPermissionOrPropose).not.toHaveBeenCalled();
    expect(calls.createLink).not.toHaveBeenCalled();
  });

  it("applies a same-owner edge through addSessionBlocker (from = blocked, to = blocker), governed and stamped with the BLOCKED session's own workspace, never raw createLink", async () => {
    const res = await postLinks(buildTestApp(), {
      workspaceId: CONSUMER_WS,
      fromType: "session",
      fromId: MY_SESSION,
      toType: "session",
      toId: MY_OTHER_SESSION,
      linkType: "blocked_by",
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      status: "created",
      link: null,
      blockedBy: { inserted: 1 },
    });
    const calls = await writeCalls();
    // Governance is judged in SESSION_WS (the blocked session's own
    // workspace), NOT CONSUMER_WS (the request-stamped workspace) — so a
    // filed proposal's workspaceId always matches the edge it would create.
    expect(calls.checkPermissionOrPropose).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: SESSION_WS })
    );
    // `addSessionBlocker` derives the edge's workspace itself; the caller
    // never passes one.
    expect(calls.addSessionBlocker).toHaveBeenCalledWith({
      sessionId: MY_SESSION,
      blockerSessionId: MY_OTHER_SESSION,
      userId: USER_ID,
    });
    expect(calls.createLink).not.toHaveBeenCalled();
  });

  it("reports an already-existing edge with inserted: 0", async () => {
    existingEdges.add(`${MY_SESSION}::${MY_OTHER_SESSION}`);

    const res = await postLinks(buildTestApp(), {
      workspaceId: CONSUMER_WS,
      fromType: "session",
      fromId: MY_SESSION,
      toType: "session",
      toId: MY_OTHER_SESSION,
      linkType: "blocked_by",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "created",
      link: null,
      blockedBy: { inserted: 0 },
    });
  });

  it("refuses metadata sent with blocked_by, before governance, writing nothing", async () => {
    const res = await postLinks(buildTestApp(), {
      workspaceId: CONSUMER_WS,
      fromType: "session",
      fromId: MY_SESSION,
      toType: "session",
      toId: MY_OTHER_SESSION,
      linkType: "blocked_by",
      metadata: { note: "should be refused" },
    });

    expect(res.status).toBe(400);
    const calls = await writeCalls();
    expect(calls.checkPermissionOrPropose).not.toHaveBeenCalled();
    expect(calls.addSessionBlocker).not.toHaveBeenCalled();
    expect(calls.createLink).not.toHaveBeenCalled();
  });

  it("governs an agent-attributed blocked_by with userId = the human and agentUserId = the agent, never the agent as userId", async () => {
    const AGENT_USER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    const res = await postLinks(buildTestApp(), {
      workspaceId: CONSUMER_WS,
      fromType: "session",
      fromId: MY_SESSION,
      toType: "session",
      toId: MY_OTHER_SESSION,
      linkType: "blocked_by",
      agentUserId: AGENT_USER_ID,
    });

    expect(res.status).toBe(200);
    const calls = await writeCalls();
    expect(calls.checkPermissionOrPropose).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        agentUserId: AGENT_USER_ID,
      })
    );
    // The producer's ownership floor must ALSO stay on the human, not the agent.
    expect(calls.addSessionBlocker).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID })
    );
  });

  it("falls back to the key's bound agentUserId when the body omits it, mirroring runs.ts", async () => {
    const KEY_AGENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
    app.use("/*", async (c, next) => {
      c.set("userId", USER_ID);
      c.set("scopes", ["hub-protocol.write", "hub-protocol.read"]);
      c.set("agentUserId", KEY_AGENT_ID);
      await next();
    });
    registerLinksRoutes(app);

    const res = await postLinks(app, {
      workspaceId: CONSUMER_WS,
      fromType: "session",
      fromId: MY_SESSION,
      toType: "session",
      toId: MY_OTHER_SESSION,
      linkType: "blocked_by",
      // agentUserId deliberately absent from the body.
    });

    expect(res.status).toBe(200);
    const calls = await writeCalls();
    expect(calls.checkPermissionOrPropose).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        agentUserId: KEY_AGENT_ID,
      })
    );
  });

  it("floors on the authenticated principal, not a caller-supplied userId", async () => {
    const res = await postLinks(buildTestApp(), {
      userId: "victim-user",
      fromType: "session",
      fromId: VICTIM_SESSION,
      toType: "session",
      toId: MY_SESSION,
      linkType: "blocked_by",
    });

    // resolveActingContext binds USER_ID; the body's userId must not reach the floor.
    expect(res.status).toBe(404);
    const calls = await writeCalls();
    expect(calls.addSessionBlocker).not.toHaveBeenCalled();
  });
});

describe("POST /links — project --uses--> workspace", () => {
  const PROJECT = "33333333-3333-4333-8333-333333333333";

  beforeEach(() => {
    vi.clearAllMocks();
    workspaceRowsById.clear();
    membershipByWsId.clear();
    visibleProjectIds.clear();
    workspaceRowsById.set(CONSUMER_WS, { id: CONSUMER_WS });
    membershipByWsId.set(CONSUMER_WS, { role: "editor" });
    resolveActingContextMock.mockResolvedValue({
      ok: true,
      userId: USER_ID,
      workspaceId: CONSUMER_WS,
      role: "editor",
    });
  });

  const usesBody = {
    workspaceId: CONSUMER_WS,
    fromType: "project",
    fromId: PROJECT,
    toType: "workspace",
    toId: CONSUMER_WS,
    linkType: "uses",
  };

  it("404s a project the caller cannot see, before governance", async () => {
    const res = await postLinks(buildTestApp(), usesBody);
    expect(res.status).toBe(404);
    expect(checkPermissionOrPropose).not.toHaveBeenCalled();
  });

  it("forwards reasoning to the gate and returns the review link when it proposes", async () => {
    visibleProjectIds.add(PROJECT);
    vi.mocked(checkPermissionOrPropose).mockResolvedValueOnce({
      granted: false,
      proposalId: "prop-uses",
      reviewPath: "/open/prop-uses",
      reviewUrl: "https://pod.example/open/prop-uses",
    } as never);
    const res = await postLinks(buildTestApp(), {
      ...usesBody,
      reasoning: "Architech runs through Operations",
    });
    expect(await res.json()).toEqual({
      status: "proposed",
      proposalId: "prop-uses",
      reviewPath: "/open/prop-uses",
      reviewUrl: "https://pod.example/open/prop-uses",
    });
    expect(
      vi.mocked(checkPermissionOrPropose).mock.calls[0]?.[0]
    ).toMatchObject({
      reasoning: "Architech runs through Operations",
    });
  });
});
