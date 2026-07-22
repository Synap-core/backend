import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  isAllowedOrigin,
  isApprovedApplicationOrigin,
  isApprovedApplicationOriginForClient,
  rejectsUnapprovedExternalPodApiRequest,
} from "./cors-origin.js";

describe("first-party base domain (self-healing from PUBLIC_URL)", () => {
  const KEYS = [
    "SYNAP_BASE_DOMAIN",
    "PUBLIC_URL",
    "DOMAIN",
    "ALLOWED_ORIGINS",
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])) as Record<
      string,
      string | undefined
    >;
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("derives the base from PUBLIC_URL when SYNAP_BASE_DOMAIN is unset — a sibling surface is first-party", () => {
    process.env.PUBLIC_URL = "https://pod.thearch.synap.live";
    expect(isAllowedOrigin("https://pod-admin.thearch.synap.live")).toBe(true);
    expect(isAllowedOrigin("https://pod.thearch.synap.live")).toBe(true);
  });

  it("self-heals a STALE SYNAP_BASE_DOMAIN left over from a previous domain", () => {
    process.env.SYNAP_BASE_DOMAIN = "team.thearchitech.xyz"; // pre-migration value
    process.env.PUBLIC_URL = "https://pod.thearch.synap.live";
    // the new sibling is first-party (healed to the current PUBLIC_URL) …
    expect(isAllowedOrigin("https://pod-admin.thearch.synap.live")).toBe(true);
    // … and the stale base no longer admits its old siblings
    expect(isAllowedOrigin("https://pod-admin.team.thearchitech.xyz")).toBe(
      false
    );
  });

  it("honors an explicit SYNAP_BASE_DOMAIN when the pod lives under it (incl. a broader base)", () => {
    process.env.SYNAP_BASE_DOMAIN = "synap.live"; // intentionally broad
    process.env.PUBLIC_URL = "https://pod.thearch.synap.live";
    expect(isAllowedOrigin("https://crm.synap.live")).toBe(true);
    expect(isAllowedOrigin("https://pod-admin.thearch.synap.live")).toBe(true);
  });

  it("trusts an explicit base for a custom apex domain it cannot derive", () => {
    process.env.SYNAP_BASE_DOMAIN = "mycorp.io";
    process.env.PUBLIC_URL = "https://synap.mycorp.io"; // no pod/pod-admin prefix → not derivable
    expect(isAllowedOrigin("https://app.mycorp.io")).toBe(true);
  });

  it("never widens to a bare TLD (security guard)", () => {
    // pod.io would strip to "io"; the ≥2-label guard rejects that
    process.env.PUBLIC_URL = "https://pod.io";
    expect(isAllowedOrigin("https://evil.io")).toBe(false);
    // the pod's own exact origin still works via the explicit PUBLIC_URL allowlist
    expect(isAllowedOrigin("https://pod.io")).toBe(true);
  });
});

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
