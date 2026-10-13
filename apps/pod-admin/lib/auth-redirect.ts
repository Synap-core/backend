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
  error: { data?: { code?: string | null } | null } | null | undefined
): boolean {
  if (error?.data?.code !== "UNAUTHORIZED") return false;
  if (typeof window === "undefined") return false;
  window.location.assign(`/login?return=${encodeURIComponent(currentPath())}`);
  return true;
}

/**
 * Where to come back to — the LIVE url, including its query string.
 *
 * The query is the address on the deep links this app emits: ⌘K and Home's
 * "Needs you" rows produce e.g. `/review?type=access&focus=<id>` or
 * `/security?section=issuers&focus=<id>`. Returning to a bare pathname would
 * drop the target after an expired session bounced through login.
 *
 * `/login`'s `safeReturnTo` keeps the query string (it only refuses what
 * would leave the origin, and `/login` itself), so the receiver needed
 * nothing.
 */
function currentPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}
