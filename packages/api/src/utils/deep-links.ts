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

/**
 * The pod's public ORIGIN (`https://pod.example.com`), from the same
 * normalized PUBLIC_URL every link uses, or `undefined` when unset or
 * unparseable. A push carries it so a lock-screen answer queued before a pod
 * switch is never sent to the wrong pod.
 */
export function podPublicOrigin(): string | undefined {
  const base = publicBase();
  if (!base) return undefined;
  try {
    return new URL(base).origin;
  } catch {
    return undefined;
  }
}

/**
 * Where this pod's published shares are read as a PAGE (a Website Factory
 * showcase site, one per brand), from `SYNAP_SHARE_PAGE_URL`: its normalized
 * base (`https://share.example.com`, trailing slash stripped), or `undefined`
 * when unset or not an http(s) URL. Unset = the pod hands out no page link;
 * a publication still has its developer address.
 */
export function sharePageBase(): string | undefined {
  const raw = process.env.SYNAP_SHARE_PAGE_URL?.trim().replace(/\/+$/, "");
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:"
      ? raw
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The page a stranger opens for a published share: `${base}/d/<token>` (the
 * site's `/d/[token]` route), or `undefined` when no page is configured.
 */
export function sharePageUrl(token: string): string | undefined {
  const base = sharePageBase();
  return base ? undefined : undefined;
}

/**
 * The DEVICE flavour of a link, chosen by the PRODUCER at build time.
 *
 * A producer always knows its audience — a push notification addressed to a
 * registered phone knows it is going to a phone — so the pod never has to guess
 * from a user-agent. `dispatchOpen` (apps/api/src/open-dispatch.ts) reads this
 * off the query string and, for `"mobile"`, bounces to `synap://` instead of
 * 302-ing to the desktop-only pod-admin review page.
 *
 * These two literals are the CONSUMER's `OPEN_CLIENT_PARAM` /
 * `OPEN_CLIENT_MOBILE`; `apps/api/src/open-kinds.lock.test.ts` freezes a copy of
 * this pair against them so the producer and the route cannot drift.
 */
export const OPEN_CLIENT_PARAM = "client";
export type OpenLinkClient = "mobile";

/**
 * Absolute, clickable link into the app: `${PUBLIC_URL}/open/<id>`.
 *
 * `opts.client` appends the device flavour (`?client=mobile`). Omit it for the
 * canonical, device-agnostic link — that stays byte-identical to what every
 * existing caller emits.
 */
export function openLink(
  id: string,
  opts?: { client?: OpenLinkClient }
): string {
  const base = publicBase();
  const path = opts?.client
    ? `${openPath(id)}?${OPEN_CLIENT_PARAM}=${opts.client}`
    : openPath(id);
  return base ? `${base}${path}` : path;
}

/**
 * Pod-relative path into the app: `/open/<id>`.
 * Lock-step with `@synap-core/hub-rest-client` `openPath` (same encoding).
 */
export function openPath(id: string): string {
  return `/open/${encodeURIComponent(id)}`;
}

/**
 * Typed deep link: `${PUBLIC_URL}/open/<type>/<id>`.
 *
 * The bare-id `/open/:id` route (apps/api/src/index.ts) is public, so it probes
 * only what changes its HTTP answer (proposal → review page; entity / view →
 * web host) and bounces every other id TYPELESS as `synap://open/<id>`; the
 * signed-in app then resolves the kind through `GET /api/hub/resolve/:id`
 * (which does know capability containers). A producer that already KNOWS the
 * kind uses the typed route `/open/:type/:id`, which carries it through with
 * no resolve round-trip.
 *
 * `type` is deliberately narrow (only what this pod actually emits) and MUST
 * stay a subset of `TYPED_OPEN_KINDS` (apps/api/src/open-dispatch.ts), which is
 * itself locked against pod-admin's HOST ∪ BOUNCE list by
 * `apps/api/src/open-kinds.lock.test.ts` — the lock carries a frozen copy of
 * this union so a kind emitted here can never outrun the route that serves it.
 *
 * `settings` takes a Settings SECTION as its id (`agents`): the door an owed
 * slot hands a person whose fix lives in Settings (e.g. "bind an agent").
 */
export const TYPED_DEEP_LINK_KINDS = ["capability", "settings"] as const;
export type TypedDeepLinkKind = (typeof TYPED_DEEP_LINK_KINDS)[number];

/** Absolute, clickable typed link: `${PUBLIC_URL}/open/<type>/<id>`. */
export function openTypedLink(type: TypedDeepLinkKind, id: string): string {
  const base = publicBase();
  const path = `/open/${type}/${encodeURIComponent(id)}`;
  return base ? `${base}${path}` : path;
}
