/**
 * "Your apps": what the person OPENS and uses (founder decision D-B, 4 Nov
 * 2026, plan c727854c W5), in one list, so every surface reads the same set:
 *
 *   pinned     what they pinned on their rail: a kind's surface, a saved
 *              view of it, a living document (`preferences.railPins`; goals
 *              are work, not apps, and stay out);
 *   spaces     the spaces they can open (`workspaces.list`, its floor);
 *   websites   the sites they keep as tools: pod `website` entities (or any
 *              bookmark kind) tagged {@link WEBSITE_TOOL_TAG}.
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

/** The tag that makes a saved link one of the person's tools. */
export const WEBSITE_TOOL_TAG = "tool";

/** Does this entity's `tags` property carry the tool tag? Tags arrive as an array or a comma string. */
export function hasToolTag(tags: unknown): boolean {
  const list = Array.isArray(tags)
    ? tags
    : typeof tags === "string"
      ? tags.split(",")
      : [];
  return list.some(
    (tag) =>
      typeof tag === "string" && tag.trim().toLowerCase() === WEBSITE_TOOL_TAG
  );
}

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

/** An entity row as `entities.list` returns it (only the fields read here). */
export interface YourAppsLinkRow {
  id: string;
  title: string | null;
  properties: unknown;
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name);

function propsOf(row: YourAppsLinkRow): Record<string, unknown> {
  return row.properties && typeof row.properties === "object"
    ? (row.properties as Record<string, unknown>)
    : {};
}

function urlOf(row: YourAppsLinkRow): string | null {
  const url = propsOf(row).url;
  return typeof url === "string" && url.trim() ? url.trim() : null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

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
  const websites: YourApp[] = input.links
    .filter((row) => hasToolTag(propsOf(row).tags))
    .flatMap((row) => {
      const url = urlOf(row);
      if (!url) return [];
      return [
        {
          key: `website:${row.id}`,
          kind: "website" as const,
          name: row.title?.trim() || hostOf(url),
          entityId: row.id,
          url,
        },
      ];
    })
    .sort(byName);
  return [...pinned, ...spaces, ...websites];
}
