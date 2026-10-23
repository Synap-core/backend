import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAwaitingLocalAuth: vi.fn(),
  createIssuerIdentityLinkReceipt: vi.fn(),
  bindExistingFederatedIdentity: vi.fn(),
  finalizeCompletion: vi.fn(),
  getApplicationConnectionRequest: vi.fn(),
  getApplicationConnectionStatus: vi.fn(),
  getCompletableRequest: vi.fn(),
  getByUrl: vi.fn(),
  getDb: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  normalizeApplicationCallbackUrl: vi.fn(),
  normalizeApplicationConnectionScopes: vi.fn(),
  normalizePublisherUrl: vi.fn(),
  releaseCompletion: vi.fn(),
  reserveCompletion: vi.fn(),
  consumeIssuerIdentityLinkReceipt: vi.fn(),
  consumeFederatedAssertionReceipt: vi.fn(),
  verifyIssuerJwt: vi.fn(),
  verifyTrustedIssuerJwt: vi.fn(),
}));

vi.mock("@synap/auth", () => ({
  // The request-start endpoint intentionally has no Pod authentication.
  authMiddleware: async (
    c: { set: (key: string, value: string) => void },
    next: () => Promise<Response>
  ) => {
    c.set("userId", "pod-user-1");
    return next();
  },
  getKratosSessionByToken: vi.fn(),
}));

vi.mock("@synap-core/core", () => ({ createLogger: () => mocks.logger }));

vi.mock("@synap/database", () => ({
  activateFederatedMember: vi.fn(),
  and: vi.fn(),
  arrayContains: vi.fn(),
  assertFederatedAccessTarget: vi.fn(),
  bindExistingFederatedIdentity: mocks.bindExistingFederatedIdentity,
  consumeFederatedAssertionReceipt: mocks.consumeFederatedAssertionReceipt,
  consumeIssuerIdentityLinkReceipt: mocks.consumeIssuerIdentityLinkReceipt,
  createIssuerIdentityLinkReceipt: mocks.createIssuerIdentityLinkReceipt,
  eq: vi.fn(),
  FederatedApplicationConnectionService: class FederatedApplicationConnectionService {
    createAwaitingLocalAuth = mocks.createAwaitingLocalAuth;
    finalizeCompletion = mocks.finalizeCompletion;
    getCompletableRequest = mocks.getCompletableRequest;
    getRequest = mocks.getApplicationConnectionRequest;
    getStatusForContinuation = mocks.getApplicationConnectionStatus;
    releaseCompletion = mocks.releaseCompletion;
    reserveCompletion = mocks.reserveCompletion;
  },
  getDb: mocks.getDb,
  PodOwnerAlreadyClaimedError: class PodOwnerAlreadyClaimedError extends Error {},
  readPodUserAccess: vi.fn(),
  hasActivePodAccess: vi.fn(),
  seedAdminUser: vi.fn(),
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
  federatedApplicationConnections: {},
  federatedIdentityLinks: {},
  projectMembers: {},
  projects: {},
  users: {},
  workspaceMembers: {},
  workspaces: {},
}));

vi.mock("@synap/api", async () => ({
  // The real Pod Admin URL resolver (`../pod-admin-config.js` re-exports it
  // from @synap/api). Without it every start case read a 500.
  ...(await import("../../../../packages/api/src/utils/pod-admin-url.js")),
  // Mirrors the real contract (@synap/api jwks-client): PUBLIC_URL, no trailing slash.
  podAudience: () => process.env.PUBLIC_URL?.replace(/\/+$/, "") || null,
  createOpaqueApplicationConnectionValue: vi.fn(),
  hashOpaqueApplicationConnectionValue: (value: string) =>
    value === "r".repeat(32) ? "b".repeat(64) : `hash:${value}`,
  normalizeApplicationCallbackUrl: mocks.normalizeApplicationCallbackUrl,
  normalizeApplicationClientId: (value: string) => value,
  normalizeApplicationConnectionScopes:
    mocks.normalizeApplicationConnectionScopes,
  normalizeApplicationOrigin: (value: string) => value,
  normalizeIssuerUrl: (value: string) => value,
  normalizePublisherUrl: mocks.normalizePublisherUrl,
  verifyIssuerJwt: mocks.verifyIssuerJwt,
  verifyTrustedIssuerJwt: mocks.verifyTrustedIssuerJwt,
}));

import { federationRouter } from "./federation.js";

describe("application connection request boundary", () => {
  const now = Math.floor(Date.now() / 1_000);

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PUBLIC_URL = "https://pod.example.test";
    process.env.POD_ADMIN_URL = "https://pod-admin.example.test";
    mocks.normalizeApplicationCallbackUrl.mockImplementation(
      (value: string) => value
    );
    mocks.normalizeApplicationConnectionScopes.mockImplementation(
      (value: string[]) => value
    );
    mocks.normalizePublisherUrl.mockReturnValue(null);
  });

  afterEach(() => {
    delete process.env.PUBLIC_URL;
    delete process.env.POD_ADMIN_DOMAIN;
    delete process.env.POD_ADMIN_URL;
  });

  it("requires a top-level form rather than a cross-origin credentialed fetch", async () => {
    const response = await federationRouter.request(
      "/application-connections/requests/start",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: "ory_kratos_session=cookie-only",
          Origin: "https://app.example.test",
          Accept: "application/json",
        },
        body: JSON.stringify({
          issuerUrl: "https://issuer.example.test",
          azp: "com.example.crm",
          displayName: "Example CRM",
          origin: "https://app.example.test",
          callbackUrl: "https://app.example.test/auth/pod-return",
        }),
      }
    );

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      error: "Application setup must use a top-level form submission",
      code: "INVALID_APPLICATION_HANDOFF",
      remediation: "review_pod_connection_setup",
    });
    expect(mocks.createAwaitingLocalAuth).not.toHaveBeenCalled();
  });

  it("sends browser form failures to the Pod-owned Admin error surface", async () => {
    const response = await federationRouter.request(
      "/application-connections/requests/start",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://app.example.test",
        },
        body: "origin=https%3A%2F%2Fapp.example.test",
      }
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://pod-admin.example.test/connection-requests/error?code=INVALID_APPLICATION_HANDOFF"
    );
    expect(mocks.createAwaitingLocalAuth).not.toHaveBeenCalled();
  });

  it("starts one awaiting-local-auth request without a Pod credential", async () => {
    mocks.createAwaitingLocalAuth.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
    });
    const form = new URLSearchParams({
      requestId: "11111111-1111-4111-8111-111111111111",
      issuerUrl: "https://issuer.example.test",
      issuerSubject: "issuer-user-1",
      azp: "com.example.crm",
      displayName: "Example CRM",
      origin: "https://app.example.test",
      callbackUrl: "https://app.example.test/login",
      requestedScopes: JSON.stringify([
        "auth:exchange-user",
        "identity:link-user",
      ]),
      continuationHash: "a".repeat(64),
      redemptionHash: "b".repeat(64),
      redemptionSecret: "r".repeat(32),
    });
    const response = await federationRouter.request(
      "/application-connections/requests/start",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://app.example.test",
          Accept: "application/json",
        },
        body: form.toString(),
      }
    );

    expect(response.status).toBe(303);
    const location = response.headers.get("location");
    expect(location).toBe(
      "https://pod-admin.example.test/connection-requests/new?requestId=11111111-1111-4111-8111-111111111111#redeem=rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr"
    );
    const target = new URL(location!);
    expect(target.searchParams.get("redeem")).toBeNull();
    expect(target.hash).toBe("#redeem=rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr");
    expect(mocks.createAwaitingLocalAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "11111111-1111-4111-8111-111111111111",
        issuerSubject: "issuer-user-1",
        continuationHash: "a".repeat(64),
        redemptionHash: "b".repeat(64),
      })
    );
    expect(mocks.createAwaitingLocalAuth.mock.calls[0]?.[0]).not.toHaveProperty(
      "redemptionSecret"
    );
  });

  it("requires an explicit secure Pod Admin URL before persisting a request", async () => {
    delete process.env.POD_ADMIN_URL;
    const form = new URLSearchParams({
      requestId: "11111111-1111-4111-8111-111111111111",
      issuerUrl: "https://issuer.example.test",
      issuerSubject: "issuer-user-1",
      azp: "com.example.crm",
      displayName: "Example CRM",
      origin: "https://app.example.test",
      callbackUrl: "https://app.example.test/login",
      requestedScopes: JSON.stringify([
        "auth:exchange-user",
        "identity:link-user",
      ]),
      continuationHash: "a".repeat(64),
      redemptionHash: "b".repeat(64),
      redemptionSecret: "r".repeat(32),
    });

    const response = await federationRouter.request(
      "/application-connections/requests/start",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://app.example.test",
          Accept: "application/json",
        },
        body: form.toString(),
      }
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error:
        "This Pod needs a secure Pod Console URL before application access can be set up",
      code: "POD_ADMIN_URL_REQUIRED",
      remediation: "configure_pod_admin_url",
    });
    expect(mocks.createAwaitingLocalAuth).not.toHaveBeenCalled();
  });

  it("renders a safe HTML fallback for a browser handoff when Pod Admin is not configured", async () => {
    delete process.env.POD_ADMIN_URL;
    const form = new URLSearchParams({
      requestId: "11111111-1111-4111-8111-111111111111",
      issuerUrl: "https://issuer.example.test",
      issuerSubject: "issuer-user-1",
      azp: "com.example.crm",
      displayName: "Example CRM",
      origin: "https://app.example.test",
      callbackUrl: "https://app.example.test/login",
      requestedScopes: JSON.stringify(["identity:link-user"]),
      continuationHash: "a".repeat(64),
      redemptionHash: "b".repeat(64),
      redemptionSecret: "r".repeat(32),
    });

    const response = await federationRouter.request(
      "/application-connections/requests/start",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://app.example.test",
        },
        body: form.toString(),
      }
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("text/html");
    await expect(response.text()).resolves.toContain(
      "Pod connection needs configuration"
    );
    expect(mocks.createAwaitingLocalAuth).not.toHaveBeenCalled();
  });

  it("rejects a Pod Admin URL that disagrees with the deployed Admin hostname", async () => {
    process.env.POD_ADMIN_DOMAIN = "pod-admin.example.test";
    process.env.POD_ADMIN_URL = "https://different-admin.example.test";
    const form = new URLSearchParams({
      requestId: "11111111-1111-4111-8111-111111111111",
      issuerUrl: "https://issuer.example.test",
      issuerSubject: "issuer-user-1",
      azp: "com.example.crm",
      displayName: "Example CRM",
      origin: "https://app.example.test",
      callbackUrl: "https://app.example.test/login",
      requestedScopes: JSON.stringify(["identity:link-user"]),
      continuationHash: "a".repeat(64),
      redemptionHash: "b".repeat(64),
      redemptionSecret: "r".repeat(32),
    });

    const response = await federationRouter.request(
      "/application-connections/requests/start",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://app.example.test",
          Accept: "application/json",
        },
        body: form.toString(),
      }
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "POD_ADMIN_URL_INVALID",
      remediation: "configure_pod_admin_url",
    });
    expect(mocks.createAwaitingLocalAuth).not.toHaveBeenCalled();
  });

  it("rejects a Pod Admin path because the deployed console is a dedicated origin", async () => {
    process.env.POD_ADMIN_URL = "https://pod-admin.example.test/admin";
    const form = new URLSearchParams({
      requestId: "11111111-1111-4111-8111-111111111111",
      issuerUrl: "https://issuer.example.test",
      issuerSubject: "issuer-user-1",
      azp: "com.example.crm",
      displayName: "Example CRM",
      origin: "https://app.example.test",
      callbackUrl: "https://app.example.test/login",
      requestedScopes: JSON.stringify([
        "auth:exchange-user",
        "identity:link-user",
      ]),
      continuationHash: "a".repeat(64),
      redemptionHash: "b".repeat(64),
      redemptionSecret: "r".repeat(32),
    });

    const response = await federationRouter.request(
      "/application-connections/requests/start",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://app.example.test",
          Accept: "application/json",
        },
        body: form.toString(),
      }
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "POD_ADMIN_URL_INVALID",
      remediation: "configure_pod_admin_url",
    });
    expect(mocks.createAwaitingLocalAuth).not.toHaveBeenCalled();
  });

  it("answers a narrow credentialless status preflight", async () => {
    mocks.getApplicationConnectionRequest.mockResolvedValue({
      requestedOrigin: "https://app.example.test",
    });
    const response = await federationRouter.request(
      "/application-connections/requests/11111111-1111-4111-8111-111111111111/status",
      {
        method: "OPTIONS",
        headers: { Origin: "https://app.example.test" },
      }
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example.test"
    );
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
      "Content-Type"
    );
  });

  it("returns only lifecycle state to the app that holds the continuation", async () => {
    mocks.getApplicationConnectionRequest.mockResolvedValue({
      requestedOrigin: "https://app.example.test",
    });
    mocks.getApplicationConnectionStatus.mockResolvedValue({
      status: "pending",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });

    const response = await federationRouter.request(
      "/application-connections/requests/11111111-1111-4111-8111-111111111111/status",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://app.example.test",
        },
        body: JSON.stringify({ continuation: "c".repeat(32) }),
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "pending",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(mocks.getApplicationConnectionStatus).toHaveBeenCalledWith({
      requestId: "11111111-1111-4111-8111-111111111111",
      continuationHash: `hash:${"c".repeat(32)}`,
    });
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("recovers the persisted Pod receipt after a lost completion response", async () => {
    mocks.getApplicationConnectionRequest.mockResolvedValue({
      requestedOrigin: "https://app.example.test",
    });
    mocks.getApplicationConnectionStatus.mockResolvedValue({
      status: "completed",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      completion: {
        receiptId: "11111111-1111-4111-8111-111111111111",
        expiresAt: new Date("2030-01-01T00:05:00.000Z"),
      },
    });

    const response = await federationRouter.request(
      "/application-connections/requests/11111111-1111-4111-8111-111111111111/complete",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://app.example.test",
        },
        body: JSON.stringify({ continuation: "c".repeat(32) }),
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "completed",
      receiptId: "11111111-1111-4111-8111-111111111111",
      expiresAt: "2030-01-01T00:05:00.000Z",
    });
    expect(mocks.getCompletableRequest).not.toHaveBeenCalled();
  });

  it("mints one receipt when concurrent completions contend for a request", async () => {
    const request = {
      id: "11111111-1111-4111-8111-111111111111",
      issuerUrl: "https://issuer.example.test",
      issuerSubject: "issuer-user-1",
      clientId: "crm",
      requestedScopes: ["identity:link-user"],
      requestedByUserId: "pod-user-1",
      approvedConnectionId: "22222222-2222-4222-8222-222222222222",
    };
    const claims = {
      email: "person@example.test",
      exp: now + 300,
      iat: now,
      iss: request.issuerUrl,
      intentId: "claim-intent-1",
      jti: "identity-link-assertion-race",
      nonce: "a-long-enough-nonce-for-the-test",
      purpose: "identity-link" as const,
      sub: "issuer-user-1",
      type: "federated_assertion" as const,
      azp: request.clientId,
    };
    mocks.getApplicationConnectionRequest.mockResolvedValue({
      requestedOrigin: "https://app.example.test",
    });
    mocks.getApplicationConnectionStatus.mockResolvedValue({
      status: "approved",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      completion: null,
    });
    mocks.getCompletableRequest.mockResolvedValue(request);
    mocks.getByUrl.mockResolvedValue({
      allowedScopes: [],
      id: "issuer-1",
      issuerUrl: request.issuerUrl,
      status: "approved",
    });
    mocks.getDb.mockResolvedValue({
      query: {
        federatedApplicationConnections: {
          findFirst: vi.fn().mockResolvedValue({
            allowedOrigins: ["https://app.example.test"],
            allowedScopes: ["identity:link-user"],
          }),
        },
      },
    });
    mocks.verifyIssuerJwt.mockResolvedValue(claims);
    mocks.consumeFederatedAssertionReceipt.mockResolvedValue("consumed");
    mocks.reserveCompletion
      .mockResolvedValueOnce({ kind: "reserved", request })
      .mockResolvedValueOnce(null);
    mocks.bindExistingFederatedIdentity.mockResolvedValue({ status: "bound" });
    mocks.createIssuerIdentityLinkReceipt.mockResolvedValue({
      receiptId: "33333333-3333-4333-8333-333333333333",
      expiresAt: new Date("2030-01-01T00:05:00.000Z"),
    });
    mocks.finalizeCompletion.mockResolvedValue({ id: request.id });

    const makeCompletion = () =>
      federationRouter.request(
        `/application-connections/requests/${request.id}/complete`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://app.example.test",
          },
          body: JSON.stringify({
            continuation: "c".repeat(32),
            assertion: jwt.sign(claims, "test-secret", { algorithm: "HS256" }),
          }),
        }
      );

    const [first, second] = await Promise.all([
      makeCompletion(),
      makeCompletion(),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(mocks.createIssuerIdentityLinkReceipt).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeCompletion).toHaveBeenCalledTimes(1);
  });

  it("rejects a completion assertion whose subject differs from the subject committed at handoff start", async () => {
    const request = {
      id: "11111111-1111-4111-8111-111111111111",
      issuerUrl: "https://issuer.example.test",
      issuerSubject: "issuer-user-1",
      clientId: "crm",
      requestedScopes: ["identity:link-user"],
      requestedByUserId: "pod-user-1",
      approvedConnectionId: "22222222-2222-4222-8222-222222222222",
    };
    const claims = {
      email: "person@example.test",
      exp: now + 300,
      iat: now,
      iss: request.issuerUrl,
      intentId: "claim-intent-substitution",
      jti: "identity-link-assertion-substitution",
      nonce: "a-long-enough-nonce-for-the-test",
      purpose: "identity-link" as const,
      sub: "another-issuer-user",
      type: "federated_assertion" as const,
      azp: request.clientId,
    };
    mocks.getApplicationConnectionRequest.mockResolvedValue({
      requestedOrigin: "https://app.example.test",
    });
    mocks.getApplicationConnectionStatus.mockResolvedValue({
      status: "approved",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      completion: null,
    });
    mocks.getCompletableRequest.mockResolvedValue(request);
    mocks.getByUrl.mockResolvedValue({
      allowedScopes: [],
      id: "issuer-1",
      issuerUrl: request.issuerUrl,
      status: "approved",
    });
    mocks.verifyIssuerJwt.mockResolvedValue(claims);

    const response = await federationRouter.request(
      `/application-connections/requests/${request.id}/complete`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://app.example.test",
        },
        body: JSON.stringify({
          continuation: "c".repeat(32),
          assertion: jwt.sign(claims, "test-secret", { algorithm: "HS256" }),
        }),
      }
    );

    expect(response.status).toBe(401);
    expect(mocks.reserveCompletion).not.toHaveBeenCalled();
    expect(mocks.consumeFederatedAssertionReceipt).not.toHaveBeenCalled();
  });

  it("renews an expired completion receipt with a fresh assertion without rebinding the Pod identity", async () => {
    const request = {
      id: "11111111-1111-4111-8111-111111111111",
      issuerUrl: "https://issuer.example.test",
      issuerSubject: "issuer-user-1",
      clientId: "crm",
      requestedScopes: ["identity:link-user"],
      requestedByUserId: "pod-user-1",
      approvedConnectionId: "22222222-2222-4222-8222-222222222222",
      completedAt: new Date("2029-12-31T23:59:00.000Z"),
    };
    const claims = {
      email: "person@example.test",
      exp: now + 300,
      iat: now,
      iss: request.issuerUrl,
      intentId: "renewed-claim-intent",
      jti: "identity-link-assertion-renewal",
      nonce: "a-fresh-long-enough-nonce-for-the-test",
      purpose: "identity-link" as const,
      sub: request.issuerSubject,
      type: "federated_assertion" as const,
      azp: request.clientId,
    };
    mocks.getApplicationConnectionRequest.mockResolvedValue({
      requestedOrigin: "https://app.example.test",
    });
    mocks.getApplicationConnectionStatus.mockResolvedValue({
      status: "completed",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      completion: null,
    });
    mocks.getCompletableRequest.mockResolvedValue(request);
    mocks.getByUrl.mockResolvedValue({
      allowedScopes: [],
      id: "issuer-1",
      issuerUrl: request.issuerUrl,
      status: "approved",
    });
    mocks.getDb.mockResolvedValue({
      query: {
        federatedApplicationConnections: {
          findFirst: vi.fn().mockResolvedValue({
            allowedOrigins: ["https://app.example.test"],
            allowedScopes: ["identity:link-user"],
          }),
        },
      },
    });
    mocks.verifyIssuerJwt.mockResolvedValue(claims);
    mocks.consumeFederatedAssertionReceipt.mockResolvedValue("consumed");
    mocks.reserveCompletion.mockResolvedValue({ kind: "reserved", request });
    mocks.createIssuerIdentityLinkReceipt.mockResolvedValue({
      receiptId: "33333333-3333-4333-8333-333333333333",
      expiresAt: new Date("2030-01-01T00:05:00.000Z"),
    });
    mocks.finalizeCompletion.mockResolvedValue({ id: request.id });

    const response = await federationRouter.request(
      `/application-connections/requests/${request.id}/complete`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://app.example.test",
        },
        body: JSON.stringify({
          continuation: "c".repeat(32),
          assertion: jwt.sign(claims, "test-secret", { algorithm: "HS256" }),
        }),
      }
    );

    expect(response.status).toBe(200);
    expect(mocks.bindExistingFederatedIdentity).not.toHaveBeenCalled();
    expect(mocks.createIssuerIdentityLinkReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        issuerSubject: request.issuerSubject,
        userId: request.requestedByUserId,
      })
    );
  });

  it("recovers a transient post-consumption failure only within the same request replay context", async () => {
    const request = {
      id: "11111111-1111-4111-8111-111111111111",
      issuerUrl: "https://issuer.example.test",
      issuerSubject: "issuer-user-1",
      clientId: "crm",
      requestedScopes: ["identity:link-user"],
      requestedByUserId: "pod-user-1",
      approvedConnectionId: "22222222-2222-4222-8222-222222222222",
      completedAt: null,
    };
    const claims = {
      email: "person@example.test",
      exp: now + 300,
      iat: now,
      iss: request.issuerUrl,
      intentId: "retry-claim-intent",
      jti: "identity-link-assertion-retry",
      nonce: "a-long-enough-retry-nonce-for-the-test",
      purpose: "identity-link" as const,
      sub: request.issuerSubject,
      type: "federated_assertion" as const,
      azp: request.clientId,
    };
    mocks.getApplicationConnectionRequest.mockResolvedValue({
      requestedOrigin: "https://app.example.test",
    });
    mocks.getApplicationConnectionStatus.mockResolvedValue({
      status: "approved",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      completion: null,
    });
    mocks.getCompletableRequest.mockResolvedValue(request);
    mocks.getByUrl.mockResolvedValue({
      allowedScopes: [],
      id: "issuer-1",
      issuerUrl: request.issuerUrl,
      status: "approved",
    });
    mocks.getDb.mockResolvedValue({
      query: {
        federatedApplicationConnections: {
          findFirst: vi.fn().mockResolvedValue({
            allowedOrigins: ["https://app.example.test"],
            allowedScopes: ["identity:link-user"],
          }),
        },
      },
    });
    mocks.verifyIssuerJwt.mockResolvedValue(claims);
    mocks.consumeFederatedAssertionReceipt
      .mockResolvedValueOnce("consumed")
      .mockResolvedValueOnce("recovered");
    mocks.reserveCompletion
      .mockResolvedValueOnce({ kind: "reserved", request })
      .mockResolvedValueOnce({ kind: "reserved", request });
    mocks.releaseCompletion.mockResolvedValue(undefined);
    mocks.bindExistingFederatedIdentity.mockResolvedValue({ status: "bound" });
    mocks.createIssuerIdentityLinkReceipt
      .mockRejectedValueOnce(new Error("transient receipt write"))
      .mockResolvedValueOnce({
        receiptId: "33333333-3333-4333-8333-333333333333",
        expiresAt: new Date("2030-01-01T00:05:00.000Z"),
      });
    mocks.finalizeCompletion.mockResolvedValue({ id: request.id });

    const makeCompletion = () =>
      federationRouter.request(
        `/application-connections/requests/${request.id}/complete`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://app.example.test",
          },
          body: JSON.stringify({
            continuation: "c".repeat(32),
            assertion: jwt.sign(claims, "test-secret", { algorithm: "HS256" }),
          }),
        }
      );

    expect((await makeCompletion()).status).toBe(503);
    expect((await makeCompletion()).status).toBe(200);
    expect(mocks.consumeFederatedAssertionReceipt).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replayContext: `application-connection:${request.id}`,
      })
    );
    expect(mocks.releaseCompletion).toHaveBeenCalledTimes(1);
  });

  it("rejects an application identity link that is missing a signed application identifier", async () => {
    const claims = {
      email: "person@example.test",
      exp: now + 300,
      iat: now,
      iss: "https://issuer.example.test",
      intentId: "intent-1",
      jti: "identity-link-assertion-1",
      nonce: "a-long-enough-nonce-for-the-test",
      purpose: "identity-link" as const,
      sub: "issuer-user-1",
      type: "federated_assertion" as const,
    };
    mocks.verifyIssuerJwt.mockResolvedValue(claims);
    mocks.getByUrl.mockResolvedValue({
      allowedScopes: ["identity:link-user"],
      id: "issuer-1",
      issuerUrl: claims.iss,
      status: "approved",
    });
    mocks.getDb.mockResolvedValue({
      query: {
        users: {
          findFirst: vi.fn().mockResolvedValue({
            id: "pod-user-1",
            email: claims.email,
          }),
        },
      },
    });

    const response = await federationRouter.request(
      "/identity-links?application_id=crm&issuer_url=https%3A%2F%2Fissuer.example.test",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assertion: jwt.sign(claims, "test-secret", { algorithm: "HS256" }),
        }),
      }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "APPLICATION_IDENTIFIER_REQUIRED",
    });
  });

  it("consumes an app-authorized receipt through its exact approved connection", async () => {
    const claims = {
      exp: now + 300,
      iat: now,
      iss: "https://issuer.example.test",
      intentId: "intent-1",
      jti: "identity-link-receipt-1",
      nonce: "a-long-enough-nonce-for-the-test",
      purpose: "identity-link-receipt" as const,
      sub: "issuer-user-1",
      type: "federated_assertion" as const,
      azp: "crm",
    };
    mocks.verifyIssuerJwt.mockResolvedValue(claims);
    mocks.getByUrl.mockResolvedValue({
      // Deliberately no issuer-wide identity-link scope: this route must use
      // the exact application connection instead.
      allowedScopes: [],
      id: "issuer-1",
      issuerUrl: claims.iss,
      status: "approved",
    });
    mocks.getDb.mockResolvedValue({
      query: {
        federatedApplicationConnections: {
          findFirst: vi.fn().mockResolvedValue({
            allowedOrigins: [],
            allowedScopes: ["identity:link-user"],
          }),
        },
      },
    });
    mocks.consumeIssuerIdentityLinkReceipt.mockResolvedValue({
      status: "expired",
    });
    mocks.consumeFederatedAssertionReceipt.mockResolvedValue("consumed");

    const response = await federationRouter.request("/identity-links/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        receiptId: "11111111-1111-4111-8111-111111111111",
        assertion: jwt.sign(claims, "test-secret", { algorithm: "HS256" }),
      }),
    });

    // A 409 proves the receipt reached its one-time-consumption boundary. A
    // 401/403 here would mean app-only approval was incorrectly rejected.
    expect(response.status).toBe(409);
    expect(mocks.consumeIssuerIdentityLinkReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        issuerId: "issuer-1",
        issuerSubject: claims.sub,
        intentId: claims.intentId,
      })
    );
  });
});

/**
 * The account hint on the start form: the issuer's signed identity-link
 * assertion, so Pod Admin can name the account that will receive access.
 * `verifyIssuerJwt` is mocked to accept exactly ONE token (`SIGNED`), so a
 * route that trusted decoded claims instead of the verifier would turn the
 * forged case below red.
 */
describe("application connection start — account hint", () => {
  const ISSUER = "https://issuer.example.test";
  const AUDIENCE = "https://pod.example.test";
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const claimsFor = (overrides: Record<string, unknown> = {}) => ({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "issuer-user-1",
    email: "Ada@Example.test",
    type: "federated_assertion",
    purpose: "identity-link",
    intentId: "intent-1",
    nonce: "n".repeat(32),
    azp: "com.example.crm",
    iat: nowSeconds,
    exp: nowSeconds + 300,
    jti: "jti-1",
    ...overrides,
  });
  // Decodable shape only; the signature is the mocked verifier's business.
  const tokenFor = (claims: Record<string, unknown>, key = "issuer-key") =>
    jwt.sign(claims, key, { algorithm: "HS256" });
  const SIGNED = tokenFor(claimsFor());

  const start = (assertion?: string) => {
    const form = new URLSearchParams({
      requestId: "11111111-1111-4111-8111-111111111111",
      issuerUrl: ISSUER,
      issuerSubject: "issuer-user-1",
      azp: "com.example.crm",
      displayName: "Example CRM",
      origin: "https://app.example.test",
      callbackUrl: "https://app.example.test/login",
      requestedScopes: JSON.stringify([
        "auth:exchange-user",
        "identity:link-user",
      ]),
      continuationHash: "a".repeat(64),
      redemptionHash: "b".repeat(64),
      redemptionSecret: "r".repeat(32),
      ...(assertion !== undefined ? { assertion } : {}),
    });
    return federationRouter.request("/application-connections/requests/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://app.example.test",
        Accept: "application/json",
      },
      body: form.toString(),
    });
  };
  const storedMetadata = () =>
    mocks.createAwaitingLocalAuth.mock.calls[0]?.[0]?.requestMetadata;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PUBLIC_URL = AUDIENCE;
    process.env.POD_ADMIN_URL = "https://pod-admin.example.test";
    mocks.normalizeApplicationCallbackUrl.mockImplementation(
      (value: string) => value
    );
    mocks.normalizeApplicationConnectionScopes.mockImplementation(
      (value: string[]) => value
    );
    mocks.normalizePublisherUrl.mockReturnValue(null);
    mocks.createAwaitingLocalAuth.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
    });
    mocks.getByUrl.mockImplementation(async (url: string) =>
      url === ISSUER
        ? { id: "issuer-1", issuerUrl: ISSUER, status: "approved" }
        : null
    );
    mocks.verifyIssuerJwt.mockImplementation(async (token: string) =>
      token === SIGNED ? claimsFor() : null
    );
  });

  afterEach(() => {
    delete process.env.PUBLIC_URL;
    delete process.env.POD_ADMIN_URL;
  });

  it("records the verified account from an approved issuer, without spending the JTI", async () => {
    const response = await start(SIGNED);

    expect(response.status).toBe(303);
    expect(mocks.verifyIssuerJwt).toHaveBeenCalledWith(
      SIGNED,
      ISSUER,
      AUDIENCE,
      { consumeJti: false }
    );
    expect(storedMetadata()).toEqual({
      requestedVia: "browser-pod-admin-handoff",
      requesterAccount: {
        verifiedEmail: "ada@example.test",
        verifiedAt: expect.any(String),
        issuerUrl: ISSUER,
      },
    });
    expect(
      Number.isNaN(Date.parse(storedMetadata().requesterAccount.verifiedAt))
    ).toBe(false);
  });

  it("keeps the origin the issuer vouched for, for the invite-consent rule", async () => {
    mocks.verifyIssuerJwt.mockImplementation(async (token: string) =>
      token === SIGNED
        ? claimsFor({ origin: "https://app.example.test" })
        : null
    );
    expect((await start(SIGNED)).status).toBe(303);
    expect(storedMetadata().requesterAccount).toMatchObject({
      vouchedOrigin: "https://app.example.test",
    });
  });

  it("ignores a forged or unsigned hint: the request starts Not verified", async () => {
    const forged = tokenFor(
      claimsFor({ email: "mallory@example.test" }),
      "attacker-key"
    );
    const unsigned = jwt.sign(claimsFor(), "", { algorithm: "none" });

    for (const assertion of [forged, unsigned, "not-a-jwt"]) {
      mocks.createAwaitingLocalAuth.mockClear();
      const response = await start(assertion);
      expect(response.status).toBe(303);
      expect(storedMetadata()).toEqual({
        requestedVia: "browser-pod-admin-handoff",
      });
    }
  });

  it("starts without a hint exactly as before", async () => {
    const response = await start();
    expect(response.status).toBe(303);
    expect(storedMetadata()).toEqual({
      requestedVia: "browser-pod-admin-handoff",
    });
    expect(mocks.getByUrl).not.toHaveBeenCalled();
    expect(mocks.verifyIssuerJwt).not.toHaveBeenCalled();
  });

  it("never fetches keys for an issuer this Pod has not approved", async () => {
    // Pending in the registry, unknown to it, and named only by the token.
    mocks.getByUrl.mockResolvedValueOnce({
      id: "issuer-1",
      issuerUrl: ISSUER,
      status: "pending",
    });
    expect((await start(SIGNED)).status).toBe(303);
    mocks.getByUrl.mockResolvedValueOnce(null);
    expect((await start(SIGNED)).status).toBe(303);
    const elsewhere = tokenFor(claimsFor({ iss: "https://evil.example.test" }));
    expect((await start(elsewhere)).status).toBe(303);

    expect(mocks.verifyIssuerJwt).not.toHaveBeenCalled();
    expect(mocks.getByUrl).not.toHaveBeenCalledWith(
      "https://evil.example.test"
    );
    for (const [input] of mocks.createAwaitingLocalAuth.mock.calls) {
      expect(input.requestMetadata).not.toHaveProperty("requesterAccount");
    }
  });

  it.each([
    ["another subject", { sub: "issuer-user-2" }],
    ["another app", { azp: "com.example.other" }],
    ["no app", { azp: undefined }],
  ])("refuses a validly signed hint for %s", async (_label, overrides) => {
    mocks.verifyIssuerJwt.mockImplementation(async (token: string) =>
      token === SIGNED ? claimsFor(overrides) : null
    );

    const response = await start(SIGNED);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "INVALID_APPLICATION_HANDOFF",
    });
    expect(mocks.createAwaitingLocalAuth).not.toHaveBeenCalled();
  });
});
