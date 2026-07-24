/**
 * Hub Protocol REST — CP-MCP redeem + revoke endpoint tests.
 *
 * Covers the security-critical contract Wave B consumes:
 *   (b) redeem rejects an expired / consumed / unknown code (all collapse to an
 *       empty atomic-claim → generic 400).
 *   (c) redeem on a valid code marks it consumed AND mints the claude-web key with
 *       linkedUserId = createdByUserId = podUserId, returning the contract shape.
 *   (d) scope-grammar mapping: mcp:read → mcp.read, mcp:write → mcp.write (+ the
 *       hub-protocol peers), unknown dropped, empty → functional default set.
 *   (e) revoke shares the SAME CP-trusted-issuer auth block as redeem, but scoped
 *       to its own `mcp_revoke` purpose claim — a `mcp_redeem`-scoped assertion
 *       must NOT work here (cross-purpose replay), and vice-versa.
 *   (f) revoke is idempotent + side-channel-safe: unknown / already-revoked /
 *       non-claude-web keyIds all collapse to 200 `{ revoked: false }`, never a
 *       4xx that would let a caller distinguish the reason.
 *
 * Strategy: mock `@synap/database` (the update→set→where→returning chain used by
 * redeem's atomic claim, PLUS `db.query.apiKeys`/`db.query.users` used by revoke's
 * security floor) + `provisionSurfaceAgentKey` + `ApiKeyRepository` + the module
 * logger, mount ONLY these routes on an isolated Hono app. No live Postgres.
 * `@synap/database/schema` is left REAL so the scope mapping exercises the actual
 * `isValidScope`, and `apiKeys`/`users` are real column objects (their identity
 * doesn't matter since `eq`/`db.query.*.findFirst` are mocked below).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Control what the atomic claim (update…returning) resolves to, and capture the
// `.set(...)` payload so we can assert the row is marked consumed.
const claim: { rows: unknown[] } = { rows: [] };
const setSpy = vi.fn();

// revoke's security-floor lookups: the api_keys row being revoked, and its
// owner's `users` row (userType/agentType), controlled per-test.
const revokeDb: {
  apiKeyRow: Record<string, unknown> | null;
  userRow: Record<string, unknown> | null;
} = { apiKeyRow: null, userRow: null };
const apiKeyRepoRevokeSpy = vi.fn((..._args: unknown[]) => Promise.resolve());

vi.mock("@synap/database", () => {
  const update = vi.fn(() => ({
    set: (payload: unknown) => {
      setSpy(payload);
      return {
        where: () => ({
          returning: () => Promise.resolve(claim.rows),
        }),
      };
    },
  }));
  return {
    db: {
      update,
      query: {
        apiKeys: {
          findFirst: vi.fn(() => Promise.resolve(revokeDb.apiKeyRow)),
        },
        users: {
          findFirst: vi.fn(() => Promise.resolve(revokeDb.userRow)),
        },
      },
    },
    mcpConnectCodes: {
      codeHash: "code_hash",
      podUserId: "pod_user_id",
      scopes: "scopes",
      agentType: "agent_type",
      consumedAt: "consumed_at",
      expiresAt: "expires_at",
    },
    users: { id: "users.id" },
    and: (...args: unknown[]) => ({ _and: args }),
    eq: (a: unknown, b: unknown) => ({ _eq: [a, b] }),
    isNull: (a: unknown) => ({ _isNull: a }),
    gt: (a: unknown, b: unknown) => ({ _gt: [a, b] }),
    // Revoke's repository door — spy on `.revoke(id, userId, reason)` without
    // touching a real DB/bcrypt.
    ApiKeyRepository: class {
      revoke(...args: unknown[]) {
        return apiKeyRepoRevokeSpy(...args);
      }
    },
    EventRepository: class {},
    sql: {},
  };
});

const provisionSpy = vi.fn();
vi.mock("../../../services/agent-identity-service.js", () => ({
  provisionSurfaceAgentKey: (opts: unknown) => provisionSpy(opts),
}));

vi.mock("./_shared.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Redeem now authenticates via a CP trusted-issuer JWT (not a hub key). Mock the
// verifier: default = a valid CP assertion; a test can override to null to assert
// the 401 auth path.
const verifyCpSpy = vi.fn(
  async (_token?: string, _opts?: unknown) => ({ mcp_redeem: true }) as unknown
);
vi.mock("../../../utils/jwks-client.js", () => ({
  verifyTrustedIssuerJwt: (token: string, opts: unknown) =>
    verifyCpSpy(token, opts),
}));

// Import AFTER mocks are registered.
import {
  registerMcpRedeemRoutes,
  mapCpScopesToPodScopes,
} from "./mcp-redeem.js";

function buildApp() {
  const app = new Hono();
  registerMcpRedeemRoutes(app as never);
  return app;
}

async function postRedeem(app: Hono, body: unknown) {
  return app.request("/mcp/redeem", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // A CP trusted-issuer assertion (mock verifier accepts it by default).
      authorization: "Bearer test-cp-assertion",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  claim.rows = [];
  setSpy.mockClear();
  provisionSpy.mockReset();
  revokeDb.apiKeyRow = null;
  revokeDb.userRow = null;
  apiKeyRepoRevokeSpy.mockClear();
  // The redeem/revoke handlers read PUBLIC_URL as the assertion audience.
  process.env.PUBLIC_URL = "https://pod.test.synap.live";
  verifyCpSpy.mockReset();
  verifyCpSpy.mockResolvedValue({ mcp_redeem: true });
});

async function postRevoke(app: Hono, body: unknown) {
  return app.request("/mcp/revoke", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // A CP trusted-issuer assertion (mock verifier accepts it by default).
      authorization: "Bearer test-cp-assertion",
    },
    body: JSON.stringify(body),
  });
}

// ─── (d) scope-grammar mapping ────────────────────────────────────────────────

describe("mapCpScopesToPodScopes", () => {
  it("maps CP colon grammar to pod dot grammar (mcp:read → mcp.read)", () => {
    const out = mapCpScopesToPodScopes(["mcp:read"]);
    expect(out).toContain("mcp.read");
    expect(out).not.toContain("mcp:read");
    // read implies the hub-protocol peer so the key can drive /mcp
    expect(out).toContain("hub-protocol.read");
  });

  it("maps mcp:write → mcp.write and pulls in hub-protocol read+write", () => {
    const out = mapCpScopesToPodScopes(["mcp:write"]);
    expect(out).toContain("mcp.write");
    expect(out).toContain("hub-protocol.write");
    expect(out).toContain("hub-protocol.read");
  });

  it("drops unknown scopes", () => {
    const out = mapCpScopesToPodScopes(["totally:bogus"]);
    // nothing valid mapped → falls back to the functional default set
    expect(out).toEqual(
      expect.arrayContaining([
        "hub-protocol.read",
        "hub-protocol.write",
        "mcp.read",
        "mcp.write",
      ])
    );
  });

  it("empty / null → functional default set", () => {
    for (const input of [[], null, undefined] as const) {
      const out = mapCpScopesToPodScopes(input);
      expect(out).toEqual([
        "hub-protocol.read",
        "hub-protocol.write",
        "mcp.read",
        "mcp.write",
      ]);
    }
  });
});

// ─── (b) reject invalid codes ─────────────────────────────────────────────────

describe("POST /mcp/redeem — rejection", () => {
  it("401 when the CP trusted-issuer assertion is invalid (auth gate)", async () => {
    verifyCpSpy.mockResolvedValueOnce(null); // assertion fails verification
    const res = await postRedeem(buildApp(), { code: "whatever" });
    expect(res.status).toBe(401);
    expect(provisionSpy).not.toHaveBeenCalled();
  });

  it("401 when the assertion is a valid CP JWT but not minted for redeem", async () => {
    verifyCpSpy.mockResolvedValueOnce({}); // trusted issuer, but no mcp_redeem
    const res = await postRedeem(buildApp(), { code: "whatever" });
    expect(res.status).toBe(401);
    expect(provisionSpy).not.toHaveBeenCalled();
  });

  it("401 when the Authorization header is missing", async () => {
    const res = await buildApp().request("/mcp/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "whatever" }),
    });
    expect(res.status).toBe(401);
    expect(provisionSpy).not.toHaveBeenCalled();
  });

  it("400 when code is missing", async () => {
    const res = await postRedeem(buildApp(), {});
    expect(res.status).toBe(400);
    expect(provisionSpy).not.toHaveBeenCalled();
  });

  it("400 when the atomic claim finds no unconsumed, unexpired row (unknown/expired/consumed)", async () => {
    claim.rows = []; // the WHERE (isNull consumed AND expires > now) filtered everything
    const res = await postRedeem(buildApp(), { code: "whatever" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/invalid, expired, or already-redeemed/i);
    // never mints on a failed claim
    expect(provisionSpy).not.toHaveBeenCalled();
  });
});

// ─── (c) valid redeem ─────────────────────────────────────────────────────────

describe("POST /mcp/redeem — success", () => {
  it("marks consumed, mints with linkedUserId=podUserId, returns the contract shape", async () => {
    claim.rows = [
      {
        podUserId: "user-123",
        scopes: ["mcp:read", "mcp:write"],
        agentType: "claude-web",
      },
    ];
    provisionSpy.mockResolvedValue({
      agentUserId: "agent-web-1",
      registration: { outcome: "CONNECTED_VERIFIED" },
      apiKey: { id: "key-1" },
      plainKey: "synap_hub_live_deadbeef",
      keyId: "key-1",
    });

    const res = await postRedeem(buildApp(), {
      code: "the-raw-code",
      instanceId: "inst-a",
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;

    // Contract Wave B consumes:
    expect(json).toEqual({
      apiKey: "synap_hub_live_deadbeef",
      keyId: "key-1",
      podUserId: "user-123",
      scopes: expect.arrayContaining(["mcp.read", "mcp.write"]),
      agentUserId: "agent-web-1",
    });

    // The atomic claim marked the row consumed.
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ consumedAt: expect.any(Date) })
    );

    // Minted for THIS human: linkedUserId = createdByUserId = podUserId.
    expect(provisionSpy).toHaveBeenCalledTimes(1);
    const opts = provisionSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(opts).toMatchObject({
      agentType: "claude-web",
      createdByUserId: "user-123",
      linkedUserId: "user-123",
      instanceId: "inst-a",
      ensureRegistryRow: true,
    });
    expect(opts.scopes).toEqual(
      expect.arrayContaining(["mcp.read", "mcp.write"])
    );
  });

  it("500 when the minted key fails verification", async () => {
    claim.rows = [{ podUserId: "user-9", scopes: [], agentType: "claude-web" }];
    provisionSpy.mockResolvedValue({
      agentUserId: "agent-web-9",
      registration: {
        outcome: "KEY_MINTED_BUT_VERIFICATION_FAILED",
        verificationError: "self-verify 401",
      },
      apiKey: { id: "key-9" },
      plainKey: "synap_hub_live_x",
      keyId: "key-9",
    });

    const res = await postRedeem(buildApp(), { code: "c" });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { code?: string };
    expect(json.code).toBe("KEY_MINTED_BUT_VERIFICATION_FAILED");
  });
});

// ─── POST /mcp/revoke ─────────────────────────────────────────────────────────

const CLAUDE_WEB_KEY_ROW = {
  id: "podkey-1",
  userId: "agent-user-1",
  revokedAt: null,
};
const CLAUDE_WEB_OWNER = { userType: "agent", agentType: "claude-web" };

describe("POST /mcp/revoke — auth", () => {
  it("401 when the Authorization header is missing", async () => {
    const res = await buildApp().request("/mcp/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyId: "podkey-1" }),
    });
    expect(res.status).toBe(401);
    expect(apiKeyRepoRevokeSpy).not.toHaveBeenCalled();
  });

  it("401 when the CP trusted-issuer assertion fails verification", async () => {
    verifyCpSpy.mockResolvedValueOnce(null);
    const res = await postRevoke(buildApp(), { keyId: "podkey-1" });
    expect(res.status).toBe(401);
    expect(apiKeyRepoRevokeSpy).not.toHaveBeenCalled();
  });

  it("401 CROSS-PURPOSE REPLAY: a valid CP JWT scoped to mcp_redeem (not mcp_revoke) is rejected here", async () => {
    verifyCpSpy.mockResolvedValueOnce({ mcp_redeem: true }); // no mcp_revoke claim
    revokeDb.apiKeyRow = CLAUDE_WEB_KEY_ROW;
    revokeDb.userRow = CLAUDE_WEB_OWNER;
    const res = await postRevoke(buildApp(), { keyId: "podkey-1" });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { reason?: string };
    expect(json.reason).toBe("wrong_purpose");
    expect(apiKeyRepoRevokeSpy).not.toHaveBeenCalled();
  });

  it("400 when keyId is missing", async () => {
    verifyCpSpy.mockResolvedValueOnce({ mcp_revoke: true });
    const res = await postRevoke(buildApp(), {});
    expect(res.status).toBe(400);
    expect(apiKeyRepoRevokeSpy).not.toHaveBeenCalled();
  });
});

describe("POST /mcp/revoke — idempotent / security floor", () => {
  beforeEach(() => {
    // Every test in this block presents a validly-scoped mcp_revoke assertion —
    // only the DB-side state under test varies.
    verifyCpSpy.mockResolvedValue({ mcp_revoke: true });
  });

  it("200 { revoked: false } for an unknown keyId — never leaks existence", async () => {
    revokeDb.apiKeyRow = null;
    const res = await postRevoke(buildApp(), { keyId: "does-not-exist" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: false });
    expect(apiKeyRepoRevokeSpy).not.toHaveBeenCalled();
  });

  it("200 { revoked: false } for an already-revoked key — safely retryable", async () => {
    revokeDb.apiKeyRow = { ...CLAUDE_WEB_KEY_ROW, revokedAt: new Date() };
    revokeDb.userRow = CLAUDE_WEB_OWNER;
    const res = await postRevoke(buildApp(), { keyId: "podkey-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: false });
    expect(apiKeyRepoRevokeSpy).not.toHaveBeenCalled();
  });

  it("200 { revoked: false } — SECURITY FLOOR: refuses a key whose owner is not the claude-web agent", async () => {
    revokeDb.apiKeyRow = CLAUDE_WEB_KEY_ROW;
    revokeDb.userRow = { userType: "agent", agentType: "some-other-agent" };
    const res = await postRevoke(buildApp(), { keyId: "podkey-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: false });
    expect(apiKeyRepoRevokeSpy).not.toHaveBeenCalled();
  });

  it("200 { revoked: true } — happy path calls the repository revoke door with the right keyId", async () => {
    revokeDb.apiKeyRow = CLAUDE_WEB_KEY_ROW;
    revokeDb.userRow = CLAUDE_WEB_OWNER;
    const res = await postRevoke(buildApp(), { keyId: "podkey-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    expect(apiKeyRepoRevokeSpy).toHaveBeenCalledTimes(1);
    expect(apiKeyRepoRevokeSpy).toHaveBeenCalledWith(
      "podkey-1",
      "agent-user-1", // revokedBy = the key's own owner (no human actor here)
      expect.any(String)
    );
  });
});
