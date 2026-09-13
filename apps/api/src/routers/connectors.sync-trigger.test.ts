/**
 * POST /api/connectors/sync-trigger — the CP webhook poke door.
 *
 * Drives the REAL Hono route. The trust verification itself
 * (`verifyCpJwtWithTrust` = `verifyTrustedIssuerJwt`: signature, pinned issuer,
 * audience, expiry) is faked here as its OUTCOME (claims | null) — what this
 * suite proves is what the route does with that outcome: acts only on verified
 * claims, never on body fields; rejects a null/foreign-type token; maps the
 * broker connection id to the pod's connection row; surfaces unknown/queue-down
 * as distinct statuses. It does NOT re-prove aud/exp enforcement inside the
 * verifier.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  // The real @synap/database (spread below) validates its config on import.
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  process.env.CONTROL_PLANE_URL = "https://cp.example.test";
  return {
    verify: vi.fn(),
    enqueue: vi.fn(),
    reconcile: vi.fn(),
    /** Successive registry reads; the last entry repeats. */
    rowReads: [] as Array<Array<{ id: string }>>,
  };
});

vi.mock("@synap/api", () => ({
  verifyCpJwtWithTrust: h.verify,
  enqueueConnectionSync: h.enqueue,
  reconcileLiveConnections: h.reconcile,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const fakeDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            h.rowReads.length > 1 ? h.rowReads.shift()! : (h.rowReads[0] ?? []),
        }),
      }),
    }),
  };
  return { ...actual, getDb: async () => fakeDb };
});

import { connectorsRouter } from "./connectors.js";

const CLAIMS = {
  type: "connector_sync_trigger",
  aud: "https://pod.example.test",
  podId: "pod-1",
  podUserId: "user-1",
  providerConfigKey: "google",
  connectionId: "nango-conn-abc",
  reason: "webhook",
  iss: "https://cp.example.test",
  jti: "j1",
};

function post(body: unknown) {
  return connectorsRouter.request("/sync-trigger", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PUBLIC_URL = "https://pod.example.test";
  h.rowReads = [[{ id: "secrets-row-1" }]];
  h.verify.mockResolvedValue(CLAIMS);
  h.enqueue.mockResolvedValue(undefined);
  h.reconcile.mockResolvedValue({ ok: true, capabilities: 1 });
});

describe("POST /sync-trigger", () => {
  it("verifies with the pinned CP issuer + pod audience and enqueues the pod connection row", async () => {
    const res = await post({
      token: "t",
      providerConfigKey: "google",
      connectionId: "nango-conn-abc",
      podUserId: "user-1",
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      accepted: true,
      connectionId: "secrets-row-1",
    });
    expect(h.verify).toHaveBeenCalledWith("t", {
      pinnedIssuer: "https://cp.example.test",
      audience: "https://pod.example.test",
    });
    expect(h.enqueue).toHaveBeenCalledWith({
      provider: "google",
      connectionId: "secrets-row-1",
      reason: "webhook",
    });
  });

  it("acts on the TOKEN claims, never on body fields", async () => {
    const res = await post({
      token: "t",
      providerConfigKey: "evil",
      connectionId: "other",
      podUserId: "attacker",
    });
    expect(res.status).toBe(202);
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google" })
    );
  });

  it("rejects a token the verifier refused (bad signature / aud / expired) — 401, nothing enqueued", async () => {
    h.verify.mockResolvedValue(null);
    const res = await post({ token: "t" });
    expect(res.status).toBe(401);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("rejects a verified token of another type (e.g. connector_disconnect) — 401", async () => {
    h.verify.mockResolvedValue({ ...CLAIMS, type: "connector_disconnect" });
    const res = await post({ token: "t" });
    expect(res.status).toBe(401);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("a known connection is enqueued without touching the broker", async () => {
    await post({ token: "t" });
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it("a connection not yet mirrored is reconciled for the poked user, then enqueued", async () => {
    h.rowReads = [[], [{ id: "secrets-row-2" }]];
    const res = await post({ token: "t" });
    expect(h.reconcile).toHaveBeenCalledWith("user-1");
    expect(res.status).toBe(202);
    expect(h.enqueue).toHaveBeenCalledWith({
      provider: "google",
      connectionId: "secrets-row-2",
      reason: "webhook",
    });
  });

  it("still unknown after mirroring is a 404 (the CP retries), nothing enqueued", async () => {
    h.rowReads = [[]];
    const res = await post({ token: "t" });
    expect(h.reconcile).toHaveBeenCalled();
    expect(res.status).toBe(404);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("an unreadable live list is a retryable 503, never a 404", async () => {
    h.rowReads = [[]];
    h.reconcile.mockResolvedValue({
      ok: false,
      reason: "unreachable",
      error: "timeout",
    });
    const res = await post({ token: "t" });
    expect(res.status).toBe(503);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("a reconcile that throws is a retryable 503", async () => {
    h.rowReads = [[]];
    h.reconcile.mockRejectedValue(new Error("db down"));
    const res = await post({ token: "t" });
    expect(res.status).toBe(503);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("a queue outage is a retryable 503", async () => {
    h.enqueue.mockRejectedValue(new Error("pg-boss not started"));
    const res = await post({ token: "t" });
    expect(res.status).toBe(503);
  });

  it("refuses without a PUBLIC_URL audience", async () => {
    delete process.env.PUBLIC_URL;
    const res = await post({ token: "t" });
    expect(res.status).toBe(500);
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("400 on a body without a token", async () => {
    const res = await post({ connectionId: "x" });
    expect(res.status).toBe(400);
  });
});
