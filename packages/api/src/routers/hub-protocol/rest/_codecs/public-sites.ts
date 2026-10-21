/**
 * Public Site Wire Codecs — the credentialless reads of a published SITE:
 * the manifest (`GET /public/sites/{siteToken}`, C1a), a collection page and
 * a record (`…/collections/{key}[/{slugOrPublicId}]`, C1b).
 *
 * No response carries an internal id or an actor identity by construction:
 * there is no field for one. `publicId` is random, never derived. Values are
 * publish-time snapshots only. THE SSOT for `@synap-core/sdk/public`'s copies.
 */

import { z } from "@hono/zod-openapi";

/** GET /public/sites/{siteToken} path params. */
export const PublicSiteParamsSchema = z
  .object({
    siteToken: z
      .string()
      .describe(
        "The site token (the capability). Stored hashed; every miss is the same 404."
      ),
  })
  .openapi("PublicSiteParams");

/** One configured collection of a site, as a stranger holding the token sees it. */
export const PublicSiteCollectionSchema = z
  .object({
    key: z.string().describe("The collection key (a profile slug)."),
    count: z.number().int().describe("Live published records in it."),
    sort: z
      .array(z.string())
      .describe("The default sort keys (`-` = descending)."),
    pageSize: z.number().int().describe("The default page size."),
    addressing: z
      .enum(["slug", "publicId"])
      .describe("How a record of this collection is addressed."),
  })
  .openapi("PublicSiteCollection");

/** A published site's manifest. */
export const PublicSiteResponseSchema = z
  .object({
    title: z
      .string()
      .optional()
      .describe("Present only when the owner's policy publishes `title`."),
    description: z
      .string()
      .optional()
      .describe(
        "Present only when the owner's policy publishes `description`."
      ),
    publishedOn: z.string().describe("Day the site went live, YYYY-MM-DD."),
    collections: z.array(PublicSiteCollectionSchema),
  })
  .openapi("PublicSite");

/** GET /public/sites/{siteToken}/collections/{key} path params. */
export const PublicSiteCollectionParamsSchema = z
  .object({
    siteToken: z.string().describe("The site token (the capability)."),
    key: z.string().describe("A configured collection key."),
  })
  .openapi("PublicSiteCollectionParams");

/** GET /public/sites/{siteToken}/collections/{key}/{slugOrPublicId} path params. */
export const PublicSiteRecordParamsSchema = z
  .object({
    siteToken: z.string().describe("The site token (the capability)."),
    key: z.string().describe("A configured collection key."),
    slugOrPublicId: z
      .string()
      .describe(
        "A record's public id (`p_` + 16 base62 chars) or its slug (lowercase words joined by `-`)."
      ),
  })
  .openapi("PublicSiteRecordParams");

/** A collection page's query: every knob bounded and allowlisted. */
export const PublicSiteCollectionQuerySchema = z
  .object({
    offset: z
      .string()
      .optional()
      .describe("0..10000 (default 0); beyond → 400 `offset too large`."),
    limit: z
      .string()
      .optional()
      .describe("Clamped to 1..100 (default: the collection's page size)."),
    sort: z
      .string()
      .optional()
      .describe(
        "≤ 3 comma-separated keys, `-` = descending, out of the collection's configured sort keys and `publishedAt` (default: the configured sort, else `-publishedAt`). Anything else → 400."
      ),
  })
  .openapi("PublicSiteCollectionQuery");

const PublicValueSchema = z.union([z.string(), z.number(), z.boolean()]);

/** One published record as a list item (no body). */
export const PublicRecordSummarySchema = z
  .object({
    collection: z.string().describe("The collection key."),
    publicId: z
      .string()
      .describe("The stable public address: `p_` + 16 random base62 chars."),
    slug: z
      .string()
      .nullable()
      .describe("The record's slug in its collection, or null."),
    title: z
      .string()
      .optional()
      .describe("Present only when the owner's policy publishes `title`."),
    properties: z
      .record(z.string(), PublicValueSchema)
      .describe(
        "The publish-time snapshot of allowlisted values (plain values only; internal ids removed)."
      ),
    publishedOn: z.string().describe("Publication day, YYYY-MM-DD."),
  })
  .openapi("PublicRecordSummary");

/** One page of a collection's live published records. */
export const PublicCollectionPageSchema = z
  .object({
    items: z.array(PublicRecordSummarySchema),
    total: z
      .number()
      .int()
      .describe("Live published records in the collection."),
    offset: z.number().int(),
    limit: z.number().int(),
  })
  .openapi("PublicCollectionPage");

/** One published record of a site, with its pinned body. */
export const PublicRecordSchema = PublicRecordSummarySchema.extend({
  body: z
    .object({ format: z.literal("markdown"), content: z.string() })
    .nullable()
    .describe("The pinned published revision's text, or null."),
}).openapi("PublicRecord");
