/**
 * `signOutInPlace` (the invite page's "Sign out and continue"): the logout URL
 * is called on the pod's PUBLIC origin asking for JSON (so Kratos answers 204
 * instead of redirecting away), and a failed step throws instead of letting
 * the page pretend the account changed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signOutInPlace } from "./kratos-flow";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

let calls: Array<{ url: string; accept?: string }> = [];
beforeEach(() => {
  calls = [];
  process.env.POD_PUBLIC_URL = "https://pod.example.com";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.POD_PUBLIC_URL;
});

function answer(logout: Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        accept: (init?.headers as Record<string, string> | undefined)?.Accept,
      });
      return url.includes("/logout/browser")
        ? json({
            // Kratos names its public base URL (the pod's /.ory prefix).
            logout_url:
              "https://pod.example.com/.ory/kratos/public/self-service/logout?token=t1",
          })
        : logout;
    })
  );
}

describe("signOutInPlace", () => {
  it("calls the logout URL asking for JSON (204, no redirect away)", async () => {
    answer(new Response(null, { status: 204 }));
    await signOutInPlace();
    expect(calls[1]).toEqual({
      url: "https://pod.example.com/.ory/kratos/public/self-service/logout?token=t1",
      accept: "application/json",
    });
  });

  it("throws when the logout step fails", async () => {
    answer(json({ error: {} }, 410));
    await expect(signOutInPlace()).rejects.toThrow(/Could not sign out/);
  });
});
