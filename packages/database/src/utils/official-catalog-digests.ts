/**
 * The digests the last verified signed index of Synap's catalog lists
 * (`official_catalog_digests`). One writer — the catalog sync, after the
 * index verified — and the readers that check an official definition
 * before it installs or converges.
 */

import { db } from "../index.js";
import { and, eq } from "drizzle-orm";
import {
  officialCatalogDigests,
  type NewOfficialCatalogDigestRow,
  type OfficialCatalogDigestRow,
} from "../schema/official-catalog-digests.js";

const INSERT_CHUNK = 500;

/**
 * Make the table exactly `rows` — one transaction, so a reader sees the
 * previous verified index or this one, never a mix. Throws on failure (the
 * caller keeps the old rows and says so).
 */
export async function replaceOfficialCatalogDigests(
  rows: NewOfficialCatalogDigestRow[]
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(officialCatalogDigests);
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await tx
        .insert(officialCatalogDigests)
        .values(rows.slice(i, i + INSERT_CHUNK));
    }
  });
}

/** The verified listing of one (kind, slug), or null when the index does not list it. */
export async function readOfficialCatalogDigest(
  kind: string,
  slug: string
): Promise<OfficialCatalogDigestRow | null> {
  const [row] = await db
    .select()
    .from(officialCatalogDigests)
    .where(
      and(
        eq(officialCatalogDigests.kind, kind),
        eq(officialCatalogDigests.slug, slug)
      )
    )
    .limit(1);
  return row ?? null;
}

/** Every verified listing of a slug, whatever its kind. */
export async function readOfficialCatalogDigestsForSlug(
  slug: string
): Promise<OfficialCatalogDigestRow[]> {
  return db
    .select()
    .from(officialCatalogDigests)
    .where(eq(officialCatalogDigests.slug, slug));
}

/** The whole verified listing. */
export async function readOfficialCatalogDigests(): Promise<
  OfficialCatalogDigestRow[]
> {
  return db.select().from(officialCatalogDigests);
}
