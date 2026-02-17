/**
 * Message Link Enums
 *
 * Shared enums for message linking system.
 * Used across backend, frontend, and Intelligence Hub.
 */
/**
 * Message Link Target Types
 *
 * All object types that messages can link to.
 */
export declare enum MessageLinkTargetType {
  ENTITY = "entity",
  DOCUMENT = "document",
  PROPOSAL = "proposal",
  MESSAGE = "message",
  EVENT = "event",
  USER = "user",
  WORKSPACE = "workspace",
  VIEW = "view",
  RELATION = "relation",
  PROJECT = "project",
  TAG = "tag",
  ROLE = "role",
  API_KEY = "apiKey",
  SKILL = "skill",
  BACKGROUND_TASK = "backgroundTask",
  AGENT = "agent",
  CHAT_THREAD = "chatThread",
  TEMPLATE = "template",
  INBOX_ITEM = "inboxItem",
}
/**
 * String literal union type (for flexibility)
 */
export type MessageLinkTargetTypeString =
  | `${MessageLinkTargetType}`
  | (string & {});
/**
 * Message Link Relationship Types
 *
 * How the message relates to the target object.
 */
export declare enum MessageLinkRelationshipType {
  CREATED = "created", // Message created this object
  UPDATED = "updated", // Message updated this object
  REFERENCES = "references", // Message references/mentions this object
  APPROVES = "approves", // Message approves this proposal
  REJECTS = "rejects", // Message rejects this proposal
  COMMENTS = "comments", // Message is a comment on this object
  REVIEWS = "reviews", // Message reviews this object
  RESPONDS_TO = "responds_to", // Message responds to another message
  QUOTES = "quotes", // Message quotes this object
  CONTEXT = "context",
}
/**
 * String literal union type (for flexibility)
 */
export type MessageLinkRelationshipTypeString =
  | `${MessageLinkRelationshipType}`
  | (string & {});
/**
 * Zod schemas for validation
 */
import { z } from "zod";
export declare const MessageLinkTargetTypeSchema: z.ZodEnum<
  typeof MessageLinkTargetType
>;
export declare const MessageLinkRelationshipTypeSchema: z.ZodEnum<
  typeof MessageLinkRelationshipType
>;
//# sourceMappingURL=enums.d.ts.map
