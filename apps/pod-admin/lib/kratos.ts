/**
 * Kratos session helpers — server-side only. Used by `proxy.ts` and
 * the `/login` server component to gate every page.
 *
 * Both helpers fetch over the Next.js process's network namespace, not the
 * browser's, so we use the in-cluster URL (`http://backend:4000` in compose)
 * to avoid TLS / proxy overhead. The browser-public URL is read directly by
 * components that talk to Kratos client-side (forbidden, top-nav sign-out,
 * the login form).
 */

import { podCallerHeaders } from "./pod-caller-headers";

// Server-side URL: this Next.js process to the backend. Reads POD_URL first
// (set to `http://backend:4000` in compose), falls back to the public URL
// when running locally outside docker.
const INTERNAL_POD_URL = process.env.POD_URL ?? "http://localhost:4000";

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
 * What the pod said about the inbound cookie. Three answers, because two
 * different things stop a whoami from returning an identity:
 *
 *   • `none`        — Kratos looked and there is no live session (401/403, or
 *                     an inactive one). Only this answer may send someone to
 *                     /login.
 *   • `unavailable` — the pod did not answer the question: unreachable, 5xx,
 *                     or 429 from the pod-edge rate limiter (budgeted per
 *                     session or client, see `pod-caller-headers.ts`). Reading
 *                     a 429 as "signed out" once bounced a signed-in operator
 *                     to /login, where the browser's own Kratos call then
 *                     refused a new login flow (`session_already_available`).
 */
export type SessionCheck =
  | { state: "active"; identity: KratosIdentity }
  | { state: "none" }
  | { state: "unavailable"; status: number | null };

/**
 * Check the inbound request's cookie against
 * `${POD_URL}/.ory/kratos/public/sessions/whoami`. Takes the inbound HEADERS,
 * not just the cookie, so the call also carries the client's address.
 */
export async function checkSession(incoming: Headers): Promise<SessionCheck> {
  const url = `${INTERNAL_POD_URL.replace(/\/$/, "")}/.ory/kratos/public/sessions/whoami`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", ...podCallerHeaders(incoming) },
      cache: "no-store",
    });
  } catch {
    return { state: "unavailable", status: null };
  }

  if (res.status === 401 || res.status === 403) return { state: "none" };
  if (!res.ok) return { state: "unavailable", status: res.status };

  let body: KratosWhoamiResponse;
  try {
    body = (await res.json()) as KratosWhoamiResponse;
  } catch {
    return { state: "unavailable", status: res.status };
  }

  if (!body.active) return { state: "none" };
  return {
    state: "active",
    identity: {
      id: body.identity.id,
      email: body.identity.traits?.email ?? "",
      name: body.identity.traits?.name ?? null,
    },
  };
}

/**
 * The identity behind the cookie, or null when there is none OR the pod could
 * not say. For API routes that only ask "may this caller proceed"; anything
 * that would SEND someone to sign in uses `checkSession` and tells the two
 * apart.
 */
export async function whoamiFromCookie(
  incoming: Headers
): Promise<KratosIdentity | null> {
  const check = await checkSession(incoming);
  return check.state === "active" ? check.identity : null;
}

/**
 * The answer an API route gives a caller it cannot serve, or null to proceed:
 * 401 for no session, 503 when the pod could not say — so the page can tell
 * "sign in again" from "try again" and never confuse the two.
 */
export async function apiSessionDenial(req: Request): Promise<Response | null> {
  const check = await checkSession(req.headers);
  if (check.state === "active") return null;
  return check.state === "none"
    ? Response.json({ error: "Not signed in" }, { status: 401 })
    : Response.json(
        { error: "The pod is busy. Try again in a few seconds." },
        { status: 503 }
      );
}

/**
 * Whether the inbound session belongs to a pod admin.
 *
 * The cleanest available signal today is `trpc.sync.getStatus` (uses
 * `podAdminProcedure`) — it 200s for admins and 403s for everyone else.
 * No state-changing side effects on a GET. Any other answer (429, 5xx,
 * unreachable) is `unavailable`, not "member": a rate-limited probe must not
 * send an admin to /forbidden or shrink their nav.
 */
export async function podAdminRole(
  incoming: Headers
): Promise<"admin" | "member" | "unavailable"> {
  // Use the non-batched single-call form for simplicity. The tRPC HTTP
  // contract supports both — see https://trpc.io/docs/client/links/httpLink.
  const url = `${INTERNAL_POD_URL.replace(/\/$/, "")}/trpc/sync.getStatus`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", ...podCallerHeaders(incoming) },
      cache: "no-store",
    });
  } catch {
    return "unavailable";
  }

  if (res.status === 200) return "admin";
  if (res.status === 403) return "member";
  return "unavailable";
}
