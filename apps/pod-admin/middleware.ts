/**
 * Pod Admin auth gate.
 *
 * Two checks for every page request below `(admin)/`:
 *
 *   1. Kratos session — `${POD_URL}/.ory/kratos/public/sessions/whoami`.
 *      No session → redirect to `${POD_URL}/auth/login?return=<current>`.
 *
 *   2. pod_admin role — uses `trpc.sync.getStatus` as a "may I admin?"
 *      probe (it's wrapped in `podAdminProcedure`, returning 403 for
 *      non-admins). Not admin → 307 to `/forbidden`.
 *
 * Public exemptions: `/forbidden`, `/api/health`, `/_next/*`, static files.
 *
 * Runtime: explicitly Node.js so we can do server-to-server fetches
 * against the pod's private Kratos host without Edge runtime quirks.
 */

import { NextResponse, type NextRequest } from "next/server";
import { whoamiFromCookie, isPodAdmin, POD_URL } from "./lib/kratos";

export const config = {
  // Match every page request EXCEPT the public exemptions.
  matcher: [
    /*
     * Match all request paths except for:
     * - api routes (we exempt /api/* — the only API route is /api/health)
     * - _next/static / _next/image
     * - favicon, robots, etc.
     * - the /forbidden page itself
     */
    "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|forbidden).*)",
  ],
};

export async function middleware(req: NextRequest) {
  const cookie = req.headers.get("cookie") ?? "";
  const currentUrl = req.nextUrl.pathname + req.nextUrl.search;

  // ── 1. Kratos session ─────────────────────────────────────────────
  const identity = await whoamiFromCookie(cookie);
  if (!identity) {
    const loginUrl = new URL(
      `/auth/login?return=${encodeURIComponent(currentUrl)}`,
      POD_URL
    );
    return NextResponse.redirect(loginUrl);
  }

  // ── 2. pod_admin role ─────────────────────────────────────────────
  const admin = await isPodAdmin(cookie);
  if (!admin) {
    return NextResponse.redirect(new URL("/forbidden", req.url));
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
