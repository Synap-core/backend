/**
 * Kratos session helpers — server-side only. Used by `middleware.ts` and
 * the `/login` server component to gate every page.
 *
 * Both helpers fetch over the Next.js process's network namespace, not the
 * browser's, so we use the in-cluster URL (`http://backend:4000` in compose)
 * to avoid TLS / proxy overhead. The browser-public URL is read directly by
 * components that talk to Kratos client-side (forbidden, top-nav sign-out,
 * the login form).
 */

// Server-side URL: this Next.js process to the backend. Reads POD_URL first
// (set to `http://backend:4000` in compose), falls back to the public URL
// when running locally outside docker.
const INTERNAL_POD_URL =
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
  const url = `${INTERNAL_POD_URL.replace(/\/$/, "")}/.ory/kratos/public/sessions/whoami`;

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
  const url = `${INTERNAL_POD_URL.replace(/\/$/, "")}/trpc/sync.getStatus`;

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
