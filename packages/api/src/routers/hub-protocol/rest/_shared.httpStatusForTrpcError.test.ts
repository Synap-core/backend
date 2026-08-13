/**
 * Unit test for `httpStatusForTrpcError` — the one door that maps a caught
 * tRPC-door error to a real HTTP status.
 *
 * The critical property under test is NOT "does it map NOT_FOUND to 404" in
 * the trivial case (a real `instanceof`-passing check would do that too) —
 * it's that the mapping survives a THROWN OBJECT THAT IS NOT `instanceof
 * TRPCError`. That is exactly the shape of the production bug this helper
 * fixes: the tsup bundle carries its own `@trpc/server` copy, so a genuinely
 * thrown `TRPCError` at runtime fails `instanceof TRPCError` checked against
 * the route file's own import. A test built on real `TRPCError` instances
 * (same module graph, unbundled) would pass for BOTH the broken `instanceof`
 * check and this fix — it would not have caught the incident. Every case
 * below uses a plain object, never `new TRPCError(...)`, to keep the test
 * honest about what actually failed live.
 */
import { describe, it, expect } from "vitest";
import { httpStatusForTrpcError } from "./_shared.js";

// A cross-bundle TRPCError look-alike: has `.code`, is NOT `instanceof` the
// TRPCError class this test file would import — same as production.
function fakeTrpcError(code: string, cause?: unknown) {
  return { name: "TRPCError", code, message: "boom", cause };
}

describe("httpStatusForTrpcError", () => {
  it("maps BAD_REQUEST → 400", () => {
    expect(httpStatusForTrpcError(fakeTrpcError("BAD_REQUEST"))).toBe(400);
  });

  it("maps UNAUTHORIZED → 403 (merged with FORBIDDEN, matching the proven-live entities.ts behavior — 401 is a deliberate non-goal, see doc comment)", () => {
    expect(httpStatusForTrpcError(fakeTrpcError("UNAUTHORIZED"))).toBe(403);
  });

  it("maps FORBIDDEN → 403", () => {
    expect(httpStatusForTrpcError(fakeTrpcError("FORBIDDEN"))).toBe(403);
  });

  it("maps NOT_FOUND → 404 — the exact code the getThreadContext incident dropped", () => {
    expect(httpStatusForTrpcError(fakeTrpcError("NOT_FOUND"))).toBe(404);
  });

  it("maps every other code (including INTERNAL_SERVER_ERROR) → 500", () => {
    expect(httpStatusForTrpcError(fakeTrpcError("INTERNAL_SERVER_ERROR"))).toBe(
      500
    );
    expect(httpStatusForTrpcError(fakeTrpcError("CONFLICT"))).toBe(500);
  });

  it("never uses `instanceof TRPCError` — a plain non-Error object with `.code` still resolves", () => {
    // No `Error` prototype at all — proves the check is a duck-typed `.code`
    // read, not a class-identity check that a bundled TRPCError would fail.
    const notAnError = { code: "NOT_FOUND" };
    expect(httpStatusForTrpcError(notAnError)).toBe(404);
  });

  it("walks the `.cause` chain — createCaller wraps a domain error as INTERNAL_SERVER_ERROR + cause", () => {
    const wrapped = fakeTrpcError(
      "INTERNAL_SERVER_ERROR",
      fakeTrpcError("NOT_FOUND")
    );
    expect(httpStatusForTrpcError(wrapped)).toBe(404);
  });

  it("stops walking beyond the depth limit (does not loop forever on a cyclic cause)", () => {
    const cyclic: Record<string, unknown> = { code: "INTERNAL_SERVER_ERROR" };
    cyclic.cause = cyclic;
    expect(httpStatusForTrpcError(cyclic)).toBe(500);
  });

  it("handles null / undefined / primitive errors without throwing", () => {
    expect(httpStatusForTrpcError(null)).toBe(500);
    expect(httpStatusForTrpcError(undefined)).toBe(500);
    expect(httpStatusForTrpcError("plain string error")).toBe(500);
    expect(httpStatusForTrpcError(new Error("no code"))).toBe(500);
  });
});
