/**
 * SITE CONFIG — `resource_shares.site_config` (SiteConfigV1) and the live
 * member counts, shared by the owner doors (`site-service.ts`) and the public
 * manifest read (`public-site-read.ts`). Kept apart from the owner doors so
 * the credentialless read never imports the write gate.
 */

import { z } from "zod";

// ── SiteConfigV1 ─────────────────────────────────────────────────────────────

/** A collection key: a profile slug (kind or role). It appears in public URLs. */
export const SiteCollectionKey = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
/** A snapshot field key (the exposure policy's `PublishedFieldKey` grammar). */
const FieldKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
/** A sort key: a field key or `publishedAt`, `-` prefix = descending. */
const SortKey = z.string().regex(/^-?[A-Za-z][A-Za-z0-9_]{0,63}$/);

/** The sort key every collection may use whatever the policy allowlists. */
export const SITE_PUBLISHED_AT_SORT = "publishedAt";
export const SITE_MAX_COLLECTIONS = 16;
export const SITE_DEFAULT_PAGE_SIZE = 20;

const SiteCollectionSchema = z
  .object({
    sort: z.array(SortKey).max(3).default([]),
    pageSize: z.number().int().min(1).max(100).default(SITE_DEFAULT_PAGE_SIZE),
    /** A field key in the allowlist, or null → addressed by public id only. */
    slugField: FieldKey.nullable().default(null),
    /** Lifecycle option keys for "publish all approved"; null = unavailable. */
    publishWhen: z
      .object({ statuses: z.array(z.string().min(1).max(64)).min(1).max(32) })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();

/**
 * `resource_shares.site_config` — STRICT: an unknown key anywhere is refused at
 * write time, never silently dropped. Written only by the site doors.
 */
export const SiteConfigV1Schema = z
  .object({
    version: z.literal(1),
    collections: z
      .record(SiteCollectionKey, SiteCollectionSchema)
      .refine((c) => Object.keys(c).length <= SITE_MAX_COLLECTIONS, {
        message: `A site has at most ${SITE_MAX_COLLECTIONS} collections.`,
      }),
  })
  .strict();

export type SiteConfigV1 = z.output<typeof SiteConfigV1Schema>;
export type SiteConfigInput = z.input<typeof SiteConfigV1Schema>;

const EMPTY_CONFIG: SiteConfigV1 = Object.freeze({
  version: 1 as const,
  collections: {},
});

/**
 * The stored config, read FAIL-CLOSED: anything unreadable (absent, a planted
 * blob, a future version) is a site with NO collections — the manifest lists
 * none and every collection door 404s. Never throws.
 */
export function resolveSiteConfig(raw: unknown): SiteConfigV1 {
  const parsed = SiteConfigV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : EMPTY_CONFIG;
}

// ── Live members ─────────────────────────────────────────────────────────────

/**
 * Live members per collection key. C1a: no member writer exists yet (member
 * rows are published from C1b on), so every count is 0 — C1b replaces this
 * with the narrowing-checked count the collection door's `total` uses, so the
 * manifest, the status and the list can never disagree.
 */
export async function liveMemberCounts(
  _siteId: string,
  keys: readonly string[]
): Promise<Map<string, number>> {
  return new Map(keys.map((k) => [k, 0]));
}
