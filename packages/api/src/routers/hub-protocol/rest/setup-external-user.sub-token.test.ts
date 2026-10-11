/**
 * `POST /setup/external-user` (sub-token mode) through the REAL route.
 *
 * THE DEFECT: the child key's grant copied the parent's permissions but not
 * their END — every copied grant was written `expiresAt: null`, so a parent
 * grant meant to lapse in three days lived on forever in each sub-token.
 *
 * Pinned: each copied grant keeps its own end, capped by the child key's; a
 * parent that may touch nothing mints nothing.
 *
 * Mocked: key lookup + mint, the mapping store, the grant read/write helpers,
 * the db. The copy (`scopesWithinLive`) and the route run unmodified.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const PARENT_OWNER = "0aaaaaaa-0000-4000-8000-000000000001";
const EXT_USER = "0bbbbbbb-0000-4000-8000-000000000002";
const WS = "0ddddddd-0000-4000-8000-000000000004";
const SOON = new Date(Date.now() + 3 * 86_400_000);
const SOONER = new Date(Date.now() + 1 * 86_400_000);

const validateApiKey = vi.fn();
const generateApiKey = vi.fn();
const resolveExternalUserMapping = vi.fn();
const lookupExternalUserMapping = vi.fn();
const liveGrantsOfKey = vi.fn();
const attachGrantsOrRevoke = vi.fn();
const findChildKey = vi.fn();

vi.mock("../../../services/api-keys.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../services/api-keys.js")>();
  return {
    ...actual,
    apiKeyService: { ...actual.apiKeyService, validateApiKey, generateApiKey },
  };
});
vi.mock(
  "../../../services/external-user-mapping.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../services/external-user-mapping.js")
    >()),
    isSubTokenFeatureEnabled: () => true,
    resolveExternalUserMapping,
    lookupExternalUserMapping,
  })
);
vi.mock("../../../services/key-grant.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/key-grant.js")>()),
  liveGrantsOfKey,
  attachGrantsOrRevoke,
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: { apiKeys: { findFirst: findChildKey } },
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    },
  };
});

const { registerSetupRoutes } = await import("./setup.js");

function mintSubToken() {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    (c as unknown as { set: (k: string, v: unknown) => void }).set("scopes", [
      "hub-protocol.write",
    ]);
    await next();
  });
  registerSetupRoutes(app as never);
  return app.request("/setup/external-user", {
    method: "POST",
    headers: {
      authorization: "Bearer synap_hub_parent",
      "content-type": "application/json",
    },
    body: JSON.stringify({ externalUserId: "ext-1", mintSubToken: true }),
  });
}

const live = (
  permissions: string[],
  expiresAt: Date | null,
  workspaceIds: string[] | null = null
) => ({
  permissions,
  workspaceIds,
  projectIds: null,
  entityIds: null,
  expiresAt,
});

beforeEach(() => {
  for (const m of [
    validateApiKey,
    generateApiKey,
    resolveExternalUserMapping,
    lookupExternalUserMapping,
    liveGrantsOfKey,
    attachGrantsOrRevoke,
    findChildKey,
  ])
    m.mockReset();
  validateApiKey.mockResolvedValue({
    id: "parent-key",
    userId: PARENT_OWNER,
    isActive: true,
    parentKeyId: null,
    scope: ["hub-protocol.write"],
  });
  resolveExternalUserMapping.mockResolvedValue({
    synapUserId: EXT_USER,
    mappingId: "map-1",
    created: true,
  });
  lookupExternalUserMapping.mockResolvedValue({ childApiKeyId: null });
  generateApiKey.mockResolvedValue({ key: "synap_hub_child", keyId: "child" });
  findChildKey.mockResolvedValue({ expiresAt: null });
});

describe("POST /setup/external-user — a sub-token's grants keep their end", () => {
  it("each copied grant carries its parent grant's own expiry", async () => {
    liveGrantsOfKey.mockResolvedValue([
      live(["entity.read"], SOON, [WS]),
      live(["entity.note.update"], null),
    ]);
    const res = await mintSubToken();
    expect(res.status).toBe(200);
    expect(attachGrantsOrRevoke).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeyId: "child",
        grants: [
          { permissions: ["entity.read"], workspaceIds: [WS], expiresAt: SOON },
          { permissions: ["entity.note.update"], expiresAt: null },
        ],
      })
    );
  });

  it("…capped by the child key's own expiry", async () => {
    findChildKey.mockResolvedValue({ expiresAt: SOONER });
    liveGrantsOfKey.mockResolvedValue([
      live(["entity.read"], SOON),
      live(["entity.note.update"], null),
    ]);
    const res = await mintSubToken();
    expect(res.status).toBe(200);
    const { grants } = attachGrantsOrRevoke.mock.calls[0]![0] as {
      grants: Array<{ expiresAt: Date | null }>;
    };
    expect(grants.map((g) => g.expiresAt)).toEqual([SOONER, SOONER]);
  });

  it("a parent that may touch nothing → 403, nothing minted", async () => {
    liveGrantsOfKey.mockResolvedValue([]);
    const res = await mintSubToken();
    expect(res.status).toBe(403);
    expect(generateApiKey).not.toHaveBeenCalled();
  });
});
