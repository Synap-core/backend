import { describe, it, expect, vi, afterEach } from "vitest";
import {
  BrokerConnectionNotFoundError,
  BrokerRefusalError,
  CpBrokerConnector,
} from "./CpBrokerConnector.js";

/**
 * The CP broker client must speak the pod's fault ≠ empty contract: an
 * unreachable, unauthenticated or malformed broker is a typed `ok:false`,
 * never an empty connection list (which every caller reads as "not connected").
 * No DB, no network — `fetch` is stubbed and the calls it received are asserted.
 */

const broker = new CpBrokerConnector({
  cpUrl: "https://cp.test/",
  relayKey: "relay-jwt",
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CpBrokerConnector.listConnectionsResult — fault ≠ empty", () => {
  it("network failure → ok:false unreachable, never []", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    );
    const r = await broker.listConnectionsResult("user-1");
    expect(r).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("a rejected pod credential (401) → ok:false unauthenticated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ error: "no" }, 401))
    );
    const r = await broker.listConnectionsResult("user-1");
    expect(r).toMatchObject({ ok: false, reason: "unauthenticated" });
  });

  it("the broker's own Nango read failed (502) → carries the broker's reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          json({ error: "nango down", reason: "malformed" }, 502)
        )
    );
    const r = await broker.listConnectionsResult("user-1");
    expect(r).toMatchObject({
      ok: false,
      reason: "malformed",
      error: "nango down",
    });
  });

  it("a body without a connections array → ok:false malformed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ nope: true })));
    const r = await broker.listConnectionsResult("user-1");
    expect(r).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("success names only the pod USER, authenticates with the relay key, and maps rows", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        connections: [
          {
            connectionId: "conn-1",
            provider: "google",
            createdAt: "2026-09-01T00:00:00.000Z",
            lastFetchedAt: null,
            hasError: true,
            objectScoped: false,
          },
        ],
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await broker.listConnectionsResult("user-1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.connections).toEqual([
        {
          connectionId: "conn-1",
          provider: "google",
          userId: "user-1",
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
          lastSyncAt: undefined,
          hasError: true,
        },
      ]);
    }
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://cp.test/api/connector-broker/connections?podUserId=user-1"
    );
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer relay-jwt",
    });
  });
});

describe("CpBrokerConnector — refusals and idempotency", () => {
  it("an over-limit session is a BrokerRefusalError carrying CONNECTOR_LIMIT", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          json(
            { error: "Your plan allows 1 connector.", code: "CONNECTOR_LIMIT" },
            403
          )
        )
    );
    const err = await broker
      .createSession("user-1", "notion", "ws")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerRefusalError);
    expect((err as BrokerRefusalError).code).toBe("CONNECTOR_LIMIT");
  });

  it("revoke: a connection not in the user's namespace (404) THROWS — nothing was revoked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ error: "gone" }, 404))
    );
    await expect(
      broker.revokeConnection("conn-x", undefined, "user-1")
    ).rejects.toBeInstanceOf(BrokerConnectionNotFoundError);
  });

  it("revoke: forwards the provider key so the CP proves ownership by id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ success: true }, 200));
    vi.stubGlobal("fetch", fetchMock);
    await broker.revokeConnection("conn-x", "google", "user-1");
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string
    );
    expect(body).toEqual({
      podUserId: "user-1",
      connectionId: "conn-x",
      providerConfigKey: "google",
    });
  });

  it("revoke: a broker failure throws — a disconnect can never report success it did not get", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ error: "boom" }, 502))
    );
    await expect(
      broker.revokeConnection("conn-x", undefined, "user-1")
    ).rejects.toThrow("boom");
  });

  it("getConnectionResult: reads ONE connection by id, naming only the pod user", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        connection: {
          connectionId: "conn/1",
          provider: "google",
          createdAt: "2026-09-01T00:00:00.000Z",
          lastFetchedAt: null,
          hasError: true,
          objectScoped: false,
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await broker.getConnectionResult("user-1", "google", "conn/1");
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://cp.test/api/connector-broker/connections/conn%2F1?podUserId=user-1&providerConfigKey=google"
    );
    expect(r).toEqual({
      ok: true,
      connection: {
        connectionId: "conn/1",
        provider: "google",
        userId: "user-1",
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
        lastSyncAt: undefined,
        hasError: true,
      },
    });
  });

  it("getConnectionResult: 404 is an ANSWER (null); faults stay typed, never null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ error: "Connection not found" }, 404))
    );
    expect(await broker.getConnectionResult("user-1", "google", "c")).toEqual({
      ok: true,
      connection: null,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ error: "no" }, 401))
    );
    expect(
      await broker.getConnectionResult("user-1", "google", "c")
    ).toMatchObject({
      ok: false,
      reason: "unauthenticated",
    });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(json({ error: "nango", reason: "truncated" }, 502))
    );
    expect(
      await broker.getConnectionResult("user-1", "google", "c")
    ).toMatchObject({
      ok: false,
      reason: "malformed",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    );
    expect(
      await broker.getConnectionResult("user-1", "google", "c")
    ).toMatchObject({
      ok: false,
      reason: "unreachable",
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ nope: true })));
    expect(
      await broker.getConnectionResult("user-1", "google", "c")
    ).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });

  it("proxy: a broker refusal surfaces as the status, a broker fault throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ error: "Connection not found" }, 404))
    );
    const refused = await broker.proxyRequest({
      userId: "user-1",
      connectionId: "c",
      providerConfigKey: "google",
      method: "GET",
      path: "/x",
    });
    expect(refused).toEqual({
      status: 404,
      headers: {},
      body: { error: { message: "Connection not found" } },
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    await expect(
      broker.proxyRequest({
        userId: "user-1",
        connectionId: "c",
        providerConfigKey: "google",
        method: "GET",
        path: "/x",
      })
    ).rejects.toThrow("down");
  });
});
