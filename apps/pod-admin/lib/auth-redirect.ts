/**
 * Reactive auth fallback.
 *
 * The middleware gates on cookie PRESENCE. A present-but-expired session still
 * passes it, then the tRPC call returns UNAUTHORIZED. Rather than showing a dead
 * "couldn't load" error, send the operator to /login and bring them back — the
 * same pattern the connection-request redeem flow already uses.
 *
 * Returns true when it triggered a redirect, so callers can render a spinner
 * instead of an error while the navigation happens.
 */
export function redirectToLoginIfUnauthorized(
  error: { data?: { code?: string | null } | null } | null | undefined,
  returnPath: string
): boolean {
  if (error?.data?.code !== "UNAUTHORIZED") return false;
  if (typeof window === "undefined") return false;
  window.location.assign(`/login?return=${encodeURIComponent(returnPath)}`);
  return true;
}
