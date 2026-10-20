/**
 * Hub REST — the PUBLIC READ of a published SITE (collection door C1a).
 *
 * `GET /public/sites/:siteToken` — the site manifest: credentialless,
 * cross-origin readable. It lives under the `/public/` namespace, so the ONE
 * predicate (`public-doors.ts`) skips hub auth + idempotency, and the pod edge
 * gives it the credentialless transport (CORS `*`, no credentials, cookies
 * stripped) and the `public_read` rate class (IP-keyed).
 *
 * Contract (see `services/sharing/public-site-read.ts`): the site's metadata
 * snapshot and its configured collections only; no internal id, no actor;
 * every miss is the byte-identical 404; a LIVE site whose home space's public
 * doors are switched off is a 403 `public_doors_disabled`, decided last;
 * `Cache-Control: no-cache` + a weak ETag, so an unpublish is visible on the
 * very next revalidation. The handler never reads a principal.
 */

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  PublicSiteParamsSchema,
  PublicSiteResponseSchema,
} from "./_codecs/public-sites.js";
import { logger, type HubHono, httpStatusForTrpcError } from "./_shared.js";
import {
  PUBLIC_NOT_FOUND_BODY,
  ifNoneMatchHits,
} from "../../../services/sharing/public-read.js";
import { readPublicSite } from "../../../services/sharing/public-site-read.js";
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

  app.get("/public/sites/:siteToken", async (c) => {
    c.header("Cache-Control", PUBLIC_SITE_CACHE_CONTROL);
    let read;
    try {
      read = await readPublicSite(c.req.param("siteToken") ?? "");
    } catch (err) {
      // A FAILED read is a 5xx, never a calm 404. The token is never logged.
      logger.error({ err }, "public site read failed");
      return c.json({ error: "Internal error" }, httpStatusForTrpcError(err));
    }
    if (!read) return c.json(PUBLIC_NOT_FOUND_BODY, 404);
    if ("closed" in read) {
      return c.json(PUBLIC_DOORS_DISABLED_BODY, PUBLIC_DOORS_DISABLED_STATUS);
    }

    c.header("ETag", read.etag);
    if (ifNoneMatchHits(c.req.header("if-none-match"), read.etag)) {
      return c.body(null, 304);
    }
    return c.json(read.view, 200);
  });
}
