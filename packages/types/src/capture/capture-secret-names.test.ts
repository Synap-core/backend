import { describe, expect, it } from "vitest";
import {
  CaptureAnswerSchema,
  CaptureQuestionPartSchema,
  REDACTED_SECRET,
} from "./index.js";

/**
 * Capture shares the ask leaf's form schemas, so the NAME floor changes capture
 * too: a follow-up form can no longer carry a credential-NAMED field, and a
 * plain string answered under a credential-named key is redacted before it is
 * persisted into `messages.metadata.capturePart`.
 */

const KEY = "sk_live_51Habc";

describe("capture: the credential NAME floor", () => {
  it("drops a credential-named follow-up field whose type is innocent", () => {
    const part = CaptureQuestionPartSchema.parse({
      kind: "capture_question",
      v: 1,
      sessionId: "0b7f5f7e-7c1a-4f59-9d35-3f1f3d2f8a01",
      round: 1,
      question: "Which account?",
      chips: [],
      formSpec: {
        fields: [
          { key: "account", label: "Account", type: "text" },
          { key: "stripe_api_key", label: "Stripe secret key", type: "text" },
        ],
      },
      partialCount: 0,
      status: "open",
    });
    expect(part.formSpec?.fields.map((f) => f.key)).toEqual(["account"]);
  });

  it("redacts a plain string answered under a credential-named key", () => {
    const answer = CaptureAnswerSchema.parse({
      type: "form",
      values: { account: "acct_1", stripe_api_key: KEY },
    });
    if (answer.type !== "form") throw new Error("expected a form answer");
    expect(answer.values.stripe_api_key).toBe(REDACTED_SECRET);
    expect(answer.values.account).toBe("acct_1");
    expect(JSON.stringify(answer)).not.toContain(KEY);
  });
});
