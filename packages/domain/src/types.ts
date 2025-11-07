import { z } from 'zod';
import { ConversationMessageMetadataSchema } from '@synap/core';

export const KnowledgeFactSchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  fact: z.string(),
  confidence: z.number().min(0).max(1),
  sourceEntityId: z.string().uuid().optional(),
  sourceMessageId: z.string().uuid().optional(),
  createdAt: z.date(),
});

export const RecordKnowledgeFactInputSchema = z.object({
  userId: z.string(),
  fact: z.string().min(1),
  confidence: z.number().min(0).max(1).default(0.5),
  sourceEntityId: z.string().uuid().optional(),
  sourceMessageId: z.string().uuid().optional(),
  embedding: z.array(z.number()).length(1536),
});

export const SearchKnowledgeFactsInputSchema = z.object({
  userId: z.string(),
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).default(5),
});

export const UpsertEntityEmbeddingInputSchema = z.object({
  entityId: z.string().uuid(),
  userId: z.string(),
  entityType: z.string().min(1),
  embedding: z.array(z.number()).min(1),
  title: z.string().optional(),
  preview: z.string().optional(),
  fileUrl: z.string().url().optional(),
  embeddingModel: z.string().default('text-embedding-3-small'),
});

export const VectorSearchInputSchema = z.object({
  userId: z.string(),
  embedding: z.array(z.number()).min(1),
  limit: z.number().int().positive().max(25).default(5),
});

export const VectorSearchResultSchema = z.object({
  entityId: z.string().uuid(),
  userId: z.string(),
  entityType: z.string(),
  title: z.string().nullable(),
  preview: z.string().nullable(),
  fileUrl: z.string().nullable(),
  relevanceScore: z.number().min(0),
});

export const CreateNoteInputSchema = z.object({
  userId: z.string(),
  content: z.string().min(1),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  entityId: z.string().uuid().optional(),
  source: z.enum(['api', 'automation', 'sync', 'migration', 'system']).default('api'),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const CreateNoteResultSchema = z.object({
  entityId: z.string().uuid(),
  eventId: z.string().uuid(),
  aggregateVersion: z.number().int().positive(),
  title: z.string(),
  preview: z.string().nullable(),
  fileUrl: z.string().nullable(),
  filePath: z.string().nullable(),
  fileSize: z.number().int().nonnegative().nullable(),
  fileType: z.string().nullable(),
  checksum: z.string().nullable(),
  tags: z.array(z.string()).default([]),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const SearchNotesInputSchema = z.object({
  userId: z.string(),
  query: z.string().min(1),
  limit: z.number().int().positive().max(100).default(10),
});

export const NoteSearchResultSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  preview: z.string().nullable(),
  fileUrl: z.string().nullable(),
  fileType: z.string().nullable(),
  tags: z.array(z.string()).default([]),
});

export const SuggestionStatusSchema = z.enum(["pending", "accepted", "dismissed"]);
export const SuggestionTypeSchema = z.enum(["propose_project"]);

export const RelatedEntitySummarySchema = z.object({
  entityId: z.string(),
  title: z.string().nullable().optional(),
});

export const ProposeProjectPayloadSchema = z.object({
  tagId: z.string(),
  tagName: z.string(),
  usageCount: z.number().int().nonnegative(),
  timeRangeHours: z.number().int().positive(),
  relatedEntities: z.array(RelatedEntitySummarySchema).default([]),
});

export const SuggestionPayloadSchema = z.union([
  ProposeProjectPayloadSchema,
  z.record(z.string(), z.unknown()),
]);

export const AggregateTypeSchema = z.enum(['entity', 'relation', 'user', 'system']);
export const EventSourceSchema = z.enum(['api', 'automation', 'sync', 'migration', 'system']);

export const EntitySchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  type: z.string(),
  title: z.string().nullable(),
  preview: z.string().nullable(),
  fileUrl: z.string().nullable(),
  filePath: z.string().nullable(),
  fileSize: z.number().nullable().optional(),
  fileType: z.string().nullable().optional(),
  checksum: z.string().nullable().optional(),
  version: z.number().int().positive(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullable(),
});

export const EntitySummarySchema = EntitySchema.pick({
  id: true,
  userId: true,
  type: true,
  title: true,
  preview: true,
  fileUrl: true,
  createdAt: true,
  updatedAt: true,
});


export const SuggestionSchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  type: SuggestionTypeSchema,
  status: SuggestionStatusSchema,
  title: z.string(),
  description: z.string(),
  payload: SuggestionPayloadSchema.optional(),
  confidence: z.number().min(0).max(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const CreateProposeProjectSuggestionSchema = z.object({
  userId: z.string(),
  tagId: z.string(),
  tagName: z.string(),
  usageCount: z.number().int().nonnegative(),
  timeRangeHours: z.number().int().positive(),
  confidence: z.number().min(0).max(1),
  relatedEntities: z.array(RelatedEntitySummarySchema).default([]),
});

export const TagUsageCandidateSchema = z.object({
  userId: z.string(),
  tagId: z.string(),
  tagName: z.string(),
  usageCount: z.number().int().nonnegative(),
});

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system']);

export const ConversationMessageSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  role: MessageRoleSchema,
  content: z.string(),
  metadata: ConversationMessageMetadataSchema.nullable().optional(),
  userId: z.string(),
  timestamp: z.date(),
  previousHash: z.string().nullable(),
  hash: z.string(),
  deletedAt: z.date().nullable().optional(),
});

export const AppendConversationMessageInputSchema = z.object({
  threadId: z.string().uuid(),
  parentId: z.string().uuid().optional(),
  role: MessageRoleSchema,
  content: z.string().min(1),
  metadata: ConversationMessageMetadataSchema.nullable().optional(),
  userId: z.string(),
});

export const ConversationThreadInfoSchema = z.object({
  threadId: z.string().uuid(),
  messageCount: z.number().int().nonnegative(),
  latestMessage: ConversationMessageSchema.nullable(),
  branches: z.number().int().nonnegative(),
});

export const ConversationThreadSummarySchema = z.object({
  threadId: z.string().uuid(),
  messageCount: z.number().int().nonnegative(),
  latestMessage: ConversationMessageSchema,
});

export const HashVerificationSchema = z.object({
  isValid: z.boolean(),
  brokenAt: z.string().uuid().nullable(),
  message: z.string(),
});

export const EventRecordSchema = z.object({
  id: z.string().uuid(),
  timestamp: z.date(),
  aggregateId: z.string().uuid(),
  aggregateType: AggregateTypeSchema,
  eventType: z.string(),
  userId: z.string(),
  data: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()).optional(),
  version: z.number().int().nonnegative(),
  causationId: z.string().uuid().optional(),
  correlationId: z.string().uuid().optional(),
  source: EventSourceSchema,
});

export const AppendEventInputSchema = z.object({
  aggregateId: z.string().uuid(),
  aggregateType: AggregateTypeSchema,
  eventType: z.string(),
  userId: z.string(),
  data: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()).optional(),
  version: z.number().int().positive(),
  causationId: z.string().uuid().optional(),
  correlationId: z.string().uuid().optional(),
  source: EventSourceSchema.optional(),
});

export const GetAggregateStreamOptionsSchema = z.object({
  fromVersion: z.number().int().nonnegative().optional(),
  toVersion: z.number().int().nonnegative().optional(),
  eventTypes: z.array(z.string()).optional(),
});

export const GetUserStreamOptionsSchema = z.object({
  days: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
  eventTypes: z.array(z.string()).optional(),
  aggregateTypes: z.array(AggregateTypeSchema).optional(),
});

export const AppendEventBatchInputSchema = z.array(AppendEventInputSchema);

export type KnowledgeFact = z.infer<typeof KnowledgeFactSchema>;
export type RecordKnowledgeFactInput = z.infer<typeof RecordKnowledgeFactInputSchema>;
export type SearchKnowledgeFactsInput = z.infer<typeof SearchKnowledgeFactsInputSchema>;
export type UpsertEntityEmbeddingInput = z.infer<typeof UpsertEntityEmbeddingInputSchema>;
export type VectorSearchInput = z.infer<typeof VectorSearchInputSchema>;
export type VectorSearchResult = z.infer<typeof VectorSearchResultSchema>;
export type CreateNoteInput = z.infer<typeof CreateNoteInputSchema>;
export type CreateNoteResult = z.infer<typeof CreateNoteResultSchema>;
export type SearchNotesInput = z.infer<typeof SearchNotesInputSchema>;
export type NoteSearchResult = z.infer<typeof NoteSearchResultSchema>;
export type Suggestion = z.infer<typeof SuggestionSchema>;
export type SuggestionStatus = z.infer<typeof SuggestionStatusSchema>;
export type SuggestionType = z.infer<typeof SuggestionTypeSchema>;
export type SuggestionPayload = z.infer<typeof SuggestionPayloadSchema>;
export type ProposeProjectPayload = z.infer<typeof ProposeProjectPayloadSchema>;
export type CreateProposeProjectSuggestionInput = z.infer<
  typeof CreateProposeProjectSuggestionSchema
>;
export type RelatedEntitySummary = z.infer<typeof RelatedEntitySummarySchema>;
export type TagUsageCandidate = z.infer<typeof TagUsageCandidateSchema>;
export type Entity = z.infer<typeof EntitySchema>;
export type EntitySummary = z.infer<typeof EntitySummarySchema>;
export type MessageRole = z.infer<typeof MessageRoleSchema>;
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;
export type AppendConversationMessageInput = z.infer<typeof AppendConversationMessageInputSchema>;
export type ConversationThreadInfo = z.infer<typeof ConversationThreadInfoSchema>;
export type ConversationThreadSummary = z.infer<typeof ConversationThreadSummarySchema>;
export type HashVerificationResult = z.infer<typeof HashVerificationSchema>;
export type AggregateType = z.infer<typeof AggregateTypeSchema>;
export type EventSource = z.infer<typeof EventSourceSchema>;
export type EventRecord = z.infer<typeof EventRecordSchema>;
export type AppendEventInput = z.infer<typeof AppendEventInputSchema>;
export type GetAggregateStreamOptions = z.infer<typeof GetAggregateStreamOptionsSchema>;
export type GetUserStreamOptions = z.infer<typeof GetUserStreamOptionsSchema>;
export type AppendEventBatchInput = z.infer<typeof AppendEventBatchInputSchema>;


