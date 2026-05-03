/**
 * Search Wire Codecs — Hub Protocol REST schemas for Typesense + pgvector search.
 */

import { z } from "@hono/zod-openapi";

export const SearchCollectionSchema = z
  .enum([
    "entities",
    "documents",
    "views",
    "projects",
    "chat_threads",
    "agents",
  ])
  .openapi("SearchCollection");

/** Single Typesense hit — collection + arbitrary document. */
export const SearchResultSchema = z
  .object({
    collection: SearchCollectionSchema,
    document: z.record(z.string(), z.unknown()),
    score: z.number().optional(),
    highlights: z.array(z.unknown()).optional(),
  })
  .passthrough()
  .openapi("SearchResult");

/** Cross-collection search response. */
export const SearchResponseSchema = z
  .object({
    results: z.array(SearchResultSchema),
    totalFound: z.number().optional(),
    page: z.number().optional(),
    perPage: z.number().optional(),
  })
  .passthrough()
  .openapi("SearchResponse");

/** GET /search query. */
export const SearchQuerySchema = z
  .object({
    userId: z.string(),
    query: z.string(),
    workspaceId: z.string().optional(),
    collections: z
      .string()
      .optional()
      .describe(
        "Comma-separated list of collections (e.g. entities,documents)."
      ),
    limit: z.string().optional(),
    page: z.string().optional(),
  })
  .openapi("SearchQuery");

/** GET /search/collection query. */
export const SearchCollectionQuerySchema = z
  .object({
    userId: z.string(),
    collection: SearchCollectionSchema,
    query: z.string(),
    workspaceId: z.string().optional(),
    limit: z.string().optional(),
    page: z.string().optional(),
  })
  .openapi("SearchCollectionQuery");

/** GET /search/documents query. */
export const SearchDocumentsQuerySchema = z
  .object({
    userId: z.string(),
    query: z.string(),
    type: z.enum(["text", "markdown", "code", "pdf", "docx"]).optional(),
    limit: z.string().optional(),
  })
  .openapi("SearchDocumentsQuery");

/** GET /vector-search query. */
export const VectorSearchQuerySchema = z
  .object({
    userId: z.string(),
    query: z.string(),
    types: z
      .string()
      .optional()
      .describe(
        "Comma-separated subject types to search (e.g. entity,document)."
      ),
    workspaceId: z.string().optional(),
    limit: z.string().optional(),
  })
  .openapi("VectorSearchQuery");
