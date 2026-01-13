/**
 * @synap/events - Generated Payload Schemas
 *
 * Zod schemas for each table's event payloads.
 * These are derived from the Drizzle table column definitions.
 */

import { z } from "zod";

// ============================================================================
// BASE SCHEMAS
// ============================================================================

/**
 * Base metadata schema - always JSONB, always optional
 */
export const MetadataSchema = z.record(z.unknown()).optional();

/**
 * Request context - for tracking async operations
 */
export const RequestContextSchema = z.object({
  requestId: z.string().uuid().optional(),
  correlationId: z.string().uuid().optional(),
  causationId: z.string().uuid().optional(),
  source: z
    .enum(["api", "automation", "sync", "migration", "system", "intelligence"])
    .optional(),
});

// ============================================================================
// ENTITIES TABLE PAYLOADS
// ============================================================================

/**
 * Entity types supported
 */
export const EntityTypeSchema = z.enum([
  "note",
  "task",
  "project",
  "contact",
  "meeting",
  "idea",
  "event",
  "habit",
  "page",
]);

export type EntityType = z.infer<typeof EntityTypeSchema>;

/**
 * File attachment for entity creation
 */
export const FileAttachmentSchema = z
  .object({
    content: z.string(), // Base64 or text content
    filename: z.string(),
    contentType: z.string(),
    source: z.enum(["text-input", "file-upload", "ai-generated"]),
  })
  .optional();

/**
 * entities.create.requested payload
 */
export const EntitiesCreateRequestedPayload = z.object({
  // Required
  entityType: EntityTypeSchema,

  // Optional - core fields from entities table
  id: z.string().uuid().optional(), // Auto-generated if not provided
  title: z.string().optional(),
  preview: z.string().optional(),
  content: z.string().optional(), // For notes - becomes file

  // File handling
  file: FileAttachmentSchema,

  // Type-specific metadata (task: dueDate, priority; contact: email, phone)
  metadata: MetadataSchema,

  // Request context
  ...RequestContextSchema.shape,
  
  // AI-specific metadata for tracking AI-generated proposals
  aiMetadata: z.object({
    messageId: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
    model: z.string().optional(),
    reasoning: z.string().optional(),
  }).optional(),
});

/**
 * entities.create.validated payload
 */
export const EntitiesCreateCompletedPayload = z.object({
  entityId: z.string().uuid(),
  entityType: EntityTypeSchema,
  title: z.string().optional(),

  // File info (if created)
  fileUrl: z.string().url().optional(),
  filePath: z.string().optional(),
  fileSize: z.number().int().nonnegative().optional(),
  fileType: z.string().optional(),
  checksum: z.string().optional(),
});

/**
 * entities.update.requested payload
 */
export const EntitiesUpdateRequestedPayload = z.object({
  entityId: z.string().uuid(),

  // Fields to update
  title: z.string().optional(),
  preview: z.string().optional(),
  content: z.string().optional(),

  // Metadata updates
  metadata: MetadataSchema,

  ...RequestContextSchema.shape,
});

// ============================================================================
// DOCUMENTS TABLE PAYLOADS
// ============================================================================

/**
 * documents.create.requested payload
 */
export const DocumentsCreateRequestedPayload = z.object({
  // Required
  title: z.string(),
  type: z.enum(["text", "markdown", "code", "pdf", "docx"]),

  // Content
  content: z.string().optional(),
  file: FileAttachmentSchema,

  // Optional
  language: z.string().optional(), // For code files
  projectId: z.string().uuid().optional(),

  metadata: MetadataSchema,
  ...RequestContextSchema.shape,
});

/**
 * documents.create.validated payload
 */
export const DocumentsCreateCompletedPayload = z.object({
  documentId: z.string().uuid(),
  title: z.string(),
  storageUrl: z.string().url(),
  storageKey: z.string(),
  size: z.number().int(),
  currentVersion: z.number().int(),
});

// ============================================================================
// CONVERSATION MESSAGES TABLE PAYLOADS
// ============================================================================

/**
 * Attachment in a message
 */
export const MessageAttachmentSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(["image", "file", "document"]),
  filename: z.string(),
  storageKey: z.string().optional(),
  storageUrl: z.string().url().optional(),
  externalUrl: z.string().url().optional(), // If from external source
  size: z.number().int().optional(),
  mimeType: z.string().optional(),
});

/**
 * conversationMessages.create.requested payload
 */
export const ConversationMessagesCreateRequestedPayload = z.object({
  threadId: z.string().uuid(),
  content: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  parentId: z.string().uuid().optional(),

  // Attachments (will be uploaded to storage)
  attachments: z.array(MessageAttachmentSchema).optional(),

  metadata: MetadataSchema,
  ...RequestContextSchema.shape,
});

// ============================================================================
// CHAT THREADS TABLE PAYLOADS
// ============================================================================

/**
 * chatThreads.create.requested payload
 */
export const ChatThreadsCreateRequestedPayload = z.object({
  title: z.string().optional(),
  threadType: z.enum(["main", "branch"]).optional(),
  parentThreadId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  agentId: z.string().optional(),

  metadata: MetadataSchema,
  ...RequestContextSchema.shape,
});

// ============================================================================
// TASK DETAILS TABLE PAYLOADS (extension of entities)
// ============================================================================

/**
 * taskDetails.create.requested payload
 */
export const TaskDetailsCreateRequestedPayload = z.object({
  taskId: z.string().uuid(),
  priority: z.number().min(0).max(3).optional(),
  dueDate: z.string().datetime().optional(),
  status: z.enum(["todo", "in_progress", "done", "cancelled"]).optional(),
  tagNames: z.array(z.string()).optional(),

  metadata: MetadataSchema,
});

// ============================================================================
// SCHEMA REGISTRY
// ============================================================================

/**
 * All generated payload schemas mapped by event type
 */
export const GeneratedPayloadSchemas = {
  "entities.create.requested": EntitiesCreateRequestedPayload,
  "entities.create.validated": EntitiesCreateCompletedPayload,
  "entities.update.requested": EntitiesUpdateRequestedPayload,
  "documents.create.requested": DocumentsCreateRequestedPayload,
  "documents.create.validated": DocumentsCreateCompletedPayload,
  "conversationMessages.create.requested":
    ConversationMessagesCreateRequestedPayload,
  "chatThreads.create.requested": ChatThreadsCreateRequestedPayload,
  "taskDetails.create.requested": TaskDetailsCreateRequestedPayload,
} as const;

export type GeneratedPayloadSchemaType = keyof typeof GeneratedPayloadSchemas;

/**
 * Get payload schema for an event type
 */
export function getPayloadSchema(eventType: string): z.ZodSchema | null {
  return (
    (GeneratedPayloadSchemas as Record<string, z.ZodSchema>)[eventType] ?? null
  );
}

/**
 * Validate payload against its schema
 */
export function validatePayload<T extends GeneratedPayloadSchemaType>(
  eventType: T,
  payload: unknown,
): z.infer<(typeof GeneratedPayloadSchemas)[T]> {
  const schema = GeneratedPayloadSchemas[eventType];
  return schema.parse(payload);
}
