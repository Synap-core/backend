/**
 * `GET /api/provision/diagnose-intelligence` used to return the first 12
 * characters of the DECRYPTED Intelligence Service key (security wave
 * 2026-10-13, LOW list). It now returns a fingerprint (`sha256:` + 8 hex) and
 * no character of the key.
 *
 * It was also PUBLIC: anyone read the shared intelligence service's private
 * address and key fingerprint, and each anonymous hit made the pod fire two
 * probes at it (audit pod-doors F4). It is now for the pod's Control Plane, a
 * pod admin, or an in-container (loopback) caller: anyone else gets a 401 and
 * nothing is resolved or probed.
 *
 * Real route handler; the serving-service resolver, the key decrypt and the
 * probe are stubbed at their module edges.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const FAKE_KEY = "test-secret-is-key-0123456789abcdef";

vi.mock("@synap-core/core", () => {
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  return { createLogger: () => log };
});
vi.mock("bcrypt", () => ({ default: {} }));
vi.mock("./pod-updates-deps.js", () => ({
  readPodUpdateSettingsRaw: async () => undefined,
}));
const { probeIntelligenceService } = vi.hoisted(() => ({
  probeIntelligenceService: vi.fn(async () => ({ reachable: false })),
}));
vi.mock("./provision-intelligence-probe.js", () => ({
  probeIntelligenceService,
}));
// provision.ts imports the account-recovery deps; the real module pulls
// @synap/jobs in, which this test's @synap/database stub cannot satisfy.
vi.mock("./account-recovery-deps.js", () => ({
  findAccountByIdentity: vi.fn(),
  isPodAdmin: vi.fn(),
}));
vi.mock("@synap/api", () => ({
  // Mirrors the real contract (@synap/api jwks-client): PUBLIC_URL, no trailing slash.
  podAudience: () => process.env.PUBLIC_URL?.replace(/\/+$/, "") || null,
  createAndVerifyHubInboundKey: vi.fn(),
  encryptServiceKey: vi.fn(),
  describeServingIntelligence: vi.fn(async () => ({
    service: {
      apiKey: "encrypted-blob",
      enabled: true,
      status: "active",
    },
    url: "http://is.invalid",
    via: "pod_default",
  })),
  envIntelligenceEndpoint: vi.fn(),
  getSyncGenerationState: vi.fn(),
  resolveServiceKey: () => FAKE_KEY,
  toRegistrationTrace: vi.fn(),
  verifyTrustedIssuerJwt: vi.fn(),
}));
vi.mock("@synap/database", () => ({
  getDb: vi.fn(),
  readControlPlaneLink: async () => ({ issuer: "https://cp.test.invalid" }),
  eq: vi.fn(),
  and: vi.fn(),
  sql: vi.fn(),
  drizzleSql: vi.fn(),
  EventRepository: vi.fn(),
  ApiKeyRepository: vi.fn(),
  TrustedIssuerService: vi.fn(),
}));
vi.mock("@synap/database/api-key-revocation", () => ({
  revokeApiKeys: vi.fn(),
}));
vi.mock("@synap/database/schema", () => ({
  workspaces: {},
  intelligenceServices: {},
  users: {},
  workspaceMembers: {},
  apiKeys: {},
}));

const { provisionRouter } = await import("./provision.js");

/** The pod's Control Plane, through the trusted-issuer door. */
async function asControlPlane(): Promise<Response> {
  const { verifyTrustedIssuerJwt } = await import("@synap/api");
  vi.mocked(verifyTrustedIssuerJwt).mockResolvedValue({ type: "pod-status" });
  vi.stubEnv("PUBLIC_URL", "https://pod.test.invalid");
  try {
    return await provisionRouter.request("/diagnose-intelligence", {
      headers: { Authorization: "Bearer test-cp-jwt" },
    });
  } finally {
    vi.unstubAllEnvs();
  }
}

/** A Node socket peer, the way @hono/node-server hands it to a route. */
const peer = (remoteAddress: string) => ({
  incoming: { socket: { remoteAddress } },
});

describe("GET /diagnose-intelligence — who may read it (audit pod-doors F4)", () => {
  it("an anonymous caller gets 401, and nothing is resolved or probed", async () => {
    const { describeServingIntelligence } = await import("@synap/api");
    vi.mocked(describeServingIntelligence).mockClear();
    probeIntelligenceService.mockClear();
    const res = await provisionRouter.request(
      "/diagnose-intelligence",
      {},
      peer("203.0.113.7")
    );
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain("is.invalid");
    expect(text).not.toContain("sha256:");
    expect(vi.mocked(describeServingIntelligence)).not.toHaveBeenCalled();
    expect(probeIntelligenceService).not.toHaveBeenCalled();
  });

  it("a loopback peer behind a proxy header is not in-container: 401", async () => {
    const res = await provisionRouter.request(
      "/diagnose-intelligence",
      { headers: { "x-forwarded-for": "203.0.113.7" } },
      peer("127.0.0.1")
    );
    expect(res.status).toBe(401);
  });

  it("an in-container (loopback) caller reads it", async () => {
    const res = await provisionRouter.request(
      "/diagnose-intelligence",
      {},
      peer("127.0.0.1")
    );
    expect(res.status).toBe(200);
  });

  it("the pod's Control Plane reads it", async () => {
    expect((await asControlPlane()).status).toBe(200);
  });
});

describe("GET /diagnose-intelligence", () => {
  it("returns a fingerprint of the IS key, never any of its characters", async () => {
    const res = await asControlPlane();
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as {
      resolved: { source: string };
      auth: Record<string, unknown>;
    };
    // Non-vacuous: the decrypt branch really ran (a database-sourced service).
    expect(body.resolved.source).toBe("database");

    const expected = `sha256:${createHash("sha256").update(FAKE_KEY).digest("hex").slice(0, 8)}`;
    expect(body.auth.keyFingerprint).toBe(expected);
    expect(body.auth).not.toHaveProperty("keyPrefix");
    // No run of 6+ characters of the key appears anywhere in the response.
    for (let i = 0; i + 6 <= FAKE_KEY.length; i++) {
      expect(text).not.toContain(FAKE_KEY.slice(i, i + 6));
    }
  });
});

/**
 * `GET /api/provision/debug` (issuer-authenticated, rendered by the CP admin
 * dashboard) used to return the first 8 characters of PROVISIONING_TOKEN. It
 * now returns the same fingerprint as /diagnose-intelligence (SEC-F2), and its
 * audience is the ONE pod audience spelling (PUBLIC_URL, no trailing slash).
 */
describe("GET /debug", () => {
  const FAKE_PROV_TOKEN = "test-secret-Qz7xK2pV9mW4rT8nLb3Jc6";

  it("returns a fingerprint of the provisioning token, never any of its characters", async () => {
    const { verifyTrustedIssuerJwt } = await import("@synap/api");
    vi.mocked(verifyTrustedIssuerJwt).mockResolvedValue({ type: "debug" });
    vi.stubEnv("PUBLIC_URL", "https://pod.test.invalid/");
    vi.stubEnv("KRATOS_ADMIN_URL", "http://kratos.test.invalid");
    vi.stubEnv("PROVISIONING_TOKEN", FAKE_PROV_TOKEN);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("no network in tests");
      })
    );
    try {
      const res = await provisionRouter.request("/debug", {
        headers: { Authorization: "Bearer test-issuer-jwt" },
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      const body = JSON.parse(text) as {
        provisioningToken: Record<string, unknown>;
      };

      // The audience is normalised: the trailing slash of PUBLIC_URL is gone.
      expect(vi.mocked(verifyTrustedIssuerJwt)).toHaveBeenCalledWith(
        "test-issuer-jwt",
        { audience: "https://pod.test.invalid" }
      );

      const expected = `sha256:${createHash("sha256").update(FAKE_PROV_TOKEN).digest("hex").slice(0, 8)}`;
      expect(body.provisioningToken).toEqual({
        configured: true,
        fingerprint: expected,
      });
      for (let i = 0; i + 6 <= FAKE_PROV_TOKEN.length; i++) {
        expect(text).not.toContain(FAKE_PROV_TOKEN.slice(i, i + 6));
      }
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
});
