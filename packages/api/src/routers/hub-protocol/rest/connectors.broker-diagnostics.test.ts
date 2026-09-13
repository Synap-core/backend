/**
 * GET /api/hub/connectors/broker-diagnostics — the pod owner's read of the
 * broker trust state.
 *
 * Pins the door: hub-protocol.read AND pod owner/admin, the reader's report
 * passed through, and a failed read (reader OR admin check) answered as 503 —
 * never folded into a report. The reader's facts are covered by
 * connectors/broker-trust-diagnostics.pglite.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

const h = vi.hoisted(() => ({
  isPodAdmin: vi.fn(),
  read: vi.fn(),
}));

vi.mock("../../../connectors/broker-trust-diagnostics.js", () => ({
  readBrokerTrustDiagnostics: h.read,
}));
vi.mock("../../../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: h.isPodAdmin,
}));
// Sibling imports this route file pulls in, unrelated to this door.
vi.mock("../../../connectors/index.js", () => ({
  resolveBroker: async () => ({
    ok: false,
    reason: "not-configured",
    error: "",
  }),
  BrokerRefusalError: class BrokerRefusalError extends Error {},
}));
vi.mock("../../../connectors/external-dispatch.js", () => ({
  triggerProviderAction: async () => ({ success: true }),
}));
vi.mock("../../../connectors/materialize-tools.js", () => ({
  materializeConnectorTools: async () => ({}),
}));

const { registerConnectorsRoutes } = await import("./connectors.js");

const REPORT = {
  cpIssuer: { present: true, status: "approved", hasSourceConfigWrite: true },
  ownerIdentityLink: { present: true },
  relayCredential: { present: true, validUntil: "2026-10-01T00:00:00.000Z" },
  broker: { kind: "control-plane", reason: null },
};

function get(scopes: string[] = ["hub-protocol.read"]) {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set("scopes" as never, scopes as never);
    c.set("userId" as never, "user-1" as never);
    await next();
  });
  registerConnectorsRoutes(app as never);
  return app.request("/connectors/broker-diagnostics");
}

beforeEach(() => {
  vi.clearAllMocks();
  h.isPodAdmin.mockResolvedValue(true);
  h.read.mockResolvedValue(REPORT);
});

describe("GET /connectors/broker-diagnostics", () => {
  it("requires hub-protocol.read", async () => {
    const res = await get([]);
    expect(res.status).toBe(403);
    expect(h.read).not.toHaveBeenCalled();
  });

  it("refuses a caller who is not a pod owner/admin", async () => {
    h.isPodAdmin.mockResolvedValue(false);
    const res = await get();
    expect(res.status).toBe(403);
    expect(h.isPodAdmin).toHaveBeenCalledWith("user-1");
    expect(h.read).not.toHaveBeenCalled();
  });

  it("returns the reader's report to a pod admin", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(REPORT);
    expect(h.read).toHaveBeenCalledWith();
  });

  it("a failed read is a 503, never a report", async () => {
    h.read.mockRejectedValue(new Error("db down"));
    const res = await get();
    expect(res.status).toBe(503);
  });

  it("a failed admin check is a 503, never a 403", async () => {
    h.isPodAdmin.mockRejectedValue(new Error("db down"));
    const res = await get();
    expect(res.status).toBe(503);
  });
});
