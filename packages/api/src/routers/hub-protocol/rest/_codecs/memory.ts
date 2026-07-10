/**
 * Memory Wire Codec — schemas for `/memory*` Hub Protocol endpoints.
 *
 * Memory facts are user-scoped episodic snippets backed by `knowledge_facts`
 * (pgvector when enabled, full-text otherwise on shared pods).
 */

import { z } from "@hono/zod-openapi";

/** A single fact row. */
export const MemoryFactSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    fact: z.string(),
    confidence: z.number().min(0).max(1).optional(),
    sourceEntityId: z.string().nullable().optional(),
    sourceMessageId: z.string().nullable().optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
  })
  .openapi("MemoryFact");

/** Body for POST /memory. */
export const CreateMemoryRequestSchema = z
  .object({
    userId: z
      .string()
      .optional()
      .describe("Defaults to the authenticated agent's user when omitted."),
    fact: z.string().min(1),
    confidence: z.number().min(0).max(1).optional(),
    embedding: z
      .array(z.number())
      .optional()
      .describe(
        "Optional 1536-d embedding. Falls back to a zero vector when omitted."
      ),
    sourceEntityId: z.string().optional(),
    sourceMessageId: z.string().optional(),
  })
  .openapi("CreateMemoryRequest");

/** Body for POST /memory/search. */
export const MemorySearchRequestSchema = z
  .object({
    userId: z.string(),
    embedding: z.array(z.number()),
    limit: z.number().int().positive().max(100).optional(),
  })
  .openapi("MemorySearchRequest");

// ── Memory turns, sessions, writes (IS plugin contract) ──────────────────────

/** A single chat turn (user or assistant message). */
export const MemoryTurnSchema = z
  .object({
    role: z.enum(["user", "assistant", "system"]),
    content: z.string(),
  })
  .openapi("MemoryTurn");

/** Body for POST /memory/turns. */
export const MemoryTurnsRequestSchema = z
  .object({
    userId: z
      .string()
      .optional()
      .describe("Defaults to the authenticated agent's user when omitted."),
    sessionId: z.string().describe("Session grouping ID."),
    turns: z.array(MemoryTurnSchema).min(1),
    summary: z.string().optional().describe("Optional human-readable summary."),
    confidence: z.number().min(0).max(1).optional(),
    embedding: z
      .array(z.number())
      .optional()
      .describe(
        "Optional 1536-d embedding for the full session. Falls back to zero vector."
      ),
    sourceEntityId: z.string().optional(),
    sourceMessageId: z.string().optional(),
  })
  .openapi("MemoryTurnsRequest");

/** Body for POST /memory/sessions. */
export const MemorySessionRequestSchema = z
  .object({
    userId: z
      .string()
      .optional()
      .describe("Defaults to the authenticated agent's user when omitted."),
    sessionId: z.string().describe("Unique session ID."),
    summary: z.string().min(1).describe("Human-readable session summary."),
    turnCount: z.number().int().positive().optional(),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .openapi("MemorySessionRequest");

/** Body for POST /memory/writes. Batch write of structured memory entries. */
export const MemoryWritesRequestSchema = z
  .object({
    userId: z
      .string()
      .optional()
      .describe("Defaults to the authenticated agent's user when omitted."),
    entries: z
      .array(
        z.object({
          action: z.enum(["remember", "update", "forget"]),
          target: z
            .string()
            .describe("Entity or concept targeted by the action."),
          content: z.string().describe("The fact/data to persist."),
        })
      )
      .min(1)
      .max(50),
    confidence: z.number().min(0).max(1).optional(),
  })
  .openapi("MemoryWritesRequest");

/** Response for turns/sessions/writes — single fact created or batch summary. */
export const MemoryBatchResponseSchema = z
  .object({
    success: z.boolean(),
    facts: z.array(MemoryFactSchema),
    count: z.number().int().nonnegative(),
  })
  .openapi("MemoryBatchResponse");
