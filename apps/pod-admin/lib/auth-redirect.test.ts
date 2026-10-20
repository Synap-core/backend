import { afterEach, describe, expect, it, vi } from "vitest";

const sessionState = vi.fn<() => Promise<"active" | "none" | "unknown">>();
vi.mock("./kratos-flow", () => ({
  browserSessionState: () => sessionState(),
}));

const { redirectToLogin, redirectToLoginIfUnauthorized } =
  await import("./auth-redirect");

/**
 * The return path must carry the QUERY STRING, not just the pathname.
 *
 * Each caller used to pass a hardcoded `"/audit"`-style literal, discarding
 * `?section=…&focus=…` — which is the entire address on the surfaces this app
 * built. An expired session on a ⌘K deep link bounced through login and landed
 * on the bare tab with the target gone.
 */
const UNAUTHORIZED = { data: { code: "UNAUTHORIZED" } };

function stubLocation(url: string) {
  const assign = vi.fn();
  const u = new URL(url);
  vi.stubGlobal("window", {
    location: { pathname: u.pathname, search: u.search, assign },
  });
  return assign;
}

/** Let the session check and its `.then` settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.unstubAllGlobals();
  sessionState.mockReset();
});

describe("redirectToLoginIfUnauthorized", () => {
  it("preserves the query string a deep link depends on", async () => {
    sessionState.mockResolvedValue("none");
    const assign = stubLocation(
      "https://pod.example/audit?section=proposals&focus=abc-123"
    );
    expect(redirectToLoginIfUnauthorized(UNAUTHORIZED)).toBe(true);
    await settle();
    const target = new URL(assign.mock.calls[0][0], "https://pod.example");
    expect(target.searchParams.get("return")).toBe(
      "/audit?section=proposals&focus=abc-123"
    );
  });

  it("works for a plain path with no query", async () => {
    sessionState.mockResolvedValue("none");
    const assign = stubLocation("https://pod.example/people");
    redirectToLoginIfUnauthorized(UNAUTHORIZED);
    await settle();
    const target = new URL(assign.mock.calls[0][0], "https://pod.example");
    expect(target.searchParams.get("return")).toBe("/people");
  });

  it("stays on the page when Kratos says the session is alive", async () => {
    // An UNAUTHORIZED that is not a session expiry (a Hub-key door, a relayed
    // upstream 401) must not send a signed-in person to /login.
    sessionState.mockResolvedValue("active");
    const assign = stubLocation("https://pod.example/marketplace?tab=tools");
    expect(redirectToLoginIfUnauthorized(UNAUTHORIZED)).toBe(true);
    await settle();
    expect(assign).not.toHaveBeenCalled();
  });

  it("stays on the page when Kratos does not answer", async () => {
    sessionState.mockResolvedValue("unknown");
    const assign = stubLocation("https://pod.example/marketplace");
    redirectToLoginIfUnauthorized(UNAUTHORIZED);
    await settle();
    expect(assign).not.toHaveBeenCalled();
  });

  it("asks Kratos once for a burst of failing queries", async () => {
    sessionState.mockResolvedValue("none");
    const assign = stubLocation("https://pod.example/runs");
    redirectToLoginIfUnauthorized(UNAUTHORIZED);
    redirectToLoginIfUnauthorized(UNAUTHORIZED);
    await settle();
    expect(sessionState).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("ignores errors that are not UNAUTHORIZED", () => {
    const assign = stubLocation("https://pod.example/audit?focus=x");
    expect(redirectToLoginIfUnauthorized({ data: { code: "FORBIDDEN" } })).toBe(
      false
    );
    expect(assign).not.toHaveBeenCalled();
    expect(sessionState).not.toHaveBeenCalled();
  });

  it("ignores a null error", () => {
    const assign = stubLocation("https://pod.example/audit");
    expect(redirectToLoginIfUnauthorized(null)).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("redirectToLogin", () => {
  it("checks the session and goes to login, for a 401 outside tRPC", async () => {
    sessionState.mockResolvedValue("none");
    const assign = stubLocation("https://pod.example/updates");
    expect(redirectToLogin()).toBe(true);
    await settle();
    const target = new URL(assign.mock.calls[0][0], "https://pod.example");
    expect(target.searchParams.get("return")).toBe("/updates");
  });
});
