/**
 * `POST /setup/service` driven through the REAL route with a surface key
 * (auth Path 4: any active `hub-protocol.write` key).
 *
 * THE DEFECT: an agent key could mint itself a `service` key, and `service` was
 * a trusted on-behalf-of key type in `mayActAsUser` — so an agent could name any
 * pod user. The override is gone (acting-context.test.ts); these pin the door:
 *   - an AGENT-principal key may not mint at all (attribution laundering);
 *   - a human key may not mint into a workspace its owner is not a member of.
 * The success case is the positive control: without it both refusals could be
 * a route that refuses everything.
 *
 * Mocked: key lookup, key identity, the two db reads, and the mint core. The
 * route's own auth helper and gates run unmodified.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HUMAN = "0aaaaaaa-0000-4000-8000-000000000001";
const AGENT = "0ccccccc-0000-4000-8000-000000000003";
const WS = "0ddddddd-0000-4000-8000-000000000004";

const validateApiKey = vi.fn();
const resolveKeyIdentity = vi.fn();
const findWorkspace = vi.fn();
const findMembership = vi.fn();
const createAndVerifyServiceKey = vi.fn();
const attachFullAccessGrant = vi.fn();
const attachGrantOrRevoke = vi.fn();
const attachGrantsOrRevoke = vi.fn();
const liveGrantsOfKey = vi.fn();
const findUser = vi.fn();

vi.mock("../../../services/api-keys.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../services/api-keys.js")>();
  return {
    ...actual,
    apiKeyService: { ...actual.apiKeyService, validateApiKey },
  };
});

vi.mock("../../../access/key-identity.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../access/key-identity.js")>();
  return { ...actual, resolveKeyIdentity };
});

vi.mock(
  "../../../services/external-registration.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../services/external-registration.js")
      >();
    return { ...actual, createAndVerifyServiceKey };
  }
);

vi.mock("../../../services/key-grant.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../services/key-grant.js")>();
  return {
    ...actual,
    attachFullAccessGrant,
    attachGrantOrRevoke,
    attachGrantsOrRevoke,
    liveGrantsOfKey,
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: {
        workspaces: { findFirst: findWorkspace },
        workspaceMembers: { findFirst: findMembership },
        users: { findFirst: findUser },
      },
    },
  };
});

const { registerSetupRoutes } = await import("./setup.js");

function makeApp() {
  const app = new OpenAPIHono();
  registerSetupRoutes(app as never);
  return app;
}

const mint = (app: OpenAPIHono, extra: Record<string, unknown> = {}) =>
  app.request("/setup/service", {
    method: "POST",
    headers: {
      authorization: "Bearer synap_hub_not_a_jwt",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      workspaceId: WS,
      scopes: ["hub-protocol.write"],
      ...extra,
    }),
  });

const OTHER_WS = "0eeeeeee-0000-4000-8000-000000000005";
const SOON = new Date(Date.now() + 3 * 86_400_000);
const live = (
  permissions: string[],
  more: { workspaceIds?: string[]; expiresAt?: Date | null } = {}
) => ({
  permissions,
  workspaceIds: more.workspaceIds ?? null,
  projectIds: null,
  entityIds: null,
  expiresAt: more.expiresAt ?? null,
});

function asHumanMember() {
  validateApiKey.mockResolvedValue(surfaceKey(HUMAN));
  resolveKeyIdentity.mockResolvedValue({
    effectiveUserId: HUMAN,
    agentUserId: undefined,
    isAgent: false,
  });
  findMembership.mockResolvedValue({ id: "m-1" });
}

function surfaceKey(userId: string) {
  return {
    id: "key-1",
    userId,
    linkedUserId: userId === AGENT ? HUMAN : null,
    isActive: true,
    scope: ["hub-protocol.read", "hub-protocol.write"],
    keyType: userId === AGENT ? "hub_inbound" : "user_pat",
  };
}

beforeEach(() => {
  delete process.env.PROVISIONING_TOKEN;
  for (const m of [
    validateApiKey,
    resolveKeyIdentity,
    findWorkspace,
    findMembership,
    createAndVerifyServiceKey,
    attachFullAccessGrant,
    attachGrantOrRevoke,
    attachGrantsOrRevoke,
    liveGrantsOfKey,
  ])
    m.mockReset();
  liveGrantsOfKey.mockResolvedValue([live(["*"])]);
  findWorkspace.mockResolvedValue({ id: WS });
  createAndVerifyServiceKey.mockResolvedValue({
    outcome: "CONNECTED_VERIFIED",
    apiKey: { id: "svc-1" },
    plainKey: "synap_hub_svc",
  });
});

describe("POST /setup/service — surface-key minting", () => {
  it("an AGENT-principal key → 403, nothing minted", async () => {
    validateApiKey.mockResolvedValue(surfaceKey(AGENT));
    resolveKeyIdentity.mockResolvedValue({
      effectiveUserId: HUMAN,
      agentUserId: AGENT,
      isAgent: true,
    });
    findMembership.mockResolvedValue({ id: "m-1" });

    const res = await mint(makeApp());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("agent key cannot mint"),
    });
    expect(createAndVerifyServiceKey).not.toHaveBeenCalled();
  });

  it("a human key whose owner is NOT a member of the workspace → 403, nothing minted", async () => {
    validateApiKey.mockResolvedValue(surfaceKey(HUMAN));
    resolveKeyIdentity.mockResolvedValue({
      effectiveUserId: HUMAN,
      agentUserId: undefined,
      isAgent: false,
    });
    findMembership.mockResolvedValue(undefined);

    const res = await mint(makeApp());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("is not a member of workspace"),
    });
    expect(createAndVerifyServiceKey).not.toHaveBeenCalled();
  });

  it("positive control: a human member's key mints a key it owns", async () => {
    validateApiKey.mockResolvedValue(surfaceKey(HUMAN));
    resolveKeyIdentity.mockResolvedValue({
      effectiveUserId: HUMAN,
      agentUserId: undefined,
      isAgent: false,
    });
    findMembership.mockResolvedValue({ id: "m-1" });

    const res = await mint(makeApp());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      keyType: "service",
      workspaceId: WS,
    });
    expect(createAndVerifyServiceKey).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: HUMAN, workspaceId: WS }),
      HUMAN,
      HUMAN
    );
    // No grant asked for, KEY caller = a copy of the caller key's own grants
    // in this space — never the owner's whole reach.
    expect(liveGrantsOfKey).toHaveBeenCalledWith("key-1");
    expect(attachGrantsOrRevoke).toHaveBeenCalledWith(
      expect.objectContaining({
        principalUserId: HUMAN,
        onBehalfOf: HUMAN,
        grants: [
          expect.objectContaining({ permissions: ["*"], workspaceIds: [WS] }),
        ],
      })
    );
    expect(attachFullAccessGrant).not.toHaveBeenCalled();
  });
});

describe("POST /setup/service — a key mints only within its own grants", () => {
  it("a key that may touch nothing → 403, nothing minted", async () => {
    asHumanMember();
    liveGrantsOfKey.mockResolvedValue([]);
    const res = await mint(makeApp());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("may touch nothing");
    expect(createAndVerifyServiceKey).not.toHaveBeenCalled();
  });

  it("no grant asked → the NARROW caller's grant is copied, not `*`", async () => {
    asHumanMember();
    liveGrantsOfKey.mockResolvedValue([
      live(["entity.note.read"], { expiresAt: SOON }),
    ]);
    const res = await mint(makeApp());
    expect(res.status).toBe(200);
    expect(attachFullAccessGrant).not.toHaveBeenCalled();
    expect(attachGrantsOrRevoke).toHaveBeenCalledWith(
      expect.objectContaining({
        grants: [
          {
            permissions: ["entity.note.read"],
            workspaceIds: [WS],
            expiresAt: SOON,
          },
        ],
      })
    );
  });

  it("a caller pinned to ANOTHER space → 403", async () => {
    asHumanMember();
    liveGrantsOfKey.mockResolvedValue([
      live(["*"], { workspaceIds: [OTHER_WS] }),
    ]);
    const res = await mint(makeApp());
    expect(res.status).toBe(403);
    expect(createAndVerifyServiceKey).not.toHaveBeenCalled();
  });

  it("a grant WIDER than the caller's → 403, nothing minted", async () => {
    asHumanMember();
    liveGrantsOfKey.mockResolvedValue([live(["entity.note.read"])]);
    const res = await mint(makeApp(), {
      grant: { permissions: ["entity.delete"] },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("reaches beyond");
    expect(createAndVerifyServiceKey).not.toHaveBeenCalled();
  });

  it("a grant inside the caller's is attached, ending no later than it", async () => {
    asHumanMember();
    liveGrantsOfKey.mockResolvedValue([
      live(["entity.read"], { expiresAt: SOON }),
    ]);
    const res = await mint(makeApp(), {
      grant: { permissions: ["entity.note.read"] },
    });
    expect(res.status).toBe(200);
    expect(attachGrantOrRevoke).toHaveBeenCalledWith(
      expect.objectContaining({
        grant: expect.objectContaining({
          permissions: ["entity.note.read"],
          workspaceIds: [WS],
        }),
        expiresAt: SOON,
      })
    );
  });

  it("an operator credential (PROVISIONING_TOKEN) keeps the full-access default", async () => {
    process.env.PROVISIONING_TOKEN = "prov-token";
    findUser.mockResolvedValue({ id: HUMAN, userType: "human" });
    findMembership.mockResolvedValue({ id: "m-1" });
    const app = makeApp();
    const res = await app.request("/setup/service", {
      method: "POST",
      headers: {
        authorization: "Bearer prov-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceId: WS, linkedUserId: HUMAN }),
    });
    expect(res.status).toBe(200);
    expect(liveGrantsOfKey).not.toHaveBeenCalled();
    expect(attachFullAccessGrant).toHaveBeenCalled();
  });
});
