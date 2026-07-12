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
      },
    },
    eq: vi.fn((_col: unknown, val: unknown) => ({ ids: [val as string] })),
    and: vi.fn((...conds: { ids?: string[] }[]) => ({
      ids: conds.flatMap((c) => c.ids ?? []),
    })),
    isNull: vi.fn(() => ({ ids: [] })),
    getWorkspaceMembership: vi.fn(
      async (_db: unknown, workspaceId: string) =>
        membershipByWsId.get(workspaceId) ?? null
    ),
  };
});

vi.mock("@synap/database/schema", () => ({
  workspaces: { id: "id", archivedAt: "archived_at" },
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

const resolveActingContextMock = vi.fn();

vi.mock("./_shared.js", () => ({
  hasScope: (scopes: string[], required: string) => scopes.includes(required),
  logger: { error: vi.fn(), warn: vi.fn() },
  resolveActingContext: (...args: unknown[]) =>
    resolveActingContextMock(...args),
  resolveActorId: vi.fn(async (_agentUserId: unknown, userId: string) => ({
    actorId: userId,
  })),
}));

// Imports must come AFTER vi.mock (ESM hoisting handles this).
import { OpenAPIHono } from "@hono/zod-openapi";
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
