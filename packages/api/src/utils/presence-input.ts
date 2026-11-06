/**
 * The `presence` field of a SENSITIVE ACTION's input (W3 slice 3): chained as
 * `.input(presenceInput)` before the procedure's own input, so typed clients
 * can send a proof. The proof itself is read from the RAW input by
 * `requireFreshAuthentication` (trpc.ts); this parser outputs `{}`, so the
 * proof never reaches the handler's `input` (a handler that spreads its input
 * into a stored row must not store it).
 */
import { z } from "zod";
import { presenceProofSchema } from "@synap-core/types/presence";
import type { Context } from "../types/context.js";

export const presenceInput = z
  .object({ presence: presenceProofSchema.optional() })
  .transform(() => ({}));

/**
 * Was this call made by a proposal EXECUTOR whose approval already checked
 * the proof (`applyProposalApproval`)? The executor sets
 * `presenceChecked: "applyProposalApproval"` on the context of its server-side
 * caller (`createCaller`). A client never sets a context field: the context
 * is built by the pod from the request (`createContext`). The tripwire
 * `presence-gate-every-door` pins which files hold the flag.
 */
export function proofCheckedByApproval(
  ctx: Pick<Context, "presenceChecked">
): boolean {
  return ctx.presenceChecked === "applyProposalApproval";
}
