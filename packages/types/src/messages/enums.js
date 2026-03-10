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
export var MessageLinkTargetType;
(function (MessageLinkTargetType) {
  MessageLinkTargetType["ENTITY"] = "entity";
  MessageLinkTargetType["DOCUMENT"] = "document";
  MessageLinkTargetType["PROPOSAL"] = "proposal";
  MessageLinkTargetType["MESSAGE"] = "message";
  MessageLinkTargetType["EVENT"] = "event";
  MessageLinkTargetType["USER"] = "user";
  MessageLinkTargetType["WORKSPACE"] = "workspace";
  MessageLinkTargetType["VIEW"] = "view";
  MessageLinkTargetType["RELATION"] = "relation";
  MessageLinkTargetType["PROJECT"] = "project";
  MessageLinkTargetType["TAG"] = "tag";
  MessageLinkTargetType["ROLE"] = "role";
  MessageLinkTargetType["API_KEY"] = "apiKey";
  MessageLinkTargetType["SKILL"] = "skill";
  MessageLinkTargetType["BACKGROUND_TASK"] = "backgroundTask";
  MessageLinkTargetType["AGENT"] = "agent";
  MessageLinkTargetType["CHAT_THREAD"] = "chatThread";
  MessageLinkTargetType["TEMPLATE"] = "template";
  MessageLinkTargetType["INBOX_ITEM"] = "inboxItem";
})(MessageLinkTargetType || (MessageLinkTargetType = {}));
/**
 * Message Link Relationship Types
 *
 * How the message relates to the target object.
 */
export var MessageLinkRelationshipType;
(function (MessageLinkRelationshipType) {
  MessageLinkRelationshipType["CREATED"] = "created";
  MessageLinkRelationshipType["UPDATED"] = "updated";
  MessageLinkRelationshipType["REFERENCES"] = "references";
  MessageLinkRelationshipType["APPROVES"] = "approves";
  MessageLinkRelationshipType["REJECTS"] = "rejects";
  MessageLinkRelationshipType["COMMENTS"] = "comments";
  MessageLinkRelationshipType["REVIEWS"] = "reviews";
  MessageLinkRelationshipType["RESPONDS_TO"] = "responds_to";
  MessageLinkRelationshipType["QUOTES"] = "quotes";
  MessageLinkRelationshipType["CONTEXT"] = "context";
})(MessageLinkRelationshipType || (MessageLinkRelationshipType = {}));
/**
 * Zod schemas for validation
 */
import { z } from "zod";
export const MessageLinkTargetTypeSchema = z.nativeEnum(MessageLinkTargetType);
export const MessageLinkRelationshipTypeSchema = z.nativeEnum(
  MessageLinkRelationshipType
);
//# sourceMappingURL=enums.js.map
