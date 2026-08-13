/**
 * Unit test for `errCode` — duck-typed `.code` reader with a cause-chain
 * walk. Added when auditing whether `errCode` vs `httpStatusForTrpcError`
 * was a real split or an artificial one (team request): they ARE genuinely
 * different questions (raw code vs. mapped HTTP status), but `errCode` was
 * under-built for its own call sites — two of its three uses
 * (proposals.ts's `updateProposal`/`revert`, both CONFLICT/NOT_IMPLEMENTED
 * checks) go through `createCaller`, which per `trpc.ts`'s
 * `errorCatchingMiddleware` CAN wrap a thrown error as
 * `{code:'INTERNAL_SERVER_ERROR', cause: <original>}`. A shallow,
 * top-level-only read would silently miss a wrapped CONFLICT/NOT_IMPLEMENTED
 * the exact same way the pre-`2a163c7e` code missed a wrapped NOT_FOUND —
 * same failure class, one level deeper in the stack.
 */
import { describe, it, expect } from "vitest";
import { errCode } from "./_shared.js";

function fakeTrpcError(code: string, cause?: unknown) {
  return { name: "TRPCError", code, message: "boom", cause };
}

describe("errCode", () => {
  it("reads the top-level code when there is no wrapping", () => {
    expect(errCode(fakeTrpcError("CONFLICT"))).toBe("CONFLICT");
  });

  it("walks past an INTERNAL_SERVER_ERROR wrapper to find the real code in .cause", () => {
    // The exact shape trpc.ts's errorCatchingMiddleware produces when it
    // wraps a non-passthrough error.
    const wrapped = fakeTrpcError(
      "INTERNAL_SERVER_ERROR",
      fakeTrpcError("CONFLICT")
    );
    expect(errCode(wrapped)).toBe("CONFLICT");
  });

  it("walks two levels deep", () => {
    const doubleWrapped = fakeTrpcError(
      "INTERNAL_SERVER_ERROR",
      fakeTrpcError("INTERNAL_SERVER_ERROR", fakeTrpcError("NOT_IMPLEMENTED"))
    );
    expect(errCode(doubleWrapped)).toBe("NOT_IMPLEMENTED");
  });

  it("stops walking beyond the depth limit (does not loop forever on a cyclic cause)", () => {
    const cyclic: Record<string, unknown> = { code: "INTERNAL_SERVER_ERROR" };
    cyclic.cause = cyclic;
    expect(errCode(cyclic)).toBeUndefined();
  });

  it("returns undefined when every level is INTERNAL_SERVER_ERROR with no real code underneath", () => {
    const allWrapper = fakeTrpcError(
      "INTERNAL_SERVER_ERROR",
      fakeTrpcError("INTERNAL_SERVER_ERROR")
    );
    expect(errCode(allWrapper)).toBeUndefined();
  });

  it("handles null / undefined / primitive errors without throwing", () => {
    expect(errCode(null)).toBeUndefined();
    expect(errCode(undefined)).toBeUndefined();
    expect(errCode("plain string error")).toBeUndefined();
    expect(errCode(new Error("no code"))).toBeUndefined();
  });

  it("never uses `instanceof TRPCError` — a plain object with `.code` still resolves", () => {
    expect(errCode({ code: "FORBIDDEN" })).toBe("FORBIDDEN");
  });
});
