import { NextResponse, type NextRequest } from "next/server";

/**
 * Proactive auth gate.
 *
 * Pod Admin is fully client-rendered and fetches via tRPC with the
 * `ory_kratos_session` cookie (set `Domain=<root>` so it crosses subdomains).
 * Without a session cookie the operator is logged out — send them to /login
 * BEFORE any page tries (and fails) to fetch, then bring them back via
 * `?return=`. This is a presence check only; a present-but-expired cookie is
 * caught reactively by the pages' UNAUTHORIZED handling (see auth-redirect.ts).
 *
 * Public paths are exempt. `/connection-requests/new` MUST stay public: it
 * extracts the one-time redeem secret from the URL fragment and stores it
 * before it self-redirects to login — gating it here would drop the secret.
 */

const PUBLIC_PREFIXES = [
  "/login",
  "/setup",
  "/forbidden",
  "/connection-requests/new",
  "/connection-requests/error",
  "/api",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname, search } = req.nextUrl;
  if (isPublic(pathname) || req.cookies.has("ory_kratos_session")) {
    return NextResponse.next();
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?return=${encodeURIComponent(`${pathname}${search}`)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next internals and static files (anything with a dot).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
