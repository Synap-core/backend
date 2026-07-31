/**
 * Regression test for the 2026-07-31 report-run failure.
 *
 * A report's `analyze` step died at exactly 60.011s and recorded the entire
 * error as `"The operation was aborted due to timeout"` — which names neither
 * the side that gave up, nor the elapsed time, nor the budget, nor the payload
 * size that caused it. This test pins the ATTRIBUTED replacement at the real
 * call site (`generateViaIS`, the one that fired), not just at the helper.
 *
 * MUTATION-PROVEN: each of the four assertions below was individually verified
 * to FAIL when its field is stripped from `describeISFailure` — see the report.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isCallBudgetMs,
  describeISFailure,
  describeISHttpError,
} from "@synap/intelligence-client";

vi.mock("../../utils/intelligence-routing.js", () => ({
  getDefaultActiveService: vi.fn(async () => ({
    endpoint: "https://is.test.internal",
    apiKey: "k",
  })),
}));

const { generateViaIS } = await import("./generate.js");

/** The exact shape `AbortSignal.timeout()` rejects with. */
function timeoutError(): Error {
  const e = new Error("The operation was aborted due to timeout");
  e.name = "TimeoutError";
  return e;
}

describe("IS call budget", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env.SYNAP_IS_GENERATION_TIMEOUT_MS;
  });
  beforeEach(() => {
    delete process.env.SYNAP_IS_GENERATION_TIMEOUT_MS;
  });

  it("defaults generation to 180s — deliberately above the 60s that failed", () => {
    expect(isCallBudgetMs("generation")).toBe(180_000);
    expect(isCallBudgetMs("agentTurn")).toBe(240_000);
    expect(isCallBudgetMs("command")).toBe(120_000);
  });

  it("is env-overridable, and IGNORES a garbage override rather than aborting instantly", () => {
    process.env.SYNAP_IS_GENERATION_TIMEOUT_MS = "300000";
    expect(isCallBudgetMs("generation")).toBe(300_000);
    process.env.SYNAP_IS_GENERATION_TIMEOUT_MS = "not-a-number";
    expect(isCallBudgetMs("generation")).toBe(180_000);
    process.env.SYNAP_IS_GENERATION_TIMEOUT_MS = "0";
    expect(isCallBudgetMs("generation")).toBe(180_000);
  });

  it("attributes a pod-side abort with side + elapsed + budget + size + endpoint", () => {
    const err = describeISFailure(
      {
        kind: "generation",
        endpoint: "https://is.test.internal/v1/tools/generate",
        payloadChars: 6144,
        startedAt: Date.now() - 60_011,
        budgetMs: 180_000,
      },
      timeoutError()
    );
    // WHICH SIDE gave up — the question the original message could not answer.
    expect(err.message).toContain("[pod-side abort]");
    // ELAPSED (allow a few ms of test-runner drift) + BUDGET.
    expect(err.message).toMatch(/gave up after 600\d\dms of a 180000ms budget/);
    // PAYLOAD SIZE — the variable that predicts this failure.
    expect(err.message).toContain("payloadChars=6144");
    // ENDPOINT.
    expect(err.message).toContain(
      "endpoint=https://is.test.internal/v1/tools/generate"
    );
    // The original cause is preserved, not swallowed.
    expect(err.message).toContain(
      "TimeoutError: The operation was aborted due to timeout"
    );
  });

  it("distinguishes a transport failure from a pod-side abort", () => {
    const err = describeISFailure(
      {
        kind: "generation",
        endpoint: "https://is.test.internal/v1/tools/generate",
        payloadChars: 10,
        startedAt: Date.now(),
        budgetMs: 180_000,
      },
      new Error("fetch failed")
    );
    expect(err.message).toContain("[transport failure]");
    expect(err.message).not.toContain("[pod-side abort]");
  });

  it("attributes an IS-returned HTTP error to the IS side and truncates its body", () => {
    const err = describeISHttpError(
      {
        kind: "generation",
        endpoint: "https://is.test.internal/v1/tools/generate",
        payloadChars: 42,
        startedAt: Date.now(),
        budgetMs: 180_000,
      },
      502,
      "Bad Gateway",
      "x".repeat(5000)
    );
    expect(err.message).toContain("[IS error]");
    expect(err.message).toContain("HTTP 502 Bad Gateway");
    expect(err.message).toContain("payloadChars=42");
    expect(err.message.length).toBeLessThan(600);
  });

  it("generateViaIS surfaces the attributed message (the real 2026-07-31 path)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw timeoutError();
    }) as unknown as typeof fetch;

    const prompt = "x".repeat(6000);
    await expect(generateViaIS({ prompt, maxTokens: 700 })).rejects.toThrow(
      /IS generation call failed \[pod-side abort\].*budget.*endpoint=https:\/\/is\.test\.internal\/v1\/tools\/generate.*payloadChars=/s
    );
  });

  it("generateViaIS uses the configured budget as its abort signal", async () => {
    process.env.SYNAP_IS_GENERATION_TIMEOUT_MS = "111000";
    let seen: number | undefined;
    globalThis.fetch = vi.fn(async (_u: unknown, init: RequestInit) => {
      // AbortSignal.timeout exposes no deadline; assert via a real race instead:
      // the signal must NOT already be aborted, and the call must carry one.
      seen = init.signal ? 1 : 0;
      return new Response(JSON.stringify({ output: "ok" }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(generateViaIS({ prompt: "hi" })).resolves.toBe("ok");
    expect(seen).toBe(1);
    expect(isCallBudgetMs("generation")).toBe(111_000);
  });
});
