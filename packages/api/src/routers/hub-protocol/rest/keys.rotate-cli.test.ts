/**
 * Hub Protocol REST — POST /keys/rotate-cli identity preservation.
 *
 * REGRESSION GUARD. `rotate-cli` re-mints the calling key. It is a ROTATION:
 * the replacement must be the SAME credential with fresh material, with ONE
 * deliberate change — the scope set is refreshed to INTEGRATION_HUB_SCOPES.cli.
 *
 * Before the fix this door forwarded only `userId`, `keyName`, the new scopes
 * and `hubId`, so the replacement key silently dropped:
 *   - keyType      → fell to the 'hub_inbound' schema default, and a 'service'
 *                    key stopped being confined by `resolveConfinedWorkspace`
 *   - workspaceId  → the confinement binding itself
 *   - linkedUserId → the agent→operator link; without it the agent's writes go
 *                    operator-direct instead of through the governance membrane
 *   - instanceId   → per-instance rotation scoping
 *
 * WIDENING GUARD (2026-10-06 centralisation audit). This door had no gate: ANY
 * key — a read-only `service` key, a sub-token, a probe key — came out with the
 * full CLI scope set, and `expiresInDays: undefined` made a 90-day key
 * permanent. Only an agent/CLI key (`hub_inbound`) that already holds
 * read+write may rotate, and its expiry is kept. The fixture used to be a
 * read-only `service` key rotating to write: it pinned the escalation as
 * correct.
 *
 * Strategy mirrors `auth.test.ts`: build an ISOLATED Hono app that mounts only
 * a stub auth middleware + the keys route, and mock `_shared.js` so the test
 * does not pull in the full hub-protocol router graph (which needs a live DB).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

// `_shared.js` re-exports the whole hub router; we only need its logger.
vi.mock("./_shared.js", () => ({
  // Considered fallback (total-mock-missing-export ratchet): `importOriginal`
  // cannot load the real `_shared.js` here — this file's TOTAL
  // `@synap/database` mock lacks exports its module graph reads. The route's
  // catch imports the status mapper; these tests never exercise a mapped
  // error, so it answers the old blanket 500.
  httpStatusForTrpcError: () => 500,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** The api_keys row the calling bearer resolves to. Reassigned per test. */
let callingKeyRow: Record<string, unknown> | undefined;

vi.mock("@synap/database", () => ({
  db: {
    query: {
      apiKeys: {
        findFirst: vi.fn(async () => callingKeyRow),
      },
    },
  },
  eq: vi.fn((a, b) => ({ type: "eq", a, b })),
}));

vi.mock("@synap/database/schema", () => ({
  apiKeys: { id: "id" },
}));

vi.mock("../../../services/api-keys.js", () => ({
  apiKeyService: {
    generateApiKey: vi.fn(async () => ({
      key: "synap_user_rotated-plaintext",
      keyId: "new-key-id",
    })),
    revokeApiKey: vi.fn(async () => undefined),
  },
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { registerKeysRoutes } from "./keys.js";
import { apiKeyService } from "../../../services/api-keys.js";
import { INTEGRATION_HUB_SCOPES } from "../../../services/hub-integration-registration.js";
import type { HubHono, HubVariables } from "./_shared.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const OLD_KEY_ID = "01234567-89ab-cdef-0123-456789abcdef";
const BOUND_WORKSPACE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/**
 * A CLI key that carries EVERY field this door used to drop: a confined
 * `service` key that also acts on behalf of a human operator, on one instance.
 * This combination is reachable in normal operation — agent keys minted for CLI
 * surfaces do carry `linkedUserId`.
 */
const EXPIRES_AT = new Date(Date.now() + 30 * 86_400_000);
const CONFINED_AGENT_KEY = {
  id: OLD_KEY_ID,
  userId: "user-1",
  keyName: "claude-code CLI",
  keyPrefix: "synap_user_",
  hubId: "synap-hub-prod",
  // stale scope set — intentionally refreshed (read+write: no widening)
  scope: ["hub-protocol.read", "hub-protocol.write", "mcp.read", "mcp.write"],
  keyType: "hub_inbound" as const,
  description: "CLI key for the laptop",
  workspaceId: BOUND_WORKSPACE,
  linkedUserId: "operator-42",
  instanceId: "laptop-1",
  parentKeyId: null,
  isActive: true,
  expiresAt: EXPIRES_AT,
};

// ─── Test app ───────────────────────────────────────────────────────────────

/**
 * Only the two context variables the handler reads (`apiKeyId`, `userId`) are
 * stubbed — the real auth middleware is covered by `auth.test.ts`.
 */
function buildTestApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    const bearerKeyId = c.req.header("x-test-key-id");
    if (bearerKeyId) c.set("apiKeyId", bearerKeyId);
    c.set("userId", "user-1");
    return next();
  });
  registerKeysRoutes(app);
  return app;
}

/** The `identity` (7th) argument the door passed to the mint door. */
function identityArgOfLastMint(): Record<string, unknown> | undefined {
  const mock = vi.mocked(apiKeyService.generateApiKey);
  return mock.mock.calls.at(-1)?.[6] as Record<string, unknown> | undefined;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("POST /keys/rotate-cli — identity preservation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callingKeyRow = { ...CONFINED_AGENT_KEY };
  });

  async function rotate(app: HubHono = buildTestApp()) {
    return app.request("/keys/rotate-cli", {
      method: "POST",
      headers: { "x-test-key-id": OLD_KEY_ID },
    });
  }

  it("carries keyType, workspaceId, linkedUserId and instanceId onto the rotated key", async () => {
    const res = await rotate();
    expect(res.status).toBe(200);

    expect(identityArgOfLastMint()).toMatchObject({
      keyType: "hub_inbound",
      workspaceId: BOUND_WORKSPACE,
      linkedUserId: "operator-42",
      instanceId: "laptop-1",
    });
  });

  it("preserves the key's description and human-facing identity fields", async () => {
    await rotate();
    const call = vi.mocked(apiKeyService.generateApiKey).mock.calls.at(-1)!;

    expect(call[0]).toBe(CONFINED_AGENT_KEY.userId);
    expect(call[1]).toBe(CONFINED_AGENT_KEY.keyName);
    expect(call[3]).toBe(CONFINED_AGENT_KEY.hubId);
    expect(identityArgOfLastMint()).toMatchObject({
      description: "CLI key for the laptop",
    });
  });

  it("still re-scopes the rotated key to the CLI scope set", async () => {
    // The ONE thing this door is meant to change. Identity preservation must
    // not accidentally carry the stale scopes over.
    const res = await rotate();

    const call = vi.mocked(apiKeyService.generateApiKey).mock.calls.at(-1)!;
    expect(call[2]).toEqual(INTEGRATION_HUB_SCOPES.cli);
    expect(call[2]).not.toEqual(CONFINED_AGENT_KEY.scope);
    await expect(res.json()).resolves.toMatchObject({
      apiKey: "synap_user_rotated-plaintext",
      keyId: "new-key-id",
      scopes: INTEGRATION_HUB_SCOPES.cli,
    });
    expect(vi.mocked(apiKeyService.revokeApiKey)).toHaveBeenCalledWith(
      OLD_KEY_ID,
      "user-1",
      expect.any(String)
    );
  });

  it("forwards NULL identity fields as NULL, not as schema defaults", async () => {
    // A plain user key: nothing to confine, nothing to link. The rotated key
    // must not gain a binding it never had.
    callingKeyRow = {
      ...CONFINED_AGENT_KEY,
      workspaceId: null,
      linkedUserId: null,
      instanceId: null,
      description: null,
    };

    await rotate();

    expect(identityArgOfLastMint()).toEqual({
      keyType: "hub_inbound",
      workspaceId: null,
      linkedUserId: null,
      instanceId: null,
      description: null,
    });
  });
});

describe("POST /keys/rotate-cli — never widens a key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callingKeyRow = { ...CONFINED_AGENT_KEY };
  });

  const rotate = () =>
    buildTestApp().request("/keys/rotate-cli", {
      method: "POST",
      headers: { "x-test-key-id": OLD_KEY_ID },
    });

  it("keeps the key's expiry instead of making it permanent", async () => {
    const res = await rotate();
    expect(res.status).toBe(200);
    const days = vi.mocked(apiKeyService.generateApiKey).mock.calls.at(-1)![4];
    expect(typeof days).toBe("number");
    expect(days as number).toBeGreaterThan(29.9);
    expect(days as number).toBeLessThanOrEqual(30);
  });

  it.each([
    [
      "a read-only service key",
      { keyType: "service", scope: ["hub-protocol.read"] },
    ],
    ["a read-only agent key", { scope: ["hub-protocol.read", "mcp.read"] }],
    ["a personal access token", { keyType: "user_pat" }],
    ["a sub-token", { parentKeyId: "11111111-2222-3333-4444-555555555555" }],
    ["a probe key", { scope: [...CONFINED_AGENT_KEY.scope, "probe"] }],
  ])("refuses %s and mints nothing", async (_label, patch) => {
    callingKeyRow = { ...CONFINED_AGENT_KEY, ...patch };
    const res = await rotate();
    expect(res.status).toBe(403);
    expect(vi.mocked(apiKeyService.generateApiKey)).not.toHaveBeenCalled();
    expect(vi.mocked(apiKeyService.revokeApiKey)).not.toHaveBeenCalled();
  });
});
