/**
 * Retry-policy tests for the IS `structure()` call.
 *
 * No database, no network: the policy is a pure loop over an injected `call`,
 * with injected `sleep`/`now` so backoff is asserted without real waiting.
 */

import { describe, it, expect, vi } from "vitest";

import {
  callStructureWithRetry,
  type StructureRetryOptions,
} from "./is-structure-retry.js";

const TIMEOUT_MS = 45_000;

/**
 * Build options with a fake clock. Each `call()` is charged `elapsedPerCall`
 * ms so fast-null vs slow-null classification is deterministic.
 */
function makeOptions(
  elapsedPerCall: number,
  overrides: Partial<StructureRetryOptions> = {}
): StructureRetryOptions & { sleeps: number[]; tick: () => void } {
  let clock = 0;
  const sleeps: number[] = [];
  return {
    timeoutMs: TIMEOUT_MS,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    ...overrides,
    // `tick` is advanced by the caller's wrapped `call`
    sleeps,
    tick: () => {
      clock += elapsedPerCall;
    },
  } as StructureRetryOptions & { sleeps: number[]; tick: () => void };
}

/** Wrap a call so it charges the fake clock before resolving. */
function timed<T>(
  opts: { tick: () => void },
  impl: () => Promise<T | null>
): () => Promise<T | null> {
  return async () => {
    const result = await impl();
    opts.tick();
    return result;
  };
}

describe("callStructureWithRetry", () => {
  it("returns the first success without retrying", async () => {
    const opts = makeOptions(100);
    const call = vi.fn(timed(opts, async () => ({ entities: [] })));

    const outcome = await callStructureWithRetry(call, opts);

    expect(call).toHaveBeenCalledTimes(1);
    expect(outcome.result).toEqual({ entities: [] });
    expect(outcome.attempts).toBe(1);
    expect(outcome.lastReason).toBeUndefined();
    expect(opts.sleeps).toEqual([]);
  });

  it("retries a fast null (transient) and returns a later success", async () => {
    const opts = makeOptions(500);
    let n = 0;
    const call = vi.fn(
      timed(opts, async () => (++n < 3 ? null : { entities: ["ok"] }))
    );

    const outcome = await callStructureWithRetry(call, opts);

    expect(call).toHaveBeenCalledTimes(3);
    expect(outcome.result).toEqual({ entities: ["ok"] });
    expect(outcome.attempts).toBe(3);
    expect(outcome.lastReason).toBeUndefined();
  });

  it("respects the attempt bound when every call is a fast null", async () => {
    const opts = makeOptions(500, { maxAttempts: 3 });
    const call = vi.fn(timed(opts, async () => null));

    const outcome = await callStructureWithRetry(call, opts);

    expect(call).toHaveBeenCalledTimes(3);
    expect(outcome.result).toBeNull();
    expect(outcome.attempts).toBe(3);
    expect(outcome.lastReason).toBe("transient_null");
  });

  it("honors a maxAttempts of 2", async () => {
    const opts = makeOptions(500, { maxAttempts: 2 });
    const call = vi.fn(timed(opts, async () => null));

    const outcome = await callStructureWithRetry(call, opts);

    expect(call).toHaveBeenCalledTimes(2);
    expect(outcome.attempts).toBe(2);
  });

  it("does NOT retry a slow null (timeout burned the budget)", async () => {
    // Elapsed above fastNullRatio * timeoutMs ⇒ classified as a timeout.
    const opts = makeOptions(TIMEOUT_MS);
    const call = vi.fn(timed(opts, async () => null));

    const outcome = await callStructureWithRetry(call, opts);

    expect(call).toHaveBeenCalledTimes(1);
    expect(outcome.result).toBeNull();
    expect(outcome.attempts).toBe(1);
    expect(outcome.lastReason).toBe("timeout_null");
    expect(opts.sleeps).toEqual([]);
  });

  it("does NOT retry an auth error — the throw propagates on attempt 1", async () => {
    class IntelligenceAuthError extends Error {}
    const opts = makeOptions(200);
    const call = vi.fn(async () => {
      throw new IntelligenceAuthError("401");
    });

    await expect(callStructureWithRetry(call, opts)).rejects.toBeInstanceOf(
      IntelligenceAuthError
    );
    expect(call).toHaveBeenCalledTimes(1);
    expect(opts.sleeps).toEqual([]);
  });

  it("backs off exponentially between retries", async () => {
    const opts = makeOptions(500, {
      maxAttempts: 3,
      initialBackoffMs: 300,
      backoffMultiplier: 2,
    });
    const call = vi.fn(timed(opts, async () => null));

    await callStructureWithRetry(call, opts);

    // One sleep per retry (2 retries for 3 attempts), doubling each time.
    expect(opts.sleeps).toEqual([300, 600]);
  });

  it("reports each retry through onRetry so the transient rate is observable", async () => {
    const onRetry = vi.fn();
    const opts = makeOptions(500, { maxAttempts: 3, onRetry });
    const call = vi.fn(timed(opts, async () => null));

    await callStructureWithRetry(call, opts);

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, {
      attempt: 1,
      maxAttempts: 3,
      reason: "transient_null",
      elapsedMs: 500,
      backoffMs: 300,
    });
    expect(onRetry).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ attempt: 2, backoffMs: 600 })
    );
  });

  it("never sleeps after the final attempt", async () => {
    const opts = makeOptions(500, { maxAttempts: 3 });
    const call = vi.fn(timed(opts, async () => null));

    await callStructureWithRetry(call, opts);

    expect(opts.sleeps).toHaveLength(2); // not 3
  });
});
