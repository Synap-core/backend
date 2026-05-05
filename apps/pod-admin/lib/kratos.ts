/**
 * Kratos middleware helpers — used by `middleware.ts` to gate every
 * route below `(admin)/`.
 *
 * The pod's Kratos public endpoints live under `${POD_URL}/.ory/kratos/public/`.
 * For session checks we forward the inbound request's cookies verbatim and
 * read the JSON body. Two cases:
 *
 *   • 401 / 403 → no session. Redirect to the pod's login page.
 *   • 200       → session OK. Return identity for downstream role checks.
 *
 * Role check (pod_admin): once the session is confirmed, we ask the pod
 * tRPC endpoint for the current user's pod-admin status. A dedicated
 * pod-admin "ping" route doesn't exist yet, so we call `system.getDataPodStats`
 * — `protectedProcedure` will 200 for any signed-in user, but if the user
 * isn't a pod admin we fall back to a follow-up `sync.getStatus` call which
 * uses `podAdminProcedure` and returns 403 for non-admins. Two requests is
 * fine; this only fires on tab navigation, not on every request inside a
 * tab (the middleware matcher excludes `_next/*` and assets).
 */

const ENV_POD_URL =
  process.env.POD_URL ??
  process.env.NEXT_PUBLIC_POD_URL ??
  "http://localhost:4000";

export interface KratosIdentity {
  id: string;
  email: string;
  name: string | null;
}

export interface KratosWhoamiResponse {
  id: string;
  active: boolean;
  identity: {
    id: string;
    traits?: { email?: string; name?: string };
  };
}

/**
 * Check the inbound cookie against `${POD_URL}/.ory/kratos/public/sessions/whoami`.
 * Returns the identity on success, or null if no session.
 */
export async function whoamiFromCookie(
  cookieHeader: string
): Promise<KratosIdentity | null> {
  const url = `${ENV_POD_URL.replace(/\/$/, "")}/.ory/kratos/public/sessions/whoami`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: cookieHeader,
      },
      // Defensive: middleware runs in the Edge runtime, but we use the
      // Node.js runtime in middleware.ts to keep this fetch path stable
      // even when Kratos is reached over private DNS.
      cache: "no-store",
    });
  } catch {
    // Network failure — treat as unauthenticated. Caller redirects to login.
    return null;
  }

  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) return null;

  let body: KratosWhoamiResponse;
  try {
    body = (await res.json()) as KratosWhoamiResponse;
  } catch {
    return null;
  }

  if (!body.active) return null;
  return {
    id: body.identity.id,
    email: body.identity.traits?.email ?? "",
    name: body.identity.traits?.name ?? null,
  };
}

/**
 * Check whether the inbound session belongs to a pod admin.
 *
 * The cleanest available signal today is `trpc.sync.getStatus` (uses
 * `podAdminProcedure`) — it 200s for admins and 403s for everyone else.
 * No state-changing side effects on a GET. The tRPC URL on a pod is
 * `${podUrl}/trpc/<router>.<procedure>`; we hit the batched path so the
 * shape matches the client.
 */
export async function isPodAdmin(cookieHeader: string): Promise<boolean> {
  // Use the non-batched single-call form for simplicity. The tRPC HTTP
  // contract supports both — see https://trpc.io/docs/client/links/httpLink.
  const url = `${ENV_POD_URL.replace(/\/$/, "")}/trpc/sync.getStatus`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: cookieHeader,
      },
      cache: "no-store",
    });
  } catch {
    return false;
  }

  // 200 = pod admin. 403 = signed in but not pod admin. Anything else =
  // treat as not admin (operator can ask their pod admin for access).
  return res.status === 200;
}

export const POD_URL = ENV_POD_URL;
