/**
 * Pod Admin auth gate.
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
 *      non-admins). Not admin → 307 to `/forbidden`.
 *
 * Public exemptions: `/login`, `/forbidden`, `/api/*`, `/_next/*`,
 * static files.
 *
 * Runtime: explicitly Node.js so we can do server-to-server fetches
 * against the pod's private Kratos host without Edge runtime quirks.
 */

import { NextResponse, type NextRequest } from "next/server";
import { whoamiFromCookie, isPodAdmin } from "./lib/kratos";

export const config = {
  // Match every page request EXCEPT the public exemptions.
  matcher: [
    /*
     * Match all request paths except for:
     * - api routes (we exempt /api/* — the only API route is /api/health)
     * - _next/static / _next/image
     * - favicon, robots, etc.
     * - the /login and /forbidden pages themselves (otherwise the
     *   redirect target would loop through the auth check)
     */
    "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|login|forbidden|setup|invite).*)",
  ],
};

export async function proxy(req: NextRequest) {
  const cookie = req.headers.get("cookie") ?? "";
  const currentUrl = req.nextUrl.pathname + req.nextUrl.search;
  const path = req.nextUrl.pathname;

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
  const identity = await whoamiFromCookie(cookie);
  if (!identity) {
    const loginUrl = new URL(
      `/login?return=${encodeURIComponent(currentUrl)}`,
      req.url
    );
    return NextResponse.redirect(loginUrl);
  }

  // ── 2. pod_admin role ─────────────────────────────────────────────
  // /connect, /my-connections, and /approve-agent/* are self-service
  // surfaces for any signed-in pod user (CLI/Raycast/Claude Desktop key
  // minting, viewing/revoking your own keys, and the matching agent-key
  // approval). The backend endpoints they call already re-verify the
  // Kratos session server-side — we just need a valid session here, not
  // the pod_admin role.
  const isSelfService =
    path === "/connect" ||
    path === "/my-connections" ||
    path.startsWith("/approve-agent") ||
    path.startsWith("/connection-requests/");
  if (!isSelfService) {
    const admin = await isPodAdmin(cookie);
    if (!admin) {
      return NextResponse.redirect(new URL("/forbidden", req.url));
    }
  }

  // Pass identity to downstream pages via request headers — useful for
  // server components that want to render the operator's name without
  // re-doing the whoami call.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-pod-admin-id", identity.id);
  requestHeaders.set("x-pod-admin-email", identity.email);
  if (identity.name) requestHeaders.set("x-pod-admin-name", identity.name);

  return NextResponse.next({ request: { headers: requestHeaders } });
}
