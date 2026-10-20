/**
 * IS THIS PUBLICATION LIVE? — "served on the public web right now", decided
 * once. The public read serves a token only when this holds (plus the entity
 * still existing, which only the read can check), the owner's share listing
 * shows `live` from it, and a publish reports "republished" only over a row
 * that was live. Three hand-written versions used to disagree: the listing
 * could say live while the read answered 404.
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
}

/** Public, published, not revoked, not expired, addressable: any public row. */
function servedNow(row: PublicationLiveInput, now: number): boolean {
  return (
    row.audience === "public" &&
    row.state === "published" &&
    !row.revokedAt &&
    !(row.expiresAt && row.expiresAt.getTime() <= now) &&
    !!row.publishedAt &&
    row.hasToken
  );
}

export function isPublicationLive(
  row: PublicationLiveInput,
  now: number = Date.now()
): boolean {
  // The W3 read (`/public/shares/:token`) serves entities only, so a SITE
  // row's token is never served there.
  return row.resourceType === "entity" && servedNow(row, now);
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
