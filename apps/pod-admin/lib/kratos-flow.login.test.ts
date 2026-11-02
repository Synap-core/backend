/**
 * Starting a login flow from a browser that is already signed in.
 *
 * Kratos answers 400 `{ error: { id: "session_already_available" } }`. The
 * client read `id` at the top level, so it never matched and /login showed
 * "Failed to create login flow (400)" to a signed-in operator.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLoginFlow,
  existingSessionAction,
  loginFlowRefusal,
  pauseSeconds,
  unconfirmedSessionCopy,
} from "./kratos-flow";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const ALREADY = {
  error: {
    id: "session_already_available",
    code: 400,
    status: "Bad Request",
    reason: "A valid session was detected and thus login is not possible.",
    message: "The request was malformed or contained invalid parameters",
  },
};

let urls: string[] = [];
beforeEach(() => {
  urls = [];
  process.env.POD_PUBLIC_URL = "https://pod.example.com";
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.POD_PUBLIC_URL;
});

const SESSION = { id: "s1", active: true, identity: { id: "u1" } };

/** `create` answers the flow request; whoami answers with `whoamiRes`. */
function answer(create: Response, whoamiRes: Response = json(SESSION)) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      return url.includes("/sessions/whoami") ? whoamiRes : create;
    })
  );
}

/** whoami answers the given responses in order (the last one repeats). */
function answerSeq(create: Response | (() => Response), seq: Response[]) {
  let i = 0;
  const calls = { whoami: 0, create: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      if (url.includes("/sessions/whoami")) {
        calls.whoami++;
        return seq[Math.min(i++, seq.length - 1)].clone();
      }
      calls.create++;
      return typeof create === "function" ? create() : create.clone();
    })
  );
  return calls;
}

/** Runs `createLoginFlow` to the end on fake timers; returns it and the ms it waited. */
async function settle(returnTo?: string) {
  vi.useFakeTimers();
  const start = Date.now();
  const p = createLoginFlow(returnTo);
  let done = false;
  void p.finally(() => (done = true));
  await vi.advanceTimersByTimeAsync(0);
  while (!done) await vi.advanceTimersByTimeAsync(250);
  return { result: await p, waitedMs: Date.now() - start };
}

const tooMany = (retryAfter?: string) =>
  new Response("{}", {
    status: 429,
    headers: retryAfter ? { "Retry-After": retryAfter } : {},
  });

describe("loginFlowRefusal", () => {
  it("reads session_already_available from Kratos' error envelope", () => {
    expect(loginFlowRefusal(400, ALREADY)).toEqual({ kind: "signed_in" });
  });

  it("still accepts a bare top-level id", () => {
    expect(loginFlowRefusal(400, { id: "session_already_available" })).toEqual({
      kind: "signed_in",
    });
  });

  it("words any other refusal with Kratos' message and reason", () => {
    expect(
      loginFlowRefusal(400, {
        error: { id: "x", message: "Bad", reason: "because" },
      })
    ).toEqual({ kind: "error", message: "Bad: because" });
  });

  it("falls back to the status when the body says nothing", () => {
    expect(loginFlowRefusal(502, null)).toEqual({
      kind: "error",
      message: "Failed to create login flow (502)",
    });
  });
});

describe("createLoginFlow", () => {
  it("reports the existing session instead of throwing", async () => {
    answer(json(ALREADY, 400));
    await expect(
      createLoginFlow("https://admin.example/login")
    ).resolves.toEqual({ existingSession: SESSION });
  });

  it("retries whoami once, a second later, after a 500, then reports the session", async () => {
    const calls = answerSeq(json(ALREADY, 400), [json({}, 500), json(SESSION)]);
    const { result, waitedMs } = await settle();
    expect(result).toEqual({ existingSession: SESSION });
    expect(calls.whoami).toBe(2);
    expect(waitedMs).toBeGreaterThanOrEqual(1000);
  });

  it("a short Retry-After is waited out before whoami is asked again", async () => {
    const calls = answerSeq(json(ALREADY, 400), [tooMany("3"), json(SESSION)]);
    const { result, waitedMs } = await settle();
    expect(result).toEqual({ existingSession: SESSION });
    expect(calls.whoami).toBe(2);
    expect(waitedMs).toBeGreaterThanOrEqual(3000);
  });

  it("a long Retry-After is not asked inside: rate-limited at once, with the wait", async () => {
    const calls = answerSeq(json(ALREADY, 400), [tooMany("60")]);
    const { result, waitedMs } = await settle();
    expect(result).toEqual({
      unconfirmed: { kind: "rate_limited", retryAfterSeconds: 60 },
    });
    expect(calls.whoami).toBe(1);
    expect(waitedMs).toBe(0);
  });

  it("a 429 without Retry-After is asked again once, a second later", async () => {
    const calls = answerSeq(json(ALREADY, 400), [tooMany()]);
    const { result } = await settle();
    expect(result).toEqual({ unconfirmed: { kind: "rate_limited" } });
    expect(calls.whoami).toBe(2);
  });

  it("reports unavailable after two 503s, without throwing", async () => {
    const calls = answerSeq(json(ALREADY, 400), [json({}, 503)]);
    const { result } = await settle();
    expect(result).toEqual({ unconfirmed: { kind: "unavailable" } });
    expect(calls.whoami).toBe(2);
  });

  it("signed out (401): asks for the flow again and returns the form", async () => {
    const FLOW = { id: "f2", ui: { action: "x", method: "POST", nodes: [] } };
    let n = 0;
    const calls = answerSeq(
      () => (n++ === 0 ? json(ALREADY, 400) : json(FLOW)),
      [json({}, 401)]
    );
    const r = await createLoginFlow();
    expect(r.flow?.id).toBe("f2");
    expect(r.unconfirmed).toBeUndefined();
    expect(calls.whoami).toBe(1);
    expect(calls.create).toBe(2);
  });

  it("signed out twice: stops after one re-ask (no loop)", async () => {
    const calls = answerSeq(json(ALREADY, 400), [json({}, 401)]);
    await expect(createLoginFlow()).resolves.toEqual({
      unconfirmed: { kind: "signed_out" },
    });
    expect(calls.create).toBe(2);
  });

  it("a normal 200 flow never asks whoami", async () => {
    const calls = answerSeq(
      json({ id: "f1", ui: { action: "x", method: "POST", nodes: [] } }),
      [json({}, 500)]
    );
    const r = await createLoginFlow();
    expect(r.flow?.id).toBe("f1");
    expect(calls.whoami).toBe(0);
  });

  it("asks for a re-auth flow with refresh=true", async () => {
    answer(json({ id: "f1", ui: { action: "x", method: "POST", nodes: [] } }));
    const r = await createLoginFlow(undefined, { refresh: true });
    expect(r.flow?.id).toBe("f1");
    expect(new URL(urls[0]).searchParams.get("refresh")).toBe("true");
  });
});

describe("existingSessionAction", () => {
  it("returns when the server could not check (busy pod)", () => {
    expect(existingSessionAction("unavailable")).toBe("return");
  });

  it("returns when the server saw the session (re-auth)", () => {
    expect(existingSessionAction("active")).toBe("return");
  });

  it("explains instead of looping when the server saw NO session", () => {
    expect(existingSessionAction("none")).toBe("explain_cookie_scope");
  });
});

describe("unconfirmedSessionCopy", () => {
  it("signed out: says the sign-in ended and offers a fresh sign-in, never a reload", () => {
    const c = unconfirmedSessionCopy({ kind: "signed_out" });
    expect(c).toEqual({
      title: "Sign in again",
      body: "This browser's sign-in to the console has ended.",
      actionLabel: "Sign in",
      action: "sign_in",
    });
  });

  it("rate-limited: still signed in, and counts the pause down", () => {
    const f = { kind: "rate_limited" as const, retryAfterSeconds: 7 };
    expect(pauseSeconds(f)).toBe(7);
    const c = unconfirmedSessionCopy(f);
    expect(c.title).toBe("You're still signed in");
    expect(c.body).toBe(
      "The pod asked for a short pause. You can continue in 7 seconds."
    );
    expect(c.action).toBe("continue");
    expect(unconfirmedSessionCopy(f, 1).body).toMatch(/in 1 second\.$/);
    expect(unconfirmedSessionCopy(f, 0).body).toBe(
      "The pod asked for a short pause. You can continue now."
    );
  });

  it("rate-limited with no Retry-After still pauses (the default)", () => {
    expect(pauseSeconds({ kind: "rate_limited" })).toBeGreaterThan(0);
    expect(pauseSeconds({ kind: "unavailable" })).toBe(0);
    expect(pauseSeconds({ kind: "signed_out" })).toBe(0);
  });

  it("only a busy pod is offered a reload", () => {
    expect(unconfirmedSessionCopy({ kind: "unavailable" }).action).toBe(
      "retry"
    );
  });

  it("never leads with a status code", () => {
    for (const f of [
      { kind: "unavailable" as const },
      { kind: "rate_limited" as const },
      { kind: "signed_out" as const },
    ]) {
      expect(unconfirmedSessionCopy(f).title).not.toMatch(/\d{3}/);
    }
  });
});
