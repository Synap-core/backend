/**
 * Public Share Wire Codecs — the credentialless read of a PUBLISHED share
 * (`GET /public/shares/{token}`, Sites W3).
 *
 * The response carries no internal id and no actor identity by construction:
 * there is no field for one. Values are the publish-time snapshot only.
 */

import { z } from "@hono/zod-openapi";

/**
 * How a published body is served: `markdown` (text a reader parses as safe
 * markdown) or `html` (a whole document a reader shows only in a sandboxed
 * frame, never in its own DOM). Shared with the site record read.
 */
export const PublicBodyFormatSchema = z
  .enum(["markdown", "html"])
  .describe(
    "markdown = parse as safe markdown; html = render only inside a sandboxed frame (no scripts)."
  );

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
      .object({ format: PublicBodyFormatSchema, content: z.string() })
      .nullable()
      .describe(
        "The pinned published revision's text in its real format, or null (none pinned, or not a text body)."
      ),
    publishedOn: z.string().describe("Publication day, YYYY-MM-DD."),
  })
  .openapi("PublicShare");
