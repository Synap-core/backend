/**
 * IS THIS PUBLICATION LIVE? — "served on the public web right now", decided
 * once. The public read serves a token only when this holds (plus the entity
 * still existing, which only the read can check), the owner's share listing
 * shows `live` from it, and a publish reports "republished" only over a row
 * that was live. Three hand-written versions used to disagree: the listing
 * could say live while the read answered 404.
 *
 * TWO WAYS IN, ONE RULE (collection door C1b). A record is addressed either
 * by its OWN token (`via: "token"`, the W3 door `/public/shares/:token`) or
 * through the SITE it is a member of (`via: "site"`, the collection doors
 * `/public/sites/:token/collections/…`). A member row never has a token of its
 * own — the site's token addresses it — so `via: "site"` drops the token
 * requirement for MEMBER rows only; the site row itself still needs its token
 * ({@link isSiteLive}). And a member row is never live through a token, even
 * one planted on it: it is only ever served through its site.
 */

export interface PublicationLiveInput {
  audience: string;
  resourceType: string;
  state: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
  publishedAt: Date | null;
  /** The stored token hash (or `hasToken`): a url exists to serve. */
  hasToken: boolean;
  /** The site a MEMBER row belongs to (0336); null/absent = standalone. */
  siteShareId?: string | null;
}

export interface PublicationLiveOptions {
  /** How the row is addressed: its own token (default) or its site. */
  via?: "token" | "site";
  now?: number;
}

/** Public, published, not revoked, not expired: any public row. */
function publishedNow(row: PublicationLiveInput, now: number): boolean {
  return (
    row.audience === "public" &&
    row.state === "published" &&
    !row.revokedAt &&
    !(row.expiresAt && row.expiresAt.getTime() <= now) &&
    !!row.publishedAt
  );
}

/** {@link publishedNow} and addressable by its own token. */
function servedNow(row: PublicationLiveInput, now: number): boolean {
  return publishedNow(row, now) && row.hasToken;
}

export function isPublicationLive(
  row: PublicationLiveInput,
  { via = "token", now = Date.now() }: PublicationLiveOptions = {}
): boolean {
  // Both doors serve entities only, so a SITE row is never live here.
  if (row.resourceType !== "entity") return false;
  if (via === "site") return !!row.siteShareId && publishedNow(row, now);
  return !row.siteShareId && servedNow(row, now);
}

/**
 * IS THIS SITE LIVE? — the same rule for a SITE row (collection door, 0336):
 * a public PROJECT row that is not itself a site member, published, not
 * revoked, not expired, with a token. The site manifest door serves a site
 * token only when this holds (plus the project still existing, which only the
 * read can check), and the owner's site status shows `live` from it.
 */
export function isSiteLive(
  row: PublicationLiveInput & { siteShareId: string | null },
  now: number = Date.now()
): boolean {
  return (
    row.resourceType === "project" &&
    row.siteShareId === null &&
    servedNow(row, now)
  );
}
