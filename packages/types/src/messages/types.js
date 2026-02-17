/**
 * Message Link Types
 *
 * TypeScript types for message links.
 */
import { z } from "zod";
import { MessageLinkTargetTypeSchema, MessageLinkRelationshipTypeSchema, } from "./enums.js";
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
//# sourceMappingURL=types.js.map