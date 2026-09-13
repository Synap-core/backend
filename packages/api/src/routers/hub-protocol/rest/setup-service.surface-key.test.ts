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

vi.mock("../../../services/external-registration.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../services/external-registration.js")
    >();
  return { ...actual, createAndVerifyServiceKey };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: {
        workspaces: { findFirst: findWorkspace },
        workspaceMembers: { findFirst: findMembership },
        users: { findFirst: vi.fn() },
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

const mint = (app: OpenAPIHono) =>
  app.request("/setup/service", {
    method: "POST",
    headers: {
      authorization: "Bearer synap_hub_not_a_jwt",
      "content-type": "application/json",
    },
    body: JSON.stringify({ workspaceId: WS, scopes: ["hub-protocol.write"] }),
  });

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
  ])
    m.mockReset();
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
    expect(await res.json()).toMatchObject({ keyType: "service", workspaceId: WS });
    expect(createAndVerifyServiceKey).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: HUMAN, workspaceId: WS }),
      HUMAN,
      HUMAN
    );
  });
});
