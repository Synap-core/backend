/**
 * `isRetryableError` honours the IS's own `retryable: false` (plan §7).
 *
 * The IS refuses an account that is out of credits, out of plan or over the
 * shared budget with a failure envelope that says `retryable: false`.
 * `describeISHttpError` attaches it as `.failure`, but the retry predicate
 * read only its own marker, so the automation executor spent every configured
 * retry on a refusal that could not change. Driven through the REAL producer
 * (`describeISHttpError` on the IS's JSON body), as the executor receives it.
 */
import { describe, it, expect } from "vitest";
import {
  describeISHttpError,
  isRetryableError,
  type ISCallContext,
} from "./is-call-budget.js";

const ctx = (): ISCallContext => ({
  kind: "generation",
  endpoint: "https://is.example/v1/tools/generate",
  payloadChars: 1_200,
  startedAt: Date.now() - 300,
  budgetMs: 180_000,
});

const isAnswered = (status: number, body: unknown) =>
  describeISHttpError(ctx(), status, "", JSON.stringify(body));

describe("isRetryableError — the IS envelope's retryable verdict", () => {
  it("a refusal the IS calls non-retryable is not retried", () => {
    const err = isAnswered(402, {
      error: "AI credits empty",
      failure: { code: "credits_empty", retryable: false, action: "top_up" },
    });
    expect(isRetryableError(err)).toBe(false);
  });

  it("an envelope the IS calls retryable stays retryable", () => {
    const err = isAnswered(503, {
      failure: { code: "entitlement_unavailable", retryable: true },
    });
    expect(isRetryableError(err)).toBe(true);
  });

  it("a failure with no envelope keeps the default: retry", () => {
    expect(isRetryableError(isAnswered(503, { error: "Bad Gateway" }))).toBe(
      true
    );
  });
});
