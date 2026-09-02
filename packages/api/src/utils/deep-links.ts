/**
 * deep-links.ts — the ONE builder for clickable links into the app.
 *
 * Every create/propose response surfaces a single canonical link of the form
 * `${PUBLIC_URL}/open/<id>` — a BARE object id (no type). The pod's public
 * `GET /open/:id` route (see apps/api/src/index.ts) resolves the id's type
 * and dispatches: proposals and (for humans) entity/view 302 to pod-admin;
 * unfurl bots and other kinds bounce to `synap://open/<type>/<id>`.
 * Emitting the bare-id origin (the pod itself) keeps one link shape.
 *
 * PUBLIC_URL is normalized exactly like capture.ts does it: force https (chat
 * clients such as Discord only linkify https, and `synap://` alone is not
 * clickable there) and strip any trailing slash. When PUBLIC_URL is unset we
 * fall back to the pod-relative path so the value is always a usable string.
 */

function publicBase(): string | undefined {
  return process.env.PUBLIC_URL?.replace(/^http:/, "https:").replace(/\/$/, "");
}

/** Absolute, clickable link into the app: `${PUBLIC_URL}/open/<id>`. */
export function openLink(id: string): string {
  const base = publicBase();
  return base ? `${base}${openPath(id)}` : openPath(id);
}

/**
 * Pod-relative path into the app: `/open/<id>`.
 * Lock-step with `@synap/hub-rest-client` `openPath` (same encoding).
 */
export function openPath(id: string): string {
  return `/open/${encodeURIComponent(id)}`;
}
