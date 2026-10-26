/**
 * TRIPWIRE (apps/api has no `test` script; the ratchet runs tripwires only):
 * `GET /admin/link-cloud` on the pod host sends the browser to THIS pod's
 * console "Link Synap Cloud" page, and never forwards a query (the CP hop's
 * assertion and outcome travel in the fragment, which the browser keeps).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const h = vi.hoisted(() => ({
  admin: { ok: true, base: new URL("https://console.example.org/") } as
    | { ok: true; base: URL }
    | { ok: false; code: "POD_ADMIN_URL_REQUIRED" | "POD_ADMIN_URL_INVALID" },
}));

vi.mock("./pod-admin-config.js", () => ({
  configuredPodAdminBase: () => h.admin,
}));

import { registerLinkCloudBounce } from "./link-cloud-bounce.js";

function app() {
  const a = new Hono();
  registerLinkCloudBounce(a);
  return a;
}

beforeEach(() => {
  h.admin = { ok: true, base: new URL("https://console.example.org/") };
});

describe("GET /admin/link-cloud (pod host)", () => {
  it("302s to this pod's console link page", async () => {
    const res = await app().request("/admin/link-cloud");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://console.example.org/link-cloud"
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("drops any query: nothing of the hop is forwarded from one", async () => {
    const res = await app().request(
      "/admin/link-cloud?assertion=leak&intent=x&next=https://evil.example"
    );
    expect(res.headers.get("location")).toBe(
      "https://console.example.org/link-cloud"
    );
  });

  it("names no guessed console when the pod has none configured (503)", async () => {
    h.admin = { ok: false, code: "POD_ADMIN_URL_REQUIRED" };
    const res = await app().request("/admin/link-cloud");
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
  });
});
