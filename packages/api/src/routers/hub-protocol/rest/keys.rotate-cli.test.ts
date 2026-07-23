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
 * Strategy mirrors `auth.test.ts`: build an ISOLATED Hono app that mounts only
 * a stub auth middleware + the keys route, and mock `_shared.js` so the test
 * does not pull in the full hub-protocol router graph (which needs a live DB).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

// `_shared.js` re-exports the whole hub router; we only need its logger.
vi.mock("./_shared.js", () => ({
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
import { resolveConfinedWorkspace } from "../confine-workspace.js";
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
const CONFINED_AGENT_KEY = {
  id: OLD_KEY_ID,
  userId: "user-1",
  keyName: "claude-code CLI",
  keyPrefix: "synap_user_",
  hubId: "synap-hub-prod",
  scope: ["hub-protocol.read"], // stale scope set — intentionally refreshed
  keyType: "service" as const,
  description: "CLI key for the laptop",
  workspaceId: BOUND_WORKSPACE,
  linkedUserId: "operator-42",
  instanceId: "laptop-1",
  isActive: true,
  expiresAt: null,
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
      keyType: "service",
      workspaceId: BOUND_WORKSPACE,
      linkedUserId: "operator-42",
      instanceId: "laptop-1",
    });
  });

  it("keeps the rotated key confined to its bound workspace", async () => {
    // End-to-consequence: feed the preserved fields to the real confinement
    // resolver. Pre-fix these were undefined → `resolveConfinedWorkspace` took
    // the legacy passthrough branch and the key became pod-wide.
    await rotate();
    const identity = identityArgOfLastMint()!;

    expect(
      resolveConfinedWorkspace(
        identity.keyType as string,
        identity.workspaceId as string,
        null
      )
    ).toBe(BOUND_WORKSPACE);
    expect(() =>
      resolveConfinedWorkspace(
        identity.keyType as string,
        identity.workspaceId as string,
        "some-other-workspace"
      )
    ).toThrow(/confined to workspace/);
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
      keyType: "user_pat",
      workspaceId: null,
      linkedUserId: null,
      instanceId: null,
      description: null,
    };

    await rotate();

    expect(identityArgOfLastMint()).toEqual({
      keyType: "user_pat",
      workspaceId: null,
      linkedUserId: null,
      instanceId: null,
      description: null,
    });
  });
});
