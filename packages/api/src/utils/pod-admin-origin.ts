import { configuredPodAdminBase } from "./pod-admin-url.js";

/**
 * The pod-admin app's origin for this pod's origin — where the key-approval
 * pages live (`/approve-agent/:keyId`, `/approve-agents?keys=`). ONE rule: the
 * setup door's review URL and `agentUsers.list`'s `approveUrl` both build on it.
 *
 * The configured console (`POD_ADMIN_URL`) when it is valid — the deploy
 * configuration is authoritative. Otherwise the installer's naming
 * (`pod_admin_domain_for_domain` in `synap`): `pod.<root>` → `pod-admin.<root>`,
 * a legacy `<sub>.<root>` → `<sub>-admin.<root>`, localhost → the local
 * pod-admin dev server.
 */
export function toPodAdminOrigin(origin: string): string {
  const configured = configuredPodAdminBase();
  if (configured.ok) return configured.base.origin;
  try {
    const u = new URL(origin);
    const host = u.hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      return "http://localhost:4040";
    }
    if (host.startsWith("pod.")) {
      return `${u.protocol}//pod-admin.${host.slice("pod.".length)}`;
    }
    const dot = host.indexOf(".");
    if (dot > 0) {
      return `${u.protocol}//${host.slice(0, dot)}-admin.${host.slice(dot + 1)}`;
    }
    return `${u.protocol}//pod-admin.${host}`;
  } catch {
    return origin;
  }
}

/**
 * Where a person approves a pending agent key: the pod-admin app (already
 * Kratos-authed there), not a page on the API origin. Reverse-proxy-safe: the
 * pod's PUBLIC_URL first — the request URL is the internal (often http://) one
 * behind nginx. ONE builder: the setup door's `reviewUrl` and the holder's
 * key-state answer (`/auth/key-state`) both call it.
 */
export function agentApprovalPageUrl(
  requestUrl: string,
  keyId: string,
  agentType: string
): string {
  const origin = process.env.PUBLIC_URL || new URL(requestUrl).origin;
  return `${toPodAdminOrigin(origin)}/approve-agent/${keyId}?agentType=${encodeURIComponent(agentType)}`;
}

/**
 * Is `origin` (a request's `Origin` header) the pod-admin app of THIS pod?
 * The pages that call the Kratos-cookie decision routes (approve / reject a
 * pending key) live there, so a cookie-authenticated POST from anywhere else
 * is a cross-site request riding the person's session — refused.
 *
 * Accepted: the origin `toPodAdminOrigin` derives from the pod's public
 * origin (the one every approval link is built on), and the configured
 * `POD_ADMIN_URL` when it is valid (a pod whose console has its own host).
 * An absent or `null` origin is never accepted.
 */
export function isPodAdminOrigin(
  origin: string | null | undefined,
  requestUrl: string
): boolean {
  if (!origin || origin === "null") return false;
  let presented: string;
  try {
    presented = new URL(origin).origin;
  } catch {
    return false;
  }
  const allowed = new Set<string>();
  try {
    allowed.add(
      new URL(
        toPodAdminOrigin(process.env.PUBLIC_URL || new URL(requestUrl).origin)
      ).origin
    );
  } catch {
    // An unparsable public URL contributes nothing.
  }
  const configured = configuredPodAdminBase();
  if (configured.ok) allowed.add(configured.base.origin);
  return allowed.has(presented);
}
