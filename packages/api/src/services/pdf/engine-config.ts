/**
 * Where the pod's PDF engine (Stirling PDF) answers — PDF tools W1.
 *
 * The engine is an INTERNAL service the pod runs beside the API (a Compose
 * profile, service `stirling-pdf`, port 8080). Only the backend reaches it, at
 * the URL the operator configured in `STIRLING_URL` (e.g.
 * `http://stirling-pdf:8080`). Unset or blank means the engine is OFF on this
 * pod, and every PDF verb refuses with that sentence rather than pretending.
 *
 * Deliberately NOT run through the SSRF validator (`validateExternalUrl`,
 * `safePublicFetch`): those refuse private addresses by design, and an
 * internal service on the Compose network IS a private address. This URL is
 * operator-trusted configuration, read only from the environment; no request,
 * verb parameter or stored row can supply or alter it.
 */

/** The engine's base URL without a trailing slash, or null when it is off. */
export function stirlingBaseUrl(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const raw = env.STIRLING_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}
