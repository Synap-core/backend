import { describe, it, expect } from "vitest";
import {
  classifyAiFailure,
  describeAiFailure,
  aiFailureMessage,
} from "./ai-failure.js";

/**
 * The artifact this module exists for: a user asked the Companion a question
 * and was told "The AI service is temporarily unavailable. Please try again
 * shortly." The truth was HTTP 402 Insufficient Balance — the provider was out
 * of credit, and no retry could ever have worked.
 */
describe("402 / out of credit", () => {
  const shapes: ReadonlyArray<[string, unknown]> = [
    [
      "thrown by IntelligenceHubClient",
      new Error(
        "Intelligence Hub error: 402 Payment Required at https://is.example"
      ),
    ],
    [
      "status property",
      Object.assign(new Error("call failed"), { status: 402 }),
    ],
    ["provider prose", new Error("deepseek: Insufficient Balance")],
    [
      "provider code",
      Object.assign(new Error("failed"), { code: "insufficient_quota" }),
    ],
  ];

  for (const [label, error] of shapes) {
    it(`classifies as quota — ${label}`, () => {
      expect(classifyAiFailure(error)).toBe("quota");
    });

    it(`never tells the user to try again — ${label}`, () => {
      const described = describeAiFailure(error);
      expect(described.retryable).toBe(false);
      expect(described.needsOperator).toBe(true);
      expect(described.message.toLowerCase()).not.toContain("try again");
      expect(described.message.toLowerCase()).not.toContain("temporarily");
      expect(described.message).toMatch(/operator/);
      expect(described.message).toMatch(/will not help/);
    });
  }

  it("outranks an incidental timeout word in the same body", () => {
    expect(
      classifyAiFailure(
        new Error(
          "Intelligence Hub error: 402 Payment Required (request timeout budget 60s)"
        )
      )
    ).toBe("quota");
  });
});

describe("retryable vs not", () => {
  const cases: ReadonlyArray<[unknown, string, boolean]> = [
    [
      new Error(
        "Intelligence service is temporarily unavailable (circuit open)"
      ),
      "circuit",
      true,
    ],
    [new Error("The operation was aborted"), "timeout", true],
    [new Error("IS answer HTTP 503"), "upstream", true],
    [
      new Error("Intelligence Hub error: 429 Too Many Requests"),
      "rate_limit",
      true,
    ],
    [new Error("fetch failed"), "upstream", true],
    [
      Object.assign(new Error("rejected credentials"), { status: 401 }),
      "auth",
      false,
    ],
    [
      new Error("Intelligence Hub error: 400 Bad Request"),
      "bad_request",
      false,
    ],
  ];

  for (const [error, expected, retryable] of cases) {
    it(`${expected} → retryable=${retryable}`, () => {
      const described = describeAiFailure(error);
      expect(described.class).toBe(expected);
      expect(described.retryable).toBe(retryable);
    });
  }

  it("credential rejection never promises a refresh that is not happening", () => {
    const message = aiFailureMessage(
      Object.assign(new Error("Unauthorized"), { status: 401 })
    );
    expect(message).not.toMatch(/refresh/i);
    expect(message).toMatch(/will not help/);
  });
});

describe("no evidence → no invented cause", () => {
  it("says we do not know why", () => {
    const described = describeAiFailure(new Error("boom"));
    expect(described.class).toBe("unknown");
    expect(described.message).toMatch(/do not yet know why/);
    expect(described.message).not.toMatch(/overload|recovering|credential/i);
  });

  it("does not read a bare number as an HTTP status", () => {
    expect(classifyAiFailure(new Error("processed 402 documents"))).toBe(
      "unknown"
    );
  });
});

describe("reference id", () => {
  it("is appended when the caller already has one", () => {
    expect(
      aiFailureMessage(new Error("boom"), { reference: "req-123" })
    ).toContain("Reference: req-123.");
  });

  it("is omitted when there is none — never minted here", () => {
    expect(aiFailureMessage(new Error("boom"))).not.toContain("Reference");
  });
});

/**
 * WIRE CONTRACT with the browser: `CHAT_STREAM_ERROR` carries `error` (shown),
 * `code` (stable), `retryable` (drives whether a Retry button may be offered).
 * The screenshot bug offered Retry on a 402.
 */
describe("wire contract", () => {
  it("402 → provider_no_credit, retryable false (no Retry button)", () => {
    const described = describeAiFailure(
      new Error("Intelligence Hub error: 402 Payment Required")
    );
    expect(described.code).toBe("provider_no_credit");
    expect(described.retryable).toBe(false);
  });

  it("maps every class to a stable code", () => {
    const expected: Record<string, string> = {
      quota: "provider_no_credit",
      auth: "provider_auth",
      rate_limit: "rate_limited",
      timeout: "timeout",
      circuit: "circuit_open",
      upstream: "upstream_error",
      bad_request: "bad_request",
      invalid_response: "invalid_response",
      unknown: "unknown",
    };
    for (const [failureClass, code] of Object.entries(expected)) {
      expect(describeAiFailure(failureClass).code).toBe(code);
    }
  });

  it("no class is retryable AND operator-blocked at once", () => {
    for (const failureClass of Object.keys({
      quota: 0,
      auth: 0,
      rate_limit: 0,
      timeout: 0,
      circuit: 0,
      upstream: 0,
      bad_request: 0,
      invalid_response: 0,
      unknown: 0,
    })) {
      const described = describeAiFailure(failureClass);
      expect(described.retryable && described.needsOperator).toBe(false);
    }
  });

  it("unknown defaults to NOT retryable — never invite an unevidenced retry", () => {
    expect(describeAiFailure(new Error("boom")).retryable).toBe(false);
  });
});

/**
 * The IS now attaches structured evidence to its SSE error frame. We branch on
 * `code` + `retryable` — never on `failure.message`, which is RAW PROVIDER TEXT
 * ("Insufficient Balance") and would reintroduce the same defect, just sourced
 * from the provider instead of invented by us.
 */
describe("IS failure envelope", () => {
  const withEnvelope = (failure: Record<string, unknown>) =>
    Object.assign(new Error("Intelligence service stream failed"), { failure });

  it("maps every IS code explicitly", () => {
    const expected: Record<string, string> = {
      insufficient_credit: "quota",
      quota_exhausted: "plan_quota",
      auth: "auth",
      rate_limit: "rate_limit",
      timeout: "timeout",
      circuit_open: "circuit",
      provider_error: "upstream",
      cancelled: "cancelled",
      unknown: "unknown",
    };
    for (const [code, cls] of Object.entries(expected)) {
      expect(classifyAiFailure(withEnvelope({ code }))).toBe(cls);
    }
  });

  it("falls to unknown on a code we do not know — never the nearest neighbour", () => {
    expect(classifyAiFailure(withEnvelope({ code: "moon_phase_wrong" }))).toBe(
      "unknown"
    );
    expect(
      describeAiFailure(withEnvelope({ code: "moon_phase_wrong" })).message
    ).toMatch(/do not yet know why/);
  });

  it("never puts the raw provider text in user copy", () => {
    const described = describeAiFailure(
      withEnvelope({
        code: "insufficient_credit",
        message: "Insufficient Balance",
      })
    );
    expect(described.message).not.toContain("Insufficient Balance");
    expect(described.message).toMatch(/top up/);
  });

  it("trusts the IS retryable flag over our class default (429 that is really credit)", () => {
    const described = describeAiFailure(
      withEnvelope({ code: "rate_limit", retryable: false, status: 429 })
    );
    expect(described.retryable).toBe(false);
    expect(described.message).toMatch(/retrying will not help/i);
    expect(described.message).not.toMatch(/sending again may work/i);
  });

  it("says WHEN when retryAfterSeconds is real evidence", () => {
    const described = describeAiFailure(
      withEnvelope({
        code: "rate_limit",
        retryable: true,
        retryAfterSeconds: 30,
      })
    );
    expect(described.message).toContain("Try again in about 30s.");
    expect(described.message).not.toMatch(/shortly/);
  });

  it("keeps prose classification when no envelope is attached", () => {
    expect(
      classifyAiFailure(
        new Error("Intelligence Hub error: 402 Payment Required")
      )
    ).toBe("quota");
  });
});

describe("known class in, copy out", () => {
  it("accepts a class the caller already resolved", () => {
    const described = describeAiFailure("invalid_response");
    expect(described.class).toBe("invalid_response");
    expect(described.retryable).toBe(false);
  });
});
