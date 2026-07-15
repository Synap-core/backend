import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  and: vi.fn(),
  arrayContains: vi.fn(),
  eq: vi.fn(),
  findFirst: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("@synap/database", () => ({
  and: mocks.and,
  arrayContains: mocks.arrayContains,
  eq: mocks.eq,
  federatedApplicationConnections: {
    allowedOrigins: "allowedOrigins",
    clientId: "clientId",
    issuerId: "issuerId",
    status: "status",
  },
  trustedIssuers: {
    id: "issuerId",
    issuerUrl: "issuerUrl",
    status: "issuerStatus",
  },
  getDb: mocks.getDb,
}));

vi.mock("@synap/api", () => ({
  normalizeIssuerUrl: (value: string) => value,
}));

vi.mock("./middleware/security.js", () => ({
  getCorsOrigins: () => [],
}));

import {
  isApprovedApplicationOrigin,
  isApprovedApplicationOriginForClient,
  rejectsUnapprovedExternalPodApiRequest,
} from "./cors-origin.js";

describe("approved application origin CORS policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockResolvedValue({
      query: {
        federatedApplicationConnections: { findFirst: mocks.findFirst },
        trustedIssuers: { findFirst: mocks.findFirst },
      },
    });
  });

  it("admits only an exact owner-approved browser origin", async () => {
    mocks.findFirst
      .mockResolvedValueOnce({ issuerId: "issuer-1" })
      .mockResolvedValueOnce({ id: "issuer-1" });

    await expect(
      isApprovedApplicationOrigin("https://crm.example.test")
    ).resolves.toBe(true);
    expect(mocks.arrayContains).toHaveBeenCalledWith("allowedOrigins", [
      "https://crm.example.test",
    ]);
    expect(mocks.eq).toHaveBeenCalledWith("status", "approved");
  });

  it("fails closed for unapproved, malformed, or unavailable origins", async () => {
    mocks.findFirst.mockResolvedValue(null);
    await expect(
      isApprovedApplicationOrigin("https://other.example.test")
    ).resolves.toBe(false);
    await expect(isApprovedApplicationOrigin("null")).resolves.toBe(false);
    mocks.getDb.mockRejectedValue(new Error("database unavailable"));
    await expect(
      isApprovedApplicationOrigin("https://crm.example.test")
    ).resolves.toBe(false);
  });

  it("withdraws application CORS when its issuer is revoked", async () => {
    mocks.findFirst
      .mockResolvedValueOnce({ issuerId: "issuer-1" })
      .mockResolvedValueOnce(null);

    await expect(
      isApprovedApplicationOrigin("https://crm.example.test")
    ).resolves.toBe(false);
  });

  it("binds federation bootstrap CORS to the exact approved client", async () => {
    mocks.findFirst
      .mockResolvedValueOnce({ id: "issuer-1" })
      .mockResolvedValueOnce({ id: "connection-1" });

    await expect(
      isApprovedApplicationOriginForClient(
        "https://crm.example.test",
        "crm",
        "https://issuer.example.test"
      )
    ).resolves.toBe(true);
    expect(mocks.eq).toHaveBeenCalledWith("clientId", "crm");

    await expect(
      isApprovedApplicationOriginForClient(
        "https://crm.example.test",
        undefined,
        "https://issuer.example.test"
      )
    ).resolves.toBe(false);
  });

  it("server-rejects a revoked external origin even if a browser cached preflight", () => {
    expect(
      rejectsUnapprovedExternalPodApiRequest({
        origin: "https://crm.example.test",
        firstPartyOrigin: false,
        approvedApplicationOrigin: false,
        path: "/trpc/entities.list",
        method: "POST",
      })
    ).toBe(true);
    expect(
      rejectsUnapprovedExternalPodApiRequest({
        origin: "https://crm.example.test",
        firstPartyOrigin: false,
        approvedApplicationOrigin: false,
        path: "/api/federation/application-connections/requests",
        method: "POST",
      })
    ).toBe(false);
  });
});
