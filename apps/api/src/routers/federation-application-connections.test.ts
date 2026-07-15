import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getByUrl: vi.fn(),
  getDb: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  consumeIssuerIdentityLinkReceipt: vi.fn(),
  consumeFederatedAssertionReceipt: vi.fn(),
  verifyIssuerJwt: vi.fn(),
  verifyTrustedIssuerJwt: vi.fn(),
}));

vi.mock("@synap/auth", () => ({
  // The request-start endpoint is intentionally direct-Pod-session only.
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
  assertFederatedAccessTarget: vi.fn(),
  bindExistingFederatedIdentity: vi.fn(),
  consumeFederatedAssertionReceipt: mocks.consumeFederatedAssertionReceipt,
  consumeIssuerIdentityLinkReceipt: mocks.consumeIssuerIdentityLinkReceipt,
  createIssuerIdentityLinkReceipt: vi.fn(),
  eq: vi.fn(),
  FederatedApplicationConnectionService: class FederatedApplicationConnectionService {},
  getDb: mocks.getDb,
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
  federatedApplicationConnections: {},
  federatedIdentityLinks: {},
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
  normalizeApplicationClientId: (value: string) => value,
  normalizeApplicationConnectionScopes: vi.fn(),
  normalizeApplicationOrigin: (value: string) => value,
  normalizeIssuerUrl: (value: string) => value,
  normalizePublisherUrl: vi.fn(),
  verifyIssuerJwt: mocks.verifyIssuerJwt,
  verifyTrustedIssuerJwt: mocks.verifyTrustedIssuerJwt,
}));

import { federationRouter } from "./federation.js";

describe("application connection request boundary", () => {
  const now = Math.floor(Date.now() / 1_000);

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PUBLIC_URL = "https://pod.example.test";
  });

  afterEach(() => {
    delete process.env.PUBLIC_URL;
  });

  it("rejects cookie-only requests before parsing or storing a callback", async () => {
    const response = await federationRouter.request(
      "/application-connections/requests",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: "ory_kratos_session=cookie-only",
          Origin: "https://app.example.test",
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

    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example.test"
    );
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error: "X-Session-Token is required for this Pod approval request",
    });
  });

  it("answers a strict, credentialless request preflight", async () => {
    const response = await federationRouter.request(
      "/application-connections/requests",
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
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain(
      "X-Session-Token"
    );
  });

  it("rejects an application exchange that is missing a signed application identifier", async () => {
    const claims = {
      email: "person@example.test",
      exp: now + 300,
      iat: now,
      iss: "https://issuer.example.test",
      jti: "exchange-assertion-1",
      purpose: "user-exchange" as const,
      sub: "issuer-user-1",
      type: "federated_assertion" as const,
    };
    mocks.verifyIssuerJwt.mockResolvedValue(claims);
    mocks.getByUrl.mockResolvedValue({
      allowedScopes: ["auth:exchange-user"],
      id: "issuer-1",
      issuerUrl: claims.iss,
      status: "approved",
    });

    const response = await federationRouter.request(
      "/exchange?application_id=crm&issuer_url=https%3A%2F%2Fissuer.example.test",
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
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("requires the browser endpoint application id to match the signed exchange azp", async () => {
    const claims = {
      email: "person@example.test",
      exp: now + 300,
      iat: now,
      iss: "https://issuer.example.test",
      jti: "exchange-assertion-2",
      purpose: "user-exchange" as const,
      sub: "issuer-user-1",
      type: "federated_assertion" as const,
      azp: "crm",
    };
    mocks.verifyIssuerJwt.mockResolvedValue(claims);
    mocks.getByUrl.mockResolvedValue({
      allowedScopes: ["auth:exchange-user"],
      id: "issuer-1",
      issuerUrl: claims.iss,
      status: "approved",
    });

    const response = await federationRouter.request(
      "/exchange?application_id=another-app",
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
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("rejects a browser origin that is not approved for the signed issuer and client", async () => {
    const claims = {
      email: "person@example.test",
      exp: now + 300,
      iat: now,
      iss: "https://issuer.example.test",
      jti: "exchange-assertion-3",
      purpose: "user-exchange" as const,
      sub: "issuer-user-1",
      type: "federated_assertion" as const,
      azp: "crm",
    };
    mocks.verifyIssuerJwt.mockResolvedValue(claims);
    mocks.getByUrl.mockResolvedValue({
      allowedScopes: ["auth:exchange-user"],
      id: "issuer-1",
      issuerUrl: claims.iss,
      status: "approved",
    });
    mocks.getDb.mockResolvedValue({
      query: {
        federatedApplicationConnections: {
          findFirst: vi.fn().mockResolvedValue({
            allowedOrigins: ["https://approved.example.test"],
            allowedScopes: ["auth:exchange-user"],
          }),
        },
      },
    });

    const response = await federationRouter.request(
      "/exchange?application_id=crm&issuer_url=https%3A%2F%2Fissuer.example.test",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://other.example.test",
        },
        body: JSON.stringify({
          assertion: jwt.sign(claims, "test-secret", { algorithm: "HS256" }),
        }),
      }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "APPLICATION_CONNECTION_APPROVAL_REQUIRED",
    });
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
