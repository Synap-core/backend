/**
 * Pod Console auth gate.
 *
 * Next.js 16 renamed the `middleware` file convention to `proxy` — same
 * request-interception semantics, new filename + export name.
 *
 * Two checks for every page request below `(admin)/`:
 *
 *   1. Kratos session — `${POD_URL}/.ory/kratos/public/sessions/whoami`.
 *      No session → redirect to same-origin `/login?return=<current>`.
 *      Pod-admin owns its sign-in surface natively (`app/login/page.tsx`)
 *      so we never bounce through the legacy admin-ui SPA. That earlier
 *      redirect chain (`pod.X/admin/kratos?return=…`) had a known reload
 *      loop on `session_already_available`.
 *
 *   2. pod_admin role — uses `trpc.sync.getStatus` as a "may I admin?"
 *      probe (it's wrapped in `podAdminProcedure`, returning 403 for
 *      non-admins). Not admin → 307 to `/forbidden`, except on the
 *      self-service receivers and the member console (`lib/route-policy.ts`).
 *
 * When the pod cannot ANSWER either question (unreachable, 5xx, 429 from its
 * rate limiter) the request gets a 503 "try again" page — never /login and
 * never /forbidden. Those two are verdicts about the person; a busy pod is
 * not one (`lib/kratos.ts` `SessionCheck`).
 *
 * Public exemptions: `/login`, `/forbidden`, `/api/*`, `/_next/*`,
 * static files.
 *
 * Runtime: explicitly Node.js so we can do server-to-server fetches
 * against the pod's private Kratos host without Edge runtime quirks.
 */

import { NextResponse, type NextRequest } from "next/server";
import { checkSession, podAdminRole } from "./lib/kratos";
import {
  CONSOLE_ROLE_HEADER,
  isMemberConsolePath,
  isSelfService,
  type ConsoleRole,
} from "./lib/route-policy";

export const config = {
  // Match every page request EXCEPT the public exemptions. Must stay a
  // literal (Next reads it statically); `lib/route-policy.test.ts` proves it
  // equals `MATCHER_EXCLUDED_PREFIXES`.
  matcher: [
    /*
     * Match all request paths except for:
     * - api routes (we exempt /api/* — the only API route is /api/health)
     * - _next/static / _next/image
     * - favicon, robots, etc.
     * - the /login and /forbidden pages themselves (otherwise the
     *   redirect target would loop through the auth check)
     * - /recovery — "Can't sign in?" is read by someone who is signed out
     */
    "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|login|recovery|forbidden|setup|invite).*)",
  ],
};

export async function proxy(req: NextRequest) {
  const currentUrl = req.nextUrl.pathname + req.nextUrl.search;
  const path = req.nextUrl.pathname;

  // Collapse /open/proposal/:id → /proposal/:id before auth so login's
  // return URL is the final review surface (no post-login extra hop).
  // Id charset matches open-params SAFE_ID_RE. Other /open/* paths unchanged.
  const openProposalMatch = path.match(
    /^\/open\/proposal\/([A-Za-z0-9_-]{1,64})$/
  );
  if (openProposalMatch) {
    const target = req.nextUrl.clone();
    target.pathname = `/proposal/${openProposalMatch[1]}`;
    return NextResponse.redirect(target, 307);
  }

  // This is a deliberately data-free bootstrap page. A browser can read and
  // scrub its fragment before native sign-in, preserving the requester-held
  // redemption proof across a Kratos redirect. It cannot inspect, redeem, or
  // review a connection request without a local Pod session.
  if (
    path === "/connection-requests/new" ||
    path === "/connection-requests/error"
  ) {
    return NextResponse.next();
  }

  // ── 1. Kratos session ─────────────────────────────────────────────
  const session = await checkSession(req.headers);
  if (session.state === "unavailable") return podUnavailable();
  if (session.state === "none") {
    const loginUrl = new URL(
      `/login?return=${encodeURIComponent(currentUrl)}`,
      req.url
    );
    return NextResponse.redirect(loginUrl);
  }
  const { identity } = session;

  // ── 2. pod_admin role ─────────────────────────────────────────────
  // Self-service receivers need only the session (each one's reason lives
  // in `lib/route-policy.ts`). The member console (`/home`, `/review`, D8)
  // opens for any member but still asks the role, because the nav it
  // renders depends on it. Everything else is pod_admin or /forbidden.
  let role: ConsoleRole | null = null;
  if (isMemberConsolePath(path) || !isSelfService(path)) {
    const answer = await podAdminRole(req.headers);
    if (answer === "unavailable") return podUnavailable();
    if (answer === "member" && !isMemberConsolePath(path)) {
      return NextResponse.redirect(new URL("/forbidden", req.url));
    }
    role = answer;
  }

  // Pass identity to downstream pages via request headers — useful for
  // server components that want to render the operator's name without
  // re-doing the whoami call.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-pod-admin-id", identity.id);
  requestHeaders.set("x-pod-admin-email", identity.email);
  // A nameless identity must not inherit a client-sent name header.
  if (identity.name) requestHeaders.set("x-pod-admin-name", identity.name);
  else requestHeaders.delete("x-pod-admin-name");
  // The role shapes the console nav only (data stays gated server-side).
  // Never forwarded from the client: deleted first, then set only where the
  // proxy asked the pod.
  requestHeaders.delete(CONSOLE_ROLE_HEADER);
  if (role) requestHeaders.set(CONSOLE_ROLE_HEADER, role);

  return NextResponse.next({ request: { headers: requestHeaders } });
}

/**
 * The pod did not answer "who is this?". Self-contained HTML (no app chrome:
 * the layout would need the very answers we lack), and a 503 so a prefetch
 * never caches it as the page.
 */
function podUnavailable(): NextResponse {
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pod Console</title><style>body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:32rem;margin:0 auto;padding:4rem 1rem;line-height:1.5;color:#18181b;background:#fafafa}@media (prefers-color-scheme:dark){body{color:#e4e4e7;background:#09090b}}a{color:inherit}</style></head><body><h1 style="font-size:1.25rem">Your pod didn’t answer just now</h1><p>The pod is busy or restarting, so the console couldn’t check your sign-in. Nothing was signed out.</p><p><a href="">Try again</a> in a few seconds.</p></body></html>`,
    {
      status: 503,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Retry-After": "10",
      },
    }
  );
}
