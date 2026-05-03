/**
 * Proactive Wire Codecs — IS posts proactive messages into a user's feed channel.
 */

import { z } from "@hono/zod-openapi";

export const ProactiveTypeSchema = z
  .enum([
    "insight",
    "suggestion",
    "alert",
    "nudge",
    "morning_briefing",
    "weekly_digest",
    "health_check",
  ])
  .openapi("ProactiveType");

/** POST /proactive/post request body. */
export const ProactivePostRequestSchema = z
  .object({
    userId: z.string(),
    workspaceId: z.string(),
    content: z
      .string()
      .max(10_000)
      .describe("Plaintext or markdown body. Max 10000 chars."),
    proactiveType: ProactiveTypeSchema,
    reasoning: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("ProactivePostRequest");

/**
 * POST /proactive/post response.
 * - posted=true → delivered, includes channelId/messageId
 * - posted=false → suppressed, `reason` indicates why (e.g. rate_limited)
 */
export const ProactivePostResponseSchema = z
  .object({
    posted: z.boolean(),
    delivered: z.boolean().optional(),
    channelId: z.string().optional(),
    messageId: z.string().optional(),
    reason: z.string().optional(),
    detail: z.string().optional(),
  })
  .passthrough()
  .openapi("ProactivePostResponse");
