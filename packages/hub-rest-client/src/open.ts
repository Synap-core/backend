/**
 * Portable Synap locator — the ONE URL grammar for every client.
 *
 * HTTPS (canonical, type-probed by GET /open/:id):
 *   `{pod}/open/<id>`
 * HTTPS, one surface ATTACHED to an object (Surfaces P3): the object's page,
 * opened on that surface:
 *   `{pod}/open/<kind>/<id>?surface=<surfaceId>`
 *
 * Desktop (needs a kind; the Browser route table is object-nav.ts):
 *   `synap://open/<kind>/<id>`
 *
 * Server-side sibling with PUBLIC_URL: packages/api/src/utils/deep-links.ts.
 * Keep `openPath` (and `OpenPathOptions`) byte-identical with it.
 */

function normalizePodUrl(podUrl: string): string {
  return podUrl.replace(/\/+$/, "");
}

/**
 * `kind` types the link (`/open/<kind>/<id>`); `surface` opens the object's
 * page on one surface attached to it (`?surface=<surfaceId>`, needs `kind`).
 */
export interface OpenPathOptions {
  kind?: string;
  surface?: string;
}

/**
 * Pod-relative path: `/open/<id>`, `/open/<kind>/<id>`, or
 * `/open/<kind>/<id>?surface=<surfaceId>`.
 */
export function openPath(id: string, opts?: OpenPathOptions): string {
  const kind = opts?.kind ? `${encodeURIComponent(opts.kind)}/` : "";
  const path = `/open/${kind}${encodeURIComponent(id)}`;
  return opts?.kind && opts.surface
    ? `${path}?surface=${encodeURIComponent(opts.surface)}`
    : path;
}

/** Canonical https locator: `${podUrl}/open/<id>` (or typed, with a surface). */
export function openUrl(
  podUrl: string,
  id: string,
  opts?: OpenPathOptions
): string {
  return `${normalizePodUrl(podUrl)}${openPath(id, opts)}`;
}

/**
 * Desktop protocol URL. Kind is a free string (entity, view, proposal, …).
 * Prefer `openUrl` when a pod origin is available — the pod resolves type.
 *
 * `params` are ADDRESS parameters the browser's route table reads off the query
 * string. Some kinds are not addressable by id alone: a run is addressed by
 * `{flowType, runId}`, so `GET /resolve/:id` returns `params: {flowType}` next
 * to the label and the caller passes it straight through here. Producing the
 * query string in this ONE producer is what keeps the grammar single — a caller
 * concatenating `?k=v` onto the returned string would be a second producer.
 */
export function openAppUrl(
  kind: string,
  id: string,
  params?: Record<string, string>
): string {
  const base = `synap://open/${kind}/${encodeURIComponent(id)}`;
  const entries = Object.entries(params ?? {});
  if (entries.length === 0) return base;
  const query = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `${base}?${query}`;
}
