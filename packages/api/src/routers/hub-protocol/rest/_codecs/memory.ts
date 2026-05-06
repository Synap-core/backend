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
