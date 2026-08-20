/**
 * THE regression pin for the 2026-08-20 Companion outage.
 *
 * A user asked the Companion a question and was told:
 *   "The AI service rejected the request itself as invalid. Retrying the same
 *    request will not help — this one needs a fix on our side. Reference: …"
 *
 * Two things were wrong with that sentence, and neither was the classification:
 *
 * 1. NO AI SERVICE REJECTED ANYTHING. The Intelligence Service's OWN zod schema
 *    refused the request (`turnContext may not contain more than 20 items`).
 *    Naming the AI provider as the culprit is precisely the defect this module
 *    exists to prevent — its own docstring: "never assert a cause the code did
 *    not verify". A 4xx on the AI call can come from either side and at this
 *    layer we cannot tell which, so the copy must not name one.
 *
 * 2. THE REAL REASON EXISTED AND WAS THROWN AWAY. The IS answered with
 *    `{error:"Validation error", details:[…]}`; the hub client logged that body
 *    and then threw an Error carrying only `status statusText baseUrl`. The one
 *    fact that would have made the message actionable never left the client.
 */

import { describe, it, expect } from "vitest";
import { describeAiFailure } from "./ai-failure.js";

/** How `intelligence-hub-client` now shapes a rejected hub call. */
function hubError(status: number, detail?: string): Error {
  const err = new Error(
    `Intelligence Hub error: ${status} Bad Request at https://is.example`
  ) as Error & { status?: number; detail?: string };
  err.status = status;
  if (detail) err.detail = detail;
  return err;
}

describe("describeAiFailure — the reason travels with the failure", () => {
  it("surfaces the vetted reason for a rejected request", () => {
    const out = describeAiFailure(
      hubError(
        400,
        "turnContext.entries: turnContext may not contain more than 20 items"
      )
    );
    expect(out.class).toBe("bad_request");
    expect(out.message).toContain(
      "turnContext may not contain more than 20 items"
    );
  });

  it("does NOT blame the AI service for a rejection it cannot attribute", () => {
    const out = describeAiFailure(hubError(400));
    // The old copy asserted an actor the code never verified.
    expect(out.message).not.toMatch(/the AI service rejected/i);
    expect(out.message).toMatch(/rejected as invalid/i);
  });

  it("still says retrying will not help, and stays operator-flagged", () => {
    const out = describeAiFailure(hubError(400, "some reason"));
    expect(out.retryable).toBe(false);
    expect(out.needsOperator).toBe(true);
    expect(out.message).toMatch(/will not help/i);
  });

  it("says nothing extra when no reason was vetted", () => {
    expect(describeAiFailure(hubError(400)).message).not.toContain("Reason:");
  });

  it("does not append a reason to classes that already state their own cause", () => {
    // A 402 says exactly why it failed; bolting a generic reason onto it would
    // make the sentence worse, not better.
    const quota = describeAiFailure(hubError(402, "irrelevant detail"));
    expect(quota.class).toBe("quota");
    expect(quota.message).not.toContain("irrelevant detail");
  });

  it("ignores a non-string detail rather than rendering [object Object]", () => {
    const err = new Error(
      "Intelligence Hub error: 400 Bad Request"
    ) as Error & {
      status?: number;
      detail?: unknown;
    };
    err.status = 400;
    err.detail = { nested: true };
    expect(describeAiFailure(err).message).not.toContain("object");
  });

  it("keeps the reference, and puts the reason before it", () => {
    const out = describeAiFailure(hubError(400, "because X"), {
      reference: "abc-123",
    });
    expect(out.message).toContain("Reference: abc-123.");
    expect(out.message.indexOf("because X")).toBeLessThan(
      out.message.indexOf("abc-123")
    );
  });
});
