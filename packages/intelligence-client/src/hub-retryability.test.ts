/**
 * Pins the retry verdict for a refused hub call.
 *
 * The 2026-08-20 Companion outage retried a schema rejection three times
 * (`A2AI_TRIGGER_JOB_OPTIONS.retryLimit: 3`), because the worker rethrew every
 * failure unconditionally. Four identical impossible requests, four log
 * entries, and the user's error delayed by the whole chain.
 */

import { describe, it, expect } from "vitest";
import { isRetryableHubError } from "./intelligence-hub-client.js";

const withStatus = (status: number): Error => {
  const err = new Error(`Intelligence Hub error: ${status}`) as Error & {
    status?: number;
  };
  err.status = status;
  return err;
};

describe("isRetryableHubError", () => {
  it("does not retry a request the service refused", () => {
    // The outage: replaying it byte-for-byte yields the identical refusal.
    expect(isRetryableHubError(withStatus(400))).toBe(false);
    expect(isRetryableHubError(withStatus(422))).toBe(false);
    expect(isRetryableHubError(withStatus(403))).toBe(false);
  });

  it("DOES retry the two 4xx that are temporal, not structural", () => {
    expect(isRetryableHubError(withStatus(408))).toBe(true);
    expect(isRetryableHubError(withStatus(429))).toBe(true);
  });

  it("retries server-side and transport failures", () => {
    expect(isRetryableHubError(withStatus(500))).toBe(true);
    expect(isRetryableHubError(withStatus(503))).toBe(true);
  });

  it("retries when there is no evidence either way", () => {
    // No status ⇒ a network/transport throw. Preserve prior behaviour rather
    // than inventing a verdict — the conservative default is to try again.
    expect(isRetryableHubError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableHubError(undefined)).toBe(true);
    expect(isRetryableHubError({ status: "400" })).toBe(true);
  });
});
