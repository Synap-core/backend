/**
 * TRIPWIRE (apps/api has no `test` script; the ratchet runs tripwires only):
 * `GET /invite/:token` on the pod host sends the browser to THIS pod's console
 * invite page (the link the CP puts in an own-domain pod's invite email), and
 * the token never reaches a log line.
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

import { registerInviteBounce } from "./invite-bounce.js";
import { redactSecretPath } from "./middleware/redact-secret-path.js";

const TOKEN = "inv-tok/with?odd#chars";

function app() {
  const a = new Hono();
  registerInviteBounce(a);
  return a;
}

beforeEach(() => {
  h.admin = { ok: true, base: new URL("https://console.example.org/") };
});

describe("GET /invite/:token (pod host)", () => {
  it("302s to this pod's console invite page, the token encoded", async () => {
    const res = await app().request(`/invite/${encodeURIComponent(TOKEN)}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `https://console.example.org/invite/${encodeURIComponent(TOKEN)}`
    );
  });

  it("names no guessed console when the pod has none configured (503)", async () => {
    h.admin = { ok: false, code: "POD_ADMIN_URL_REQUIRED" };
    const res = await app().request("/invite/t-1");
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
    await expect(res.json()).resolves.toMatchObject({
      code: "POD_ADMIN_URL_REQUIRED",
    });
  });

  it("the token is masked in a log line", () => {
    const line = redactSecretPath("<-- GET /invite/s3cr3t-invite-token");
    expect(line).toBe("<-- GET /invite/[redacted]");
  });
});
