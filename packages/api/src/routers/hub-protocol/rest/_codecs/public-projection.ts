/**
 * Public Projection Wire Codecs — Hub Protocol REST schemas for the
 * UNAUTHENTICATED, read-only public projection endpoint.
 *
 * Deliberately product-agnostic: the request/response shape names no product,
 * role, or field. Everything the endpoint exposes is driven by the workspace's
 * own `settings.publicProjection` opt-in config.
 */

import { z } from "@hono/zod-openapi";

/** GET /public/projection query. */
export const PublicProjectionQuerySchema = z
  .object({
    workspace: z.string().describe("Target workspace id (uuid)."),
    q: z
      .string()
      .optional()
      .describe("Optional keyword filter (matched on title + preview)."),
    role: z
      .string()
      .optional()
      .describe(
        "Optional single facet role slug to narrow to. Ignored unless it is " +
          "within the workspace's configured public role allowlist."
      ),
    limit: z
      .string()
      .optional()
      .describe("Page size. Default 20, hard-capped at 50."),
  })
  .openapi("PublicProjectionQuery");

/** A single projected row — field-whitelisted, never a raw entity dump. */
export const PublicProjectionItemSchema = z
  .object({
    id: z.string(),
    title: z.string().nullable(),
    role: z.string(),
    properties: z
      .record(z.string(), z.unknown())
      .describe(
        "Only keys present in settings.publicProjection.fields survive here."
      ),
  })
  .openapi("PublicProjectionItem");

/** Public projection response envelope. */
export const PublicProjectionResponseSchema = z
  .object({
    items: z.array(PublicProjectionItemSchema),
    count: z.number(),
  })
  .openapi("PublicProjectionResponse");
