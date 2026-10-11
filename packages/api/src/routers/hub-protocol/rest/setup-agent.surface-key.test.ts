/**
 * `POST /setup/agent` through the REAL route with a `hub-protocol.write` key
 * (auth Path 4 — the surface-agent mint).
 *
 * THE DEFECT: any such key — an AGENT key included — could mint a LIVE
 * surface-agent key with no approval (`requireApproval` was an opt-in), and
 * the new key carried the agent's own limits, which for a legacy agent with
 * no capabilities resolve to `*`. A narrow key could so connect a full one.
 *
 * Pinned:
 *   - a key caller ALWAYS gets a pending key + an `agent/connect` proposal,
 *     even when it does not ask for approval (and when it asks not to);
 *   - the new key's grant is cut down to the caller key's live grants,
 *     ending no later than them;
 *   - a key that may touch nothing provisions nothing.
 *
 * Mocked: key lookup, identity, the provisioning door, the proposal filer,
 * the grant read/write helpers and the db writes. The route's auth and its
 * bounding run unmodified.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HUMAN = "0aaaaaaa-0000-4000-8000-000000000001";
const AGENT = "0ccccccc-0000-4000-8000-000000000003";
const NEW_AGENT = "0bbbbbbb-0000-4000-8000-000000000002";
const KEY_END = new Date(Date.now() + 90 * 86_400_000);
const CALLER_END = new Date(Date.now() + 5 * 86_400_000);

const validateApiKey = vi.fn();
const resolveKeyIdentity = vi.fn();
const provisionSurfaceAgentKey = vi.fn();
const fileAgentConnectProposal = vi.fn();
const liveGrantsOfKey = vi.fn();
const attachGrantsOrRevoke = vi.fn();
const revokeApiKeys = vi.fn();
const setActive = vi.fn();
const invalidateVerificationCache = vi.fn();

vi.mock("../../../services/api-keys.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../services/api-keys.js")>();
  return {
    ...actual,
    apiKeyService: {
      ...actual.apiKeyService,
      validateApiKey,
      invalidateVerificationCache,
    },
  };
});
vi.mock("../../../access/key-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../access/key-identity.js")>()),
  resolveKeyIdentity,
}));
vi.mock(
  "../../../services/agent-identity-service.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../services/agent-identity-service.js")
    >()),
    provisionSurfaceAgentKey,
  })
);
vi.mock("../../../services/agent-connect.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../services/agent-connect.js")
  >()),
  fileAgentConnectProposal,
}));
vi.mock("../../../services/key-grant.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/key-grant.js")>()),
  liveGrantsOfKey,
  attachGrantsOrRevoke,
}));
vi.mock("@synap/database/api-key-revocation", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@synap/database/api-key-revocation")
  >()),
  revokeApiKeys,
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: { users: { findFirst: async () => ({ id: HUMAN }) } },
      update: () => ({ set: (v: unknown) => ({ where: () => setActive(v) }) }),
    },
  };
});

const { registerSetupRoutes } = await import("./setup.js");

function makeApp() {
  const app = new OpenAPIHono();
  registerSetupRoutes(app as never);
  return app;
}

const connect = (body: Record<string, unknown> = {}) =>
  makeApp().request("/setup/agent", {
    method: "POST",
    headers: {
      authorization: "Bearer synap_hub_not_a_jwt",
      "content-type": "application/json",
    },
    body: JSON.stringify({ agentType: "claude-code", ...body }),
  });

const live = (permissions: string[], expiresAt: Date | null = null) => ({
  permissions,
  workspaceIds: null,
  projectIds: null,
  entityIds: null,
  expiresAt,
});

function callerKey(agent: boolean) {
  validateApiKey.mockResolvedValue({
    id: "caller-key",
    userId: agent ? AGENT : HUMAN,
    linkedUserId: agent ? HUMAN : null,
    isActive: true,
    scope: ["hub-protocol.read", "hub-protocol.write"],
  });
  resolveKeyIdentity.mockResolvedValue({
    effectiveUserId: HUMAN,
    agentUserId: agent ? AGENT : undefined,
    isAgent: agent,
  });
}

let grantsByKey: Record<string, ReturnType<typeof live>[]>;

beforeEach(() => {
  delete process.env.PROVISIONING_TOKEN;
  for (const m of [
    validateApiKey,
    resolveKeyIdentity,
    provisionSurfaceAgentKey,
    fileAgentConnectProposal,
    liveGrantsOfKey,
    attachGrantsOrRevoke,
    revokeApiKeys,
    setActive,
    invalidateVerificationCache,
  ])
    m.mockReset();
  // The legacy agent's own grant: no capabilities ⇒ `*`.
  grantsByKey = {
    "caller-key": [live(["entity.note.read"], CALLER_END)],
    "new-key": [live(["*"], KEY_END)],
  };
  liveGrantsOfKey.mockImplementation(async (id: string) => grantsByKey[id]);
  provisionSurfaceAgentKey.mockResolvedValue({
    agentUserId: NEW_AGENT,
    registration: { outcome: "CONNECTED_VERIFIED" },
    apiKey: { id: "new-key", expiresAt: KEY_END },
    plainKey: "synap_hub_new",
  });
  fileAgentConnectProposal.mockResolvedValue({ proposalId: "prop-1" });
});

describe("POST /setup/agent — a key never connects a live AI by itself", () => {
  it.each([
    ["an AGENT key", true],
    ["a human key", false],
  ])(
    "%s, not asking for approval → pending key + agent/connect proposal",
    async (_label, agent) => {
      callerKey(agent);
      const res = await connect({ requireApproval: false });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        requiresApproval: true,
        pendingProposalId: "prop-1",
      });
      expect(setActive).toHaveBeenCalledWith({ isActive: false });
      expect(fileAgentConnectProposal).toHaveBeenCalledWith(
        expect.objectContaining({ keyId: "new-key", ownerUserId: HUMAN })
      );
    }
  );

  it("a pending key stops answering at once — its cached verification is dropped after it is switched off", async () => {
    // The mint's self-verify caches the key as valid for 30s; live on
    // 2026-10-11 a pending key read entities inside that window.
    callerKey(true);
    const res = await connect();
    expect(res.status).toBe(200);
    expect(setActive).toHaveBeenCalledWith({ isActive: false });
    expect(invalidateVerificationCache).toHaveBeenCalled();
    expect(invalidateVerificationCache.mock.invocationCallOrder[0]).toBeGreaterThan(
      setActive.mock.invocationCallOrder[0]!
    );
  });

  it("a pending key leaves the agent's working keys alone until approval", async () => {
    callerKey(true);
    const res = await connect();
    expect(res.status).toBe(200);
    expect(provisionSurfaceAgentKey).toHaveBeenCalledWith(
      expect.objectContaining({ pendingApproval: true })
    );
  });

  it("the new key's `*` is cut down to the caller's grant, ending with it", async () => {
    callerKey(true);
    const res = await connect();
    expect(res.status).toBe(200);
    expect(attachGrantsOrRevoke).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeyId: "new-key",
        principalUserId: NEW_AGENT,
        onBehalfOf: HUMAN,
        grants: [{ permissions: ["entity.note.read"], expiresAt: CALLER_END }],
      })
    );
    // Bounded BEFORE the proposal reads the key's grant for its card.
    expect(attachGrantsOrRevoke.mock.invocationCallOrder[0]).toBeLessThan(
      fileAgentConnectProposal.mock.invocationCallOrder[0]!
    );
  });

  it("a key that may touch nothing → 403, nothing provisioned", async () => {
    callerKey(false);
    grantsByKey["caller-key"] = [];
    const res = await connect();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("may touch nothing");
    expect(provisionSurfaceAgentKey).not.toHaveBeenCalled();
  });

  it("no overlap with the agent's own limits → key revoked, 403", async () => {
    callerKey(false);
    grantsByKey["new-key"] = [live(["entity.task.update"], KEY_END)];
    const res = await connect();
    expect(res.status).toBe(403);
    expect(revokeApiKeys).toHaveBeenCalled();
    expect(fileAgentConnectProposal).not.toHaveBeenCalled();
  });
});
