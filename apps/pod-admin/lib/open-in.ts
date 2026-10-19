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
 *
 * The third rule: **a phone is a different receiver.** There `synap://` opens
 * the mobile app (Relay), which opens fewer things than the desktop app and
 * mis-routes the rest. Every desktop exit says what a phone does with it
 * (`phone`), from ONE table (`RELAY_OPENABLE_KINDS`), and `placeExit` turns
 * that into what the device shows: the link with the mobile install hatch, or
 * an honest "open this on your computer" with a web page when one covers it.
 */

import {
  consolePath,
  desktopPlaceConsoleTarget,
} from "@synap-core/types/console";
import type { ObjectNavView } from "@synap-core/types/navigation";
import { HOST_TYPES } from "../app/open/open-params";
import { NAV_ITEMS, navHref } from "./console-nav";

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
  /**
   * An object addressed by kind + id. Web-hosted when pod-admin can render it.
   * `view` asks for a READING of it that only the apps draw (`room` = a
   * session's Intake Room), so an object with a view always hands off.
   * `params` are address parameters both the web page and the apps read (a
   * run's `flowType`).
   */
  | {
      kind: "object";
      objectKind: string;
      id: string;
      view?: ObjectNavView;
      params?: Record<string, string>;
    }
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
  | {
      kind: "objectInApp";
      objectKind: string;
      id: string;
      /** Address parameters the app needs to find it (a run's `flowType`). */
      params?: Record<string, string>;
    }
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
  /**
   * What a PHONE does with this `synap://` link, where the scheme opens the
   * mobile app (Relay) instead of the desktop one. Present iff `isDesktopLink`;
   * `placeExit` reads it, nothing else should.
   */
  phone?: PhoneExit;
}

/** A pod-admin page that covers, on the web, what a desktop exit opens. */
export interface WebAlternative {
  href: string;
  label: string;
}

export type PhoneExit =
  /** Relay has a screen for it: the same link works, its install hatch differs. */
  | { opens: "relay" }
  /** Relay cannot open it. `web` is a console page that covers it, if any. */
  | { opens: "nowhere"; web?: WebAlternative };

/**
 * The one place the "you need the app" escape hatch is spelled. Not exported:
 * it rides on every desktop `Exit`, and a list that offers it once beneath its
 * rows renders `ExitFallback` with one of those exits — so the hatch can never
 * drift from where the row links point, or from the device (`placeExit`).
 */
const DESKTOP_FALLBACK = {
  href: `${WEB_BASE}/download/browser`,
  label: "Get the desktop app",
} as const;

/**
 * The phone's install hatch, for a link Relay can open. Same landing origin;
 * `/download/relay` is the page Relay itself sends people to
 * (`relay-app/src/lib/pair-hint.ts` `RELAY_DOWNLOAD_URL`).
 */
export const MOBILE_FALLBACK = {
  href: `${WEB_BASE}/download/relay`,
  label: "Get the Synap mobile app",
} as const;

/**
 * Object kinds Relay can open from `synap://open/<kind>/<id>` — THE table.
 *
 * On a phone the `synap://` scheme belongs to Relay, not the desktop app, and
 * Relay resolves it through its own route table
 * (`relay-app/src/lib/object-nav.ts` `KIND_ROUTE`; its `NO_SCREEN` lists what
 * it knowingly cannot open — `workspace`, `channel`, `view`, `capability`,
 * `skill`). Every kind here has a `KIND_ROUTE` row keyed by the SAME id this
 * door puts in the link (a session's `?view=room` included). A kind missing
 * here is told "open on your computer" on a phone rather than handed a link
 * that lands on Relay's "not found". The `open/app/<appId>` grammar (desktop
 * apps, Settings sections) is not an object kind: Relay reads it as a desktop
 * place and, for one it has no screen for, says "on your computer" with the
 * console page that covers it. The console says the same here, one tap
 * sooner, from the same table (`desktopPlaceWebAlternative`).
 */
const RELAY_OPENABLE_KINDS: ReadonlySet<string> = new Set([
  "session",
  "automation",
  "playbook",
  "owed",
  "proposal",
  "entity",
  "document",
  "project",
]);

/** Console pages a desktop place can point at that are not in the nav. */
const SELF_SERVICE_PAGE_LABEL: Readonly<Record<string, string>> = {
  "/my-vault": "My vault",
};

/**
 * The console page that does a desktop place's job (`<appId>` or
 * `settings/<section>`), from the table every host reads
 * (`DESKTOP_PLACE_CONSOLE_PAGE`), so a phone, which cannot reach the desktop
 * place, is pointed there instead of at nothing.
 */
function desktopPlaceWebAlternative(
  desktopPath: string
): WebAlternative | undefined {
  const target = desktopPlaceConsoleTarget(desktopPath);
  const href = target ? consolePath(target) : null;
  if (!href) return undefined;
  const label =
    NAV_ITEMS.find((i) => i.href === href)?.label ??
    SELF_SERVICE_PAGE_LABEL[href];
  return label ? { href, label } : undefined;
}

/**
 * A desktop-only object's page in the console, when it has one. An ADMIN page:
 * a phone is pointed there (`placeExit`), and `/open`'s bounce card offers it
 * to a pod admin.
 */
export function objectWebAlternative(
  objectKind: string,
  id: string
): WebAlternative | undefined {
  if (objectKind === "workspace") {
    return {
      href: `${navHref("spaces")}/${encodeURIComponent(id)}`,
      label: "See this space here",
    };
  }
  return undefined;
}

function withWeb(web: WebAlternative | undefined): PhoneExit {
  return web ? { opens: "nowhere", web } : { opens: "nowhere" };
}

function desktop(href: string, phone: PhoneExit): Exit {
  return { href, isDesktopLink: true, fallback: DESKTOP_FALLBACK, phone };
}

/** `synap://open/<kind>/<id>[?view=|?flowType=]` — the object grammar both apps read. */
function objectLink(
  objectKind: string,
  id: string,
  query?: Record<string, string>
) {
  const href = `synap://open/${encodeURIComponent(objectKind)}/${encodeURIComponent(id)}`;
  const search = query ? new URLSearchParams(query).toString() : "";
  return desktop(
    search ? `${href}?${search}` : href,
    RELAY_OPENABLE_KINDS.has(objectKind)
      ? { opens: "relay" }
      : withWeb(objectWebAlternative(objectKind, id))
  );
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
      // A view is a reading only the apps draw (the Intake Room): the web
      // page would show the plain object and silently drop what was asked.
      if (WEB_HOSTED_OBJECTS.has(target.objectKind) && !target.view) {
        const path = `/open/${encodeURIComponent(target.objectKind)}/${encodeURIComponent(target.id)}`;
        const search = target.params
          ? new URLSearchParams(target.params).toString()
          : "";
        return web(search ? `${path}?${search}` : path);
      }
      // Everything else — workspace, cell, project, skill, tool — has no web
      // renderer. Be honest about it. (The operational kinds, documents and
      // channels are hosted; a caller that means "in the desktop app" asks
      // for `objectInApp`.)
      return objectLink(target.objectKind, target.id, {
        ...target.params,
        ...(target.view ? { view: target.view } : {}),
      });
    }

    case "objectInApp":
      return objectLink(target.objectKind, target.id, target.params);

    case "settings":
      // Receiver verified: `useDeepLinkHandler.ts` routes `open/app/<id>/<seg>`
      // to the app with `props.route = [<seg>]`, and `SettingsApp` reads
      // `route[0]` to call `navigateToSettings()`.
      return desktop(
        `synap://open/app/settings/${target.section}`,
        withWeb(desktopPlaceWebAlternative(`settings/${target.section}`))
      );

    case "app":
      return desktop(
        `synap://open/app/${encodeURIComponent(target.appId)}`,
        withWeb(desktopPlaceWebAlternative(target.appId))
      );

    case "account":
      return web(`${WEB_BASE}/account/${target.page}`);

    case "guide":
      return web(`${WEB_BASE}/guides/${encodeURIComponent(target.slug)}`);
  }
}

/**
 * A marketplace publisher's own page — where a showcase-only listing installs
 * from. The one exit to a third-party origin, so it is its
 * own door: only an https address resolves (the pod already refuses any other
 * scheme in a source's index; this is the second check, at the link), and
 * anything else is `null` — no link at all rather than a `javascript:` one.
 */
export function publisherExit(url: string | null | undefined): Exit | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return null;
    }
    return web(parsed.toString());
  } catch {
    return null;
  }
}

/**
 * An exit as THIS device can follow it.
 *
 * `href: null` means there is nothing to click here: the reader is on a phone,
 * where `synap://` opens Relay, and Relay has no screen for the target. Then
 * `unavailable` carries the honest sentence and, when the console covers the
 * same ground, the page that does.
 */
export interface PlacedExit {
  href: string | null;
  isDesktopLink: boolean;
  /** The install hatch for this device's app. Only with a `synap://` href. */
  fallback?: { href: string; label: string };
  unavailable?: { note: string; web?: WebAlternative };
}

/** Said where a phone cannot follow an exit. Plain, and true. */
export const PHONE_UNAVAILABLE_NOTE = "Open this on your computer.";

/**
 * Resolve an exit for the device. Desktop (and the server render) get the exit
 * exactly as `openIn` built it; a phone keeps web exits, keeps a Relay-openable
 * `synap://` link with the MOBILE install hatch, and turns everything else into
 * an `unavailable` note — never a link that lands on Relay's "not found".
 */
export function placeExit(exit: Exit, onPhone: boolean): PlacedExit {
  if (!onPhone || !exit.isDesktopLink || !exit.phone) return exit;
  if (exit.phone.opens === "relay") {
    return { href: exit.href, isDesktopLink: true, fallback: MOBILE_FALLBACK };
  }
  return {
    href: null,
    isDesktopLink: true,
    unavailable: exit.phone.web
      ? { note: PHONE_UNAVAILABLE_NOTE, web: exit.phone.web }
      : { note: PHONE_UNAVAILABLE_NOTE },
  };
}
