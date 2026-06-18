/**
 * Knowledge Wire Codec — schemas for `/knowledge*` Hub Protocol endpoints.
 *
 * Knowledge keys are pod-wide procedural docs addressed by string key
 * (e.g. "deploy:backend"). Distinct from memory (user episodic).
 */

import { z } from "@hono/zod-openapi";

/** A single knowledge entry. */
export const KnowledgeEntrySchema = z
  .object({
    id: z.string(),
    key: z.string(),
    value: z.unknown().describe("Arbitrary JSON payload."),
    namespace: z.string().nullable().optional(),
    slug: z.string().nullable().optional(),
    status: z.string().optional(),
    workspaceId: z.string().nullable().optional(),
    author: z.string().nullable().optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
  })
  .openapi("KnowledgeEntry");

/** Body for POST /knowledge. */
export const CreateKnowledgeRequestSchema = z
  .object({
    key: z.string().min(1),
    value: z.unknown(),
    namespace: z.string().optional(),
    slug: z.string().optional(),
    status: z.string().optional(),
    workspaceId: z.string().uuid().nullable().optional(),
    author: z.string().optional(),
  })
  .openapi("CreateKnowledgeRequest");

/** Body for PUT /knowledge/:key. */
export const UpsertKnowledgeRequestSchema = z
  .object({
    value: z.unknown(),
    status: z.string().optional(),
    author: z.string().optional(),
  })
  .openapi("UpsertKnowledgeRequest");
