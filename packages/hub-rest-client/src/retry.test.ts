/**
 * fetchWithRetry — the ONE shared request loop's retry classification.
 * Drives it indirectly through `getMe()` (a plain GET) since the loop itself
 * is private; `global.fetch` is mocked so no network is involved.
 *
 * `setTimeout` is stubbed to fire immediately rather than faked wholesale —
 * `AbortSignal.timeout()` uses its own internal timer, not the exposed
 * `setTimeout` global, so `vi.useFakeTimers()` starves it and hangs every
 * attempt instead of speeding the test up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubRestClient } from "./client.js";
import { HubApiError } from "./errors.js";

function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("HubRestClient retry classification", () => {
  const originalFetch = global.fetch;
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;
  const delays: number[] = [];

  beforeEach(() => {
    delays.length = 0;
    setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number
    ) => {
      delays.push(ms ?? 0);
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    setTimeoutSpy.mockRestore();
  });

  function client() {
    return new HubRestClient({
      podUrl: "https://pod.example.com",
      apiKey: "key",
      maxAttempts: 3,
    });
  }

  it("does not retry a terminal 4xx (e.g. 400)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(400, { error: "bad" }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(client().getMe()).rejects.toThrow(HubApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 and succeeds once it clears", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: "rate limited" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "u1" }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(client().getMe()).resolves.toEqual({ id: "u1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 408", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(408, { error: "timeout" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "u1" }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(client().getMe()).resolves.toEqual({ id: "u1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 5xx until exhausted, then throws", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(503, { error: "down" }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(client().getMe()).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3); // maxAttempts
  });

  it("honors a short Retry-After on a 429 instead of the computed backoff", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}, { "retry-after": "5" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "u1" }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(client().getMe()).resolves.toEqual({ id: "u1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([5_000]); // honored Retry-After, not the jittered default
  });

  it("gives up immediately on a Retry-After far beyond the cap, without waiting it out", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(429, {}, { "retry-after": "3600" })); // 1h
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(client().getMe()).rejects.toThrow(/not retrying/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no second attempt, no 1h wait
  });

  describe("Idempotency-Key", () => {
    // `request`/`requestRaw` are protected — exercise them through a thin
    // subclass rather than reaching past TS visibility with bracket access.
    class TestClient extends HubRestClient {
      callRequest<T>(
        method: string,
        path: string,
        body?: unknown,
        extraHeaders?: Record<string, string>
      ): Promise<T> {
        return this.request<T>(method, path, body, undefined, extraHeaders);
      }
    }

    function testClient() {
      return new TestClient({
        podUrl: "https://pod.example.com",
        apiKey: "key",
        maxAttempts: 3,
      });
    }

    function headersOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): Headers {
      return new Headers(
        (fetchMock.mock.calls[call]?.[1] as RequestInit)?.headers as HeadersInit
      );
    }

    it("does not attach Idempotency-Key on a GET", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse(200, { id: "u1" }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await testClient().callRequest("GET", "/api/hub/users/me");

      expect(headersOf(fetchMock).has("Idempotency-Key")).toBe(false);
    });

    it("attaches a generated Idempotency-Key on a mutating request", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse(200, { id: "e1" }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await testClient().callRequest("POST", "/api/hub/entities", {
        title: "x",
      });

      const key = headersOf(fetchMock).get("Idempotency-Key");
      expect(key).toBeTruthy();
      // crypto.randomUUID() shape — proves it's generated, not a static stub.
      expect(key).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });

    it("reuses the SAME key across every retry of one logical call", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(503, { error: "down" }))
        .mockResolvedValueOnce(jsonResponse(503, { error: "down" }))
        .mockResolvedValueOnce(jsonResponse(200, { id: "e1" }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await testClient().callRequest("POST", "/api/hub/entities", {
        title: "x",
      });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      const keys = [0, 1, 2].map((i) =>
        headersOf(fetchMock, i).get("Idempotency-Key")
      );
      expect(keys[0]).toBeTruthy();
      expect(keys[1]).toBe(keys[0]);
      expect(keys[2]).toBe(keys[0]);
    });

    it("uses a DIFFERENT key for two distinct calls", async () => {
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(() =>
          Promise.resolve(jsonResponse(200, { id: "e1" }))
        )
        .mockImplementationOnce(() =>
          Promise.resolve(jsonResponse(200, { id: "e1" }))
        );
      global.fetch = fetchMock as unknown as typeof fetch;

      const c = testClient();
      await c.callRequest("POST", "/api/hub/entities", { title: "x" });
      await c.callRequest("POST", "/api/hub/entities", { title: "y" });

      const key0 = headersOf(fetchMock, 0).get("Idempotency-Key");
      const key1 = headersOf(fetchMock, 1).get("Idempotency-Key");
      expect(key0).toBeTruthy();
      expect(key1).toBeTruthy();
      expect(key1).not.toBe(key0);
    });

    it("preserves a caller-supplied Idempotency-Key instead of generating one", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse(200, { id: "e1" }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await testClient().callRequest(
        "POST",
        "/api/hub/entities",
        { title: "x" },
        { "Idempotency-Key": "caller-supplied-key-123" }
      );

      expect(headersOf(fetchMock).get("Idempotency-Key")).toBe(
        "caller-supplied-key-123"
      );
    });
  });
});
