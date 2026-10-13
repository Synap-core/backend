/**
 * The server-side session check must tell "no session" from "the pod did not
 * answer". A 429 from the pod's rate limiter used to read as signed out, and
 * the gate sent a signed-in operator to /login.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiSessionDenial, checkSession, podAdminRole } from "./kratos";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function answer(res: () => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => res())
  );
}

afterEach(() => vi.unstubAllGlobals());

/** The inbound browser request, as Caddy hands it to pod-admin. */
const CALLER = new Headers({
  cookie: "c=1",
  "x-forwarded-for": "198.51.100.7",
});

describe("every pod call carries the caller", () => {
  // Without the address the pod keyed every console call as IP "unknown":
  // one shared rate-limit budget for every operator.
  it.each([
    ["checkSession", () => checkSession(CALLER)],
    ["podAdminRole", () => podAdminRole(CALLER)],
  ])("%s sends the cookie and the client address", async (_, call) => {
    const fetchMock = vi.fn(async () => json(ACTIVE));
    vi.stubGlobal("fetch", fetchMock);
    await call();
    const init = (
      fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    )[1];
    expect(init.headers).toMatchObject({
      Cookie: "c=1",
      "x-forwarded-for": "198.51.100.7",
    });
  });
});

const ACTIVE = {
  id: "s1",
  active: true,
  identity: { id: "u1", traits: { email: "a@b.c", name: "Ada" } },
};

describe("checkSession", () => {
  it("is active with the identity on a live session", async () => {
    answer(() => json(ACTIVE));
    expect(await checkSession(CALLER)).toEqual({
      state: "active",
      identity: { id: "u1", email: "a@b.c", name: "Ada" },
    });
  });

  it.each([401, 403])("is none when Kratos answers %i", async (status) => {
    answer(() => json({ error: { code: status } }, status));
    expect(await checkSession(CALLER)).toEqual({ state: "none" });
  });

  it("is none for an inactive session", async () => {
    answer(() => json({ ...ACTIVE, active: false }));
    expect(await checkSession(CALLER)).toEqual({ state: "none" });
  });

  it.each([429, 500, 502, 503])(
    "is unavailable — never none — when the pod answers %i",
    async (status) => {
      answer(() => json({ error: "Rate limit exceeded" }, status));
      expect(await checkSession(CALLER)).toEqual({
        state: "unavailable",
        status,
      });
    }
  );

  it("is unavailable when the pod is unreachable", async () => {
    answer(() => Promise.reject(new TypeError("fetch failed")));
    expect(await checkSession(CALLER)).toEqual({
      state: "unavailable",
      status: null,
    });
  });
});

describe("podAdminRole", () => {
  it("maps 200 to admin and 403 to member", async () => {
    answer(() => json({}));
    expect(await podAdminRole(CALLER)).toBe("admin");
    answer(() => json({}, 403));
    expect(await podAdminRole(CALLER)).toBe("member");
  });

  it("is unavailable on a 429, so an admin is not sent to /forbidden", async () => {
    answer(() => json({}, 429));
    expect(await podAdminRole(CALLER)).toBe("unavailable");
  });
});

describe("apiSessionDenial", () => {
  const req = new Request("https://admin.example/api/x", {
    headers: { cookie: "c=1" },
  });

  it("lets a live session through", async () => {
    answer(() => json(ACTIVE));
    expect(await apiSessionDenial(req)).toBeNull();
  });

  it("answers 401 for no session and 503 for a busy pod", async () => {
    answer(() => json({}, 401));
    expect((await apiSessionDenial(req))?.status).toBe(401);
    answer(() => json({}, 429));
    expect((await apiSessionDenial(req))?.status).toBe(503);
  });
});
