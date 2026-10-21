/**
 * Hub REST — the PUBLIC READ of a published SITE (collection door).
 *
 *   GET /public/sites/:siteToken                                    manifest (C1a)
 *   GET /public/sites/:siteToken/collections/:key                   a page (C1b)
 *   GET /public/sites/:siteToken/collections/:key/:slugOrPublicId   a record (C1b)
 *
 * Credentialless, cross-origin readable. They live under the `/public/`
 * namespace, so the ONE predicate (`public-doors.ts`) skips hub auth +
 * idempotency, and the pod edge gives them the credentialless transport (CORS
 * `*`, no credentials, cookies stripped) and the `public_read` rate class
 * (IP-keyed).
 *
 * Contract (see `services/sharing/public-site-read.ts`): publish-time
 * snapshots only; no internal id, no actor; every miss is the byte-identical
 * 404; a LIVE site whose home space's public doors are switched off is a 403
 * `public_doors_disabled`, decided after every miss; an invalid query on a
 * live site's real collection is a 400 (never before the site resolved);
 * `Cache-Control: no-cache` + a weak ETag, so an unpublish is visible on the
 * very next revalidation. No handler reads a principal.
 */

import type { Context } from "hono";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  PublicCollectionPageSchema,
  PublicRecordSchema,
  PublicSiteCollectionParamsSchema,
  PublicSiteCollectionQuerySchema,
  PublicSiteParamsSchema,
  PublicSiteRecordParamsSchema,
  PublicSiteResponseSchema,
} from "./_codecs/public-sites.js";
import { logger, type HubHono, httpStatusForTrpcError } from "./_shared.js";
import {
  PUBLIC_NOT_FOUND_BODY,
  ifNoneMatchHits,
  type PublicShareClosed,
} from "../../../services/sharing/public-read.js";
import {
  readPublicSite,
  readSiteCollection,
  readSiteRecord,
  type PublicSiteInvalidQuery,
  type PublicSiteRead,
} from "../../../services/sharing/public-site-read.js";
import {
  PUBLIC_DOORS_DISABLED_BODY,
  PUBLIC_DOORS_DISABLED_STATUS,
} from "../../../services/sharing/public-doors-switch.js";

/** Revalidate every time: an unpublished site must disappear on the next request. */
export const PUBLIC_SITE_CACHE_CONTROL = "no-cache";

export function registerPublicSitesRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/public/sites/{siteToken}",
    tags: ["Public"],
    summary: "Read a published site's manifest (credentialless)",
    description:
      "Returns a PUBLISHED site's public metadata and its configured collections. " +
      "No auth; cross-origin readable; no credentials honoured. Unknown, " +
      "revoked, unpublished and deleted-project tokens all return the same 404.",
    security: [],
    request: { params: PublicSiteParamsSchema },
    responses: {
      200: {
        description: "The site manifest",
        schema: PublicSiteResponseSchema,
      },
      304: {
        description: "Not modified (If-None-Match matched)",
      },
      403: {
        description:
          "The site is live but its home workspace's public pages are switched " +
          "off (body code `public_doors_disabled`; never used for a miss)",
        schema: ErrorSchema,
      },
      404: {
        description: "Not found (every kind of miss)",
        schema: ErrorSchema,
      },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/public/sites/:siteToken", async (c) =>
    answer(c, () => readPublicSite(c.req.param("siteToken") ?? ""))
  );

  const COMMON = {
    304: { description: "Not modified (If-None-Match matched)" },
    400: {
      description:
        "Invalid query (sort, offset, limit, ref, embed) on a live site's configured collection — never used for a miss",
      schema: ErrorSchema,
    },
    403: {
      description:
        "The site is live but its home workspace's public pages are switched off (body code `public_doors_disabled`; never used for a miss)",
      schema: ErrorSchema,
    },
    404: { description: "Not found (every kind of miss)", schema: ErrorSchema },
    500: { description: "Internal error", schema: ErrorSchema },
  } as const;

  registerOpenApi(app, {
    method: "get",
    path: "/public/sites/{siteToken}/collections/{key}",
    tags: ["Public"],
    summary: "List a published site collection (credentialless)",
    description:
      "One page of a collection's live published records (snapshots, no body). " +
      "No auth; cross-origin readable; no credentials honoured. Every miss " +
      "(token, collection) returns the same 404.",
    security: [],
    request: {
      params: PublicSiteCollectionParamsSchema,
      query: PublicSiteCollectionQuerySchema,
    },
    responses: {
      200: { description: "A page", schema: PublicCollectionPageSchema },
      ...COMMON,
    },
  });

  app.get("/public/sites/:siteToken/collections/:key", async (c) =>
    answer(c, () =>
      readSiteCollection(
        c.req.param("siteToken") ?? "",
        c.req.param("key") ?? "",
        c.req.queries()
      )
    )
  );

  registerOpenApi(app, {
    method: "get",
    path: "/public/sites/{siteToken}/collections/{key}/{slugOrPublicId}",
    tags: ["Public"],
    summary: "Read one published record of a site (credentialless)",
    description:
      "A live published record of a site collection, by public id or slug, " +
      "with its pinned body. No auth; cross-origin readable; no credentials " +
      "honoured. Every miss returns the same 404.",
    security: [],
    request: { params: PublicSiteRecordParamsSchema },
    responses: {
      200: { description: "The record", schema: PublicRecordSchema },
      ...COMMON,
    },
  });

  app.get(
    "/public/sites/:siteToken/collections/:key/:slugOrPublicId",
    async (c) =>
      answer(c, () =>
        readSiteRecord(
          c.req.param("siteToken") ?? "",
          c.req.param("key") ?? "",
          c.req.param("slugOrPublicId") ?? "",
          c.req.queries()
        )
      )
  );
}

/**
 * The ONE answer path of the site doors: a failed read is a 5xx (never a calm
 * 404; the token is never logged), every miss the byte-identical 404, a closed
 * switch the 403, an invalid query the 400, else the view with a weak ETag
 * (If-None-Match → 304). Always `Cache-Control: no-cache`.
 */
async function answer<T>(
  c: Context,
  read: () => Promise<
    PublicSiteRead<T> | PublicShareClosed | PublicSiteInvalidQuery | null
  >
): Promise<Response> {
  c.header("Cache-Control", PUBLIC_SITE_CACHE_CONTROL);
  let result;
  try {
    result = await read();
  } catch (err) {
    logger.error({ err }, "public site read failed");
    return c.json({ error: "Internal error" }, httpStatusForTrpcError(err));
  }
  if (!result) return c.json(PUBLIC_NOT_FOUND_BODY, 404);
  if ("closed" in result) {
    return c.json(PUBLIC_DOORS_DISABLED_BODY, PUBLIC_DOORS_DISABLED_STATUS);
  }
  if ("invalid" in result) return c.json({ error: result.invalid }, 400);
  c.header("ETag", result.etag);
  if (ifNoneMatchHits(c.req.header("if-none-match"), result.etag)) {
    return c.body(null, 304);
  }
  return c.json(result.view as object, 200);
}
