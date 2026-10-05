/**
 * IS account refusal → hub client → pod classification → the user's words.
 *
 * Driven from the REAL wire shape with nothing hand-built in between: an
 * IS-shaped JSON body (as `enforceQuota`, `NOT_ENTITLED_BODY`,
 * `ACCOUNT_INACTIVE_BODY` and the spend guard send it) is answered to the
 * real `IntelligenceHubClient`, and the error it throws goes through the real
 * `describeAiFailure` — exactly what `channels/send-message.ts` does with a
 * failed stream and its non-streaming fallback.
 *
 * Observed live 2026-10-06: a deactivated IS customer got "The AI provider
 * rejected our credentials… an operator has to fix the AI service
 * credentials". The client dropped the body's `failure`, so only the bare 403
 * reached the classifier.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntelligenceHubClient } from "@synap/intelligence-client";
import { classifyAiFailure, describeAiFailure } from "./ai-failure.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
afterEach(() => fetchMock.mockReset());

function isAnswers(status: number, body: unknown) {
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })
  );
}

let seq = 0;
async function streamFailure(): Promise<unknown> {
  const client = new IntelligenceHubClient(
    `http://is-seam-${++seq}.test`,
    "key"
  );
  try {
    for await (const _ of client.sendMessageStream({
      query: "hi",
      threadId: "t",
      userId: "u",
    })) {
      // none
    }
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

async function fallbackFailure(): Promise<unknown> {
  const client = new IntelligenceHubClient(
    `http://is-seam-${++seq}.test`,
    "key"
  );
  return client
    .sendMessage({ query: "hi", threadId: "t", userId: "u" })
    .catch((e: unknown) => e);
}

const CASES = [
  {
    name: "monthly plan quota (429)",
    status: 429,
    body: {
      error: "Token quota exceeded",
      message: "You have exceeded your monthly token quota.",
      failure: { code: "account_quota_exceeded", retryable: false },
    },
    cls: "account_quota",
    code: "account_quota_exceeded",
    says: /monthly AI quota/,
    never: /rate-limit|credential|try again/i,
  },
  {
    name: "plan does not include AI (403)",
    status: 403,
    body: {
      error: "Account not entitled",
      message: "Your subscription does not allow intelligence access.",
      failure: { code: "not_entitled", retryable: false },
    },
    cls: "not_entitled",
    code: "not_entitled",
    says: /plan does not include/,
    never: /credential/i,
  },
  {
    name: "account deactivated (403)",
    status: 403,
    body: {
      error: "Account inactive",
      message: "Your account has been deactivated. Please contact support.",
      failure: { code: "account_inactive", retryable: false },
    },
    cls: "account_inactive",
    code: "account_inactive",
    says: /AI access is turned off for this account/,
    never: /credential|provider/i,
  },
  {
    name: "shared monthly budget (429)",
    status: 429,
    body: {
      error: "Knowledge synthesis refused: LLM budget exceeded",
      failure: {
        code: "llm_budget_exceeded",
        message: "interactive_chat over budget",
        retryable: false,
      },
    },
    cls: "budget",
    code: "llm_budget_exceeded",
    says: /shared AI capacity for this month/,
    never: /provider|rate-limit|try again/i,
  },
] as const;

describe.each(["stream", "fallback"] as const)(
  "IS account refusal via %s → user-facing verdict",
  (door) => {
    it.each(CASES)("$name", async (c) => {
      isAnswers(c.status, c.body);
      const err = await (door === "stream"
        ? streamFailure()
        : fallbackFailure());
      const d = describeAiFailure(err);
      expect(d.class).toBe(c.cls);
      expect(d.code).toBe(c.code);
      expect(d.retryable).toBe(false);
      expect(d.message).toMatch(c.says);
      expect(d.message).not.toMatch(c.never);
    });
  }
);

describe("the same refusal WITHOUT an envelope (an old IS)", () => {
  it("still falls back to the bare status — the envelope is what decides", async () => {
    isAnswers(403, { error: "Account inactive" });
    expect(classifyAiFailure(await streamFailure())).toBe("auth");
  });
});

describe("SSE error-frame envelope (chat budget stop)", () => {
  it("llm_budget_exceeded on a stream error frame classifies as budget", () => {
    // send-message attaches the frame's `failure` to the Error it throws.
    const err = Object.assign(new Error("Intelligence service stream failed"), {
      failure: { code: "llm_budget_exceeded", retryable: false },
    });
    const d = describeAiFailure(err);
    expect(d.code).toBe("llm_budget_exceeded");
    expect(d.needsOperator).toBe(true);
    expect(d.message).not.toMatch(/provider/i);
  });
});
