/**
 * Who may open a pod-admin path — the pure half of `proxy.ts`.
 *
 * Three tiers, decided by pathname alone:
 *
 *   • public     — the proxy never runs (`MATCHER_EXCLUDED_PREFIXES`): sign-in,
 *                  recovery, setup, invites, `/api/*`, static assets.
 *   • signed-in  — any Kratos session: the self-service receivers
 *                  (`isSelfService`) and the member console (`/home`,
 *                  `/review`, D8).
 *   • admin      — everything else needs the `pod_admin` role.
 *
 * Kept separate from `proxy.ts` (which needs `next/server` and live Kratos) so
 * the tiers are unit-tested, and so the console-nav tripwire can prove no
 * admin page sits under a prefix that would silently strip its gate.
 */

/**
 * Path prefixes the proxy matcher skips, WITHOUT a trailing slash: the matcher
 * is a negative lookahead on the first characters after `/`, so `login` also
 * skips `/login-history` and `api` skips `/api-keys`. That is why an admin page
 * must never start with one of these — it would render with no auth at all.
 *
 * `proxy.ts` must keep its `config.matcher` literal (Next reads it statically);
 * `route-policy.test.ts` proves the literal and this list agree.
 */
export const MATCHER_EXCLUDED_PREFIXES = [
  "api",
  "_next/static",
  "_next/image",
  "favicon.ico",
  "robots.txt",
  "login",
  "recovery",
  "forbidden",
  "setup",
  "invite",
] as const;

/** True when the proxy never sees this path (no session check, no role check). */
export function isMatcherExcluded(pathname: string): boolean {
  const rest = pathname.replace(/^\//, "");
  return MATCHER_EXCLUDED_PREFIXES.some((p) => rest.startsWith(p));
}

/**
 * Self-service surfaces for any signed-in pod user. The backend endpoints they
 * call re-verify the Kratos session (and scope to the caller) server-side — the
 * proxy only needs a valid session here, not the pod_admin role. Each line's
 * reason is the access it would otherwise wrongly deny.
 */
export function isSelfService(path: string): boolean {
  return (
    // CLI/Raycast/Claude Desktop key minting, and viewing/revoking your own
    // keys.
    path === "/connect" ||
    path === "/my-connections" ||
    // An app's detail page (`/apps/<public_id>`) is the same self-service
    // object as the row it opens from `/my-connections`: `apps.get` /
    // `apps.revoke` / `apps.remove` are already scoped to `ctx.userId`
    // server-side, so this grants no reach — it only stops a non-admin from
    // being 403'd on a page that shows their OWN app.
    path.startsWith("/apps/") ||
    // Your OWN vault, exactly like your own keys above. `secretsVault.list` /
    // `.delete` are scoped to `ctx.userId` server-side, so this grants no
    // reach — it only stops `pod_admin` being required to manage secrets that
    // are already yours.
    path === "/my-vault" ||
    // Your OWN computers and the page of each (D9). `machines.list` is floored
    // to the computers you approved, and `rename` / `setKeyTtl` / `revoke`
    // re-load the computer and refuse anyone but its owner or a pod admin
    // (`loadManageableMachine`), so this grants no reach.
    path === "/my-computers" ||
    path.startsWith("/my-computers/") ||
    // Your OWN sign-in methods and recovery codes. Every call behind it is
    // scoped to the caller's account; the one owner-only control (Synap Cloud
    // trust) is re-checked by the pod (`PUT /api/account-recovery/cloud-trust`).
    path === "/settings/security" ||
    // Authorizing an OAuth client against your own data. Requiring pod_admin
    // would lock every non-admin member out of connecting claude.ai to their
    // own pod.
    path === "/oauth/consent" ||
    path.startsWith("/approve-agent") ||
    // Approving YOUR computer (`synap init`, the device door). The pod's
    // `apiKeys.getDeviceRequest` / `.decideDeviceRequest` re-check the
    // signed-in session and make the computer the approver's own; requiring
    // pod_admin would stop every non-admin member from connecting their own
    // machine.
    path === "/device" ||
    path.startsWith("/connection-requests/") ||
    // A proposal reviewer is usually a workspace editor, not a pod admin;
    // `proposals.get`/`.approve` re-check editor role server-side, so we only
    // need a valid Kratos session here — requiring pod_admin would 403 every
    // non-admin reviewer landing from an AI-sent /open/<id> link.
    path.startsWith("/proposal/") ||
    // Signed-in `/open` is the compact web host for one entity or view.
    // `entities.get` / `views.get` re-check access server-side; requiring
    // pod_admin would 403 every non-admin operator landing from a share link.
    path.startsWith("/open/")
  );
}

/**
 * The console pages a non-admin member may open (D8): Home and Review, plus
 * `/`, which only redirects to Home. Their data is user-floored server-side
 * (`diagnose.global`, `signals`), so opening them grants no reach — the role
 * only decides which nav the viewer is shown.
 *
 * Exact paths, not prefixes: a page added later under `/home/…` or
 * `/review/…` is an admin page until someone decides otherwise here.
 */
const MEMBER_CONSOLE_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/home",
  "/review",
]);

export function isMemberConsolePath(path: string): boolean {
  return MEMBER_CONSOLE_PATHS.has(path);
}

export type RouteAccess = "public" | "signed-in" | "admin";

export function routeAccess(path: string): RouteAccess {
  if (isMatcherExcluded(path)) return "public";
  if (isSelfService(path) || isMemberConsolePath(path)) return "signed-in";
  return "admin";
}

/**
 * Prefixes no ADMIN page may live under (brief / decisions §0): the matcher
 * exclusions above, and every self-service family — an admin page at
 * `/open/x` or `/my-things` would inherit the signed-in-only tier and lose its
 * `pod_admin` gate without any error. `*` = raw prefix, trailing `/` = that
 * directory, bare = the exact path or below it.
 */
const BANNED_ADMIN_PREFIXES = [
  ...MATCHER_EXCLUDED_PREFIXES.map((p) => `${p}*`),
  "apps/",
  "approve-agent*",
  "open/",
  "proposal/",
  "connect",
  "connection-requests/",
  "device",
  "my-*",
  "settings/security",
  "oauth/consent",
] as const;

export function isBannedAdminPath(path: string): boolean {
  const rest = path.replace(/^\//, "");
  return BANNED_ADMIN_PREFIXES.some((p) => {
    if (p.endsWith("*")) return rest.startsWith(p.slice(0, -1));
    if (p.endsWith("/")) return rest.startsWith(p);
    return rest === p || rest.startsWith(`${p}/`);
  });
}

/**
 * The request header the proxy stamps with the viewer's role for the console
 * layout. It shapes the NAV only — every read behind it is re-checked
 * server-side — and the proxy always overwrites whatever the client sent.
 */
export const CONSOLE_ROLE_HEADER = "x-pod-console-role";

export type ConsoleRole = "admin" | "member";

export function parseConsoleRole(
  value: string | null | undefined
): ConsoleRole {
  // Fail toward the smaller nav: a missing header must never show admin pages.
  return value === "admin" ? "admin" : "member";
}
