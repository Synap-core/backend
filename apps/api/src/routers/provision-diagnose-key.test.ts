/**
 * `GET /api/provision/diagnose-intelligence` is unauthenticated. It used to
 * return the first 12 characters of the DECRYPTED Intelligence Service key
 * (security wave 2026-10-13, LOW list). It now returns a fingerprint
 * (`sha256:` + 8 hex) and no character of the key.
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
vi.mock("./provision-intelligence-probe.js", () => ({
  probeIntelligenceService: async () => ({ reachable: false }),
}));
vi.mock("@synap/api", () => ({
  createAndVerifyHubInboundKey: vi.fn(),
  encryptServiceKey: vi.fn(),
  describeServingIntelligence: async () => ({
    service: {
      apiKey: "encrypted-blob",
      enabled: true,
      status: "active",
    },
    url: "http://is.invalid",
    via: "pod_default",
  }),
  envIntelligenceEndpoint: vi.fn(),
  getSyncGenerationState: vi.fn(),
  resolveServiceKey: () => FAKE_KEY,
  toRegistrationTrace: vi.fn(),
  verifyTrustedIssuerJwt: vi.fn(),
}));
vi.mock("@synap/database", () => ({
  getDb: vi.fn(),
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

describe("GET /diagnose-intelligence", () => {
  it("returns a fingerprint of the IS key, never any of its characters", async () => {
    const res = await provisionRouter.request("/diagnose-intelligence");
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
