import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class PodOwnerAlreadyClaimedError extends Error {}
  class PodOwnerNotClaimedError extends Error {}

  return {
    activateFederatedMember: vi.fn(),
    assertFederatedAccessTarget: vi.fn(),
    consumeFederatedAssertionReceipt: vi.fn(),
    createIssuerIdentityLinkReceipt: vi.fn(),
    getByUrl: vi.fn(),
    getDb: vi.fn(),
    loggerError: vi.fn(),
    loggerWarn: vi.fn(),
    PodOwnerAlreadyClaimedError,
    PodOwnerNotClaimedError,
    readPodUserAccess: vi.fn(),
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
  createIssuerIdentityLinkReceipt: mocks.createIssuerIdentityLinkReceipt,
  FederatedApplicationConnectionService: class FederatedApplicationConnectionService {},
  and: vi.fn(),
  eq: vi.fn(),
  getDb: mocks.getDb,
  PodOwnerAlreadyClaimedError: mocks.PodOwnerAlreadyClaimedError,
  PodOwnerNotClaimedError: mocks.PodOwnerNotClaimedError,
  readPodUserAccess: mocks.readPodUserAccess,
  hasActivePodAccess: vi.fn(),
  seedAdminUser: mocks.seedAdminUser,
  TrustedIssuerService: class TrustedIssuerService {
    getByUrl = mocks.getByUrl;
  },
  TRUSTED_ISSUER_CAPABILITIES: {
    IDENTITY_LINK: "identity:link-user",
    MEMBERSHIP_GRANT: "membership:grant",
    USER_EXCHANGE: "auth:exchange-user",
  },
  CONTROL_PLANE_ISSUER_SCOPES: [
    "auth:exchange-user",
    "identity:link-user",
    "membership:grant",
    "source-config:write",
  ],
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
  // Mirrors the real contract (@synap/api jwks-client): PUBLIC_URL, no trailing slash.
  podAudience: () => process.env.PUBLIC_URL?.replace(/\/+$/, "") || null,
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
      code: "ASSERTION_REPLAYED",
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
      code: "REPLAY_PROTECTION_UNAVAILABLE",
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

describe("POST /bootstrap — initial admin (A4: a lab's confirming admin)", () => {
  const fetchMock = vi.fn();
  const receiptId = "22222222-2222-4222-8222-222222222222";
  const adminClaims = {
    commandId: "admin-command-1",
    email: "Founder@Example.test",
    exp: now + 300,
    iat: now,
    intentId: "intent-1",
    iss: issuerUrl,
    jti: "admin-assertion-1",
    nonce: "n".repeat(32),
    purpose: "initial-admin-bootstrap" as const,
    receiptId,
    sub: "cp-admin-1",
    type: "federated_assertion" as const,
  };
  const adminAccess = {
    podRole: "admin",
    podMember: false,
    workspaceScopes: [],
    projectScopes: [],
  };
  const post = (token: string) =>
    federationRouter.request("/bootstrap", {
      body: JSON.stringify({
        assertion: jwt.sign(adminClaims, "test-secret", { algorithm: "HS256" }),
      }),
      headers: {
        "Content-Type": "application/json",
        "X-Pod-Bootstrap-Token": token,
      },
      method: "POST",
    });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    process.env.PROVISIONING_TOKEN = "pod-bootstrap-token";
    process.env.PUBLIC_URL = "https://pod.example.test";
    mocks.getByUrl.mockResolvedValue({
      allowedScopes: ["identity:link-user"],
      id: "issuer-1",
      status: "approved",
    });
    mocks.consumeFederatedAssertionReceipt.mockResolvedValue("consumed");
    mocks.verifyIssuerJwt.mockResolvedValue(adminClaims);
    mocks.seedAdminUser.mockResolvedValue({
      userId: "pod-admin-identity",
      workspaceId: null,
      alreadyExisted: false,
    });
    mocks.createIssuerIdentityLinkReceipt.mockResolvedValue({
      receiptId,
      expiresAt: new Date(),
    });
    mocks.readPodUserAccess.mockResolvedValue(adminAccess);
    fetchMock.mockResolvedValue(kratosResponse([{ id: "pod-admin-identity" }]));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PROVISIONING_TOKEN;
  });

  it("is refused without the pod's install secret, before any work", async () => {
    const response = await post("not-the-install-secret");

    expect(response.status).toBe(401);
    expect(mocks.verifyIssuerJwt).not.toHaveBeenCalled();
    expect(mocks.seedAdminUser).not.toHaveBeenCalled();
    expect(mocks.createIssuerIdentityLinkReceipt).not.toHaveBeenCalled();
  });

  it("is refused before the owner bound the issuer, spending nothing", async () => {
    mocks.getByUrl.mockResolvedValue({
      allowedScopes: [],
      id: "issuer-1",
      status: "pending",
    });

    const response = await post("pod-bootstrap-token");

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Bootstrap the Pod owner before an initial admin",
    });
    expect(mocks.consumeFederatedAssertionReceipt).not.toHaveBeenCalled();
    expect(mocks.seedAdminUser).not.toHaveBeenCalled();
  });

  it("answers 409 when the pod has no owner yet (seed refuses)", async () => {
    mocks.seedAdminUser.mockRejectedValue(new mocks.PodOwnerNotClaimedError());

    const response = await post("pod-bootstrap-token");

    expect(response.status).toBe(409);
    expect(mocks.createIssuerIdentityLinkReceipt).not.toHaveBeenCalled();
  });

  it("binds a pod ADMIN for the issuer subject and writes the issuer-chosen receipt", async () => {
    const before = Date.now();
    const response = await post("pod-bootstrap-token");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      userId: "pod-admin-identity",
      workspaceId: null,
      receiptId,
      access: adminAccess,
    });
    expect(mocks.seedAdminUser).toHaveBeenCalledWith(
      expect.objectContaining({
        kratosIdentityId: "pod-admin-identity",
        email: "founder@example.test",
        federatedIdentity: {
          issuerId: "issuer-1",
          issuerSubject: "cp-admin-1",
        },
        initialPodAdmin: true,
      })
    );
    expect(mocks.seedAdminUser).not.toHaveBeenCalledWith(
      expect.objectContaining({ requireUnclaimedPodOwner: true })
    );
    const receipt = mocks.createIssuerIdentityLinkReceipt.mock.calls[0]![0];
    expect(receipt).toMatchObject({
      issuerId: "issuer-1",
      issuerSubject: "cp-admin-1",
      userId: "pod-admin-identity",
      intentId: "intent-1",
      nonce: adminClaims.nonce,
      receiptId,
    });
    // Outlives the CP's post-registration read (≥ 25 min), single-use anyway.
    expect(receipt.expiresAt.getTime() - before).toBeGreaterThan(25 * 60_000);
  });
});
