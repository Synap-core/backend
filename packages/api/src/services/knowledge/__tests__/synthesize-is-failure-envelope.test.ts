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
import { describeAiFailure } from "../../../utils/ai-failure.js";

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

  /*
   * The IS's own MIDDLEWARE refusals, byte-shaped as `enforceQuota` /
   * `entitlementCheck*` send them (synap-intelligence-service
   * `middleware/refusal-failure-code.test.ts` pins that side). Driven through
   * the real synthesize → classifyAiFailure → describeAiFailure path — the
   * words the MCP read handler and Hub /knowledge render.
   *
   * NEGATIVE CONTROL (run 2026-09-25): the same bodies WITHOUT `failure`
   * (the pre-fix IS) classify as `rate_limit` and `auth` — asserted below as
   * the "old IS" rows, so the envelope is what makes the difference; and
   * removing the two IS_CODE_TO_CLASS rows turned both envelope cases red
   * (`unknown`).
   */
  it("a monthly-quota 429 says the quota is used up — not 'try again shortly'", async () => {
    isResponds(429, {
      error: "Token quota exceeded",
      message:
        "You have exceeded your monthly token quota. Please upgrade your plan or wait until next billing period.",
      usage: { tokens: 120 },
      failure: { code: "account_quota_exceeded", retryable: false },
    });

    const res = await synthesizeAnswer([], "q", ["structured"], null);

    expect(res.answer).toBeNull();
    expect(res.error).toBe("synthesis_unavailable");
    expect(res.failureClass).toBe("account_quota");
    const d = describeAiFailure(res.failureClass);
    expect(d.code).toBe("account_quota_exceeded");
    expect(d.retryable).toBe(false);
    expect(d.message).toMatch(/monthly AI quota/);
    expect(d.message).not.toMatch(/rate-limit|try again/i);
  });

  it("a not-entitled 403 says the plan does not include it — not 'credentials'", async () => {
    isResponds(403, {
      error: "Account not entitled",
      message:
        "Your subscription does not allow intelligence access. Please renew or contact support.",
      failure: { code: "not_entitled", retryable: false },
    });

    const res = await synthesizeAnswer([], "q", ["structured"], null);

    expect(res.answer).toBeNull();
    expect(res.error).toBe("synthesis_unavailable");
    expect(res.failureClass).toBe("not_entitled");
    const d = describeAiFailure(res.failureClass);
    expect(d.code).toBe("not_entitled");
    expect(d.retryable).toBe(false);
    expect(d.needsOperator).toBe(false);
    expect(d.message).toMatch(/plan does not include/);
    expect(d.message).not.toMatch(/credential/i);
  });

  it("old IS (no envelope): the same refusals fall back to the bare status", async () => {
    isResponds(403, { error: "Account not entitled" });
    expect(
      (await synthesizeAnswer([], "q", ["structured"], null)).failureClass
    ).toBe("auth");
  });
});
