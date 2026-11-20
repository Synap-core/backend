/**
 * The proxy's gate answers: asked together, a positive one reused for 30 s,
 * a "no" or a "could not tell" never reused (founder accepted the 30 s
 * window, 2026-11-20). Driven through the real `checkSession` /
 * `podAdminRole` with only `fetch` stubbed, so the wire shapes are the real
 * ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ACTIVE = {
  id: "s1",
  active: true,
  identity: { id: "u1", traits: { email: "a@b.c", name: "Ada" } },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** The pod: whoami and the role probe, each answering what the test says. */
function pod(
  whoami: () => Response | Promise<Response>,
  role: () => Response | Promise<Response> = () => json({ ok: true })
) {
  const fetchMock = vi.fn(async (url: string) =>
    String(url).includes("/sessions/whoami") ? whoami() : role()
  );
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    whoamiCalls: () =>
      fetchMock.mock.calls.filter(([u]) => String(u).includes("whoami")).length,
    roleCalls: () =>
      fetchMock.mock.calls.filter(([u]) => String(u).includes("sync.getStatus"))
        .length,
  };
}

const caller = (cookie: string) =>
  new Headers({ cookie, "x-forwarded-for": "198.51.100.7" });

const SESSION_A = "ory_kratos_session=" + "a".repeat(80);
const SESSION_B = "ory_kratos_session=" + "b".repeat(80);

let gate: typeof import("./gate-cache");

beforeEach(async () => {
  // A fresh module per test: the cache is module state, by design.
  vi.resetModules();
  gate = await import("./gate-cache");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a positive answer is reused within 30 s", () => {
  it("asks the pod nothing the second time for the same session", async () => {
    const p = pod(() => json(ACTIVE));
    const first = await gate.gateAnswers(caller(SESSION_A), true);
    const second = await gate.gateAnswers(caller(SESSION_A), true);
    expect(first).toEqual({
      session: {
        state: "active",
        identity: { id: "u1", email: "a@b.c", name: "Ada" },
      },
      role: "admin",
    });
    expect(second).toEqual(first);
    expect(p.fetchMock).toHaveBeenCalledTimes(2); // the first request's two
  });

  it("keys on the Kratos cookie only: other cookies changing share the entry", async () => {
    const p = pod(() => json(ACTIVE));
    await gate.gateAnswers(caller(`theme=dark; ${SESSION_A}`), true);
    await gate.gateAnswers(caller(`${SESSION_A}; nav=collapsed`), true);
    expect(p.whoamiCalls()).toBe(1);
    expect(p.roleCalls()).toBe(1);
  });

  it("keeps a member's role too", async () => {
    const p = pod(
      () => json(ACTIVE),
      () => json({ error: "FORBIDDEN" }, 403)
    );
    await gate.gateAnswers(caller(SESSION_A), true);
    const again = await gate.gateAnswers(caller(SESSION_A), true);
    expect(again.role).toBe("member");
    expect(p.roleCalls()).toBe(1);
  });

  it("asks again once 30 s have passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T10:00:00Z"));
    const p = pod(() => json(ACTIVE));
    await gate.gateAnswers(caller(SESSION_A), true);
    vi.setSystemTime(new Date("2026-11-20T10:00:29Z"));
    await gate.gateAnswers(caller(SESSION_A), true);
    expect(p.whoamiCalls()).toBe(1);
    vi.setSystemTime(new Date("2026-11-20T10:00:31Z"));
    await gate.gateAnswers(caller(SESSION_A), true);
    expect(p.whoamiCalls()).toBe(2);
    expect(p.roleCalls()).toBe(2);
  });
});

describe("a no, or a could-not-tell, is never reused", () => {
  it.each([
    ["no session (401)", () => json({ error: "no session" }, 401)],
    ["an inactive session", () => json({ ...ACTIVE, active: false })],
    ["a rate-limited pod (429)", () => json({ error: "slow down" }, 429)],
    ["a failing pod (502)", () => json({ error: "bad gateway" }, 502)],
    [
      "an unreachable pod",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("asks Kratos again after %s", async (_, answer) => {
    const p = pod(answer);
    const first = await gate.gateAnswers(caller(SESSION_A), true);
    expect(first.session.state).not.toBe("active");
    await gate.gateAnswers(caller(SESSION_A), true);
    expect(p.whoamiCalls()).toBe(2);
  });

  it("asks the role again after the probe could not answer", async () => {
    const p = pod(
      () => json(ACTIVE),
      () => json({ error: "slow down" }, 429)
    );
    const first = await gate.gateAnswers(caller(SESSION_A), true);
    expect(first.role).toBe("unavailable");
    await gate.gateAnswers(caller(SESSION_A), true);
    expect(p.roleCalls()).toBe(2);
    // The session itself was a yes, and is reused.
    expect(p.whoamiCalls()).toBe(1);
  });

  it("keeps nothing for a request without a Kratos session cookie", async () => {
    const p = pod(() => json(ACTIVE));
    await gate.gateAnswers(caller("theme=dark"), true);
    await gate.gateAnswers(caller("theme=dark"), true);
    expect(p.whoamiCalls()).toBe(2);
  });
});

describe("two sessions never share an answer", () => {
  it("asks for each cookie and returns each its own identity", async () => {
    const p = pod(() => json(ACTIVE));
    await gate.gateAnswers(caller(SESSION_A), true);
    p.fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("whoami")
        ? json({
            ...ACTIVE,
            identity: { id: "u2", traits: { email: "b@b.c" } },
          })
        : json({ error: "FORBIDDEN" }, 403)
    );
    const b = await gate.gateAnswers(caller(SESSION_B), true);
    expect(b.session).toEqual({
      state: "active",
      identity: { id: "u2", email: "b@b.c", name: null },
    });
    expect(b.role).toBe("member");
    const a = await gate.gateAnswers(caller(SESSION_A), true);
    expect(a.role).toBe("admin");
    expect(p.whoamiCalls()).toBe(2);
  });

  it("holds the hash, never the cookie value", () => {
    const key = gate.sessionCacheKey(caller(SESSION_A));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("aaaa");
    expect(gate.sessionCacheKey(caller(SESSION_B))).not.toBe(key);
  });
});

describe("whoami and the role probe start together", () => {
  it("sends both before either answers", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const p = pod(
      async () => {
        await held;
        return json(ACTIVE);
      },
      async () => {
        await held;
        return json({ ok: true });
      }
    );
    const pending = gate.gateAnswers(caller(SESSION_A), true);
    await new Promise((r) => setTimeout(r, 0));
    expect(p.whoamiCalls()).toBe(1);
    expect(p.roleCalls()).toBe(1);
    release();
    expect((await pending).role).toBe("admin");
  });

  it("skips the role probe on a path that does not need it", async () => {
    const p = pod(() => json(ACTIVE));
    const answers = await gate.gateAnswers(caller(SESSION_A), false);
    expect(answers.role).toBeNull();
    expect(p.roleCalls()).toBe(0);
  });
});

describe("the memory is bounded", () => {
  it("drops the oldest session past 1000 entries", async () => {
    const p = pod(() => json(ACTIVE));
    const session = (n: number) =>
      caller(`ory_kratos_session=${String(n).padStart(80, "0")}`);
    for (let n = 0; n <= gate.GATE_CACHE_MAX_ENTRIES; n++) {
      await gate.gateAnswers(session(n), false);
    }
    const asked = p.whoamiCalls();
    await gate.gateAnswers(session(gate.GATE_CACHE_MAX_ENTRIES), false);
    expect(p.whoamiCalls()).toBe(asked); // the newest is still held
    await gate.gateAnswers(session(0), false);
    expect(p.whoamiCalls()).toBe(asked + 1); // the oldest was dropped
  });
});
