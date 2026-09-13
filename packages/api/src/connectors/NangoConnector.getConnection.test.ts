import { afterEach, describe, expect, it, vi } from "vitest";
import { NangoConnector } from "./NangoConnector.js";

/**
 * `NangoConnector.getConnectionResult` — the self-hosted broker's by-id read.
 *
 * It must prove ownership itself: a connection of ANOTHER end user or of another
 * provider is `null` (the same answer as absent), and a failed read is a typed
 * `ok:false`, never `null`. `fetch` is stubbed; the URL it received is asserted.
 */

const nango = new NangoConnector({
  host: "http://nango.test",
  secretKey: "sk",
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const row = (over: Record<string, unknown> = {}) => ({
  connection_id: "c-1",
  provider_config_key: "google",
  created_at: "2026-09-01T00:00:00.000Z",
  end_user: { id: "user-1" },
  errors: [],
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NangoConnector.getConnectionResult", () => {
  it("the user's own connection is returned, read by id with the provider key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(row()));
    vi.stubGlobal("fetch", fetchMock);
    const r = await nango.getConnectionResult("user-1", "google", "c-1");
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "http://nango.test/connection/c-1?provider_config_key=google"
    );
    expect(r).toMatchObject({
      ok: true,
      connection: {
        connectionId: "c-1",
        provider: "google",
        userId: "user-1",
        hasError: false,
      },
    });
  });

  it("another end user's connection, or another provider's, is null — same as absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json(row({ end_user: { id: "user-2" } })))
    );
    expect(await nango.getConnectionResult("user-1", "google", "c-1")).toEqual({
      ok: true,
      connection: null,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json(row({ provider_config_key: "notion" })))
    );
    expect(await nango.getConnectionResult("user-1", "google", "c-1")).toEqual({
      ok: true,
      connection: null,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ error: "not found" }, 404))
    );
    expect(await nango.getConnectionResult("user-1", "google", "c-1")).toEqual({
      ok: true,
      connection: null,
    });
  });

  it("a failed read is typed, never null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    );
    expect(
      await nango.getConnectionResult("user-1", "google", "c-1")
    ).toMatchObject({
      ok: false,
      reason: "unreachable",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({}, 401)));
    expect(
      await nango.getConnectionResult("user-1", "google", "c-1")
    ).toMatchObject({
      ok: false,
      reason: "unauthenticated",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ nope: 1 })));
    expect(
      await nango.getConnectionResult("user-1", "google", "c-1")
    ).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });
});
