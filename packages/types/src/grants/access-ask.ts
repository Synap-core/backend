/**
 * An app asking for ONE MORE thing (plan 647ebfd4 option C, founder 16 Nov
 * 2026): a pair of a permission its client-id document declares and the
 * space it wants it in, named by the space's id or by the template the space
 * was made from. The person answers in the app (the consent screen's short
 * mode, `synap_ask` on /authorize) or from a card (the app's ask, Hub
 * `POST /apps/access-requests`); either way an approval only ADDS to what the
 * app already holds.
 *
 * ONE grammar for both ways, so the SDK builds what the pod reads:
 * `synap_ask=<permission>@<place> <permission>@<place>`, a place being a
 * space id (uuid) or a template slug. Writes stay in a space: there is no
 * pod-wide pair here.
 */

import { isUuid } from "../property-render/structured-value.js";

/** At most this many pairs in one ask. */
export const APP_ACCESS_ASK_MAX_PAIRS = 16;

/** An ask nobody answered stops waiting after this many days. */
export const APP_ACCESS_ASK_TTL_DAYS = 7;

/** "Not now" keeps the same pair from being asked again for this many days. */
export const APP_ACCESS_ASK_QUIET_DAYS = 30;

/** Where the app wants the permission: a space by id, or by its template. */
export type AppAccessAskPlace = { workspaceId: string } | { template: string };

/** One pair an app asks for, as it names it. */
export type AppAccessAskPair = { permission: string } & AppAccessAskPlace;

/** What the app reads back about its ask. */
export const APP_ACCESS_ASK_STATUSES = [
  "pending",
  "allowed",
  "declined",
  "expired",
] as const;
export type AppAccessAskStatus = (typeof APP_ACCESS_ASK_STATUSES)[number];

/** A template slug, as `workspaces.package_slug` holds it. */
const TEMPLATE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A grant-grammar permission's characters (the grammar itself is checked by the pod). */
const PERMISSION_RE = /^[a-z*][a-z0-9_*.-]{0,119}$/i;

/** Thrown for a `synap_ask` value that does not follow the grammar. */
export class AppAccessAskSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppAccessAskSyntaxError";
  }
}

/** The place a string names: a uuid is a space id, anything else a template slug. */
export function parseAppAccessAskPlace(raw: string): AppAccessAskPlace {
  if (isUuid(raw)) return { workspaceId: raw.toLowerCase() };
  if (TEMPLATE_RE.test(raw)) return { template: raw };
  throw new AppAccessAskSyntaxError(
    `"${raw}" is neither a space id nor a template slug.`
  );
}

/**
 * Read `synap_ask` (`entity.read@content-os entity.create@<uuid>`): pairs
 * separated by spaces, each `<permission>@<place>`. Duplicates are dropped.
 * Throws `AppAccessAskSyntaxError` on anything else, an empty value included.
 */
export function parseSynapAsk(raw: string): AppAccessAskPair[] {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new AppAccessAskSyntaxError("synap_ask names no pair.");
  }
  const out: AppAccessAskPair[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const at = token.lastIndexOf("@");
    const permission = at > 0 ? token.slice(0, at) : "";
    const place = at > 0 ? token.slice(at + 1) : "";
    if (!PERMISSION_RE.test(permission) || !place) {
      throw new AppAccessAskSyntaxError(
        `"${token}" is not <permission>@<space id or template>.`
      );
    }
    const pair = { permission, ...parseAppAccessAskPlace(place) };
    const key = formatAppAccessAskPair(pair);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pair);
  }
  if (out.length > APP_ACCESS_ASK_MAX_PAIRS) {
    throw new AppAccessAskSyntaxError(
      `synap_ask names ${out.length} pairs; at most ${APP_ACCESS_ASK_MAX_PAIRS}.`
    );
  }
  return out;
}

/** One pair as `synap_ask` spells it. */
export function formatAppAccessAskPair(pair: AppAccessAskPair): string {
  return `${pair.permission}@${"workspaceId" in pair ? pair.workspaceId : pair.template}`;
}

/** The `synap_ask` value for these pairs (the inverse of `parseSynapAsk`). */
export function formatSynapAsk(pairs: readonly AppAccessAskPair[]): string {
  return pairs.map(formatAppAccessAskPair).join(" ");
}
