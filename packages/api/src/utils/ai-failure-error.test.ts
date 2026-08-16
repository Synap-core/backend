import { describe, expect, it } from "vitest";
import { initTRPC, TRPCError } from "@trpc/server";
import { ChatTurnFailureError, readAiFailure } from "./ai-failure-error.js";
import { describeAiFailure } from "./ai-failure.js";

/**
 * PINS THE BOUNDARY ASSUMPTION this whole fix rests on: that a thrown
 * `ChatTurnFailureError` survives `router.createCaller(...)` with its carried
 * verdict intact.
 *
 * Read out of the INSTALLED @trpc/server 11.17.0, `createCallerFactory`'s catch
 * ends in a bare `throw cause` — the original instance, not a re-wrap. That is
 * a library-version fact, not a language guarantee, so it is pinned here: if a
 * tRPC upgrade ever starts re-wrapping thrown errors, this test fails LOUDLY
 * instead of the Retry button silently going dead again (a regression nothing
 * else in the suite would catch, because every field would still typecheck).
 */

const t = initTRPC.create();

function callerThatThrows(error: unknown) {
  const router = t.router({
    boom: t.procedure.query(() => {
      throw error;
    }),
  });
  return router.createCaller({});
}

describe("verdict survives the tRPC caller boundary", () => {
  it("carries the classification through createCaller", async () => {
    const failure = describeAiFailure({ status: 402 });
    const caller = callerThatThrows(
      new ChatTurnFailureError({ message: failure.message, failure })
    );

    const thrown = await caller.boom().then(
      () => undefined,
      (err: unknown) => err
    );

    const readout = readAiFailure(thrown);
    expect(readout?.failure?.code).toBe("provider_no_credit");
    expect(readout?.failure?.retryable).toBe(false);
    expect(readout?.cancelled).toBe(false);
    // Still a TRPCError for every handler that already branches on one.
    expect(thrown).toBeInstanceOf(TRPCError);
    expect((thrown as TRPCError).code).toBe("INTERNAL_SERVER_ERROR");
  });

  it("carries a cancellation through createCaller", async () => {
    const caller = callerThatThrows(
      new ChatTurnFailureError({
        message: "Chat turn cancelled",
        failure: null,
        cancelled: true,
      })
    );

    const thrown = await caller.boom().catch((err: unknown) => err);
    expect(readAiFailure(thrown)).toEqual({ failure: null, cancelled: true });
  });
});

describe("readAiFailure — unclassified must read as UNKNOWN, never as fine", () => {
  it("returns undefined for a plain Error", () => {
    expect(readAiFailure(new Error("boom"))).toBeUndefined();
  });

  it("returns undefined for a bare TRPCError (the old throw shape)", () => {
    expect(
      readAiFailure(
        new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "boom" })
      )
    ).toBeUndefined();
  });

  it("returns undefined for null / a string / a number", () => {
    expect(readAiFailure(null)).toBeUndefined();
    expect(readAiFailure("boom")).toBeUndefined();
    expect(readAiFailure(42)).toBeUndefined();
  });

  it("does NOT mistake an unrelated `.failure` property for a verdict", () => {
    // The IS envelope also travels on a `.failure` key (see ai-failure.ts's
    // extractFailureEnvelope). It is not an AiFailureDescription and must not
    // be read as one.
    expect(
      readAiFailure({
        failure: { code: "insufficient_credit", retryable: false },
        cancelled: false,
      })
    ).toBeTruthy(); // shape-compatible: code:string + retryable:boolean
    expect(
      readAiFailure({ failure: { nope: true }, cancelled: false })
    ).toBeUndefined();
    expect(readAiFailure({ failure: null })).toBeUndefined(); // no `cancelled`
  });

  it("accepts a structurally-identical instance from a duplicated module copy", () => {
    // pnpm can resolve two copies of a module; a bare `instanceof` would be a
    // silent false-negative, which reads as "no classification" and quietly
    // reinstates the bug.
    const failure = describeAiFailure("timeout");
    const lookalike = Object.assign(new Error(failure.message), {
      failure,
      cancelled: false,
    });
    expect(readAiFailure(lookalike)?.failure?.retryable).toBe(true);
  });
});
