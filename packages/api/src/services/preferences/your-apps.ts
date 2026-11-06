/**
 * "Your apps": what the person OPENS and uses (founder decision D-B, 4 Nov
 * 2026, plan c727854c W5), in one list, so every surface reads the same set:
 *
 *   pinned     what they pinned on their rail: a kind's surface, a saved
 *              view of it, a living document (`preferences.railPins`; goals
 *              are work, not apps, and stay out);
 *   spaces     the spaces they can open (`workspaces.list`, its floor);
 *   websites   the sites they keep as tools: pod `website` entities (or any
 *              bookmark kind) the shared rule calls a tool (tagged `tool` and
 *              an http(s) address: `@synap-core/types/website-tools`).
 *
 * Third-party apps that hold a key on the pod are NOT apps here: they stay in
 * Connected and pod admin (`apps.list`, D-B).
 *
 * PURE: the router reads each arm through the door that already owns it and
 * hands the rows here; this file only decides the order and the shape. Pinned
 * first, in the person's own rail order; then spaces, by name; then websites,
 * by name. A row without a name or an address is left out, never invented.
 */

import { humanizeToken } from "@synap-core/types/vocabulary";
import {
  websiteToolOf,
  type SavedLinkRow,
} from "@synap-core/types/website-tools";

export type YourApp =
  | {
      /** `space:<workspaceId>`. */
      key: string;
      kind: "space";
      name: string;
      workspaceId: string;
    }
  | {
      /** The rail pin key (`kind:<slug>` or `view:<viewId>`). */
      key: string;
      kind: "surface";
      name: string;
      profileSlug: string;
      viewId: string | null;
    }
  | {
      /** The rail pin key (`doc:<documentId>`). */
      key: string;
      kind: "document";
      name: string;
      documentId: string;
    }
  | {
      /** `website:<entityId>`. */
      key: string;
      kind: "website";
      name: string;
      entityId: string;
      url: string;
    };

export type YourAppKind = YourApp["kind"];

/**
 * "Your apps", as the founder settled it on 5 Nov 2026 (S4): "apps are the
 * external ones; views, cells etc. on the pod itself are surfaces". So an
 * app is something OUTSIDE the pod that opens on it:
 *
 *   app       a pod app the person connected (an App Connect app signed in
 *             through the pod's own OAuth door, `apps.mode = 'oauth'`, not
 *             revoked), opened at its `client_uri` (the homepage its client
 *             metadata declares, same origin as its `client_id`), else at the
 *             origin of its `client_id`;
 *   website   a site they keep as a tool (the shared rule, as before).
 *
 * Pins, spaces and documents are SURFACES (Relay's "Your surfaces", the
 * desktop's rail and spaces), never apps. Pinned and space rows stay in
 * {@link yourApps} only until Relay and the desktop read this list; then that
 * list goes. Ordered: apps by name, then websites by name.
 */
export type ExternalApp =
  | {
      /** `app:<publicId>`. */
      key: string;
      kind: "app";
      name: string;
      publicId: string;
      /** Its host: the app's identity. */
      domain: string;
      /** Where it opens: its `client_uri`, else its `client_id`'s origin. */
      url: string;
      /** A Synap app (first-party origin) vs an unverified one. */
      verified: boolean;
    }
  | Extract<YourApp, { kind: "website" }>;

/** A connected pod app, as the router reads it (only the fields read here). */
export interface ExternalAppsPodAppRow {
  publicId: string;
  name: string;
  /** `apps.oauth_client_id`: the app's metadata-document URL. */
  clientId: string;
  /** `oauth_clients.client_uri`, when its document declared one. */
  clientUri: string | null;
  verified: boolean;
}

/** Where a pod app opens: its homepage, else its client_id's origin; null if neither is an http(s) URL. */
function podAppUrl(
  row: ExternalAppsPodAppRow
): { url: string; domain: string } | null {
  for (const candidate of [row.clientUri, row.clientId]) {
    if (!candidate) continue;
    try {
      const u = new URL(candidate);
      if (u.protocol !== "https:" && u.protocol !== "http:") continue;
      return {
        url: candidate === row.clientUri ? u.toString() : u.origin,
        domain: u.host,
      };
    } catch {
      // Not a URL: try the next one.
    }
  }
  return null;
}

export function externalApps(input: {
  podApps: readonly ExternalAppsPodAppRow[];
  links: readonly YourAppsLinkRow[];
}): ExternalApp[] {
  const apps: ExternalApp[] = input.podApps
    .flatMap((row) => {
      const at = podAppUrl(row);
      const name = row.name.trim() || at?.domain || "";
      return at && name
        ? [
            {
              key: `app:${row.publicId}`,
              kind: "app" as const,
              name,
              publicId: row.publicId,
              domain: at.domain,
              url: at.url,
              verified: row.verified,
            },
          ]
        : [];
    })
    .sort(byName);
  const websites = yourApps({ pins: [], spaces: [], links: input.links });
  return [...apps, ...(websites as Extract<YourApp, { kind: "website" }>[])];
}

/** A rail pin as `readRailPins` returns it (only the fields read here). */
export interface YourAppsPinRow {
  key: string;
  profileSlug: string | null;
  viewId: string | null;
  trackId: string | null;
  documentId: string | null;
  label: string | null;
  title?: string;
}

/** A space as `workspaces.list` returns it (only the fields read here). */
export interface YourAppsSpaceRow {
  id: string;
  name: string;
}

/** A saved link as `entities.list` returns it: the shared rule's own row. */
export type YourAppsLinkRow = SavedLinkRow;

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name);

/**
 * A document or a kind's surface. A goal pin ("This week", `trackId`, no kind,
 * no document) matches neither arm and is left out: it is work, not an app.
 */
function pinApp(pin: YourAppsPinRow): YourApp | null {
  if (pin.documentId) {
    const name = pin.label?.trim() || pin.title?.trim();
    return name
      ? { key: pin.key, kind: "document", name, documentId: pin.documentId }
      : null;
  }
  if (pin.profileSlug) {
    return {
      key: pin.key,
      kind: "surface",
      name: pin.label?.trim() || humanizeToken(pin.profileSlug),
      profileSlug: pin.profileSlug,
      viewId: pin.viewId,
    };
  }
  return null;
}

export function yourApps(input: {
  pins: readonly YourAppsPinRow[];
  spaces: readonly YourAppsSpaceRow[];
  links: readonly YourAppsLinkRow[];
}): YourApp[] {
  const pinned = input.pins.flatMap((p) => {
    const app = pinApp(p);
    return app ? [app] : [];
  });
  const spaces: YourApp[] = input.spaces
    .filter((s) => s.name.trim())
    .map((s) => ({
      key: `space:${s.id}`,
      kind: "space" as const,
      name: s.name.trim(),
      workspaceId: s.id,
    }))
    .sort(byName);
  // A tool is tagged AND opens over http(s): the shared rule
  // (`@synap-core/types/website-tools`), never a second one here.
  const websites: YourApp[] = input.links
    .flatMap((row) => {
      const tool = websiteToolOf(row);
      return tool
        ? [
            {
              key: `website:${tool.id}`,
              kind: "website" as const,
              name: tool.name,
              entityId: tool.id,
              url: tool.url,
            },
          ]
        : [];
    })
    .sort(byName);
  return [...pinned, ...spaces, ...websites];
}
