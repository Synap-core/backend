import { browserSessionState } from "./kratos-flow";

/**
 * Reactive auth fallback.
 *
 * The middleware gates on cookie PRESENCE. A present-but-expired session still
 * passes it, then the tRPC call returns UNAUTHORIZED. Rather than showing a dead
 * "couldn't load" error, send the operator to /login and bring them back — the
 * same pattern the connection-request redeem flow already uses.
 *
 * UNAUTHORIZED alone is not proof the session is gone: the pod also answers it
 * for a missing Hub key or provisioning token, and maps any upstream 401 it
 * relays the same way. So the browser asks Kratos first and leaves ONLY when
 * Kratos says there is no session. A live session (or a Kratos that did not
 * answer) keeps the reader on the page, whose own error state then shows —
 * sending a signed-in person to /login is how /login came to greet them with
 * "Failed to create login flow (400)".
 *
 * Returns true when the error is UNAUTHORIZED (a redirect may follow), so
 * callers can render a spinner instead of an error while the check runs.
 */
export function redirectToLoginIfUnauthorized(
  error: { data?: { code?: string | null } | null } | null | undefined
): boolean {
  if (error?.data?.code !== "UNAUTHORIZED") return false;
  if (typeof window === "undefined") return false;
  // Read the address NOW: the check is async and the page may move meanwhile.
  const returnTo = currentPath();
  // One check (and at most one navigation) for a burst of failing queries.
  pendingCheck ??= browserSessionState()
    .then((state) => {
      if (state === "none") {
        window.location.assign(`/login?return=${encodeURIComponent(returnTo)}`);
      }
    })
    .finally(() => {
      pendingCheck = null;
    });
  return true;
}

let pendingCheck: Promise<void> | null = null;

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
