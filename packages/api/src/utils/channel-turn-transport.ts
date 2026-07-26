/**
 * Streaming adds cancellation to the canonical Intelligence Service request.
 * The fallback uses the unchanged base object, so lens, skill, model, and
 * context semantics cannot drift between transports.
 */
export function withTurnStreamSignal<T extends Record<string, unknown>>(
  request: T,
  signal: AbortSignal
): T & { signal: AbortSignal } {
  return { ...request, signal };
}
