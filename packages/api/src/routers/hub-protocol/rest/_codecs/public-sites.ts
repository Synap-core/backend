/**
 * Public Site Wire Codecs — the credentialless manifest of a published SITE
 * (`GET /public/sites/{siteToken}`, collection door C1a).
 *
 * The response carries no internal id and no actor identity by construction:
 * there is no field for one. `title` / `description` are the site's
 * publish-time metadata snapshot only.
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
