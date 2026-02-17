/**
 * Message Link Types
 *
 * TypeScript types for message links.
 */
import { z } from "zod";
import { MessageLinkTargetType, MessageLinkRelationshipType } from "./enums.js";
/**
 * Message Link Interface
 */
export interface MessageLink {
    id: string;
    messageId: string;
    targetType: MessageLinkTargetType | string;
    targetId: string;
    relationshipType: MessageLinkRelationshipType | string;
    position?: {
        start: number;
        end: number;
    };
    metadata?: Record<string, unknown>;
    userId: string;
    workspaceId: string;
    createdAt: Date;
}
/**
 * Create Message Link Input
 */
export declare const CreateMessageLinkInputSchema: z.ZodObject<{
    messageId: z.ZodString;
    targetType: z.ZodEnum<typeof MessageLinkTargetType>;
    targetId: z.ZodString;
    relationshipType: z.ZodEnum<typeof MessageLinkRelationshipType>;
    position: z.ZodOptional<z.ZodObject<{
        start: z.ZodNumber;
        end: z.ZodNumber;
    }, z.core.$strip>>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    workspaceId: z.ZodString;
}, z.core.$strip>;
export type CreateMessageLinkInput = z.infer<typeof CreateMessageLinkInputSchema>;
/**
 * Query Message Links Input
 */
export declare const QueryMessageLinksInputSchema: z.ZodObject<{
    messageId: z.ZodOptional<z.ZodString>;
    targetType: z.ZodOptional<z.ZodEnum<typeof MessageLinkTargetType>>;
    targetId: z.ZodOptional<z.ZodString>;
    relationshipType: z.ZodOptional<z.ZodEnum<typeof MessageLinkRelationshipType>>;
    workspaceId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type QueryMessageLinksInput = z.infer<typeof QueryMessageLinksInputSchema>;
//# sourceMappingURL=types.d.ts.map