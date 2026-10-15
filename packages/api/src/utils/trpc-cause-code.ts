/**
 * The ONE walk of an error's `.cause` chain for a tRPC REFUSAL code — read by
 * the Hub's HTTP mapping (`httpStatusForTrpcError`, rest/_shared.ts) and by a
 * service error that carries a refusal to a tRPC door
 * (`ComposeOverlayError.refusalCode`). One code set, so a door can never
 * answer 500 where the other answers 412 (review2 SL5: three walkers, two
 * hand-listed sets, PRECONDITION_FAILED in one only). Neutral (no router
 * import), so services and routers both depend down on it.
 */

/** The tRPC codes that are a refusal the caller can act on — never a server fault. */
export const REFUSAL_TRPC_CODES = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "PRECONDITION_FAILED",
] as const;

export type RefusalTrpcCode = (typeof REFUSAL_TRPC_CODES)[number];

const REFUSALS: ReadonlySet<string> = new Set(REFUSAL_TRPC_CODES);

/**
 * The first refusal code in `err`'s `.cause` chain, or null (a server fault).
 * Depth-limited (4): `createCaller` wraps a thrown domain error as
 * `TRPCError{code:'INTERNAL_SERVER_ERROR', cause: <domain error>}`, so the
 * meaningful code can sit one or two levels down.
 */
export function refusalCodeInCause(err: unknown): RefusalTrpcCode | null {
  let cursor: unknown = err;
  for (
    let depth = 0;
    cursor && typeof cursor === "object" && depth < 4;
    depth++
  ) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === "string" && REFUSALS.has(code))
      return code as RefusalTrpcCode;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return null;
}
