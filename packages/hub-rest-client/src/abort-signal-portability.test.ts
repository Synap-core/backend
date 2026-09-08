/**
 * `AbortSignal.any` portability — the same defect class as the `crypto` crash.
 *
 * The Raycast crash was `crypto is not defined`: a modern global assumed to
 * exist, on a host that lacks it. `AbortSignal.any` is the SECOND one in this
 * file — Node **20.3+**, Chrome 116+, Safari 17.4+ — while the package header
 * claims "Node.js >= 18, browsers, Deno, Bun, and Raycast extensions", and the
 * public methods advertise a `signal?: AbortSignal` parameter.
 *
 * These delete `AbortSignal.any` to simulate the older/thinner host, and prove
 * the request still works and still honours BOTH abort sources.
 */

import { describe, it, expect, afterEach } from "vitest";
import { HubRestClient } from "./client.js";

const realAny = (AbortSignal as unknown as { any?: unknown }).any;

function withoutAbortSignalAny() {
  delete (AbortSignal as unknown as { any?: unknown }).any;
}

afterEach(() => {
  if (realAny === undefined) {
    delete (AbortSignal as unknown as { any?: unknown }).any;
  } else {
    (AbortSignal as unknown as { any?: unknown }).any = realAny;
  }
});

/**
 * `request` is `protected`, so a consumer cannot pass a signal today — this
 * subclass is how the path is reachable at all, and saying so is the point:
 * an earlier version of this file called `client.ask({question}, {signal})`,
 * which silently exercised the NO-signal branch (`ask` takes `{query}` and
 * accepts no options object). Four green tests that proved nothing.
 */
class SignalProbe extends HubRestClient {
  callWithSignal(signal: AbortSignal): Promise<unknown> {
    return this.request(
      "POST",
      "/api/hub/knowledge/ask",
      { query: "hi" },
      signal
    );
  }
}

function probeWithFetch(impl: typeof fetch): SignalProbe {
  globalThis.fetch = impl;
  return new SignalProbe({ podUrl: "https://pod.test", apiKey: "k" });
}

function clientWithFetch(impl: typeof fetch): HubRestClient {
  globalThis.fetch = impl;
  return new HubRestClient({ podUrl: "https://pod.test", apiKey: "k" });
}

describe("combineAbortSignals — works without AbortSignal.any", () => {
  it("completes a request on a host that lacks AbortSignal.any", async () => {
    withoutAbortSignalAny();
    const probe = probeWithFetch(
      (async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch
    );
    const controller = new AbortController();
    await expect(
      probe.callWithSignal(controller.signal)
    ).resolves.toBeDefined();
  });

  it("the COMBINED signal aborts when the caller's signal aborts", async () => {
    withoutAbortSignalAny();
    let handed: AbortSignal | undefined;
    const controller = new AbortController();
    const probe = probeWithFetch((async (_u: unknown, init?: RequestInit) => {
      handed = init?.signal ?? undefined;
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);

    await probe.callWithSignal(controller.signal);

    expect(handed).toBeDefined();
    expect(handed!.aborted).toBe(false);
    controller.abort();
    expect(handed!.aborted).toBe(true); // the hand-rolled fallback forwarded it
  });

  it("an ALREADY-aborted caller signal reaches fetch aborted", async () => {
    withoutAbortSignalAny();
    const controller = new AbortController();
    controller.abort();
    let seen: boolean | undefined;
    const probe = probeWithFetch((async (_u: unknown, init?: RequestInit) => {
      seen = init?.signal?.aborted;
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as typeof fetch);

    await expect(probe.callWithSignal(controller.signal)).rejects.toBeTruthy();
    expect(seen).toBe(true);
  });

  it("uses the native AbortSignal.any when the host HAS it", async () => {
    // The other branch — proves the guard did not replace the fast path.
    let calls = 0;
    const nativeAny = (
      AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }
    ).any;
    (AbortSignal as unknown as { any: unknown }).any = (
      sigs: AbortSignal[]
    ) => {
      calls++;
      return nativeAny(sigs);
    };
    const probe = probeWithFetch(
      (async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch
    );
    await probe.callWithSignal(new AbortController().signal);
    expect(calls).toBeGreaterThan(0);
  });
});
