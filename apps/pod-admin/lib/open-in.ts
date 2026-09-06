/**
 * `openIn` — the ONE exit door out of pod-admin.
 *
 * pod-admin is the pod's front desk, not a second Synap. Most objects it can
 * name, it cannot render: the desktop app (`browser/`) owns work surfaces, and
 * the landing site owns account, billing and docs. Before this module those
 * exits were hand-written at each call site, and the audit of 2026-09-05 found
 * every single one of them broken:
 *
 *   • 3 relative hrefs (`/studio/settings/vault`, `/studio/settings/integrations`,
 *     `/openclaw`) pointed at routes pod-admin does not serve — hard 404s.
 *   • 4 CTAs pointed at `hub.synap.live?ws=<id>`: the deprecated fluid web app,
 *     behind a SECOND login, whose auth provider never reads `?ws` (its own
 *     helper said so in a TODO). The workspace you clicked from was dropped.
 *
 * The rule this module enforces: **a link is only worth emitting if you have
 * read its receiver.** Every exit below resolves to either a route pod-admin
 * itself serves, a `synap://` link whose handler was verified in
 * `browser/electron/renderer/src/hooks/useDeepLinkHandler.ts`, or an https URL
 * on the landing site.
 *
 * The second rule: **a desktop link always carries a web fallback.** Not every
 * visitor has the app installed, and a `synap://` href that does not resolve
 * fails silently — the browser simply does nothing. `fallback` is what the UI
 * offers next to it so the click is never a dead end.
 */

import { HOST_TYPES } from "../app/open/open-params";

/**
 * Landing-site origin. A CONSTANT, deliberately.
 *
 * This started as `process.env.NEXT_PUBLIC_SYNAP_WEB_URL ?? …`, which was a
 * false affordance twice over. `NEXT_PUBLIC_*` values are build-time
 * substitutions, and the pod-admin image is REUSABLE across pods whose
 * hostnames change at claim/restore — so a per-pod override could never have
 * taken effect; every deploy would have silently resolved to the default. It
 * was also never set in `deploy/`, so the "override" advertised a knob nobody
 * could turn. `lib/public-pod-url.ts` documents this exact reasoning and
 * solves the pod's own URL with a server-injected runtime value instead.
 *
 * Unlike the pod URL, the landing site is ONE global origin for every pod, so
 * it does not need that machinery — it needs to be a constant and say so.
 *
 * `www.` is deliberate, not cosmetic: the apex 307-redirects to it (verified
 * live 2026-09-06), so emitting the apex made every account, docs and download
 * link pay an extra round trip — on exactly the links a stranded user follows
 * because a `synap://` did nothing.
 */
const WEB_BASE = "https://www.synap.live";

/**
 * Browser Settings sections pod-admin hands off to. This is a SUBSET of the
 * `SettingsSection` union in `browser/electron/renderer/src/stores/appStore.ts`
 * — only the sections that are the real home of something pod-admin merely
 * summarises. Adding one here requires that the section id still exists there.
 */
export const BROWSER_SETTINGS_SECTIONS = [
  "vault",
  "connectors",
  "integrations",
  "api-keys",
  "ai-governance",
  "subscription",
  "pod",
  "extensions",
  "capabilities",
  "developer",
] as const;

export type BrowserSettingsSection = (typeof BROWSER_SETTINGS_SECTIONS)[number];

/**
 * Landing account pages. Verified present in `synap-landing/app/account/`.
 * These are the surfaces a pod owner needs that a pod can never host itself —
 * plan, invoices, provisioning, deletion.
 */
export const ACCOUNT_PAGES = [
  "pod",
  "billing",
  "settings",
  "developer",
  "support",
] as const;

export type AccountPage = (typeof ACCOUNT_PAGES)[number];

/**
 * Object kinds pod-admin renders itself, on the web, signed-in — DERIVED from
 * the `/open` page's own `HOST_TYPES`, which is contract-locked against the
 * backend's `TYPED_OPEN_KINDS`. Hand-copying it here would have made this the
 * one link in that chain nothing checks: the route would keep serving a kind
 * this door had stopped naming, silently. (`proposal` is not in the set — it
 * has its own `/proposal/[id]` route and is handled ahead of the lookup.)
 */
const WEB_HOSTED_OBJECTS: ReadonlySet<string> = new Set(HOST_TYPES);

export type ExitTarget =
  /** An object addressed by kind + id. Web-hosted when pod-admin can render it. */
  | { kind: "object"; objectKind: string; id: string }
  /** A section of the desktop app's Settings. */
  | { kind: "settings"; section: BrowserSettingsSection }
  /** A desktop app by manifest id (e.g. `marketplace`, `data`, `governance`). */
  | { kind: "app"; appId: string }
  /**
   * The same object, but explicitly IN THE DESKTOP APP even when pod-admin can
   * render it on the web. Needed by `/proposal/[id]`, which IS the web
   * renderer and still wants an "open this in the app" sub-action — asking for
   * `kind: "object"` there would just return the page you are already on.
   */
  | { kind: "objectInApp"; objectKind: string; id: string }
  /** A page in the landing site's account area. */
  | { kind: "account"; page: AccountPage }
  /** A documentation page: `synap.live/guides/<slug>`. */
  | { kind: "guide"; slug: string };

export interface Exit {
  /** Where the primary affordance points. */
  href: string;
  /**
   * True when `href` uses the `synap://` scheme, which silently does nothing
   * if the desktop app is not installed. The UI MUST render `fallback`
   * alongside any exit where this is true.
   */
  isDesktopLink: boolean;
  /** Always present when `isDesktopLink` — never leave a click with no way out. */
  fallback?: { href: string; label: string };
}

/**
 * The one place the "you need the app" escape hatch is spelled.
 *
 * Exported because a list whose every row is a desktop link should offer this
 * ONCE beneath the list, not once per row. Deriving it from here means that
 * shared affordance can never drift from where the row links actually point.
 */
export const DESKTOP_FALLBACK = {
  href: `${WEB_BASE}/download/browser`,
  label: "Get the desktop app",
} as const;

function desktop(href: string): Exit {
  return { href, isDesktopLink: true, fallback: DESKTOP_FALLBACK };
}

function web(href: string): Exit {
  return { href, isDesktopLink: false };
}

/**
 * Resolve an exit. Priority, highest first:
 *   1. a route pod-admin serves itself (always works, no install, no re-login)
 *   2. a verified `synap://` deep link + the download fallback
 *   3. an https URL on the landing site
 */
export function openIn(target: ExitTarget): Exit {
  switch (target.kind) {
    case "object": {
      // Proposals are web-first: pod-admin hosts the review surface, and the
      // backend's /open dispatcher 302s proposal links straight to it.
      if (target.objectKind === "proposal") {
        return web(`/proposal/${encodeURIComponent(target.id)}`);
      }
      if (WEB_HOSTED_OBJECTS.has(target.objectKind)) {
        return web(
          `/open/${encodeURIComponent(target.objectKind)}/${encodeURIComponent(target.id)}`
        );
      }
      // Everything else — workspace, session, channel, document, cell,
      // project, capability — has no web renderer. Be honest about it.
      return desktop(
        `synap://open/${encodeURIComponent(target.objectKind)}/${encodeURIComponent(target.id)}`
      );
    }

    case "objectInApp":
      return desktop(
        `synap://open/${encodeURIComponent(target.objectKind)}/${encodeURIComponent(target.id)}`
      );

    case "settings":
      // Receiver verified: `useDeepLinkHandler.ts` routes `open/app/<id>/<seg>`
      // to the app with `props.route = [<seg>]`, and `SettingsApp` reads
      // `route[0]` to call `navigateToSettings()`.
      return desktop(`synap://open/app/settings/${target.section}`);

    case "app":
      return desktop(`synap://open/app/${encodeURIComponent(target.appId)}`);

    case "account":
      return web(`${WEB_BASE}/account/${target.page}`);

    case "guide":
      return web(`${WEB_BASE}/guides/${encodeURIComponent(target.slug)}`);
  }
}
