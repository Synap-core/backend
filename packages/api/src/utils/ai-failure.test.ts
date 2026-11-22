import { describe, it, expect } from "vitest";
import {
  aiAvailabilityCopy,
  resolveAiFailureState,
} from "@synap-core/types/ai-availability";
import {
  classifyAiFailure,
  describeAiFailure,
  aiFailureMessage,
  describePartialTurnFailure,
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
      // The deck's provider_issue words: nobody on the pod acts, and no
      // operator or top-up is promised to whoever reads it.
      expect(described.message).toMatch(/AI provider is having trouble/);
      expect(described.message).not.toMatch(/operator|top up/i);
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
      account_quota_exceeded: "account_quota",
      not_entitled: "not_entitled",
      credits_empty: "credits_empty",
      access_suspended: "access_suspended",
      account_inactive: "account_inactive",
      llm_budget_exceeded: "budget",
      auth: "auth",
      rate_limit: "rate_limit",
      timeout: "timeout",
      circuit_open: "circuit",
      entitlement_unavailable: "entitlement_unavailable",
      provider_error: "upstream",
      cancelled: "cancelled",
      unknown: "unknown",
    };
    for (const [code, cls] of Object.entries(expected)) {
      expect(classifyAiFailure(withEnvelope({ code }))).toBe(cls);
    }
  });

  it("entitlement_unavailable (IS 503: the account service could not be reached) is a retryable moment, not a refusal", () => {
    const described = describeAiFailure(
      Object.assign(
        new Error("Intelligence Hub error: 503 Service Unavailable"),
        {
          status: 503,
          failure: {
            code: "entitlement_unavailable",
            retryable: true,
            status: 503,
          },
        }
      )
    );
    expect(described).toMatchObject({
      class: "entitlement_unavailable",
      code: "entitlement_unavailable",
      retryable: true,
      needsOperator: false,
    });
    expect(described.message).toMatch(/account service could not be reached/);
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
    expect(described.message).toMatch(/AI provider is having trouble/);
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

describe("describePartialTurnFailure — the IS code union is NOT ours", () => {
  // The IS emits `ProviderFailureCode` (insufficient_credit, auth,
  // context_length_exceeded, …). The client switches on `AiFailureCode`
  // (provider_no_credit, provider_auth, …). Forwarding the IS code raw makes
  // every case fall to the surface's `default` branch, which prints
  // `ProviderFailure.message` — RAW PROVIDER TEXT the IS documents as NOT
  // user-facing copy. These pin the translation.
  it("translates insufficient_credit → provider_no_credit, no retry, operator", () => {
    const verdict = describePartialTurnFailure({
      code: "insufficient_credit",
      message: "Insufficient Balance",
      retryable: false,
    });
    expect(verdict.code).toBe("provider_no_credit");
    expect(verdict.recoverable).toBe(false);
    expect(verdict.needsOperator).toBe(true);
    // The raw provider fragment never reaches the user.
    expect(verdict.message).not.toContain("Insufficient Balance");
    expect(verdict.message).toContain("stopped early");
  });

  it("translates auth → provider_auth and never offers a retry", () => {
    const verdict = describePartialTurnFailure({
      code: "auth",
      message: "invalid api key",
      retryable: false,
    });
    expect(verdict.code).toBe("provider_auth");
    expect(verdict.recoverable).toBe(false);
    expect(verdict.needsOperator).toBe(true);
  });

  it("keeps a genuinely retryable truncation retryable", () => {
    const verdict = describePartialTurnFailure({
      code: "provider_error",
      message: "502 Bad Gateway",
      retryable: true,
    });
    expect(verdict.code).toBe("upstream_error");
    expect(verdict.recoverable).toBe(true);
    expect(verdict.needsOperator).toBe(false);
  });

  it.each([
    ["context_length_exceeded", "context_length_exceeded"],
    ["content_filter", "content_filter"],
  ])(
    "maps the IS code %s instead of falling to unknown",
    (isCode, expected) => {
      // Both were absent from IS_CODE_TO_CLASS and resolved to `unknown`,
      // whose copy says "we do not yet know why" — a claim of ignorance about
      // a failure the IS had already classified precisely.
      const verdict = describePartialTurnFailure({
        code: isCode,
        message: "raw provider text",
        retryable: false,
      });
      expect(verdict.code).toBe(expected);
      expect(verdict.code).not.toBe("unknown");
      // Neither is an operator problem: an operator cannot shorten a prompt.
      expect(verdict.needsOperator).toBe(false);
    }
  );

  it("an IS code we have never seen degrades to unknown, never leaks raw", () => {
    const verdict = describePartialTurnFailure({
      code: "some_future_is_code",
      message: "raw provider text",
      retryable: false,
    });
    expect(verdict.code).toBe("unknown");
    expect(verdict.message).not.toContain("raw provider text");
  });
});

/**
 * ONE copy deck (plan §3.3): a class whose code proves an availability state
 * takes its words from `aiAvailabilityCopy`; this module keeps a sentence only
 * for a class about the request. The split is DERIVED from the
 * classification (`resolveAiFailureState` over each class's wire code), never
 * hand-listed, so a class that starts mapping to a state fails here until its
 * own sentence is gone.
 */
describe("one copy deck", () => {
  const CLASSES = [
    "quota",
    "plan_quota",
    "account_quota",
    "not_entitled",
    "credits_empty",
    "access_suspended",
    "account_inactive",
    "budget",
    "context_length",
    "content_filter",
    "cancelled",
    "auth",
    "rate_limit",
    "timeout",
    "circuit",
    "entitlement_unavailable",
    "upstream",
    "bad_request",
    "invalid_response",
    "unknown",
  ] as const satisfies ReadonlyArray<ReturnType<typeof classifyAiFailure>>;
  // Every member of the union is listed: a class added without a row stops
  // the build here.
  type Missing = Exclude<
    ReturnType<typeof classifyAiFailure>,
    (typeof CLASSES)[number]
  >;
  const _complete: [Missing] extends [never] ? true : never = true;
  void _complete;

  const stateClasses = CLASSES.filter(
    (c) => resolveAiFailureState(describeAiFailure(c).code) !== null
  );

  it("the classification splits the classes (non-vacuity)", () => {
    expect(stateClasses).toEqual([
      "quota",
      "plan_quota",
      "account_quota",
      "not_entitled",
      "credits_empty",
      "access_suspended",
      "account_inactive",
      "budget",
      "auth",
      "circuit",
    ]);
  });

  it.each(stateClasses)(
    "%s speaks the deck's words for its state, then the retry verdict",
    (c) => {
      const d = describeAiFailure(c);
      const deck = aiAvailabilityCopy({
        kind: resolveAiFailureState(d.code),
        action: "none",
        switchedOff: c === "account_inactive" ? true : undefined,
      });
      expect(deck).not.toBeNull();
      expect(d.message).toBe(
        `${deck!.detail}${d.retryable ? " Sending again may work." : " Retrying will not help."}`
      );
    }
  );

  it.each(CLASSES)("%s has words and no billing policy", (c) => {
    const { message } = describeAiFailure(c);
    expect(message.length).toBeGreaterThan(20);
    expect(message).not.toMatch(
      /operator|next month|this month|billing period|raise the|upgrade/i
    );
  });

  it("the payer action the IS stated closes the sentence; none stated, none invented", () => {
    const envelope = { code: "credits_empty", retryable: false } as const;
    expect(
      describeAiFailure("credits_empty", {
        envelope: { ...envelope, action: "ask_admin" },
      })
    ).toMatchObject({
      actor: "payer",
      action: "ask_admin",
      message: expect.stringMatching(
        /Captures still save\. Ask an admin to top up credits\./
      ),
    });
    const bare = describeAiFailure("credits_empty", { envelope });
    expect(bare).not.toHaveProperty("action");
    expect(bare.message).not.toMatch(/Top up|Ask an admin/);
  });

  it("the action alone (a degraded capture's) closes the sentence the same way", () => {
    expect(
      describeAiFailure("credits_empty", { action: "ask_admin" })
    ).toMatchObject({
      action: "ask_admin",
      message: expect.stringMatching(/Ask an admin to top up credits\./),
    });
  });

  it("a provider refusal on the pod's own key is the owner's, never an operator's", () => {
    const own = describeAiFailure({
      failure: {
        code: "insufficient_credit",
        retryable: false,
        ownKey: true,
      },
    });
    expect(own).toMatchObject({
      class: "quota",
      actor: "payer",
      action: "none",
      needsOperator: false,
    });
    expect(own.message).toMatch(
      /^Your AI provider key has run out of credit or was refused\. The pod's owner updates it in Settings › AI providers\./
    );
    // Synap's own key: the operator's state, as before.
    const synaps = describeAiFailure({
      failure: { code: "insufficient_credit", retryable: false },
    });
    expect(synaps).toMatchObject({ actor: "operator", needsOperator: true });
    expect(synaps.message).not.toMatch(/provider key/);
  });
});
