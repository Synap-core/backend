/**
 * The pod edge's credentialed CORS + default HTTP cache headers, EXTRACTED
 * VERBATIM from `index.ts` (Sites W3) so the transport guards can drive the
 * REAL middleware chain (`index.ts` boots a server on import and cannot be
 * imported by a test). Mount order in `index.ts` is unchanged:
 *
 *   publicDoorTransport → podEdgeCorsMiddleware → requestSizeLimit →
 *   rateLimitMiddleware → secureHeaders → sanitizeErrorEgress →
 *   httpCacheHeadersMiddleware → logger → routes
 *
 * The only behavioural change is the first line of `podEdgeCorsMiddleware`:
 * a credentialless public-door path is skipped (see `public-door-transport.ts`).
 *
 * CORS middleware — first-party allowlist plus owner-approved applications.
 *
 * Reflecting every origin together with Allow-Credentials is the textbook
 * CSWSH/credentialed-CORS vulnerability (an attacker page can read any
 * cookie-authed response cross-origin). Instead we echo the Origin back ONLY
 * when it is a trusted first party. An exact browser origin explicitly
 * approved by this Pod's owner gets a separate, credentialless CORS allowance.
 * It is transport permission only: every Pod API still requires explicit local
 * authentication and membership. Federation bootstrap endpoints are stricter:
 * the exact application id in their URL must own the calling origin and is
 * matched against the signed issuer assertion by the federation router.
 *
 * Must run first (after the public-door transport) so error responses (429,
 * 413) still carry CORS headers. Electron desktop (no Origin header) passes
 * through untouched.
 */
import type { MiddlewareHandler } from "hono";
import { isPublicDoorPath } from "@synap/api/public-doors";

import {
  isAllowedOrigin,
  isApprovedApplicationOrigin,
  rejectsUnapprovedExternalPodApiRequest,
} from "./cors-origin.js";
import { validateExplicitPodSessionToken } from "./explicit-pod-session.js";

export const podEdgeCorsMiddleware: MiddlewareHandler = async (c, next) => {
  // Credentialless public doors (`/api/hub/public/*`) are NEVER this
  // middleware's business: no credentialed ACAO/ACAC, no 403 for an unknown
  // origin, no X-Session-Token demand, no approved-origin DB lookup. Their
  // whole transport policy lives in `public-door-transport.ts`, mounted
  // OUTSIDE this one. The ONE predicate decides (public-doors.ts).
  if (isPublicDoorPath(c.req.path)) return next();
  const origin = c.req.header("origin");
  const firstPartyOrigin = Boolean(origin) && isAllowedOrigin(origin);
  const applicationExchangePath = c.req.path === "/api/federation/exchange";
  // Transport admission is ORIGIN-ONLY (application connection allowlist).
  // It is deliberately independent of trusted-issuer / application_id /
  // issuer_url. Crypto for exchange is checked later on the federation route.
  const approvedApplicationOrigin =
    Boolean(origin) &&
    !firstPartyOrigin &&
    (await isApprovedApplicationOrigin(origin));
  // Kratos public bootstrap (`/.ory/kratos/public/*`, legacy `/self-service/*`):
  // the pre-auth login/OIDC flow. See the `requiresExplicitPodToken` exemption
  // below for the full rationale.
  const authBootstrapPath =
    c.req.path.startsWith("/.ory/kratos/public/") ||
    c.req.path.startsWith("/self-service/");
  if (origin && (firstPartyOrigin || approvedApplicationOrigin)) {
    c.header("Access-Control-Allow-Origin", origin);
    // Credentials are granted to first-party surfaces AND to an approved app
    // origin ON THE KRATOS BOOTSTRAP PATHS ONLY. The native OIDC login flow
    // sets an `ory_kratos_continuity` cookie on the `oidc` submit that Kratos
    // requires back on its provider callback; without a credentialed fetch the
    // browser silently drops that Set-Cookie and the callback restarts a fresh
    // flow (bouncing the user to the pod login) instead of completing the
    // exchange. Approved app origins are same-site Synap surfaces, so the Lax
    // continuity cookie is legitimately theirs to carry. Data APIs stay
    // credential-less for approved apps (they use an explicit X-Session-Token).
    if (firstPartyOrigin || (approvedApplicationOrigin && authBootstrapPath)) {
      c.header("Access-Control-Allow-Credentials", "true");
    }
    c.header("Vary", "Origin");
    c.header(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, PATCH, OPTIONS"
    );
    c.header(
      "Access-Control-Allow-Headers",
      // Every header `createContext()` READS must be listed here. A header the
      // context reads but CORS omits is a landmine: the first cross-origin
      // client that attaches it fails preflight, and preflight failure takes
      // down the ENTIRE tRPC surface for that origin — not just the one feature.
      // `X-Project-Id` was read at context.ts:91 while absent here; `X-Session-Id`
      // joined it when the tRPC door started resolving focus sessions.
      "Content-Type, Authorization, Cookie, X-Workspace-Id, X-Project-Id, X-Session-Id, X-Session-Token"
    );
    c.header(
      "Access-Control-Expose-Headers",
      "Content-Length, X-Request-Id, Set-Cookie"
    );
    c.header("Access-Control-Max-Age", "86400");
  }

  const applicationConnectionPath = c.req.path.startsWith(
    "/api/federation/application-connections/"
  );
  // CORS headers govern what a browser may read, not whether it can send a
  // cached-preflight request. Enforce revocation at the server boundary too:
  // an unapproved external origin cannot call any normal Pod API, even while
  // the browser still remembers a previous preflight response. The narrow
  // opaque application-connection routes own their separate capability and
  // CORS checks below.
  if (
    rejectsUnapprovedExternalPodApiRequest({
      origin,
      firstPartyOrigin,
      approvedApplicationOrigin,
      path: c.req.path,
      method: c.req.method,
    })
  ) {
    return c.json(
      {
        error: "This browser origin is not approved for this Pod",
        code: "BROWSER_ORIGIN_NOT_APPROVED",
        remediation: "approve_browser_origin",
        origin: origin ?? null,
      },
      403
    );
  }
  // `authBootstrapPath` (computed above) is the Kratos public bootstrap
  // (`/.ory/kratos/public/*`, legacy `/self-service/*`) — PRE-authentication:
  // an approved external app initializes a login flow and redeems a
  // session-token-exchange code there BEFORE it has any Pod session token, so
  // requiring one is a chicken-and-egg that 401s the very first federated
  // sign-in step. Kratos owns its own CSRF/flow protection and no Pod data is
  // exposed. (Credentials ARE granted here — see the CORS block above — so the
  // native-OIDC `ory_kratos_continuity` cookie survives the flow.) Exempt it,
  // exactly as `/api/federation/exchange` is exempt.
  // An owner-approved external origin is allowed to use an explicit Pod token
  // for normal (non-bootstrap) APIs. It must never fall back to an ambient
  // Kratos SESSION cookie there:
  // CORS does not stop a cross-site request from being sent, only from being
  // read. Bootstrap and opaque continuation routes have their own assertion /
  // capability checks and intentionally do not carry this session token.
  const requiresExplicitPodToken =
    approvedApplicationOrigin &&
    !firstPartyOrigin &&
    !applicationExchangePath &&
    !applicationConnectionPath &&
    !authBootstrapPath &&
    c.req.method !== "OPTIONS";
  if (requiresExplicitPodToken) {
    const tokenStatus = await validateExplicitPodSessionToken(
      c.req.header("x-session-token")
    );
    if (tokenStatus !== "valid") {
      return c.json(
        {
          error:
            tokenStatus === "unavailable"
              ? "Pod authentication is temporarily unavailable"
              : "An explicit X-Session-Token is required for an external application origin",
        },
        tokenStatus === "unavailable" ? 503 : 401
      );
    }
    // Downstream auth middleware re-validates the token in strict mode. This
    // closes the race between this transport guard and an ordinary middleware
    // fallback to a SameSite=None Kratos cookie.
    c.set("requireExplicitSessionToken" as never, true);
  }

  // The application-connection completion routes use a narrower,
  // credentialless per-request CORS policy inside the federation router. They
  // cannot use this global first-party allowlist because a self-hosted Pod may
  // have just approved an exact external app origin. Let those OPTIONS calls
  // reach the route-level validator; every other preflight stays fail-closed.
  const applicationConnectionPreflight =
    c.req.method === "OPTIONS" &&
    /^\/api\/federation\/application-connections\/requests\/[^/]+\/(?:status|complete)$/.test(
      c.req.path
    );
  if (applicationConnectionPreflight) return next();

  // Preflight always gets a 204; a disallowed origin simply receives no ACAO
  // header above, so the browser blocks the actual request.
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  return next();
};

// HTTP Cache Headers — allow short browser caching for GET (query) requests,
// no caching for POST (mutation) requests. Simple single-instance optimization.
export const httpCacheHeadersMiddleware: MiddlewareHandler = async (
  c,
  next
) => {
  await next();
  if (c.req.method === "GET") {
    // Allow private (browser-only) caching for 60 seconds on read requests.
    // stale-while-revalidate lets the browser use a stale response while fetching fresh data.
    if (!c.res.headers.has("Cache-Control")) {
      c.header(
        "Cache-Control",
        "private, max-age=60, stale-while-revalidate=30"
      );
    }
  } else {
    c.header("Cache-Control", "no-store");
  }
};
