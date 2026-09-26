/**
 * Public Share Wire Codecs — the credentialless read of a PUBLISHED share
 * (`GET /public/shares/{token}`, Sites W3).
 *
 * The response carries no internal id and no actor identity by construction:
 * there is no field for one. Values are the publish-time snapshot only.
 */

import { z } from "@hono/zod-openapi";

/** GET /public/shares/{token} path params. */
export const PublicShareParamsSchema = z
  .object({
    token: z
      .string()
      .describe(
        "The public share token (the capability). Stored hashed; every miss is the same 404."
      ),
  })
  .openapi("PublicShareParams");

/** A published share, as a stranger holding the token sees it. */
export const PublicShareResponseSchema = z
  .object({
    resourceType: z.literal("entity"),
    title: z
      .string()
      .optional()
      .describe("Present only when the publisher allowlisted `title`."),
    properties: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .describe(
        "The publish-time snapshot of allowlisted values (plain values only; internal ids removed)."
      ),
    body: z
      .object({ format: z.literal("markdown"), content: z.string() })
      .nullable()
      .describe("The pinned published revision's text, or null."),
    publishedOn: z.string().describe("Publication day, YYYY-MM-DD."),
  })
  .openapi("PublicShare");
