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
  getDb: mocks.getDb,
}));

vi.mock("./middleware/security.js", () => ({
  getCorsOrigins: () => [],
}));

import {
  isApprovedApplicationOrigin,
  isApprovedApplicationOriginForClient,
  rejectsUnapprovedExternalPodApiRequest,
} from "./cors-origin.js";

describe("approved application origin CORS policy (origin allowlist plane)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockResolvedValue({
      query: {
        federatedApplicationConnections: { findFirst: mocks.findFirst },
      },
    });
  });

  it("admits only an exact owner-approved browser origin", async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: "connection-1" });

    await expect(
      isApprovedApplicationOrigin("https://crm.example.test")
    ).resolves.toBe(true);
    expect(mocks.arrayContains).toHaveBeenCalledWith("allowedOrigins", [
      "https://crm.example.test",
    ]);
    expect(mocks.eq).toHaveBeenCalledWith("status", "approved");
  });

  it("does not consult trusted issuers for transport admission", async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: "connection-1" });
    await expect(
      isApprovedApplicationOrigin("https://crm.example.test")
    ).resolves.toBe(true);
    // Single connection lookup only — no second issuer status query.
    expect(mocks.findFirst).toHaveBeenCalledTimes(1);
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

  it("can optionally scope origin admission to an application client id", async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: "connection-1" });

    await expect(
      isApprovedApplicationOriginForClient(
        "https://crm.example.test",
        "crm",
        "https://issuer.example.test" // ignored for transport
      )
    ).resolves.toBe(true);
    expect(mocks.eq).toHaveBeenCalledWith("clientId", "crm");

    mocks.findFirst.mockResolvedValueOnce(null);
    await expect(
      isApprovedApplicationOriginForClient(
        "https://crm.example.test",
        "unknown-app",
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
        path: "/api/federation/application-connections/requests/request-id/status",
        method: "POST",
      })
    ).toBe(false);
  });
});
