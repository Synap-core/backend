/**
 * synthesizeAnswer — the IS's classified refusal reaches `failureClass`.
 *
 * The IS answer route now sits under the spend guard; a budget refusal leaves
 * as `429 { failure: { code: "quota_exhausted", retryable: false } }`. The pod
 * used to throw a bare `IS answer HTTP 429`, so `classifyAiFailure` could only
 * read the status and called a month-long budget stop a transient
 * `rate_limit` ("try again shortly"). The envelope is the better evidence and
 * `classifyAiFailure` already prefers it — it just never received it.
 *
 * NEGATIVE CONTROL (run 2026-09-25): restoring the bare
 * `throw new Error(\`IS answer HTTP ${res.status}\`)` turned the first case
 * red (`rate_limit` instead of `plan_quota`).
 */

import { describe, it, expect, vi, afterEach } from "vitest";

const { getDefaultActiveService } = vi.hoisted(() => ({
  getDefaultActiveService: vi.fn(),
}));

vi.mock("../../../utils/intelligence-routing.js", () => ({
  getDefaultActiveService,
}));

import { synthesizeAnswer } from "../synthesize.js";

function isResponds(status: number, body: unknown) {
  getDefaultActiveService.mockResolvedValue({
    endpoint: "http://is.test",
    apiKey: "k",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("synthesizeAnswer — IS failure envelope", () => {
  it("a spend-guard refusal classifies as plan_quota, not a transient rate limit", async () => {
    isResponds(429, {
      error: "Knowledge synthesis refused: LLM budget exceeded",
      failure: { code: "quota_exhausted", message: "budget", retryable: false },
    });

    const res = await synthesizeAnswer([], "q", ["structured"], null);

    // failed ≠ empty: no answer, a named failure.
    expect(res.answer).toBeNull();
    expect(res.error).toBe("synthesis_unavailable");
    expect(res.failureClass).toBe("plan_quota");
  });

  it("a non-2xx WITHOUT an envelope still classifies from the status", async () => {
    isResponds(429, { error: "Token quota exceeded" });

    const res = await synthesizeAnswer([], "q", ["structured"], null);

    expect(res.answer).toBeNull();
    expect(res.failureClass).toBe("rate_limit");
  });
});
