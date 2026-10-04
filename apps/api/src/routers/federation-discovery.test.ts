/**
 * GET /api/federation/discovery — the public "is Synap Cloud sign-in on?"
 * contract. Driven through the REAL federationRouter (the mount is the seam),
 * with the DB and trusted-issuer registry mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getByUrl: vi.fn(),
  getDb: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@synap/auth", () => ({
  // A session gate that ALWAYS refuses: if discovery were ever put behind
  // authMiddleware, every test below would read 401.
  authMiddleware: async (c: { json: (b: unknown, s: number) => Response }) =>
    c.json({ error: "Unauthorized" }, 401),
  attachOidcCredentialToIdentity: vi.fn(),
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    error: mocks.loggerError,
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock("@synap/database", () => ({
  activateFederatedMember: vi.fn(),
  assertFederatedAccessTarget: vi.fn(),
  bindExistingFederatedIdentity: vi.fn(),
  consumeFederatedAssertionReceipt: vi.fn(),
  consumeIssuerIdentityLinkReceipt: vi.fn(),
  createIssuerIdentityLinkReceipt: vi.fn(),
  FederatedApplicationConnectionService: class FederatedApplicationConnectionService {},
  and: vi.fn(),
  arrayContains: vi.fn(),
  eq: vi.fn(),
  getDb: mocks.getDb,
  podSettings: { settings: "settings", createdAt: "createdAt" },
  PodOwnerAlreadyClaimedError: class PodOwnerAlreadyClaimedError extends Error {},
  projectPodUserAccess: vi.fn(),
  seedAdminUser: vi.fn(),
  TrustedIssuerService: class TrustedIssuerService {
    getByUrl = mocks.getByUrl;
  },
  TRUSTED_ISSUER_CAPABILITIES: {
    IDENTITY_LINK: "identity:link-user",
    MEMBERSHIP_GRANT: "membership:grant",
    USER_EXCHANGE: "auth:exchange-user",
  },
}));

vi.mock("@synap/database/schema", () => ({
  federatedIdentityLinks: {},
  federatedApplicationConnections: {},
  projectMembers: {},
  projects: {},
  users: {},
  workspaceMembers: {},
  workspaces: {},
}));

vi.mock("@synap/api", () => ({
  hashOpaqueApplicationConnectionValue: vi.fn(),
  normalizeApplicationCallbackUrl: vi.fn(),
  normalizeApplicationClientId: vi.fn(),
  normalizeApplicationConnectionScopes: vi.fn(),
  normalizeApplicationOrigin: vi.fn(),
  normalizePublisherUrl: vi.fn(),
  // Mirrors the real contract: https-only, otherwise null.
  normalizeIssuerUrl: (value: string) =>
    value.startsWith("https://") ? value.replace(/\/+$/, "") : null,
  verifyIssuerJwt: vi.fn(),
  verifyTrustedIssuerJwt: vi.fn(),
}));

import { federationRouter } from "./federation.js";

const ISSUER = "https://api.synap.live";

/** getDb() whose pod_settings read resolves to `rows` (or rejects). */
function podSettingsRows(rows: unknown[] | Error) {
  const limit =
    rows instanceof Error
      ? vi.fn().mockRejectedValue(rows)
      : vi.fn().mockResolvedValue(rows);
  mocks.getDb.mockResolvedValue({
    select: () => ({ from: () => ({ orderBy: () => ({ limit }) }) }),
  });
}

const settingsWith = (federationOidcClient: unknown) => [
  { settings: { federationOidcClient } },
];

async function discover() {
  const res = await federationRouter.request("/discovery");
  return { status: res.status, body: await res.json(), res };
}

describe("GET /discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("available when the pushed issuer is an approved trusted issuer", async () => {
    podSettingsRows(
      settingsWith({ issuer: ISSUER, clientId: "secret-client-id" })
    );
    mocks.getByUrl.mockResolvedValue({ id: "i1", status: "approved" });

    const { status, body, res } = await discover();

    expect(status).toBe(200);
    expect(body).toEqual({
      cloudSignIn: { available: true, provider: "cp", issuerUrl: ISSUER },
    });
    expect(mocks.getByUrl).toHaveBeenCalledWith(ISSUER);
    // Never leaks the client id (or anything else from the setting).
    expect(JSON.stringify(body)).not.toContain("secret-client-id");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("not_configured when no federation client was pushed", async () => {
    podSettingsRows([{ settings: {} }]);

    const { status, body } = await discover();

    expect(status).toBe(200);
    expect(body).toEqual({
      cloudSignIn: {
        available: false,
        provider: "cp",
        issuerUrl: null,
        reason: "not_configured",
      },
    });
    expect(mocks.getByUrl).not.toHaveBeenCalled();
  });

  it("not_configured when the pod has no settings row at all", async () => {
    podSettingsRows([]);
    const { body } = await discover();
    expect(body.cloudSignIn.reason).toBe("not_configured");
    expect(body.cloudSignIn.available).toBe(false);
  });

  it("not_configured when the stored issuer is not a usable https issuer", async () => {
    podSettingsRows(settingsWith({ issuer: "http://insecure.example" }));
    const { body } = await discover();
    expect(body.cloudSignIn).toEqual({
      available: false,
      provider: "cp",
      issuerUrl: null,
      reason: "not_configured",
    });
  });

  it.each([
    ["absent from trusted_issuers", null],
    ["pending", { id: "i1", status: "pending" }],
    ["revoked", { id: "i1", status: "revoked" }],
    ["rejected", { id: "i1", status: "rejected" }],
  ])("issuer_not_approved when the issuer is %s", async (_label, row) => {
    podSettingsRows(settingsWith({ issuer: ISSUER }));
    mocks.getByUrl.mockResolvedValue(row);

    const { status, body } = await discover();

    expect(status).toBe(200);
    expect(body).toEqual({
      cloudSignIn: {
        available: false,
        provider: "cp",
        issuerUrl: ISSUER,
        reason: "issuer_not_approved",
      },
    });
  });

  it("a FAILED settings read is a 503, never available:false", async () => {
    podSettingsRows(new Error("connection refused"));

    const { status, body } = await discover();

    expect(status).toBe(503);
    expect(body.error).toBe("discovery_unavailable");
    expect(body).not.toHaveProperty("cloudSignIn");
    expect(mocks.loggerError).toHaveBeenCalled();
  });

  it("a FAILED trusted-issuer read is a 503, never issuer_not_approved", async () => {
    podSettingsRows(settingsWith({ issuer: ISSUER }));
    mocks.getByUrl.mockRejectedValue(new Error("timeout"));

    const { status, body } = await discover();

    expect(status).toBe(503);
    expect(body).not.toHaveProperty("cloudSignIn");
  });
});
