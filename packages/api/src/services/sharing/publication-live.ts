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

export function isPublicationLive(
  row: PublicationLiveInput,
  now: number = Date.now()
): boolean {
  return (
    row.audience === "public" &&
    // The public read serves entities only.
    row.resourceType === "entity" &&
    row.state === "published" &&
    !row.revokedAt &&
    !(row.expiresAt && row.expiresAt.getTime() <= now) &&
    !!row.publishedAt &&
    row.hasToken
  );
}
