import { afterEach, describe, expect, it, vi } from "vitest";
import { redirectToLoginIfUnauthorized } from "./auth-redirect";

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

afterEach(() => vi.unstubAllGlobals());

describe("redirectToLoginIfUnauthorized", () => {
  it("preserves the query string a deep link depends on", () => {
    const assign = stubLocation(
      "https://pod.example/audit?section=proposals&focus=abc-123"
    );
    expect(redirectToLoginIfUnauthorized(UNAUTHORIZED)).toBe(true);
    const target = new URL(assign.mock.calls[0][0], "https://pod.example");
    expect(target.searchParams.get("return")).toBe(
      "/audit?section=proposals&focus=abc-123"
    );
  });

  it("works for a plain path with no query", () => {
    const assign = stubLocation("https://pod.example/people");
    redirectToLoginIfUnauthorized(UNAUTHORIZED);
    const target = new URL(assign.mock.calls[0][0], "https://pod.example");
    expect(target.searchParams.get("return")).toBe("/people");
  });

  it("ignores errors that are not UNAUTHORIZED", () => {
    const assign = stubLocation("https://pod.example/audit?focus=x");
    expect(redirectToLoginIfUnauthorized({ data: { code: "FORBIDDEN" } })).toBe(
      false
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it("ignores a null error", () => {
    const assign = stubLocation("https://pod.example/audit");
    expect(redirectToLoginIfUnauthorized(null)).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });
});
