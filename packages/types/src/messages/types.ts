/**
 * Message Link Types
 *
 * TypeScript types for message links.
 */

import { z } from "zod";
import {
  type MessageLinkTargetType,
  type MessageLinkRelationshipType,
  MessageLinkTargetTypeSchema,
  MessageLinkRelationshipTypeSchema,
} from "./enums.js";

/**
 * Message Link Interface
 */
export interface MessageLink {
  id: string;
  messageId: string;
  targetType: MessageLinkTargetType | string;
  targetId: string;
  relationshipType: MessageLinkRelationshipType | string;
  position?: { start: number; end: number };
  metadata?: Record<string, unknown>;
  userId: string;
  workspaceId: string;
  createdAt: Date;
}

/**
 * Create Message Link Input
 */
export const CreateMessageLinkInputSchema = z.object({
  messageId: z.string().uuid(),
  targetType: MessageLinkTargetTypeSchema,
  targetId: z.string().uuid(),
  relationshipType: MessageLinkRelationshipTypeSchema,
  position: z
    .object({
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  workspaceId: z.string().uuid(),
});

export type CreateMessageLinkInput = z.infer<
  typeof CreateMessageLinkInputSchema
>;

/**
 * Query Message Links Input
 */
export const QueryMessageLinksInputSchema = z.object({
  messageId: z.string().uuid().optional(),
  targetType: MessageLinkTargetTypeSchema.optional(),
  targetId: z.string().uuid().optional(),
  relationshipType: MessageLinkRelationshipTypeSchema.optional(),
  workspaceId: z.string().uuid().optional(),
});

export type QueryMessageLinksInput = z.infer<
  typeof QueryMessageLinksInputSchema
>;
