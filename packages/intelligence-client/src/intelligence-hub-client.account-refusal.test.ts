/**
 * An IS ACCOUNT refusal on a pre-stream non-2xx keeps its `failure` envelope
 * and never trips the circuit breaker.
 *
 * Before: the client threw only "Intelligence Hub error: 429 Too Many
 * Requests", dropping the JSON body's `failure`, so the pod classified a
 * monthly-quota 429 as `rate_limit` and a not-entitled / inactive 403 as
 * `auth`. It also called `recordFailure`, so three account refusals opened
 * the breaker and every later turn read "temporarily unavailable".
 *
 * Bodies are byte-shaped as the IS sends them (`enforceQuota`,
 * `NOT_ENTITLED_BODY`, `ACCOUNT_INACTIVE_BODY`, knowledge-answer's spend
 * guard). The pod-side classification of the same bodies is
 * `packages/api/src/utils/ai-failure-is-refusal.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntelligenceHubClient } from "./intelligence-hub-client.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
afterEach(() => fetchMock.mockReset());

const REFUSALS: Array<[string, number, Record<string, unknown>]> = [
  [
    "account_quota_exceeded",
    429,
    {
      error: "Token quota exceeded",
      message: "You have exceeded your monthly token quota.",
      failure: { code: "account_quota_exceeded", retryable: false },
    },
  ],
  [
    "not_entitled",
    403,
    {
      error: "Account not entitled",
      message: "Your subscription does not allow intelligence access.",
      failure: { code: "not_entitled", retryable: false },
    },
  ],
  // The IS account gate's 402s (`lib/account-gate.ts` → `accountRefusalBody`).
  [
    "credits_empty",
    402,
    {
      error: "AI credits are used up",
      failure: {
        code: "credits_empty",
        retryable: false,
        actor: "payer",
        action: "top_up",
      },
    },
  ],
  [
    "access_suspended",
    402,
    {
      error: "AI access is suspended",
      failure: {
        code: "access_suspended",
        retryable: false,
        actor: "payer",
        action: "ask_admin",
      },
    },
  ],
  [
    "account_inactive",
    403,
    {
      error: "Account inactive",
      message: "Your account has been deactivated. Please contact support.",
      failure: { code: "account_inactive", retryable: false },
    },
  ],
  [
    "llm_budget_exceeded",
    429,
    {
      error: "LLM budget exceeded",
      failure: {
        code: "llm_budget_exceeded",
        message: "interactive_chat over budget",
        retryable: false,
      },
    },
  ],
];

function respond(status: number, body: unknown) {
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })
  );
}

let seq = 0;
/** A fresh baseUrl per test: the breaker is module state keyed by baseUrl. */
function client() {
  return new IntelligenceHubClient(`http://is-refusal-${++seq}.test`, "key");
}

async function streamError(c: IntelligenceHubClient): Promise<unknown> {
  try {
    for await (const _ of c.sendMessageStream({
      query: "hi",
      threadId: "t",
      userId: "u",
    })) {
      // no frames expected
    }
  } catch (err) {
    return err;
  }
  throw new Error("expected sendMessageStream to throw");
}

describe("sendMessageStream — pre-stream account refusal", () => {
  it.each(REFUSALS)(
    "%s: the thrown error carries the IS envelope + status",
    async (code, status, body) => {
      respond(status, body);
      const err = (await streamError(client())) as {
        failure?: { code?: string; retryable?: boolean };
        status?: number;
      };
      expect(err.failure).toMatchObject({ code, retryable: false });
      expect(err.status).toBe(status);
    }
  );

  it.each(REFUSALS)(
    "%s: four refusals in a row never open the breaker",
    async (_code, status, body) => {
      respond(status, body);
      const c = client();
      for (let i = 0; i < 4; i++) {
        const err = (await streamError(c)) as Error;
        expect(err.message).not.toMatch(/circuit open/);
      }
      // Every call reached the IS — none was refused locally by the breaker.
      expect(fetchMock).toHaveBeenCalledTimes(4);
    }
  );

  it("NON-VACUOUS: three bare 503s DO open the breaker", async () => {
    respond(503, { error: "boom" });
    const c = client();
    for (let i = 0; i < 3; i++) await streamError(c);
    const err = (await streamError(c)) as Error;
    expect(err.message).toMatch(/circuit open/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("sendMessage — account refusal (the non-streaming fallback)", () => {
  it.each(REFUSALS)(
    "%s: no retry, envelope carried, breaker untouched",
    async (code, status, body) => {
      respond(status, body);
      const c = client();
      for (let i = 0; i < 4; i++) {
        const err = (await c
          .sendMessage({ query: "hi", threadId: "t", userId: "u" })
          .catch((e: unknown) => e)) as Error & {
          failure?: { code?: string };
        };
        expect(err.message).not.toMatch(/circuit open/);
        expect(err.failure?.code).toBe(code);
      }
      // One request per call: a non-retryable refusal is not retried.
      expect(fetchMock).toHaveBeenCalledTimes(4);
    }
  );
});
