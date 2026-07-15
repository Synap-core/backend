export type PodAdminConfigResult =
  | { ok: true; base: URL }
  | { ok: false; code: "POD_ADMIN_URL_REQUIRED" | "POD_ADMIN_URL_INVALID" };

/**
 * Validates the Pod-local operator-console endpoint once for every consumer.
 * The Pod does not infer an admin hostname from an external product or a
 * domain convention: deploy configuration is authoritative and must agree
 * with the hostname Caddy is configured to serve.
 */
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
