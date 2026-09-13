/**
 * GET /api/connectors/broker-diagnostics — the CP's read of this pod's broker
 * trust state.
 *
 * Drives the REAL Hono route. The trust verifier is faked as its OUTCOME
 * (claims | null); what this proves is that the route pins the CP issuer and the
 * pod audience, acts only on verified claims (iss + sub forwarded to the
 * reader), refuses a missing/foreign token, and answers a failed read as 503.
 * The reader's own facts are covered by broker-trust-diagnostics.pglite.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  process.env.CONTROL_PLANE_URL = "https://cp.example.test";
  return { verify: vi.fn(), read: vi.fn() };
});

vi.mock("@synap/api", () => ({
  verifyCpJwtWithTrust: h.verify,
  enqueueConnectionSync: vi.fn(),
  reconcileLiveConnections: vi.fn(),
  readBrokerTrustDiagnostics: h.read,
}));

import { config } from "@synap-core/core";
import { connectorsRouter } from "./connectors.js";

const REPORT = {
  cpIssuer: { present: true, status: "approved", hasSourceConfigWrite: true },
  ownerIdentityLink: { present: false },
  relayCredential: { present: false, validUntil: null },
  broker: { kind: "control-plane", reason: "broker-credential-missing" },
};

const IAT = 1_800_000_000;
const CLAIMS = {
  type: "pod_trust_diagnostics",
  iss: "https://cp.example.test",
  sub: "cp-user-1",
  aud: "https://pod.example.test",
  jti: "j1",
  iat: IAT,
  exp: IAT + 300,
};

function call(token?: string) {
  return connectorsRouter.request("/broker-diagnostics", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PUBLIC_URL = "https://pod.example.test";
  h.verify.mockResolvedValue(CLAIMS);
  h.read.mockResolvedValue(REPORT);
});

describe("GET /broker-diagnostics", () => {
  it("verifies against the pinned CP issuer and the pod audience, then forwards iss + sub", async () => {
    const res = await call("tok");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(REPORT);
    expect(h.verify).toHaveBeenCalledWith("tok", {
      pinnedIssuer: config.server.controlPlaneUrl,
      audience: "https://pod.example.test",
    });
    expect(h.read).toHaveBeenCalledWith({
      issuerUrl: "https://cp.example.test",
      issuerSubject: "cp-user-1",
    });
  });

  it("a PUBLIC_URL with a trailing slash verifies against the slash-less audience the CP signs", async () => {
    process.env.PUBLIC_URL = "https://pod.example.test/";
    const res = await call("tok");
    expect(res.status).toBe(200);
    expect(h.verify).toHaveBeenCalledWith("tok", {
      pinnedIssuer: config.server.controlPlaneUrl,
      audience: "https://pod.example.test",
    });
  });

  it("no bearer token → 401, nothing read", async () => {
    const res = await call();
    expect(res.status).toBe(401);
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
  });

  it("a token the verifier rejects → 401, nothing read", async () => {
    h.verify.mockResolvedValue(null);
    const res = await call("tok");
    expect(res.status).toBe(401);
    expect(h.read).not.toHaveBeenCalled();
  });

  it("a verified token of another type → 401, nothing read", async () => {
    h.verify.mockResolvedValue({ ...CLAIMS, type: "connector_sync_trigger" });
    const res = await call("tok");
    expect(res.status).toBe(401);
    expect(h.read).not.toHaveBeenCalled();
  });

  // The verifier enforces `exp` only when the token carries one, so the route
  // must refuse a token without it — and one that lives longer than 300s.
  it.each([
    ["without exp", (({ exp: _exp, ...rest }) => rest)(CLAIMS)],
    ["living longer than 300s", { ...CLAIMS, exp: IAT + 301 }],
  ])("a verified token %s → 401, nothing read", async (_label, claims) => {
    h.verify.mockResolvedValue(claims);
    const res = await call("tok");
    expect(res.status).toBe(401);
    expect(h.read).not.toHaveBeenCalled();
  });

  it("no PUBLIC_URL → refused before verification", async () => {
    delete process.env.PUBLIC_URL;
    const res = await call("tok");
    expect(res.status).toBe(500);
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("a failed read is a 503, never a report", async () => {
    h.read.mockRejectedValue(new Error("db down"));
    const res = await call("tok");
    expect(res.status).toBe(503);
  });
});
