/**
 * Tests for the standardized 401 envelope helper.
 *
 * Pure unit tests — no DB, no Hono app. We construct a minimal `Context`
 * stub since `authErrorResponse` only calls `c.json(...)`.
 */

import { describe, it, expect, vi } from "vitest";
import { authErrorResponse, shortenKeyId } from "./auth-error.js";
import type { Context } from "hono";

/**
 * Minimal Hono Context stub. We only exercise `c.json(body, status)`, so
 * casting through `unknown` keeps the test focused on observable behavior
 * rather than the full Hono surface area.
 */
function makeCtx() {
  const json = vi.fn((body: unknown, status: number) => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { json } as unknown as Context;
}

describe("authErrorResponse", () => {
  it("returns 401 with the canonical envelope for `no_auth`", async () => {
    const c = makeCtx();
    const res = authErrorResponse(c, "no_auth");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({
      error: "unauthorized",
      reason: "no_auth",
    });
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);
  });

  it("uses the default human-readable copy when no override is supplied", async () => {
    const c = makeCtx();
    const res = authErrorResponse(c, "key_revoked");
    const body = await res.json();
    expect(body.message).toMatch(/key|revoked|active/i);
  });

  it("respects an explicit message override", async () => {
    const c = makeCtx();
    const res = authErrorResponse(c, "expired", {
      message: "Custom expired copy",
    });
    const body = await res.json();
    expect(body.message).toBe("Custom expired copy");
    expect(body.reason).toBe("expired");
  });

  it("includes `missingScope` when supplied with reason=missing_scope", async () => {
    const c = makeCtx();
    const res = authErrorResponse(c, "missing_scope", {
      missingScope: "hub-protocol.write",
    });
    const body = await res.json();
    expect(body.reason).toBe("missing_scope");
    expect(body.missingScope).toBe("hub-protocol.write");
  });

  it("includes `keyIdPrefix` when supplied", async () => {
    const c = makeCtx();
    const res = authErrorResponse(c, "key_revoked", {
      keyIdPrefix: "abcd1234",
    });
    const body = await res.json();
    expect(body.keyIdPrefix).toBe("abcd1234");
  });

  it("OMITS optional fields when not supplied (no undefined leakage)", async () => {
    const c = makeCtx();
    const res = authErrorResponse(c, "no_auth");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["error", "message", "reason"]);
  });

  it("invalid_format default message hints at the expected prefix", async () => {
    const c = makeCtx();
    const res = authErrorResponse(c, "invalid_format");
    const body = await res.json();
    expect(body.message).toMatch(/synap_/);
  });
});

describe("shortenKeyId", () => {
  it("returns the first 8 chars of a uuid", () => {
    expect(shortenKeyId("01234567-89ab-cdef-0123-456789abcdef")).toBe(
      "01234567"
    );
  });

  it("returns null for null input", () => {
    expect(shortenKeyId(null)).toBe(null);
  });

  it("returns null for undefined input", () => {
    expect(shortenKeyId(undefined)).toBe(null);
  });

  it("returns null for empty string", () => {
    expect(shortenKeyId("")).toBe(null);
  });
});
