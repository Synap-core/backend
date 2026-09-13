/**
 * External target — WHERE a synced entity lives, as an https url a client can
 * open ("Open in Google" for a calendar event).
 *
 * Modeled on `services/channels/channel-deep-link.ts`: pure + total, every
 * input either yields a target or `null`. NEVER GUESS. The url is only ever the
 * one the sync mapper stored on `entity_external_links.url` (Google Calendar's
 * own `htmlLink`) — it is never rebuilt from an external id, because a rebuilt
 * url has to assume things the pod does not know (which signed-in account,
 * which id format). A wrong link is worse than none.
 *
 * The stored url is pinned to its provider's HOST. The column is written by
 * sync, but a row whose url pointed anywhere else would turn "Open in Google"
 * into a link to an arbitrary site, so it is refused rather than passed on.
 *
 * https only: no native app scheme is emitted, because no provider below
 * documents one that opens a specific item. On a phone the OS hands an https
 * url to the installed app when that app claims the domain.
 */

export interface ExternalTarget {
  webUrl: string;
}

/** A provider's accepted web locations: host + optional path prefix. */
interface WebLocation {
  host: string;
  pathPrefix?: string;
}

/**
 * Hosts a stored url may point at, per provider — ONLY what a sync mapper
 * actually writes:
 *   google  calendar events store the Calendar API `htmlLink` verbatim
 *           (`https://www.google.com/calendar/event?eid=…`, sometimes
 *           calendar.google.com). Contacts store no url (People resources
 *           have no documented web url).
 * Gmail is deliberately ABSENT: the mail kind syncs correspondents, not
 * threads, and Gmail's web thread url is undocumented, so no thread link is
 * stored. Notion has no sync yet. Add a host here together with the mapper
 * that writes it, never ahead of it.
 */
const PROVIDER_WEB_LOCATIONS: Record<string, readonly WebLocation[]> = {
  google: [
    { host: "calendar.google.com" },
    { host: "www.google.com", pathPrefix: "/calendar/" },
  ],
};

function parseHttps(raw: string | null | undefined): URL | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The target for one external link's stored url, or `null` when the pod holds
 * no honest url for it (unknown provider, no stored url, non-https url,
 * off-provider host).
 */
export function externalTargetFor(
  provider: string,
  storedUrl: string | null | undefined
): ExternalTarget | null {
  const locations = PROVIDER_WEB_LOCATIONS[provider.trim().toLowerCase()];
  if (!locations) return null;

  const url = parseHttps(storedUrl);
  if (!url) return null;

  const host = url.hostname.toLowerCase();
  const allowed = locations.some(
    (loc) =>
      loc.host === host &&
      (!loc.pathPrefix || url.pathname.startsWith(loc.pathPrefix))
  );
  if (!allowed) return null;

  return { webUrl: url.toString() };
}
