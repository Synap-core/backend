import { describe, it, expect, vi, afterEach } from "vitest";
import { NangoConnector } from "./NangoConnector.js";

/**
 * Behavioral coverage for `listConnectionsResult` — the typed, paginated read
 * that the connection reconciler's DESTRUCTIVE removal branch depends on.
 *
 * The failure this guards: a list that returns `[]` on any Nango HTTP error, or
 * reads only page 1, makes a transient 429 or a paginated-out connection look
 * identical to "revoked", and the reconciler soft-deletes live pointer rows.
 * These tests prove fault ≠ empty and that every page is walked — no DB, just a
 * stubbed `fetch`.
 */

const connector = new NangoConnector({
  host: "http://nango.test",
  secretKey: "test-key",
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A Nango /connection row for a given end_user. */
function conn(id: string, provider: string, endUser: string | null) {
  return {
    connection_id: id,
    provider_config_key: provider,
    created_at: "2026-07-17T00:00:00.000Z",
    end_user: endUser === null ? null : { id: endUser },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NangoConnector.listConnectionsResult — fault ≠ empty", () => {
  it("HTTP 429 (rate-limit) → ok:false, NOT an empty success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 429 }))
    );
    const r = await connector.listConnectionsResult("user-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unreachable");
  });

  it("HTTP 401/403 → ok:false unauthenticated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 401 }))
    );
    const r = await connector.listConnectionsResult("user-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unauthenticated");
  });

  it("network throw → ok:false unreachable (never an empty list)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    );
    const r = await connector.listConnectionsResult("user-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unreachable");
  });

  it("malformed body → ok:false malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ not_connections: 1 }))
    );
    const r = await connector.listConnectionsResult("user-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("malformed");
  });
});

describe("NangoConnector.listConnectionsResult — filtering & pagination", () => {
  it("filters by end_user client-side", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          connections: [
            conn("c1", "google", "user-1"),
            conn("c2", "google", "user-2"),
            conn("c3", "slack", "user-1"),
            conn("c4", "slack", null),
          ],
        })
      )
    );
    const r = await connector.listConnectionsResult("user-1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.connections.map((c) => c.connectionId).sort()).toEqual([
        "c1",
        "c3",
      ]);
      expect(r.connections.find((c) => c.connectionId === "c1")?.provider).toBe(
        "google"
      );
    }
  });

  it("fetches in ONE request with a high limit and NO page param", async () => {
    // Nango 0.70.9's /connection is limit-only: passing `page` returns zero
    // (live-verified). The client must request a single high-limit page and
    // never send `page`, or connection detection silently breaks.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ connections: [conn("c1", "google", "user-1")] })
      );
    vi.stubGlobal("fetch", fetchMock);

    const r = await connector.listConnectionsResult("user-1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.connections.map((c) => c.connectionId)).toEqual(["c1"]);
    // Exactly one request, with a limit, and crucially WITHOUT `page`.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("limit=");
    expect(url).not.toContain("page=");
  });
});

describe("NangoConnector.listConnectionsResult — the page cap fails closed", () => {
  it("a full page (1000 rows) is ok:false truncated, never a partial ok:true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          connections: Array.from({ length: 1000 }, (_, i) =>
            conn(`c${i}`, "google", "user-1")
          ),
        })
      )
    );
    const r = await connector.listConnectionsResult("user-1");
    expect(r).toMatchObject({ ok: false, reason: "truncated" });
  });

  it("999 rows is the complete list (positive control)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          connections: Array.from({ length: 999 }, (_, i) =>
            conn(`c${i}`, "google", "user-1")
          ),
        })
      )
    );
    const r = await connector.listConnectionsResult("user-1");
    expect(r.ok && r.connections.length).toBe(999);
  });
});

describe("NangoConnector.listConnections — lossy compat wrapper", () => {
  it("returns [] on failure (so read-only callers are unchanged)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 500 }))
    );
    const list = await connector.listConnections("user-1");
    expect(list).toEqual([]);
  });

  it("returns the connections on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ connections: [conn("c1", "google", "user-1")] })
        )
    );
    const list = await connector.listConnections("user-1");
    expect(list.map((c) => c.connectionId)).toEqual(["c1"]);
  });
});
