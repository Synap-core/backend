/**
 * Idempotency-Key minting must survive a host with no `crypto` global.
 *
 * Raycast's extension runtime has none: `crypto.randomUUID()` threw
 * `crypto is not defined` and every mutating Hub call (ask, capture,
 * create) died before the request left the process. The header is driven
 * through the public client with `global.fetch` mocked — the mint helper
 * itself is private.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubRestClient } from "./client.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function client() {
  return new HubRestClient({ podUrl: "https://pod.test", apiKey: "k" });
}

async function capturedKey(): Promise<string | undefined> {
  let seen: string | undefined;
  global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    seen = (init?.headers as Record<string, string>)["Idempotency-Key"];
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  await client().ask({ query: "ping" });
  return seen;
}

describe("Idempotency-Key minting", () => {
  const originalFetch = global.fetch;
  const originalCrypto = globalThis.crypto;

  afterEach(() => {
    global.fetch = originalFetch;
    Object.defineProperty(globalThis, "crypto", {
      value: originalCrypto,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  function setCrypto(value: unknown) {
    Object.defineProperty(globalThis, "crypto", {
      value,
      configurable: true,
      writable: true,
    });
  }

  it("uses crypto.randomUUID when the host provides it", async () => {
    await expect(capturedKey()).resolves.toMatch(UUID_RE);
  });

  it("falls back to getRandomValues when randomUUID is absent", async () => {
    setCrypto({
      getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto),
    });
    await expect(capturedKey()).resolves.toMatch(UUID_RE);
  });

  it("still mints a key when there is NO crypto global at all", async () => {
    setCrypto(undefined);
    const key = await capturedKey();
    expect(key).toBeTruthy();
    expect(key).not.toBe("");
  });

  it("does not repeat a key across requests without a crypto global", async () => {
    setCrypto(undefined);
    const keys = new Set<string | undefined>();
    for (let i = 0; i < 50; i++) keys.add(await capturedKey());
    expect(keys.size).toBe(50);
  });
});
