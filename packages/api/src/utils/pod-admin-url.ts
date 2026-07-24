/**
 * Pod-local operator-console (pod-admin) endpoint — the ONE door.
 *
 * The Pod does not infer an admin hostname from an external product or a domain
 * convention: deploy configuration is authoritative and must agree with the
 * hostname Caddy is configured to serve.
 *
 * Lives in `packages/api` (not `apps/api`) because BOTH layers need it: the app
 * layer for the legacy `/admin/connect` bounce and the federation router, and
 * the package layer for the OAuth `/authorize` → consent-screen redirect.
 * `apps/api/src/pod-admin-config.ts` re-exports this so its existing importers
 * are unchanged and there is still exactly one implementation.
 */

export type PodAdminConfigResult =
  | { ok: true; base: URL }
  | { ok: false; code: "POD_ADMIN_URL_REQUIRED" | "POD_ADMIN_URL_INVALID" };

export function configuredPodAdminBase(): PodAdminConfigResult {
  const configuredUrl = process.env.POD_ADMIN_URL?.trim();
  if (!configuredUrl) {
    return { ok: false, code: "POD_ADMIN_URL_REQUIRED" };
  }

  try {
    const base = new URL(configuredUrl);
    const configuredDomain = process.env.POD_ADMIN_DOMAIN?.trim();
    const isHttpUrl = base.protocol === "https:" || base.protocol === "http:";
    const requiresHttps = process.env.NODE_ENV === "production";
    if (
      !isHttpUrl ||
      !base.hostname ||
      base.username ||
      base.password ||
      base.pathname !== "/" ||
      base.search ||
      base.hash ||
      (configuredDomain && base.hostname !== configuredDomain) ||
      (requiresHttps && base.protocol !== "https:")
    ) {
      return { ok: false, code: "POD_ADMIN_URL_INVALID" };
    }

    return { ok: true, base };
  } catch {
    return { ok: false, code: "POD_ADMIN_URL_INVALID" };
  }
}

/**
 * The OAuth consent screen's absolute URL on pod-admin, derived from the same
 * validated base — so a pod that has not configured its admin console fails
 * closed with the SAME code the other consumers report, rather than redirecting
 * a user's browser somewhere guessed.
 */
export function configuredPodAdminConsentUrl():
  | { ok: true; url: URL }
  | { ok: false; code: "POD_ADMIN_URL_REQUIRED" | "POD_ADMIN_URL_INVALID" } {
  const base = configuredPodAdminBase();
  if (!base.ok) return base;
  return { ok: true, url: new URL("/oauth/consent", base.base) };
}
