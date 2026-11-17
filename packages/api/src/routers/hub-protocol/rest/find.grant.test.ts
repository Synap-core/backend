/**
 * GET /api/hub/find through the REAL hub auth door and door fence: the Hub REST door of the ONE find service.
 *
 * THE GAP THESE PIN: `findForCaller` (MCP `synap_find`, tRPC `knowledge.find`) had no Hub REST door, so Raycast and
 * pod apps on Hub keys could not find a skill, view, session or playbook by its words. The route is a thin adapter:
 * it hands the query to `findForCaller` and returns its answer as is.
 *
 * Asserted: a scoped key the `synap_find` declaration admits (an unpinned scope reading tool, command, playbook and
 * automation) gets the service's typed rows, with its query, lens, catalogs and limit passed through and the acting
 * person as the reader; a scoped key without those reads, and one pinned to a space, are refused by the fence
 * (GRANT_DOOR_UNSUPPORTED) before the service runs; a find that throws answers an error status, never an empty list;
 * a space the caller cannot read is a 403; an unknown catalog is a 400. The service is mocked (its own floors are
 * pinned by `services/capabilities/__tests__/find-objects*.test.ts`); the fence and the route are real.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getApiKeyStatus, grant, findForCaller } = vi.hoisted(() => ({
  getApiKeyStatus: vi.fn(),
  grant: { rows: [] as Array<Record<string, unknown>> },
  findForCaller: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: {
        users: { findFirst: async () => ({ id: "u", userType: "agent" }) },
      },
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: async () => grant.rows }),
        }),
      }),
    },
  };
});
vi.mock("../../../access/guest-containment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGuestPrincipal: vi.fn(async () => false),
}));
vi.mock("../../../services/api-keys.js", () => ({
  apiKeyService: {
    getApiKeyStatus: (...a: unknown[]) => getApiKeyStatus(...a),
    recordKeyUse: vi.fn(),
    checkRateLimit: () => true,
  },
}));
vi.mock("../../../services/external-user-mapping.js", () => ({
  isSubTokenFeatureEnabled: () => false,
  resolveExternalUserMapping: vi.fn(),
}));
vi.mock(
  "../../../services/capabilities/find-intent.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    findForCaller: (...a: unknown[]) => findForCaller(...a),
  })
);

const { hubAuthMiddleware } = await import("../_middleware/auth.js");
const { registerFindRoutes } = await import("./find.js");
import type { HubHono, HubVariables } from "./_shared.js";

const WS = "11111111-1111-4111-8111-111111111111";

const grantRow = (over: Record<string, unknown>) => ({
  id: "g1",
  permissions: ["*"],
  workspaceIds: null,
  projectIds: null,
  entityIds: null,
  expiresAt: null,
  revokedAt: null,
  clientId: "raycast",
  ...over,
});
/** What the `synap_find` declaration reads (FIND, grant-door-fence.ts), unpinned. */
const FIND_READER = grantRow({
  permissions: [
    "tool.read",
    "command.read",
    "playbook.read",
    "automation.read",
  ],
});
/** A scoped key that reads entities only. */
const ENTITY_READER = grantRow({ permissions: ["entity.*.read"] });
/** A pod app: the same reads, pinned to one space. */
const PINNED_APP = grantRow({
  permissions: [
    "tool.read",
    "command.read",
    "playbook.read",
    "automation.read",
  ],
  workspaceIds: [WS],
  clientId: "app_crm",
});

/**
 * An unbounded key: the fence lets it through, so the tests of what the ROUTE
 * answers (a failed find, a forbidden space, a bad query) do not depend on
 * the fence declaration the first tests pin.
 */
const UNBOUNDED = grantRow({ clientId: null });

/** A typed row as `searchObjectCatalogs` shapes it. */
const VIEW_ROW = {
  kind: "view",
  id: "22222222-2222-4222-8222-222222222222",
  title: "Pipeline board",
  why: "Deals by stage",
  open: "/open/22222222-2222-4222-8222-222222222222",
  workspaceId: WS,
  score: 3,
  confidence: 1,
  match: { terms: ["pipeline"], fields: ["title"] },
  termCoverage: { hit: 1, of: 1 },
};
const RESULT = {
  intent: "pipeline board",
  lens: { workspaceId: WS },
  scoring: {},
  coverage: { capabilityRows: 0 },
  views: { matches: [VIEW_ROW] },
  documents: { error: "documents read failed" },
};

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerFindRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

function asKey(row: Record<string, unknown>) {
  grant.rows = [row];
  getApiKeyStatus.mockResolvedValue({
    status: "valid",
    record: {
      id: "key-1",
      userId: "agent-principal",
      linkedUserId: "pod-owner-human",
      parentKeyId: null,
      scope: ["hub-protocol.read", "hub-protocol.write"],
      keyType: "hub_inbound",
      workspaceId: null,
      expiresAt: null,
    },
  });
}

const get = (qs: string) =>
  app().request(`/api/hub/find?${qs}`, {
    headers: { authorization: "Bearer synap_test" },
  });

beforeEach(() => vi.clearAllMocks());

describe("GET /find", () => {
  it("a key the find declaration admits gets the service's typed rows, its query passed through", async () => {
    asKey(FIND_READER);
    findForCaller.mockResolvedValue({ ok: true, result: RESULT });
    const res = await get(
      `query=${encodeURIComponent("pipeline board")}&workspaceId=${WS}&catalogs=views,documents&limit=3`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(RESULT);
    // A failed catalog stays an `error` block, never rewritten as matches: [].
    expect(body.documents).toEqual({ error: "documents read failed" });
    expect(body.views.matches[0].open).toBe(VIEW_ROW.open);
    expect(findForCaller).toHaveBeenCalledTimes(1);
    expect(findForCaller.mock.calls[0][0]).toMatchObject({
      intent: "pipeline board",
      workspaceId: WS,
      userId: "pod-owner-human",
      catalogs: ["views", "documents"],
      limit: 3,
    });
  });

  it("a scoped key without the find reads is refused by the fence, before the service runs", async () => {
    asKey(ENTITY_READER);
    const res = await get("query=pipeline");
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("GRANT_DOOR_UNSUPPORTED");
    expect(findForCaller).not.toHaveBeenCalled();
  });

  it("a key pinned to a space is refused, as on synap_find", async () => {
    asKey(PINNED_APP);
    const res = await get("query=pipeline");
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("GRANT_DOOR_UNSUPPORTED");
    expect(findForCaller).not.toHaveBeenCalled();
  });

  it("a find that fails answers an error status, never an empty list", async () => {
    asKey(UNBOUNDED);
    findForCaller.mockRejectedValue(new Error("capability registry down"));
    const res = await get("query=pipeline");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("capability registry down");
    expect(body).not.toHaveProperty("views");
  });

  it("a space the caller cannot read is a 403", async () => {
    asKey(UNBOUNDED);
    findForCaller.mockResolvedValue({ ok: false, forbidden: WS });
    const res = await get(`query=pipeline&workspaceId=${WS}`);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain(WS);
  });

  it("an unknown catalog or a missing query is a 400", async () => {
    asKey(UNBOUNDED);
    expect((await get("query=pipeline&catalogs=views,nonsense")).status).toBe(
      400
    );
    expect((await get("query=")).status).toBe(400);
    expect(findForCaller).not.toHaveBeenCalled();
  });

  it("CONTROL: an unbounded key passes", async () => {
    asKey(UNBOUNDED);
    findForCaller.mockResolvedValue({ ok: true, result: RESULT });
    expect((await get("query=pipeline")).status).toBe(200);
  });
});
