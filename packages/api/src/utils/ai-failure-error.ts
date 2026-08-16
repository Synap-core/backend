/**
 * The carrier that gets an `AiFailureDescription` ACROSS the tRPC boundary.
 *
 * THE DEFECT THIS FIXES. `channels.sendMessage` classifies its terminal failure
 * properly — `describeAiFailure` computes `code` / `retryable` / `needsOperator`
 * from real evidence, and every one of those is persisted and broadcast. Then
 * the procedure threw a bare `new TRPCError({ code, message })`, and `TRPCError`
 * carries only `code` + `message`. Everything computed was dropped AT THE
 * REPORTING BOUNDARY, three call-frames after being derived correctly.
 *
 * Downstream, `chat-turn-sse.ts` had nothing left to read, so its error frame
 * hardcoded `recoverable: false` — and the client gate is
 * `showRetry = error.recoverable !== false && Boolean(onRetry)`
 * (`chat-ui/StreamError.tsx`). One hardcoded constant standing in for a value
 * that already existed made the Retry button structurally unreachable in the
 * first-party app, with every other wire connected.
 *
 * WHY A SUBCLASS AND NOT `cause`. Verified against the INSTALLED
 * @trpc/server 11.17.0: `createCallerFactory` ends its catch with a bare
 * `throw cause` — it rethrows the ORIGINAL instance, so any field on it
 * survives the boundary intact. The `cause` option does not survive as cleanly:
 * `getCauseFromUnknown` re-wraps a plain object in an `UnknownCauseError`, so a
 * structured verdict passed that way arrives mangled. A subclass keeps the
 * value typed, keeps `instanceof TRPCError` true for every existing handler,
 * and adds no new failure mode.
 *
 * FAIL-SAFE BY CONSTRUCTION. Only this class carries a verdict. Anything else
 * thrown out of `sendMessage` — a Zod error, an auth throw, a bug — yields
 * `readAiFailure() === undefined`, and the caller must then stay
 * non-recoverable. A dead Retry button is a much better failure than a Retry
 * that silently re-bills an out-of-credit provider (`provider_no_credit`,
 * HTTP 402) or re-hammers rejected credentials (`provider_auth`) — both of
 * which are `retryable: false, needsOperator: true`.
 */

import { TRPCError } from "@trpc/server";
import type { AiFailureDescription } from "./ai-failure.js";

/**
 * A terminal chat-turn failure that KNOWS what it was.
 *
 * `failure` is null for a user cancellation: a cancelled turn is not a fault,
 * so it has no failure class to carry, and `cancelled` says which of the two
 * it is without either state having to be inferred from the other.
 */
export class ChatTurnFailureError extends TRPCError {
  readonly failure: AiFailureDescription | null;
  readonly cancelled: boolean;

  constructor(opts: {
    message: string;
    failure: AiFailureDescription | null;
    cancelled?: boolean;
  }) {
    super({ code: "INTERNAL_SERVER_ERROR", message: opts.message });
    this.name = "TRPCError"; // keep tRPC's own name-based checks working
    this.failure = opts.failure;
    this.cancelled = opts.cancelled ?? false;
  }
}

/** What a reporting boundary can honestly say about a thrown value. */
export interface AiFailureReadout {
  failure: AiFailureDescription | null;
  cancelled: boolean;
}

/**
 * Read a carried verdict off a thrown value, or `undefined` when there is none.
 *
 * `undefined` means UNCLASSIFIED — never "fine", and never "retryable". Callers
 * must treat it as non-recoverable (see the fail-safe note above).
 *
 * Uses a duck-type check rather than `instanceof` alone: this package is built
 * to ESM + CJS and pnpm can resolve two copies of a module, which makes a bare
 * `instanceof` a silent false-negative — and a false negative here reads as
 * "no classification", i.e. it would quietly reinstate the very bug this
 * module removes.
 */
export function readAiFailure(error: unknown): AiFailureReadout | undefined {
  if (error instanceof ChatTurnFailureError) {
    return { failure: error.failure, cancelled: error.cancelled };
  }
  if (typeof error !== "object" || error === null) return undefined;
  const bag = error as Record<string, unknown>;
  if (!("failure" in bag) || !("cancelled" in bag)) return undefined;
  if (typeof bag.cancelled !== "boolean") return undefined;
  const failure = bag.failure;
  if (failure === null) return { failure: null, cancelled: bag.cancelled };
  // A carried description must actually BE one — a random `.failure` property
  // (the IS envelope shape, for instance) must not be read as a verdict.
  if (
    typeof failure === "object" &&
    typeof (failure as AiFailureDescription).code === "string" &&
    typeof (failure as AiFailureDescription).retryable === "boolean"
  ) {
    return {
      failure: failure as AiFailureDescription,
      cancelled: bag.cancelled,
    };
  }
  return undefined;
}
