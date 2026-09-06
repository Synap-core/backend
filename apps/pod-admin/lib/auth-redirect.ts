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
 * This used to be a hardcoded pathname passed by each caller (`"/audit"`,
 * `"/trust-keys"`…), which threw the query away. That is the whole address on
 * the surfaces this app just built: ⌘K emits
 * `/audit?section=proposals&focus=<id>` and Overview's alerts emit
 * `/trust-keys?section=issuers&focus=<id>`. An expired session on one of those
 * bounced through login and landed on the bare tab with the target gone —
 * silently, and precisely for the deep links the wave exists to make work.
 *
 * `/login`'s `safeReturnTo` already accepts a query string (it only refuses
 * off-origin and `/login` itself), so the receiver needed nothing.
 */
function currentPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}
