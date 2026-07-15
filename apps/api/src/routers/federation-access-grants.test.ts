import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class PodOwnerAlreadyClaimedError extends Error {}

  return {
    activateFederatedMember: vi.fn(),
    assertFederatedAccessTarget: vi.fn(),
    consumeFederatedAssertionReceipt: vi.fn(),
    getByUrl: vi.fn(),
    getDb: vi.fn(),
    loggerError: vi.fn(),
    loggerWarn: vi.fn(),
    PodOwnerAlreadyClaimedError,
    seedAdminUser: vi.fn(),
    verifyIssuerJwt: vi.fn(),
    verifyTrustedIssuerJwt: vi.fn(),
  };
});

vi.mock("@synap/auth", () => ({
  authMiddleware: async (_context: unknown, next: () => Promise<Response>) =>
    next(),
  getKratosSessionByToken: vi.fn(),
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    error: mocks.loggerError,
    info: vi.fn(),
    warn: mocks.loggerWarn,
  }),
}));

vi.mock("@synap/database", () => ({
  activateFederatedMember: mocks.activateFederatedMember,
  assertFederatedAccessTarget: mocks.assertFederatedAccessTarget,
  bindExistingFederatedIdentity: vi.fn(),
  consumeFederatedAssertionReceipt: mocks.consumeFederatedAssertionReceipt,
  consumeIssuerIdentityLinkReceipt: vi.fn(),
  createIssuerIdentityLinkReceipt: vi.fn(),
  FederatedApplicationConnectionService: class FederatedApplicationConnectionService {},
  and: vi.fn(),
  eq: vi.fn(),
  getDb: mocks.getDb,
  PodOwnerAlreadyClaimedError: mocks.PodOwnerAlreadyClaimedError,
  projectPodUserAccess: vi.fn(),
  seedAdminUser: mocks.seedAdminUser,
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
  createOpaqueApplicationConnectionValue: vi.fn(),
  hashOpaqueApplicationConnectionValue: vi.fn(),
  normalizeApplicationCallbackUrl: vi.fn(),
  normalizeApplicationClientId: vi.fn(),
  normalizeApplicationConnectionScopes: vi.fn(),
  normalizeApplicationOrigin: vi.fn(),
  normalizePublisherUrl: vi.fn(),
  normalizeIssuerUrl: (value: string) => value,
  verifyIssuerJwt: mocks.verifyIssuerJwt,
  verifyTrustedIssuerJwt: mocks.verifyTrustedIssuerJwt,
}));

import { federationRouter } from "./federation.js";

const issuerUrl = "https://issuer.example.test";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const now = Math.floor(Date.now() / 1_000);
const grantClaims = {
  commandId: "grant-command-1",
  email: "person@example.test",
  exp: now + 300,
  iat: now,
  iss: issuerUrl,
  jti: "grant-assertion-1",
  purpose: "access-grant" as const,
  role: "viewer" as const,
  scope: { id: workspaceId, kind: "workspace" as const },
  sub: "issuer-user-1",
  type: "federated_assertion" as const,
};

const bootstrapClaims = {
  commandId: "bootstrap-command-1",
  email: "owner@example.test",
  exp: now + 300,
  iat: now,
  iss: issuerUrl,
  jti: "bootstrap-assertion-1",
  purpose: "initial-owner-bootstrap" as const,
  sub: "issuer-owner-1",
  type: "federated_assertion" as const,
};

function accessGrantAssertion(): string {
  return jwt.sign(grantClaims, "test-secret", { algorithm: "HS256" });
}

function bootstrapAssertion(): string {
  return jwt.sign(bootstrapClaims, "test-secret", { algorithm: "HS256" });
}

function kratosResponse(body: unknown, status = 200) {
  return {
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
  };
}

describe("POST /access-grants", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    process.env.PUBLIC_URL = "https://pod.example.test";
    mocks.getByUrl.mockResolvedValue({
      allowedScopes: ["membership:grant"],
      id: "issuer-1",
      status: "approved",
    });
    mocks.consumeFederatedAssertionReceipt.mockResolvedValue("consumed");
    mocks.verifyTrustedIssuerJwt.mockResolvedValue(grantClaims);
    mocks.activateFederatedMember.mockResolvedValue({
      alreadyActivated: false,
      membershipCreated: true,
      projectId: null,
      role: "viewer",
      scopeKind: "workspace",
      userId: "pod-user-1",
      workspaceId,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an invalid target before looking up or creating a Kratos identity", async () => {
    mocks.assertFederatedAccessTarget.mockRejectedValue(
      new Error("requested workspace does not exist")
    );

    const response = await federationRouter.request("/access-grants", {
      headers: { Authorization: `Bearer ${accessGrantAssertion()}` },
      method: "POST",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Requested Pod access target is unavailable",
    });
    expect(mocks.assertFederatedAccessTarget).toHaveBeenCalledWith({
      scopeKind: "workspace",
      workspaceId,
    });
    expect(mocks.consumeFederatedAssertionReceipt).toHaveBeenCalledWith({
      issuerId: "issuer-1",
      jti: "grant-assertion-1",
      expiresAt: expect.any(Date),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.activateFederatedMember).not.toHaveBeenCalled();
  });

  it("reports failed compensation instead of silently leaving a new Kratos identity", async () => {
    mocks.assertFederatedAccessTarget.mockResolvedValue(undefined);
    mocks.activateFederatedMember.mockRejectedValue(
      new Error("requested workspace became unavailable")
    );
    fetchMock
      .mockResolvedValueOnce(kratosResponse([]))
      .mockResolvedValueOnce(kratosResponse({ id: "new-kratos-identity" }))
      .mockResolvedValueOnce(kratosResponse(null, 500));

    const response = await federationRouter.request("/access-grants", {
      headers: { Authorization: `Bearer ${accessGrantAssertion()}` },
      method: "POST",
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error:
        "Federated access grant failed and the newly-created Pod identity could not be rolled back",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining("/admin/identities/new-kratos-identity"),
      expect.objectContaining({ method: "DELETE" })
    );
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ identityId: "new-kratos-identity" }),
      expect.stringContaining("compensation")
    );
  });

  it("stops a durable assertion replay before Pod target or Kratos work", async () => {
    mocks.consumeFederatedAssertionReceipt.mockResolvedValue("replayed");

    const response = await federationRouter.request("/access-grants", {
      headers: { Authorization: `Bearer ${accessGrantAssertion()}` },
      method: "POST",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Federated assertion has already been used",
    });
    expect(mocks.assertFederatedAccessTarget).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.activateFederatedMember).not.toHaveBeenCalled();
  });

  it("fails closed when durable replay protection is unavailable", async () => {
    mocks.consumeFederatedAssertionReceipt.mockRejectedValue(
      new Error("database unavailable")
    );

    const response = await federationRouter.request("/access-grants", {
      headers: { Authorization: `Bearer ${accessGrantAssertion()}` },
      method: "POST",
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Federated assertion replay protection is unavailable",
    });
    expect(mocks.assertFederatedAccessTarget).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.activateFederatedMember).not.toHaveBeenCalled();
  });
});

describe("POST /bootstrap", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    process.env.PROVISIONING_TOKEN = "pod-bootstrap-token";
    process.env.PUBLIC_URL = "https://pod.example.test";
    mocks.getByUrl.mockResolvedValue({
      allowedScopes: [
        "auth:exchange-user",
        "identity:link-user",
        "membership:grant",
      ],
      id: "issuer-1",
      status: "approved",
    });
    mocks.consumeFederatedAssertionReceipt.mockResolvedValue("consumed");
    mocks.getDb.mockResolvedValue({
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            innerJoin: () => ({ where: async () => [] }),
          }),
        }),
      }),
    });
    mocks.verifyIssuerJwt.mockResolvedValue(bootstrapClaims);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PROVISIONING_TOKEN;
  });

  it("surfaces a failed identity cleanup when the initial owner race is lost", async () => {
    mocks.seedAdminUser.mockRejectedValue(
      new mocks.PodOwnerAlreadyClaimedError("owner already claimed")
    );
    fetchMock
      .mockResolvedValueOnce(kratosResponse([]))
      .mockResolvedValueOnce(kratosResponse({ id: "new-owner-identity" }))
      .mockResolvedValueOnce(kratosResponse(null, 500));

    const response = await federationRouter.request("/bootstrap", {
      body: JSON.stringify({ assertion: bootstrapAssertion() }),
      headers: {
        "Content-Type": "application/json",
        "X-Pod-Bootstrap-Token": "pod-bootstrap-token",
      },
      method: "POST",
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error:
        "Initial owner bootstrap failed and the newly-created Pod identity could not be rolled back",
    });
    expect(mocks.consumeFederatedAssertionReceipt).toHaveBeenCalledWith({
      issuerId: "issuer-1",
      jti: "bootstrap-assertion-1",
      expiresAt: expect.any(Date),
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining("/admin/identities/new-owner-identity"),
      expect.objectContaining({ method: "DELETE" })
    );
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ identityId: "new-owner-identity" }),
      expect.stringContaining("compensation")
    );
  });
});
