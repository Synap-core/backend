/**
 * Hub Protocol REST — the PUBLIC READ of a published share (Sites W3).
 *
 * `GET /public/shares/:token` — credentialless, cross-origin readable. It lives
 * under the `/public/` namespace, so the ONE predicate (`public-doors.ts`) skips
 * hub auth + idempotency, and the pod edge gives it the credentialless CORS
 * policy and the `public_read` rate class (IP-keyed; a Bearer header cannot buy
 * a fresh bucket).
 *
 * Contract (see `services/sharing/public-read.ts`): snapshot + pinned revision
 * only; no internal id, no actor; every miss is the byte-identical 404;
 * `Cache-Control: no-cache` + a weak ETag on the pinned revision, so an unshare
 * is visible on the very next revalidation (the global GET default would
 * otherwise let a browser show a revoked page for 90 s). The handler never
 * reads a principal (`c.get("userId")`, a header credential, a session).
 */

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  PublicShareParamsSchema,
  PublicShareResponseSchema,
} from "./_codecs/public-shares.js";
import { logger, type HubHono, httpStatusForTrpcError } from "./_shared.js";
import {
  PUBLIC_NOT_FOUND_BODY,
  ifNoneMatchHits,
  readPublishedShare,
} from "../../../services/sharing/public-read.js";

/** Revalidate every time: a revoked share must disappear on the next request. */
export const PUBLIC_SHARE_CACHE_CONTROL = "no-cache";

export function registerPublicSharesRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/public/shares/{token}",
    tags: ["Public"],
    summary: "Read a published share (credentialless)",
    description:
      "Returns the publish-time snapshot and pinned revision of a PUBLISHED public " +
      "share. No auth; cross-origin readable; no credentials honoured. Unknown, " +
      "revoked, expired and unpublished tokens all return the same 404.",
    security: [],
    request: { params: PublicShareParamsSchema },
    responses: {
      200: {
        description: "The published share",
        schema: PublicShareResponseSchema,
      },
      304: {
        description: "Not modified (If-None-Match matched the pinned revision)",
      },
      404: {
        description: "Not found (every kind of miss)",
        schema: ErrorSchema,
      },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/public/shares/:token", async (c) => {
    c.header("Cache-Control", PUBLIC_SHARE_CACHE_CONTROL);
    let read;
    try {
      read = await readPublishedShare(c.req.param("token") ?? "");
    } catch (err) {
      // A FAILED read is a 5xx, never a calm 404 (the read throws only on a
      // database / storage fault, which the shared mapper answers 500). The
      // token is never logged.
      logger.error({ err }, "public share read failed");
      return c.json({ error: "Internal error" }, httpStatusForTrpcError(err));
    }
    if (!read) return c.json(PUBLIC_NOT_FOUND_BODY, 404);

    c.header("ETag", read.etag);
    if (ifNoneMatchHits(c.req.header("if-none-match"), read.etag)) {
      return c.body(null, 304);
    }
    return c.json(read.view, 200);
  });
}
