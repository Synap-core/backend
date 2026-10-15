/**
 * The Hub's HTTP mapping and a tRPC door's refusal read ONE cause walk and
 * ONE code set: every refusal code, wrapped the way `createCaller` wraps a
 * domain error, is a refusal on BOTH doors — never a 500 on one and a 4xx on
 * the other (review2 SL5: PRECONDITION_FAILED was a 412 on the Hub and a 500
 * through the tRPC compose door).
 */
import { describe, it, expect } from "vitest";
import { REFUSAL_TRPC_CODES, refusalCodeInCause } from "./trpc-cause-code.js";
import { httpStatusForTrpcError } from "../routers/hub-protocol/rest/_shared.js";
import { ComposeOverlayError } from "../services/compose-overlay.js";

const wrapped = (code: string) => ({
  code: "INTERNAL_SERVER_ERROR",
  cause: { code: "INTERNAL_SERVER_ERROR", cause: { code } },
});

describe("refusalCodeInCause — one walk for both doors", () => {
  it.each(REFUSAL_TRPC_CODES.map((c) => [c]))(
    "%s is a refusal on the Hub AND through a ComposeOverlayError",
    (code) => {
      expect(refusalCodeInCause(wrapped(code))).toBe(code);
      expect(httpStatusForTrpcError(wrapped(code))).not.toBe(500);
      const err = new ComposeOverlayError("refused", {
        cause: wrapped(code),
      });
      expect(err.refusalCode).toBe(code);
    }
  );

  it("a server fault is a fault on both doors", () => {
    const fault = wrapped("TIMEOUT");
    expect(refusalCodeInCause(fault)).toBeNull();
    expect(httpStatusForTrpcError(fault)).toBe(500);
    expect(
      new ComposeOverlayError("broke", { cause: fault }).refusalCode
    ).toBeNull();
  });

  it("a code deeper than the walk is not read (depth 4)", () => {
    const deep = {
      cause: { cause: { cause: { cause: { code: "FORBIDDEN" } } } },
    };
    expect(refusalCodeInCause(deep)).toBeNull();
  });
});
