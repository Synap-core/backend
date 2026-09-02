/**
 * Portable Synap locator — the ONE URL grammar for every client.
 *
 * HTTPS (canonical, type-probed by GET /open/:id):
 *   `{pod}/open/<id>`
 *
 * Desktop (needs a kind; the Browser route table is object-nav.ts):
 *   `synap://open/<kind>/<id>`
 *
 * Server-side sibling with PUBLIC_URL: packages/api/src/utils/deep-links.ts.
 * Keep the path `/open/<id>` byte-identical.
 */

function normalizePodUrl(podUrl: string): string {
  return podUrl.replace(/\/+$/, "");
}

/** Pod-relative path: `/open/<id>`. */
export function openPath(id: string): string {
  return `/open/${encodeURIComponent(id)}`;
}

/** Canonical https locator: `${podUrl}/open/<id>`. */
export function openUrl(podUrl: string, id: string): string {
  return `${normalizePodUrl(podUrl)}${openPath(id)}`;
}

/**
 * Desktop protocol URL. Kind is a free string (entity, view, proposal, …).
 * Prefer `openUrl` when a pod origin is available — the pod resolves type.
 */
export function openAppUrl(kind: string, id: string): string {
  return `synap://open/${kind}/${encodeURIComponent(id)}`;
}
