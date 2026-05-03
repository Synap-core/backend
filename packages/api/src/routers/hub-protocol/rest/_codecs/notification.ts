/**
 * Notification Wire Codecs — Hub Protocol REST schemas for IS-originated notifications.
 */

import { z } from "@hono/zod-openapi";

export const NotificationSourceTypeSchema = z
  .enum(["proposal", "connector", "agent", "system", "inbox_item"])
  .openapi("NotificationSourceType");

/** POST /notifications request body. */
export const CreateNotificationRequestSchema = z
  .object({
    userId: z.string(),
    workspaceId: z.string(),
    type: z
      .string()
      .describe(
        "Registry type, e.g. skill.triggered, proposal.created, ai_request.vault_access."
      ),
    sourceType: NotificationSourceTypeSchema.optional(),
    sourceId: z.string().optional(),
    workspaceUrl: z.string().optional(),
    groupKey: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("CreateNotificationRequest");

/** POST /notifications response. */
export const CreateNotificationResponseSchema = z
  .object({
    id: z.string(),
  })
  .openapi("CreateNotificationResponse");
